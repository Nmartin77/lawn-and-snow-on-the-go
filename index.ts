// One Edge Function for everything that needs secrets: Stripe Connect, checkout, payouts, cancel, webhook.
import Stripe from "https://esm.sh/stripe@14?target=denonext";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2023-10-16" });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SITE = Deno.env.get("SITE_URL")!; // e.g. https://YOUR-USERNAME.github.io/lawn-and-snow-on-the-go (no trailing slash)
const FEE = 0.15; // platform fee: 15% of the job total
const SERVICE_FEE_CENTS = 500; // flat $5 the customer pays for each completed job or visit, on top of the quote
const WINDOW_HOURS = 2; // the crew has this long to finish after arriving (or after the ETA)
const REVIEW_HOURS = 48; // how long the customer has to approve or report a problem after the crew finishes
const PLAN: Record<string, { interval: "week" | "month"; interval_count: number }> = {
  weekly: { interval: "week", interval_count: 1 },
  biweekly: { interval: "week", interval_count: 2 },
  monthly: { interval: "month", interval_count: 1 },
};
const cors = {
  "Access-Control-Allow-Origin": new URL(SITE).origin,
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Content-Type": "application/json",
};
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const act = new URL(req.url).pathname.split("/").pop();
  if (act === "webhook") return webhook(req);

  // Scheduled job (GitHub Actions) that releases payments whose 48 hours are up.
  if (act === "sweep" && req.headers.get("x-cron-secret") && req.headers.get("x-cron-secret") === Deno.env.get("CRON_SECRET")) return out({ released: await sweep() });
  const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return out({ error: "Sign in first." }, 401);
  const body = await req.json().catch(() => ({}));
  const { data: me } = await db.from("profiles").select("*").eq("id", user.id).single();
  const isAdmin = (Deno.env.get("ADMIN_EMAILS") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).includes((user.email || "").toLowerCase());

  try {
    if (act === "onboard" && me.role === "company") {
      let id = me.stripe_account_id;
      if (!id) {
        id = (await stripe.accounts.create({ type: "express", email: user.email, business_profile: { name: me.company_name }, capabilities: { transfers: { requested: true } }, metadata: { user_id: user.id } })).id;
        await db.from("profiles").update({ stripe_account_id: id }).eq("id", user.id);
      }
      const l = await stripe.accountLinks.create({ account: id, refresh_url: SITE + "/company.html", return_url: SITE + "/company.html", type: "account_onboarding" });
      return out({ url: l.url });
    }
    if (act === "refresh" && me.stripe_account_id) {
      const a = await stripe.accounts.retrieve(me.stripe_account_id);
      // A crew is ready to be paid when Stripe has switched on its "transfers" capability.
      const ready = a.capabilities?.transfers === "active";
      await db.from("profiles").update({ charges_enabled: ready }).eq("id", user.id);
      return out({ charges_enabled: ready });
    }
    if (act === "checkout" && me.role === "customer") {
      const { data: q } = await db.from("quotes")
        .select("*, requests(*), company:profiles!company_id(stripe_account_id,charges_enabled,company_name)")
        .eq("id", body.quote_id).single();
      if (!q || q.requests.customer_id !== user.id || q.requests.status !== "open") return out({ error: "That quote is no longer available." }, 400);
      if (!q.company.charges_enabled) return out({ error: "This crew can't accept payments yet." }, 400);
      let cust = me.stripe_customer_id;
      if (!cust) {
        cust = (await stripe.customers.create({ email: user.email, name: me.name, metadata: { user_id: user.id } })).id;
        await db.from("profiles").update({ stripe_customer_id: cust }).eq("id", user.id);
      }
      const plan = q.requests.plan, meta = { request_id: String(q.request_id), quote_id: String(q.id) };
      const item = {
        quantity: 1,
        price_data: {
          currency: "usd", unit_amount: q.price_cents,
          product_data: { name: `${q.requests.service} - ${q.company.company_name}` },
          ...(plan !== "once" ? { recurring: PLAN[plan] } : {}),
        },
      };
      const feeItem = {
        quantity: 1,
        price_data: { currency: "usd", unit_amount: SERVICE_FEE_CENTS, product_data: { name: "Service fee" }, ...(plan !== "once" ? { recurring: PLAN[plan] } : {}) },
      };
      const common = { customer: cust, line_items: [item, feeItem], metadata: meta, success_url: SITE + "/customer.html?paid=1", cancel_url: SITE + "/customer.html" };
      // The customer pays us. The crew's share is transferred only after the job is finished (see "complete").
      const s = await stripe.checkout.sessions.create(plan === "once"
        ? { ...common, mode: "payment", payment_intent_data: { transfer_group: `req_${q.request_id}`, setup_future_usage: "off_session", metadata: meta } }
        : { ...common, mode: "subscription", subscription_data: { metadata: meta } });
      return out({ url: s.url });
    }
    if (act === "complete" && me.role === "company") {
      const { payment_id, notes, photos } = body;
      const ok = Array.isArray(photos) && photos.length >= 1 && photos.length <= 10 &&
        photos.every((p: unknown) => typeof p === "string" && p.startsWith(`${user.id}/${payment_id}/`));
      if (!ok) return out({ error: "Add at least one photo of the finished work." }, 400);
      // Start the customer's 48-hour approval window. The crew is paid when the customer approves or the window ends.
      const ends = new Date(Date.now() + REVIEW_HOURS * 3600e3).toISOString();
      const { data: p } = await db.from("payments").update({ status: "review", review_ends_at: ends })
        .eq("id", payment_id).eq("company_id", user.id).eq("status", "held").select().maybeSingle();
      if (!p) return out({ error: "This job is not ready to be finished." }, 400);
      const { error } = await db.from("completions").insert({ payment_id: p.id, request_id: p.request_id, company_id: user.id, notes: String(notes || "").slice(0, 1000), photos });
      if (error) { await db.from("payments").update({ status: "held", review_ends_at: null }).eq("id", p.id); throw error; }
      return out({ ok: true, review_ends_at: ends });
    }
    if (act === "eta" && me.role === "company") {
      const t = Date.parse(body.eta_at);
      if (!Number.isFinite(t) || t < Date.now() - 3600e3 || t > Date.now() + 14 * 86400e3) return out({ error: "Pick an arrival time within the next 14 days." }, 400);
      const { data: p } = await db.from("payments")
        .update({ eta_at: new Date(t).toISOString(), window_ends_at: new Date(t + WINDOW_HOURS * 3600e3).toISOString() })
        .eq("id", body.payment_id).eq("company_id", user.id).eq("status", "held").is("arrived_at", null).select("id").maybeSingle();
      return p ? out({ ok: true }) : out({ error: "This job's arrival time can't be changed now." }, 400);
    }
    if (act === "arrive" && me.role === "company") {
      const now = Date.now();
      const { data: p } = await db.from("payments")
        .update({ arrived_at: new Date(now).toISOString(), window_ends_at: new Date(now + WINDOW_HOURS * 3600e3).toISOString() })
        .eq("id", body.payment_id).eq("company_id", user.id).eq("status", "held").is("arrived_at", null).select("id").maybeSingle();
      return p ? out({ ok: true }) : out({ error: "Could not mark this job as arrived." }, 400);
    }
    if (act === "approve" && me.role === "customer") {
      const { data: p } = await db.from("payments").select("id").eq("id", body.payment_id).eq("customer_id", user.id).maybeSingle();
      if (!p) return out({ error: "Not found." }, 404);
      return (await releasePayment(p.id, ["review"])) ? out({ ok: true }) : out({ error: "Nothing to approve." }, 400);
    }
    if (act === "dispute" && me.role === "customer") {
      const { payment_id, kind, reason } = body;
      if (!["refund", "dispute"].includes(kind) || String(reason || "").trim().length < 10) return out({ error: "Please explain what went wrong (at least 10 characters)." }, 400);
      const { data: p } = await db.from("payments").update({ status: "disputed" })
        .eq("id", payment_id).eq("customer_id", user.id).in("status", ["held", "review"]).select().maybeSingle();
      if (!p) return out({ error: "This payment can no longer be disputed." }, 400);
      await db.from("disputes").insert({ payment_id: p.id, request_id: p.request_id, customer_id: p.customer_id, company_id: p.company_id, kind, reason: String(reason).trim().slice(0, 1500) });
      return out({ ok: true });
    }
    if (act === "sweep") return out({ released: await sweep() });
    if (act === "admin_list" && isAdmin) {
      const { data: ds } = await db.from("disputes").select("*").order("created_at", { ascending: false }).limit(100);
      const rows = [];
      for (const d of ds || []) {
        const [{ data: p }, { data: r }, { data: c }] = await Promise.all([
          db.from("payments").select("amount_cents").eq("id", d.payment_id).single(),
          db.from("requests").select("service,address").eq("id", d.request_id).single(),
          db.from("completions").select("notes,photos").eq("payment_id", d.payment_id).maybeSingle()]);
        const urls = c?.photos?.length ? ((await db.storage.from("job-photos").createSignedUrls(c.photos, 3600)).data || []).map((x) => x.signedUrl).filter(Boolean) : [];
        rows.push({ ...d, amount_cents: p?.amount_cents, service: r?.service, address: r?.address, notes: c?.notes, photo_urls: urls });
      }
      return out({ disputes: rows });
    }
    if (act === "resolve" && isAdmin) {
      const { data: d } = await db.from("disputes").select("*").eq("id", body.dispute_id).eq("status", "open").maybeSingle();
      if (!d) return out({ error: "Dispute not found or already resolved." }, 400);
      const note = String(body.note || "").slice(0, 500), done = new Date().toISOString();
      if (body.outcome === "refund") {
        const { data: p } = await db.from("payments").update({ status: "releasing" }).eq("id", d.payment_id).eq("status", "disputed").select().maybeSingle();
        if (!p) return out({ error: "This payment is not in dispute." }, 400);
        try { await stripe.refunds.create({ charge: p.stripe_charge_id }, { idempotencyKey: `refund-${p.id}` }); }
        catch (e) { await db.from("payments").update({ status: "disputed" }).eq("id", p.id); throw e; }
        await db.from("payments").update({ status: "refunded" }).eq("id", p.id);
        const { data: r } = await db.from("requests").select("plan").eq("id", p.request_id).single();
        if (r?.plan === "once") await db.from("requests").update({ status: "cancelled" }).eq("id", p.request_id);
        await db.from("disputes").update({ status: "refunded", resolution_note: note, resolved_at: done }).eq("id", d.id);
      } else if (body.outcome === "release") {
        if (!(await releasePayment(d.payment_id, ["disputed"]))) return out({ error: "This payment is not in dispute." }, 400);
        await db.from("disputes").update({ status: "released", resolution_note: note, resolved_at: done }).eq("id", d.id);
      } else return out({ error: "Choose refund or release." }, 400);
      return out({ ok: true });
    }
    if (act === "cancel") {
      const { data: r } = await db.from("requests").select("*").eq("id", body.request_id).eq("customer_id", user.id).single();
      if (!r) return out({ error: "Not found." }, 404);
      if (r.stripe_subscription_id) await stripe.subscriptions.cancel(r.stripe_subscription_id);
      await db.from("requests").update({ status: "cancelled" }).eq("id", r.id);
      return out({ ok: true });
    }
    if (act === "portal" && me.role === "customer") {
      if (!me.stripe_customer_id) return out({ error: "Your card is saved the first time you book." }, 400);
      const s = await stripe.billingPortal.sessions.create({ customer: me.stripe_customer_id, return_url: SITE + "/customer.html" });
      return out({ url: s.url });
    }
    return out({ error: "Unknown action." }, 404);
  } catch (e) {
    return out({ error: (e as Error).message }, 400);
  }
});

