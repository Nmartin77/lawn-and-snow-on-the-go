// One Edge Function for everything that needs secrets: Stripe Connect, checkout, cancel, webhook.
import Stripe from "https://esm.sh/stripe@14?target=denonext";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2023-10-16" });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SITE = Deno.env.get("SITE_URL")!; // e.g. https://YOUR-USERNAME.github.io/lawn-and-snow-on-the-go (no trailing slash)
const FEE = 0.15; // platform fee: 15% of the job total
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

  const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return out({ error: "Sign in first." }, 401);
  const body = await req.json().catch(() => ({}));
  const { data: me } = await db.from("profiles").select("*").eq("id", user.id).single();

  try {
    if (act === "onboard" && me.role === "company") {
      let id = me.stripe_account_id;
      if (!id) {
        id = (await stripe.accounts.create({ type: "express", email: user.email, business_profile: { name: me.company_name }, metadata: { user_id: user.id } })).id;
        await db.from("profiles").update({ stripe_account_id: id }).eq("id", user.id);
      }
      const l = await stripe.accountLinks.create({ account: id, refresh_url: SITE + "/company.html", return_url: SITE + "/company.html", type: "account_onboarding" });
      return out({ url: l.url });
    }
    if (act === "refresh" && me.stripe_account_id) {
      const a = await stripe.accounts.retrieve(me.stripe_account_id);
      await db.from("profiles").update({ charges_enabled: a.charges_enabled }).eq("id", user.id);
      return out({ charges_enabled: a.charges_enabled });
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
      const common = { customer: cust, line_items: [item], metadata: meta, success_url: SITE + "/customer.html?paid=1", cancel_url: SITE + "/customer.html" };
      const dest = q.company.stripe_account_id;
      const s = await stripe.checkout.sessions.create(plan === "once"
        ? { ...common, mode: "payment", payment_intent_data: { application_fee_amount: Math.round(q.price_cents * FEE), transfer_data: { destination: dest }, setup_future_usage: "off_session", metadata: meta } }
        : { ...common, mode: "subscription", subscription_data: { application_fee_percent: FEE * 100, transfer_data: { destination: dest }, metadata: meta } });
      return out({ url: s.url });
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

async function webhook(req: Request) {
  const ev = await stripe.webhooks
    .constructEventAsync(await req.text(), req.headers.get("stripe-signature")!, Deno.env.get("STRIPE_WEBHOOK_SECRET")!)
    .catch(() => null);
  if (!ev) return new Response("bad signature", { status: 400 });
  const o: any = ev.data.object;
  if (ev.type === "checkout.session.completed" && o.metadata?.request_id) {
    await db.from("requests").update({ status: "booked", booked_quote: +o.metadata.quote_id, stripe_subscription_id: o.subscription || null }).eq("id", +o.metadata.request_id);
  }
  if (ev.type === "customer.subscription.deleted") {
    await db.from("requests").update({ status: "cancelled" }).eq("stripe_subscription_id", o.id);
  }
  return new Response("ok");
}
