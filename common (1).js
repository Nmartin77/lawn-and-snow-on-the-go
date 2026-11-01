import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CONFIG } from "./config.js";

// Keep only the address part of the URL, so a trailing slash or an extra path such as /rest/v1/ cannot break requests.
const cleanUrl = (u) => { try { return new URL(u).origin; } catch (e) { return u; } };
export const sb = createClient(cleanUrl(CONFIG.SUPABASE_URL), CONFIG.SUPABASE_ANON_KEY);
export const $ = (s, r = document) => r.querySelector(s);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const usd = (c) => "$" + (c / 100).toFixed(2).replace(/\.00$/, "");
export const PLANS = { once: "One-time", weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly" };
export const SERVICES = { "Lawn mowing": 12, "Hedge trimming": 30, "Mulch install": 45, "Seasonal cleanup": 25, "Sod or seeding": 70, "Snow removal": 18 };
export const est = (s, sz) => Math.max(45, Math.round((SERVICES[s] * sz) / 1000 / 5) * 5); // dollars

// Calls the Edge Function (Stripe and other server-side work).
export async function api(action, body = {}) {
  const { data: { session } } = await sb.auth.getSession();
  const r = await fetch(`${cleanUrl(CONFIG.SUPABASE_URL)}/functions/v1/api/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.access_token, apikey: CONFIG.SUPABASE_ANON_KEY },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Something went wrong.");
  return j;
}

// ---- Google Maps ----
let mapsP;
export const loadMaps = () => (mapsP ??= new Promise((res) => {
  if (!CONFIG.GOOGLE_MAPS_KEY || CONFIG.GOOGLE_MAPS_KEY.startsWith("YOUR")) return res(null);
  window.__maps = () => res(google.maps);
  const s = document.createElement("script");
  s.src = `https://maps.googleapis.com/maps/api/js?key=${CONFIG.GOOGLE_MAPS_KEY}&callback=__maps`;
  s.async = true; s.onerror = () => res(null);
  document.head.appendChild(s);
}));
export async function geocode(address) {
  const m = await loadMaps();
  if (!m) return {};
  return new Promise((r) => new m.Geocoder().geocode({ address }, (x, st) =>
    r(st === "OK" ? { lat: x[0].geometry.location.lat(), lng: x[0].geometry.location.lng() } : {})));
}
export async function makeMap(el) {
  const m = await loadMaps();
  if (!m) { el.textContent = "Add a Google Maps key in config.js to show the live map."; return null; }
  return { m, map: new m.Map(el, { center: { lat: 42.2409, lng: -83.2696 }, zoom: 10 }) };
}