// Save a customer payment as "held" until the crew finishes the job.
async function record(requestId: number, quoteId: number, chargeId: string, amount: number) {
  const { data: q } = await db.from("quotes").select("company_id, requests(customer_id)").eq("id", quoteId).single();
  if (!q) return;
  // The 15% commission applies to the crew's price only. The $5 service fee stays with the platform.
  const base = Math.max(0, amount - SERVICE_FEE_CENTS), fee = Math.round(base * FEE);
  await db.from("payments").upsert({
    request_id: requestId, quote_id: quoteId, customer_id: (q as any).requests.customer_id, company_id: q.company_id,
    amount_cents: amount, service_fee_cents: SERVICE_FEE_CENTS, fee_cents: fee, crew_cents: base - fee, stripe_charge_id: chargeId,
  }, { onConflict: "stripe_charge_id", ignoreDuplicates: true });
}

async function webhook(req: Request) {
  const ev = await stripe.webhooks
    .constructEventAsync(await req.text(), req.headers.get("stripe-signature")!, Deno.env.get("STRIPE_WEBHOOK_SECRET")!)
    .catch(() => null);
  if (!ev) return new Response("bad signature", { status: 400 });
  const o: any = ev.data.object;
  if (ev.type === "checkout.session.completed" && o.metadata?.request_id) {
    await db.from("requests").update({ status: "booked", booked_quote: +o.metadata.quote_id, stripe_subscription_id: o.subscription || null }).eq("id", +o.metadata.request_id);
    if (o.mode === "payment" && o.payment_status === "paid") {
      const pi = await stripe.paymentIntents.retrieve(o.payment_intent);
      await record(+o.metadata.request_id, +o.metadata.quote_id, pi.latest_charge as string, o.amount_total);
    }
  }
  if (ev.type === "invoice.paid" && o.subscription && o.charge) {
    const sub = await stripe.subscriptions.retrieve(o.subscription);
    if (sub.metadata?.request_id) await record(+sub.metadata.request_id, +sub.metadata.quote_id, o.charge, o.amount_paid);
  }
  if (ev.type === "customer.subscription.deleted") {
    await db.from("requests").update({ status: "cancelled" }).eq("stripe_subscription_id", o.id);
  }
  return new Response("ok");
}

