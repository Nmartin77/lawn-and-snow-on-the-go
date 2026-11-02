# Lawn and Snow on the Go

Two static web apps (`web/customer.html`, `web/company.html`) on one backend:

| Piece | Service | What it does |
|---|---|---|
| Accounts, password reset, email sign-in links | Supabase Auth | Real accounts that work on any device |
| Database and realtime | Supabase Postgres | Requests, quotes, crew locations, with row-level security |
| Payments | Stripe Connect (Express) | Customer pays, crew gets 85%, you keep 15%. Subscriptions are billed by Stripe |
| Maps | Google Maps JS API | Job pins, address lookup, live crew location |
| Secrets | `supabase/functions/api` | Holds the Stripe keys. The browser never sees them |

## Setup (about an hour)

1. **Supabase.** Create a project. In the SQL editor, run `supabase/schema.sql`. Under Authentication, turn on email confirmation and set the Site URL and redirect URLs to your domain.
2. **Stripe.** Turn on Connect (Express accounts). In Settings > Billing > Customer portal, save the portal settings. Add a webhook endpoint `https://YOUR-PROJECT.supabase.co/functions/v1/api/webhook` for the events `checkout.session.completed`, `invoice.paid` and `customer.subscription.deleted`.
3. **Deploy the function.**
   ```
   supabase link --project-ref YOUR-PROJECT
   supabase functions deploy api --no-verify-jwt
   supabase secrets set STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... SITE_URL=https://YOUR-USERNAME.github.io/lawn-and-snow-on-the-go
   ```
4. **Google Maps.** In Google Cloud, enable Maps JavaScript API and Geocoding API. Restrict the key to your domain.
5. **Configure and host.** Put your Supabase URL, anon key and Maps key in `web/config.js`. Upload the `web` folder to any static host (Netlify, Vercel, Cloudflare Pages, GitHub Pages). No build step.
6. **Test** with Stripe test mode: a crew signs up, completes payout setup, a customer requests, the crew quotes, the customer books with card 4242 4242 4242 4242.

## Location matching (10 miles)
- A customer's request is saved with map coordinates from the address (or the device's current location). The app refuses a request it cannot place on the map.
- Each crew sets a **service area**: a base address and a radius of 1 to 10 miles. Crews only see, and can only quote, open requests inside their area. The database enforces this, not just the page.
- Customers see a "Crews near you" list with names and approximate distances. A crew's exact base location is never shown, and it lives in a table only that crew can read.
- Address lookup uses Google if you add a Maps key, and falls back to OpenStreetMap's free service if not. Re-run `repair.sql` after updating.

## Arrival time and the 2-hour window
After a job is booked, the crew sets an **estimated arrival time** on the active job, or taps **I have arrived**. The customer sees the ETA and the end of a **2-hour window** to finish (from the ETA, or from the moment the crew arrived). If the window passes, both sides see that it was missed. It is information only and does not block the crew from finishing. There are no text or email alerts yet. Redeploy the function and re-run `repair.sql` after updating. Change the window with `WINDOW_HOURS` in the function.

## Photos
Customers can add up to 6 photos to a request, and crews can add up to 6 to each quote. They are stored in the private `quote-photos` bucket (created by `repair.sql`), shrunk in the browser first, and shown only to the people involved. Finished-job photos use a separate `job-photos` bucket.

## How a job and payment work
1. A customer accepts a quote and pays. The job becomes an **active job** for both sides, and other quotes disappear.
2. The money is collected by your Stripe account and **held**. The crew is not paid yet.
3. When the work is done, the crew opens the active job, uploads at least one photo, and clicks **Finish job and get paid**. This starts a **48-hour approval window**.
4. The customer can **approve** (the crew is paid right away) or **report a problem** from the job or the menu. If the customer does nothing for 48 hours, the payment is released automatically. Subscriptions work the same way for every visit.
5. The customer sees the photos on their active or past job.

Notes: re-run `supabase/repair.sql` and redeploy the function after updating. Holding customer funds before paying a crew may carry legal and licensing requirements where you operate, so ask a lawyer or accountant. A **menu button (three lines)** in both apps opens "Refunds and disputes". A problem report holds the payment. You resolve it at `admin.html` by signing in with an account whose email is in the `ADMIN_EMAILS` secret: **Refund customer** returns the money through Stripe, **Pay the crew** releases it.