// ---- Modals, sign-in, agreement ----
const modal = (html) => {
  const g = document.createElement("div");
  g.className = "gate";
  g.innerHTML = `<div class="gate-box" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(g);
  $("#app").inert = true;
  return g;
};
const close = (g) => { g.remove(); $("#app").inert = false; };
const here = () => location.href.split("#")[0].split("?")[0];

sb.auth.onAuthStateChange((ev) => {
  if (ev !== "PASSWORD_RECOVERY") return;
  const g = modal(`<h2>Choose a new password</h2><label>New password<input id="np" type="password" autocomplete="new-password"></label><p class="meta err" id="m"></p><button class="btn" id="go">Save password</button>`);
  $("#go", g).onclick = async () => {
    const p = $("#np", g).value;
    if (p.length < 8) return ($("#m", g).textContent = "Use at least 8 characters.");
    const { error } = await sb.auth.updateUser({ password: p });
    if (error) return ($("#m", g).textContent = error.message);
    location.href = here();
  };
});

// Turns the browser's vague "Failed to fetch" into a message that names the address being used.
const friendly = (e) => {
  if (!/fetch|network/i.test(e.message)) return e.message;
  let host = CONFIG.SUPABASE_URL;
  try { host = new URL(CONFIG.SUPABASE_URL).host; } catch (x) {}
  return `Could not reach "${host}". Check SUPABASE_URL in config.js: it must be your real Project URL.`;
};

function authScreen(role, done, notice = "") {
  let mode = location.hash === "#signup" ? "up" : "in";
  if (/YOUR-/.test(CONFIG.SUPABASE_URL + CONFIG.SUPABASE_ANON_KEY)) notice = "Setup needed: config.js still has YOUR-... placeholders for Supabase. Replace them with your real values.";
  const g = modal("");
  const box = $(".gate-box", g);
  const T = { in: "Sign in", up: "Create your account", pw: "Reset your password", link: "Email me a sign-in link" };
  const B = { in: "Sign in", up: "Create account", pw: "Email me a reset link", link: "Email me a link" };
  const draw = () => {
    const up = mode === "up", needPw = mode === "in" || up;
    box.innerHTML = `<h2>${T[mode]}</h2>
      <p class="meta">${role === "company" ? "For lawn, landscape and snow crews." : "For anyone booking lawn, landscape and snow services."}</p>
      ${mode === "link" ? `<p class="meta">Your username is your email. We will email you a link that signs you in.</p>` : ""}
      ${up ? `<label>Your name<input id="n" autocomplete="name"></label>${role === "company" ? `<label>Company name<input id="c" autocomplete="organization"></label>` : ""}` : ""}
      <label>Email (your username)<input id="e" type="email" autocomplete="email"></label>
      ${needPw ? `<label>Password<input id="p" type="password" autocomplete="${up ? "new-password" : "current-password"}"></label>` : ""}
      <p class="meta err" id="m" role="alert">${esc(notice)}</p>
      ${up ? `<p class="meta">By creating an account you agree to our <a href="terms.html" target="_blank" rel="noopener">terms of service</a> and <a href="privacy.html" target="_blank" rel="noopener">privacy policy</a>.</p>` : ""}
      <button class="btn" id="go">${B[mode]}</button>
      ${mode === "in" || up ? `<button class="btn ghost" data-o="google">Continue with Google</button><button class="btn ghost" data-o="apple">Continue with Apple</button>` : ""}
      ${mode === "in" ? `<p class="meta"><a href="#" data-m="pw">Forgot password?</a> · <a href="#" data-m="link">Forgot username?</a></p>` : ""}
      <button class="btn ghost" data-m="${mode === "in" ? "up" : "in"}">${mode === "in" ? "Create an account" : "Back to sign in"}</button>`;
    box.querySelectorAll("[data-m]").forEach((b) => (b.onclick = (ev) => { ev.preventDefault(); notice = ""; mode = b.dataset.m; draw(); }));
    box.querySelectorAll("[data-o]").forEach((b) => (b.onclick = async () => {
      const { error } = await sb.auth.signInWithOAuth({ provider: b.dataset.o, options: { redirectTo: here() } });
      if (error) $("#m", box).textContent = error.message;
    }));
    $("#go", box).onclick = async () => {
      const v = (id) => box.querySelector("#" + id)?.value.trim();
      const e = v("e"), p = box.querySelector("#p")?.value, msg = (t) => ($("#m", box).textContent = t);
      if (!e) return msg("Enter your email.");
      if (mode === "pw" || mode === "link") {
        const r = mode === "pw"
          ? await sb.auth.resetPasswordForEmail(e, { redirectTo: here() })
          : await sb.auth.signInWithOtp({ email: e, options: { emailRedirectTo: here(), shouldCreateUser: false } });
        return msg(r.error ? friendly(r.error) : "If that email has an account, a link is on its way.");
      }
      let r;
      if (up) {
        if (!v("n") || (role === "company" && !v("c"))) return msg("Fill in all the fields.");
        if (p.length < 8) return msg("Use a password with at least 8 characters.");
        r = await sb.auth.signUp({ email: e, password: p, options: { emailRedirectTo: here(), data: { role, name: v("n"), company_name: v("c") || null } } });
        if (!r.error && !r.data.session) return msg("Check your email to confirm your account, then sign in.");
      } else r = await sb.auth.signInWithPassword({ email: e, password: p });
      if (r.error) return msg(friendly(r.error));
      close(g); done();
    };
  };
  draw();
}

const WAIVER = 3; // raise this number to make everyone re-accept updated terms
const TERMS = [
  ["What this app does", "Lawn and Snow on the Go is a marketplace that connects customers with independent lawn, landscape and snow removal companies. It does not perform the work, does not employ the crews, and does not supervise, direct or control their work."],
  ["Release of liability", "To the fullest extent permitted by law, I release and hold harmless Lawn and Snow on the Go, its owners, employees and affiliates from all claims, losses and liability, including those caused by negligence, for any damage to property or injury to or death of any person arising from my use of the app or from any services arranged through it."],
  ["Assumption of risk", "I understand that lawn, landscape and snow removal work involves risks, including equipment hazards, slips and falls, vehicle and weather hazards, and damage to lawns, plants, hardscape, vehicles and structures. I accept those risks."],
  ["Fees and subscriptions", "Lawn and Snow on the Go keeps 15% of the total cost of each service as a platform fee. Customers see it included in the price, and the crew receives the other 85%. A subscription repeats the service on the schedule chosen until it is cancelled."],
  ["Indemnity", "I agree to defend and reimburse Lawn and Snow on the Go for any claim, cost or expense, including attorney fees, arising from my use of the app, my conduct, my work or crew, or my breach of this agreement."],
  ["No guarantees", "Prices, estimates, ratings, locations and arrival times shown in the app are informational only and may be wrong. The app is provided as is."],
  ["If part is invalid", "If a court finds part of this agreement unenforceable, the rest stays in effect."],
];
const ROLE_TERM = {
  customer: ["My responsibilities as a customer", "I am responsible for choosing my crew, confirming its licensing, insurance and references, pointing out hidden hazards on my property such as sprinkler heads, drain lines and buried items, and resolving any dispute directly with the crew."],
  company: ["I run an independent business", "I am an independent business, not an employee or agent of Lawn and Snow on the Go. I am solely responsible for my licenses, insurance, taxes, equipment, workers, safety practices and the quality of my work, and for any damage or injury my crew causes."],
};
const waiver = (role, p) => new Promise((res) => {
  const t = [...TERMS]; t.splice(3, 0, ROLE_TERM[role]);
  const g = modal(`<h2>Liability release and user agreement</h2><p class="meta">Read and sign to use Lawn and Snow on the Go. Our <a href="terms.html" target="_blank" rel="noopener">terms of service</a> and <a href="privacy.html" target="_blank" rel="noopener">privacy policy</a> also apply.</p>
    <div class="terms" tabindex="0">${t.map((x) => `<h3>${x[0]}</h3><p>${x[1]}</p>`).join("")}</div>
    <label class="chk"><input type="checkbox" id="k"> I have read this agreement, the terms of service and the privacy policy, and I understand I am giving up legal rights.</label>
    <label>Type your full legal name to sign<input id="s" autocomplete="name"></label><button class="btn" id="go" disabled>Sign and continue</button>`);
  const chk = () => ($("#go", g).disabled = !($("#k", g).checked && $("#s", g).value.trim().length > 2));
  $("#k", g).onchange = $("#s", g).oninput = chk;
  $("#go", g).onclick = async () => {
    const { error } = await sb.from("profiles").update({ waiver_version: WAIVER, waiver_signed_at: new Date().toISOString(), waiver_name: $("#s", g).value.trim() }).eq("id", p.id);
    if (error) return alert(error.message);
    p.waiver_version = WAIVER; p.waiver_signed_at = new Date().toISOString();
    close(g); res();
  };
});

// Entry point for both apps: sign in, sign the agreement, then run start(profile).
const askCompany = () => new Promise((res) => {
  const g = modal(`<h2>One more step</h2><p class="meta">What is your company called?</p><label>Company name<input id="c" autocomplete="organization"></label><p class="meta err" id="m"></p><button class="btn" id="go">Continue</button>`);
  $("#go", g).onclick = () => {
    const v = $("#c", g).value.trim();
    if (!v) return ($("#m", g).textContent = "Enter your company name.");
    close(g); res(v);
  };
});

// Two-step verification (authenticator app). Asks for a code when the account has it turned on.
async function mfaGate() {
  const { data: a } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (!a || a.nextLevel !== "aal2" || a.currentLevel === "aal2") return;
  const f = (await sb.auth.mfa.listFactors()).data?.totp?.[0];
  if (!f) return;
  await new Promise((res) => {
    const g = modal(`<h2>Enter your verification code</h2><p class="meta">Open your authenticator app and enter the 6-digit code.</p><label>Code<input id="c" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></label><p class="meta err" id="m"></p><button class="btn" id="go">Verify</button><button class="btn ghost" id="so">Sign out</button>`);
    $("#so", g).onclick = async () => { await sb.auth.signOut(); location.href = here(); };
    $("#go", g).onclick = async () => {
      const ch = await sb.auth.mfa.challenge({ factorId: f.id });
      const r = ch.error ? ch : await sb.auth.mfa.verify({ factorId: f.id, challengeId: ch.data.id, code: $("#c", g).value.trim() });
      if (r.error) return ($("#m", g).textContent = "That code didn\u2019t work. Try the newest one.");
      close(g); res();
    };
  });
}

async function securityModal() {
  const g = modal(`<h2>Two-step verification</h2><div id="b"><p class="meta">Loading...</p></div><button class="btn ghost" id="x">Close</button>`);
  $("#x", g).onclick = () => close(g);
  const b = $("#b", g), err = `<p class="meta err" id="m"></p>`;
  const f = (await sb.auth.mfa.listFactors()).data?.totp?.[0];
  if (f) {
    b.innerHTML = `<p>Two-step verification is <strong>on</strong>. Signing in asks for a code from your authenticator app.</p>${err}<button class="btn" id="off">Turn off</button>`;
    $("#off", g).onclick = async () => {
      const { error } = await sb.auth.mfa.unenroll({ factorId: f.id });
      if (error) return ($("#m", g).textContent = error.message);
      close(g); securityModal();
    };
    return;
  }
  b.innerHTML = `<p class="meta">Add a second step to your sign-in with an authenticator app such as Google Authenticator, Microsoft Authenticator or Authy.</p>${err}<button class="btn" id="on">Set up</button>`;
  $("#on", g).onclick = async () => {
    const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "Authenticator " + Date.now() });
    if (error) return ($("#m", g).textContent = error.message);
    b.innerHTML = `<p class="meta">Scan this code with your authenticator app, then enter the 6-digit code it shows.</p><img src="${data.totp.qr_code}" alt="QR code for your authenticator app" width="180" height="180"><p class="meta">Can\u2019t scan? Enter this key: <code>${esc(data.totp.secret)}</code></p><label>Code<input id="c" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>${err}<button class="btn" id="v">Turn on</button>`;
    $("#v", g).onclick = async () => {
      const ch = await sb.auth.mfa.challenge({ factorId: data.id });
      const r = ch.error ? ch : await sb.auth.mfa.verify({ factorId: data.id, challengeId: ch.data.id, code: $("#c", g).value.trim() });
      if (r.error) return ($("#m", g).textContent = "That code didn\u2019t work. Try again.");
      close(g); securityModal();
    };
  };
}

export async function boot(role, start, tried = false) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return authScreen(role, () => boot(role, start));
  await mfaGate();
  const { data: p, error } = await sb.from("profiles").select("*").eq("id", session.user.id).single();
  if (error || !p) { await sb.auth.signOut(); return authScreen(role, () => boot(role, start), "We could not load your account. Try again."); }
  // A brand-new account made with Google or Apple has no role yet, so set it from the app being used.
  if (p.role !== role && !p.waiver_version && !tried) {
    const co = role === "company" ? await askCompany() : null;
    await sb.rpc("claim_role", { r: role, company: co });
    return boot(role, start, true);
  }
  if (p.role !== role) {
    await sb.auth.signOut();
    return authScreen(role, () => boot(role, start), `That email belongs to a ${p.role} account. Use the ${p.role} app, or sign up here with another email.`);
  }
  p.email = session.user.email;
  if ((p.waiver_version || 0) < WAIVER) await waiver(role, p);
  $("#who").innerHTML = `<span class="meta">${esc(p.name || p.email)}</span> <button class="btn sm ghost" id="sec">Security</button> <button class="btn sm ghost" id="out">Sign out</button>`;
  $("#sec").onclick = securityModal;
  $("#out").onclick = async () => { await sb.auth.signOut(); location.href = here(); };
  start(p);
}