// Pay the crew its share of a payment. "from" lists the statuses it may be released from.
async function releasePayment(id: number, from: string[]): Promise<boolean> {
  const { data: p } = await db.from("payments").update({ status: "releasing" }).eq("id", id).in("status", from).select().maybeSingle();
  if (!p) return false;
  const { data: co } = await db.from("profiles").select("stripe_account_id").eq("id", p.company_id).single();
  try {
    await stripe.transfers.create({
      amount: p.crew_cents, currency: "usd", destination: co!.stripe_account_id,
      source_transaction: p.stripe_charge_id, transfer_group: `req_${p.request_id}`, metadata: { payment_id: String(p.id) },
    }, { idempotencyKey: `payout-${p.id}` });
  } catch (e) {
    await db.from("payments").update({ status: from[0] }).eq("id", p.id);
    throw e;
  }
  await db.from("payments").update({ status: "released", released_at: new Date().toISOString() }).eq("id", p.id);
  const { data: r } = await db.from("requests").select("plan").eq("id", p.request_id).single();
  if (r?.plan === "once") await db.from("requests").update({ status: "done" }).eq("id", p.request_id);
  return true;
}

// Release every payment whose approval window has ended.
async function sweep(): Promise<number> {
  const { data } = await db.from("payments").select("id").eq("status", "review").lte("review_ends_at", new Date().toISOString()).limit(50);
  let n = 0;
  for (const p of data || []) { try { if (await releasePayment(p.id, ["review"])) n++; } catch (_e) { /* try again next time */ } }
  return n;
}