Extra setup for this:
- Set two more secrets: `supabase secrets set ADMIN_EMAILS=you@example.com CRON_SECRET=a-long-random-string`.
- Automatic release after 48 hours also runs when a crew opens the app. For reliable timing, add the repo secrets `SUPABASE_URL` and `CRON_SECRET` on GitHub. The included workflow `sweep.yml` then runs every 30 minutes.

## Hosting on GitHub
GitHub hosts the two web apps (GitHub Pages). It cannot run server code, so the Supabase function and database stay on Supabase.

1. On github.com, create a new **empty** repository named `lawn-and-snow-on-the-go` (no README). Free accounts need it to be public to use Pages. Nothing secret is in this repo: the Supabase anon key and Maps key are meant to be public, and the Stripe keys live only in Supabase.
2. From this folder:
   ```
   git init -b main
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR-USERNAME/lawn-and-snow-on-the-go.git
   git push -u origin main
   ```
3. In the repo, go to Settings > Pages and set Source to **GitHub Actions**. Every push to `main` now publishes the `web` folder. Your apps will be at:
   - `https://YOUR-USERNAME.github.io/lawn-and-snow-on-the-go/customer.html`
   - `https://YOUR-USERNAME.github.io/lawn-and-snow-on-the-go/company.html`
4. Use that address (with the repo name) as `SITE_URL`, in Supabase's Redirect URLs (add `.../*`), and in the Google Maps key's HTTP referrer list (`https://YOUR-USERNAME.github.io/*`).
5. Optional: to redeploy the Supabase function automatically when it changes, add the repo secrets `SUPABASE_ACCESS_TOKEN` (from supabase.com/dashboard/account/tokens) and `SUPABASE_PROJECT_REF`. Set the Stripe secrets once with `supabase secrets set`, as in the setup steps above.
6. A custom domain (for example `lawnandsnowonthego.com`) can be added in Settings > Pages. After that, update `SITE_URL`, the redirect URLs and the Maps referrer to the new domain.

## Third-party sign-in and two-step verification
Both apps show **Continue with Google** and **Continue with Apple**, and a **Security** button that sets up two-step verification with an authenticator app (Google Authenticator, Authy and similar).

1. **Google.** In Google Cloud > APIs & Services > Credentials, create an OAuth client (Web). Add `https://YOUR-PROJECT.supabase.co/auth/v1/callback` as an authorized redirect URI. In Supabase > Authentication > Providers, turn on Google and paste the client ID and secret.
2. **Apple.** Needs a paid Apple Developer account. Create a Services ID and a sign-in key, then turn on Apple in the same Supabase screen. If you skip Apple, delete the `data-o="apple"` button in `web/common.js`.
3. **Two-step verification.** In Supabase > Authentication > Multi-Factor, make sure TOTP is enabled. It is optional for users. If you want crews to be required to use it, tell me and I will add that.
4. **If you already ran `schema.sql`,** run the new `claim_role` function from the bottom of that file in the SQL editor, and replace the `handle_new_user` function with the updated version so Google names are saved.
5. Add your site URL to Authentication > URL Configuration > Redirect URLs, or the sign-in will not return to your site.

## Before you take real money
- Fill in `BUSINESS_NAME`, `CONTACT_EMAIL` and `MAILING_ADDRESS` in `web/config.js` (they appear in the privacy policy). Have a lawyer review the liability release, the privacy policy (`web/privacy.html`) and the terms of service (`web/terms.html`). Set `GOVERNING_STATE` in `web/config.js` too. Update the policy if you add analytics, text messages, or new providers. Courts in many states will not enforce a release for gross negligence.
- Get business liability insurance, and check what insurance and licenses your crews need.
- Check sales tax rules for lawn and snow services in your state.

## Not included yet
Reviews and ratings, crew verification, a pricing model that uses snowfall depth, admin tools, email or text notifications, and refunds or disputes (handle these in the Stripe dashboard for now).
