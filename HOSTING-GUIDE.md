# Beginner's guide: put Lawn and Snow on the Go online with GitHub

No coding needed. Set aside about 30 minutes for GitHub, plus the Supabase, Stripe and Google setup in the README.

## Words you will see
- **Repository (repo):** a folder of your project that lives on GitHub.
- **Commit:** a saved snapshot of your files.
- **Push:** send your saved files up to GitHub.
- **GitHub Pages:** GitHub's free service that turns your `web` folder into a website.
- **Terminal:** a window where you type commands.

## Checklist
- [ ] GitHub account (github.com, free)
- [ ] Git installed (git-scm.com, accept the defaults) or GitHub Desktop (desktop.github.com)
- [ ] Project unzipped
- [ ] Supabase project made and `supabase/schema.sql` run (README steps 1 to 4)
- [ ] `web/config.js` filled in and saved

## Step 1: Fill in your settings
Open `web/config.js` in Notepad (Windows) or TextEdit in plain-text mode (Mac). Replace each `YOUR-...` value with your own: Supabase URL and anon key, Google Maps key, business name, contact email, mailing address and state. These values are meant to be public. Never paste a Stripe secret key here.

## Step 2: Create the repository on GitHub
1. Sign in to github.com. Click the **+** at the top right, then **New repository**.
2. Name: `lawn-and-snow-on-the-go`.
3. Choose **Public**. Free accounts need this for GitHub Pages.
4. Leave README, .gitignore and license **unchecked**.
5. Click **Create repository**.

## Step 3: Upload the project
### Option A: GitHub Desktop (no terminal)
1. Open GitHub Desktop and sign in.
2. **File > Add local repository**, choose the unzipped project folder. If it says it is not a repository, click **create a repository** there.
3. Type "Initial commit" in the summary box and click **Commit to main**.
4. Click **Publish repository**. Untick "Keep this code private". Name it `lawn-and-snow-on-the-go`. Click **Publish**.

### Option B: Terminal
Open a terminal in the project folder (Windows: right-click the folder > Open in Terminal. Mac: type `cd `, drag the folder into Terminal, press Enter). Run these one at a time:
```
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
git init -b main
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR-USERNAME/lawn-and-snow-on-the-go.git
git push -u origin main
```
If a window asks you to sign in to GitHub, do so.

## Step 4: Turn on GitHub Pages
1. In your repository click **Settings > Pages**.
2. Under "Build and deployment", set **Source** to **GitHub Actions**.
3. Click the **Actions** tab. If the "Deploy site" run has a red X, open it and click **Re-run all jobs**.
4. Wait for a green check (1 to 2 minutes).

## Step 5: Open your site
- Cover page with both sign-ins: `https://YOUR-USERNAME.github.io/lawn-and-snow-on-the-go/`
- Customers: `https://YOUR-USERNAME.github.io/lawn-and-snow-on-the-go/customer.html`
- Crews: `https://YOUR-USERNAME.github.io/lawn-and-snow-on-the-go/company.html`

## Step 6: Tell your other services the address
Use `https://YOUR-USERNAME.github.io/lawn-and-snow-on-the-go` (no slash at the end).
- **Supabase** > Authentication > URL Configuration: set the Site URL to that address and add it followed by `/**` under Redirect URLs.
- **Supabase function setting `SITE_URL`:** the same address (see README step 3).
- **Google Cloud** > your Maps key > allowed websites: `https://YOUR-USERNAME.github.io/*`

## Step 7: Test
Create a customer account, sign the agreement, and make a test request. Use Stripe test mode only: card `4242 4242 4242 4242`, any future date, any code.

## Changing the site later
Edit the file, then in GitHub Desktop commit and click **Push origin**, or in the terminal run:
```
git add .
git commit -m "What you changed"
git push
```
The site updates in a minute or two.

## If something goes wrong
| Problem | Fix |
|---|---|
| 404 page | Settings > Pages > Source must be GitHub Actions, and the latest Actions run must be green |
| Blank page, or sign-in does nothing | `web/config.js` still has placeholders, or the Supabase URL or key is wrong |
| Email links open the wrong page | Recheck the redirect URLs in Step 6 |
| Pages option is greyed out | The repository is private. Make it public in Settings |
| Map does not show | Maps key missing, or the website is not in its allowed list |
| `git push` is rejected | Run `git pull origin main --rebase`, then `git push` |
