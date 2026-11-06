# Go Live for $0

Follow in order. About 1–2 days, mostly waiting. Your current site stays live until Step 9.

## The rules that make $0 safe

A company can only charge you if it has your card.

1. **Never add a card or PayPal** to Cloudflare, Render, Neon, Cloudinary, Brevo or GitHub.
2. **If a signup demands a card, stop.** Don't enter it. Ask for an alternative.
3. **Always choose Free.** Ignore every "upgrade" button.
4. **Don't use AWS or R2.** Both bill past their limits.
5. **Turn off auto-renew on your Namecheap hosting** (Step 10). Keep it on for the domain.

The only thing you pay for is the domain renewal, about $10–15 a year.

## Step 1: Back up everything

1. Log in to Namecheap cPanel.
2. Download a **Full Backup**, or at least the database from phpMyAdmin and the `wp-content` folder.
3. Keep copies on your computer and in Google Drive.
4. In cPanel Email Accounts, write down every mailbox. Download any mail you need.

## Step 2: Put the code on GitHub

Create a **private** repo called `loverbaazar`, then:

    git init -b main && git add . && git commit -m "LoverBaazar store"
    git remote add origin https://github.com/YOUR-NAME/loverbaazar.git
    git push -u origin main

## Step 3: Database (Neon)

1. Sign up at neon.com and create a project: **Postgres 17, Singapore**.
2. Limit compute to **0.25 CU**.
3. Copy two connection strings: **pooled** and **direct**.
4. Load the products, using the **direct** string:

       cd apps/api
       DATABASE_URL='DIRECT-STRING' go run . seed seed/products.json

## Step 4: API (Render)

1. Sign up at render.com and create a **Web Service** from your repo.
2. Set: Root Directory `apps/api`, Runtime **Go**, Build `go build -o app .`, Start `./app`, Region **Singapore**, Plan **Free**.
3. Add these variables:

| Name | Value |
|---|---|
| `DATABASE_URL` | Neon **pooled** string |
| `ADMIN_TOKEN` | Output of `openssl rand -hex 32`. Save it |
| `ORIGIN_SECRET` | Output of `openssl rand -hex 32`. Save it |
| `SHIP_DHAKA`, `SHIP_OUTSIDE` | Your real delivery charges |

4. Deploy and copy the service URL.

Only ever create **one** Render service. The free 750 hours cover one service for a full month.

## Step 5: Store (Cloudflare)

1. Sign up at cloudflare.com. Choose Free.
2. Put the Render URL in `API_ORIGIN` in `apps/store/wrangler.jsonc`.
3. Deploy:

       cd apps/store
       npm i
       npx wrangler login
       npx wrangler secret put ORIGIN_SECRET
       npx astro build
       npx wrangler deploy

4. Open the `workers.dev` link it prints.

**Check:** the shop opens, and `/admin/` accepts your `ADMIN_TOKEN`. Place one test order, see it in admin, then cancel it.

## Step 6: Images

Run this from the project folder. It's slow because the old site is slow, and it's safe to re-run:

    python3 scripts/mirror_images.py

When it says `failures: 0`, commit and push. Images keep their same URLs and become free static files.

## Step 7: Admin extras

**Cloudinary** (new product photos): sign up, then add `CLOUDINARY_CLOUD`, `CLOUDINARY_KEY` and `CLOUDINARY_SECRET` on Render.

**Publish button:** on GitHub, create a fine-grained token for this repo with **Contents: Read and write**. Add `GITHUB_REPO` (`YOUR-NAME/loverbaazar`) and `GITHUB_TOKEN` on Render.

**GitHub Actions secrets** (repo Settings → Secrets and variables → Actions → **Secrets** tab). Until the two Cloudflare ones exist, pushes build the site but skip deploying:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages, right sidebar |
| `BACKUP_DATABASE_URL` | Neon **direct** string |
| `BACKUP_PASSPHRASE` | A long password. Save it safely |

**GitHub Actions variables:** `SHIP_DHAKA`, `SHIP_OUTSIDE`, `TURNSTILE_SITE`, and `CATALOG_URL` = your `workers.dev` link + `/api/catalog`.

Run **Nightly backup** by hand once and confirm it succeeds.

**Order alerts (Brevo):** sign up, verify your sender, then add `BREVO_KEY` and `SHOP_EMAIL` on Render. Emails go to the shop only, not to customers.

**Bot protection (Turnstile):** in Cloudflare, create a widget. Add `TURNSTILE_SECRET` on Render.

## Step 8: Prepare the shop

In admin, enter real stock numbers. Every in-stock product currently shows 100. Then test on a real phone: browse, order, track, cancel.

## Step 9: Switch the domain

Pick a quiet time. **Do the email part first.**

1. In Cloudflare, **Add a site** for `loverbaazar.com` on the Free plan. Check the imported DNS records.
2. Note the two Cloudflare nameservers.
3. In Namecheap, under Domain, change Nameservers to **Custom DNS** and enter them. This can take a few hours.
4. When Cloudflare says Active, open **Email Routing** and forward `loverbaazar@...` addresses to your Gmail. Test it.
5. Add this line to `apps/store/wrangler.jsonc`, after `"name"`, then push:

       "routes": [{ "pattern": "loverbaazar.com", "custom_domain": true }],

6. Set the GitHub variable `CATALOG_URL` to `https://loverbaazar.com/api/catalog`, and run **Publish store**.
7. Add a Cloudflare redirect rule from `www` to the main domain.
8. Add one rate limit rule for `/api/login` and `/api/checkout`.
9. In Search Console, submit `https://loverbaazar.com/sitemap-index.xml`.
10. Place a real test order.

**If something is badly wrong:** put the Namecheap nameservers back. The old site returns within a few hours.

## Step 10: After launch

1. Keep the old hosting for 30 days, then **turn off its auto-renew** and let it end.
2. Check Search Console weekly for 404 errors.
3. Check Neon usage monthly. Keep it under 80 CU-hours.
4. Every 3 months, test restoring a backup into a new Neon branch:

       gpg -d backup.dump.gpg > backup.dump
       pg_restore --no-owner -d 'BRANCH-STRING' backup.dump

## What happens at each limit

| Service | What happens | What you do |
|---|---|---|
| Neon compute | Database stops; checkout shows the phone number | Wait for next month, or reduce use |
| Render hours | Service stops | Wait for next month |
| Worker requests | `/api` pauses; browsing continues | Resets at 06:00 Bangladesh time |
| Cloudinary | New images may stop | Delete unused ones |
| GitHub Actions | Publish and backups stop | Wait for next month |

None of these can bill you without a card.

## Not yet confirmed

- That each signup really needs no card (rule 2 covers this).
- Render's Singapore region on Free, its limits, and whether its terms allow the 10-minute keep-awake ping. If not, remove the cron; checkout will sometimes wait about a minute.
- That the Go API works on Neon's pooled connection. It's only been tested on local Postgres. If orders fail, try the direct string.
- That the Actions workflows run. They haven't been run yet.
- Real speed from Bangladesh.

## Before taking online payments

Keep COD and manual bKash, Nagad and Rocket. A payment gateway needs merchant approval and takes a fee per sale, so add it only when the shop is ready.
