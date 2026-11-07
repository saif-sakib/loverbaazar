# Go Live for $0

Follow the steps in order, and finish each **Check** before moving on. It takes 1–2 days, mostly waiting.

Your current WordPress site stays online until Step 11, so nothing customers see changes before then.

Button names on these websites change from time to time. If one doesn't match exactly, look for the closest name. Stuck on an error? See [When something goes wrong](#when-something-goes-wrong).

## The rules that keep it $0

A company can only charge you if it has your card.

1. **Never add a card or PayPal** to Cloudflare, Render, Neon, Cloudinary, Brevo or GitHub.
2. **If a signup demands a card, stop.** Don't enter it. Ask for help instead.
3. **Always choose Free.** Ignore every "Upgrade" button.
4. **Don't use AWS or R2.** Both can bill past their limits.
5. **Turn off auto-renew on your Namecheap hosting** (Step 12). Keep it on for the domain.

The only thing you pay for is the domain renewal, about $10–15 a year.

## Before you start: keep a notes file

You'll collect several secret values. Keep them in a password manager, or in one private note on your computer. **Never put them in this project, in `.env.example`, or in a chat.**

| Name | What it is | You get it in |
|---|---|---|
| Neon pooled string | Database address for the live API | Step 3 |
| Neon direct string | Database address for loading data and backups | Step 3 |
| `ADMIN_TOKEN` | Your live admin password | Step 4 |
| `ORIGIN_SECRET` | Lets the Worker talk to the API | Step 4 |
| Render URL | Your API's address | Step 5 |
| Cloudinary cloud name, API key, API secret | Image storage | Step 6 |
| Backup passphrase | Unlocks your backups. If you lose it, the backups are useless | Step 9 |

On a Linux computer, you can run every command below in a terminal, from the project folder unless a step says otherwise.

## Step 1: Back up the old site

1. Log in to Namecheap, open your hosting, and open **cPanel**.
2. Open **Backup** or **Backup Wizard**, and download a **Full Backup**. If that isn't offered, download the database from **phpMyAdmin** (Export) and the `wp-content` folder from **File Manager** (Compress, then Download).
3. Keep one copy on your computer and one in Google Drive.
4. In cPanel, open **Email Accounts** and write down every mailbox. Download any mail you want to keep.

**Check:** you can open the backup file on your computer, and it isn't empty.

## Step 2: Put the code on GitHub

Your code is already at `github.com/saif-sakib/loverbaazar`, so just confirm these two things:

1. Open the repo on GitHub. It should say **Private** next to its name. If not, go to **Settings → General → Danger Zone → Change visibility**.
2. Send your latest work to GitHub:

       git status
       git add -A
       git commit -m "Prepare for launch"
       git push

**Check:** GitHub shows your latest commit on the `main` branch.

## Step 3: Database (Neon)

1. Go to [neon.com](https://neon.com) and sign up with GitHub or email.
2. Create a project:
   - **Name:** `loverbaazar`
   - **Postgres version:** 17
   - **Region:** Asia Pacific (Singapore)
3. In the project's **Settings → Compute**, set the size to **0.25 CU**, if that option is offered.
4. On the project dashboard, click **Connect**. You'll see a connection string starting with `postgresql://`.
5. Turn **Connection pooling** on and copy the string. Save it as **Neon pooled string**. It contains `-pooler` in its address.
6. Turn **Connection pooling** off and copy the string. Save it as **Neon direct string**.
7. Load your products, categories, pages and blog posts. Use the **direct** string, and keep the single quotes:

       cd apps/api
       DATABASE_URL='PASTE-DIRECT-STRING' go run . seed seed/products.json ../store/src/data/content.json
       cd ../..

   It takes a minute or two and prints nothing when it succeeds.

**Check:** in Neon, open **Tables**. `products` should have 290 rows, and `content` should have rows too.

## Step 4: Make your two secrets

Run this twice:

    openssl rand -hex 32

Save the first result as `ADMIN_TOKEN` and the second as `ORIGIN_SECRET`. Each one is 64 letters and numbers.

- `ADMIN_TOKEN` is your password for the live `/admin/` page.
- Don't use `local-admin-token-for-this-computer-only`. It's public, so the live API refuses to start with it.

## Step 5: API (Render)

1. Go to [render.com](https://render.com) and sign up with GitHub.
2. Click **New +**, then **Web Service**.
3. Connect GitHub if asked, and give Render access to `loverbaazar`. Choose that repo.
4. Fill in the form exactly:

   | Field | Value |
   |---|---|
   | Name | `loverbaazar-api` |
   | Language or Runtime | **Go** |
   | Branch | `main` |
   | Region | **Singapore** |
   | Root Directory | `apps/api` |
   | Build Command | `go build -o app .` |
   | Start Command | `./app` |
   | Instance Type | **Free** |

5. Find **Environment Variables** and add these three. Paste the values with no quotes and no spaces:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | Neon **pooled** string |
   | `ADMIN_TOKEN` | From Step 4 |
   | `ORIGIN_SECRET` | From Step 4 |

6. Open **Advanced**, and set **Health Check Path** to `/api/health`.
7. Click **Deploy Web Service**, and wait for the log to say the service is live. The first build takes a few minutes.
8. Copy the address at the top of the page, such as `https://loverbaazar-api.onrender.com`. Save it as **Render URL**.

Only ever create **one** Render service. The free 750 hours cover one service for a full month.

**Check:** open your Render URL followed by `/api/health` in a browser. It should show `ok`. If the deploy failed, see [Render deploy failed](#render-deploy-failed).

## Step 6: Images (Cloudinary)

Old and new images all go in one Cloudinary folder called `loverbaazar`. Your old site must still be online for this step.

1. Go to [cloudinary.com](https://cloudinary.com), and sign up for the **Free** plan.
2. In the console, open **Settings → API Keys** (or the **Dashboard**). Save the **Cloud name**, **API Key** and **API Secret**.
3. In the terminal, set the three values for this session:

       export CLOUDINARY_CLOUD=your-cloud-name
       export CLOUDINARY_KEY=your-api-key
       export CLOUDINARY_SECRET=your-api-secret

4. Copy the 1,724 old images. This can take an hour, because the old site is slow:

       python3 scripts/images_to_cloudinary.py

5. When it ends, read the last line. If `failed` isn't 0, run the same command again. It skips images already copied. If a few keep failing, check the addresses it prints in a browser. Some may already be broken on the old site.
6. In `apps/store/wrangler.jsonc`, set `IMAGE_BASE`, using your cloud name:

       "IMAGE_BASE": "https://res.cloudinary.com/your-cloud-name/image/upload/f_auto,q_auto/loverbaazar"

   Don't add a slash at the end. This one line moves every old image address, including those inside descriptions and blog posts, and keeps old links working.

7. On Render, open your service, then **Environment**, and add these so admin can upload new photos. Saving restarts the service.

   | Name | Value |
   |---|---|
   | `CLOUDINARY_CLOUD` | Your cloud name |
   | `CLOUDINARY_KEY` | Your API key |
   | `CLOUDINARY_SECRET` | Your API secret |

**Check:** in Cloudinary's **Media Library**, the `loverbaazar` folder has your images. Copy any one image's address into a browser, and it should open.

## Step 7: Store (Cloudflare)

1. Go to [cloudflare.com](https://cloudflare.com), and sign up on the **Free** plan.
2. In `apps/store/wrangler.jsonc`, replace `https://REPLACE-ME.onrender.com` in `API_ORIGIN` with your Render URL. Don't add a slash at the end.
3. Log in to Cloudflare from the terminal. A browser window opens, so click **Allow**:

       cd apps/store
       npm ci
       npx wrangler login

4. Save the Worker's secret. Paste `ORIGIN_SECRET` from Step 4 when it asks. It must match Render exactly:

       npx wrangler secret put ORIGIN_SECRET

5. Deploy once to create the Worker. This first version uses the imported data:

       npx astro build
       npx wrangler deploy

   Wrangler prints an address ending in `workers.dev`. Save it.

6. Build again from the live database, using that address. The API only answers the Worker, so this must be the `workers.dev` address, not the Render URL. It may wait up to a minute for Render to wake:

       CATALOG_URL=https://YOUR-SHOP.workers.dev/api/catalog npx astro build
       npx wrangler deploy
       cd ../..

7. Save your `wrangler.jsonc` change:

       git add apps/store/wrangler.jsonc
       git commit -m "Set API and image addresses"
       git push

**Check:**

1. The `workers.dev` address opens the shop, and images show.
2. `/admin/` on that address accepts your `ADMIN_TOKEN`.
3. Place one test order, find it in admin under **Orders**, then set it to **cancelled**.

## Step 8: Automatic publishing (GitHub)

This makes the **Publish storefront** button in admin work.

**Create the token:**

1. On GitHub, click your photo, then **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Name it `loverbaazar-publish`, and choose the longest expiry offered. Put a reminder in your calendar to renew it.
3. Under **Repository access**, choose **Only select repositories**, then `loverbaazar`.
4. Under **Permissions**, set **Contents** to **Read and write**.
5. Click **Generate token**, and copy it. GitHub only shows it once.

**Add it on Render**, under **Environment**:

| Name | Value |
|---|---|
| `GITHUB_REPO` | `saif-sakib/loverbaazar` |
| `GITHUB_TOKEN` | The token you just made |

**Connect GitHub to Cloudflare:**

1. In Cloudflare, open **My Profile → API Tokens → Create Token**, and use the **Edit Cloudflare Workers** template. Copy the token.
2. Find your **Account ID** under **Workers & Pages**, on the right side.
3. In the GitHub repo, open **Settings → Secrets and variables → Actions**.
4. On the **Secrets** tab, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. On the **Variables** tab, add `CATALOG_URL`, set to your `workers.dev` address followed by `/api/catalog`.

**Check:** in admin, click **Publish storefront**. In the GitHub repo's **Actions** tab, **Publish store** should run and turn green in about 3 minutes.

## Step 9: Backups, email and bot protection

**Nightly backups:**

1. Make up a long passphrase, and save it safely.
2. In GitHub's **Secrets** tab, add `BACKUP_DATABASE_URL` (Neon **direct** string) and `BACKUP_PASSPHRASE`.
3. In the **Actions** tab, open **Nightly backup** and click **Run workflow**.

**Order emails (Brevo):**

1. Sign up at [brevo.com](https://brevo.com) on the **Free** plan.
2. Under **Senders**, add your shop email, and click the link in the email they send.
3. Under **SMTP & API → API Keys**, create a key.
4. On Render, add `BREVO_KEY`, and `SHOP_EMAIL` set to the verified address.

Emails go to the shop only, not to customers.

**Bot protection (Turnstile), required before launch.** Checkout needs no login, so this is what keeps bots from filling your orders.

1. In Cloudflare, open **Turnstile → Add widget**.
2. Add your `workers.dev` address and `loverbaazar.com` as hostnames, and choose **Managed**.
3. On Render, add `TURNSTILE_SECRET` with the **secret key**.
4. In GitHub's **Variables** tab, add `TURNSTILE_SITE` with the **site key**.
5. Click **Publish storefront** in admin.

**Check:**

1. **Nightly backup** turned green.
2. A test order sends you an email.
3. The checkout page shows the Turnstile box, and the order still goes through.

## Step 10: Prepare the shop

In admin:

1. **Settings:** check the delivery charges, then add delivery times, payment numbers, your address, opening hours and return policy.
2. **Products:** enter real stock numbers. Every in-stock product currently shows 100.
3. Click **Publish storefront**.

Then test on a real phone: browse, order, track, cancel.

**Check:** a friend on another phone can place an order, and you can see it.

## Step 11: Switch the domain

Pick a quiet time. **Do the email part first**, or you could lose mail.

1. In Cloudflare, click **Add a site**, enter `loverbaazar.com`, and choose **Free**.
2. Compare the DNS records it imported with your Namecheap ones, especially any **MX** records for email.
3. Note the two Cloudflare nameservers it gives you.
4. In Namecheap, open **Domain List → Manage**. Under **Nameservers**, choose **Custom DNS**, enter the two names, and save. This can take a few hours.
5. Wait for Cloudflare to say the site is **Active**.
6. In Cloudflare, open **Email → Email Routing**, and forward your `loverbaazar@...` addresses to your Gmail. Send a test message.
7. In `apps/store/wrangler.jsonc`, add this line after `"name"`, then commit and push:

       "routes": [{ "pattern": "loverbaazar.com", "custom_domain": true }],

8. In GitHub's **Variables** tab, change `CATALOG_URL` to `https://loverbaazar.com/api/catalog`. Then open **Actions → Publish store → Run workflow**.
9. In Cloudflare, add a **Redirect Rule** from `www.loverbaazar.com` to `loverbaazar.com`.
10. Add a **Rate Limiting Rule** for `/api/login` and `/api/checkout`.
11. In [Google Search Console](https://search.google.com/search-console), submit `https://loverbaazar.com/sitemap-index.xml`.
12. Place a real test order on `loverbaazar.com`.

**Check:** the shop opens with a padlock, images show, an old product address still works, and your test order appears in admin.

**If something is badly wrong:** put the Namecheap nameservers back. The old site returns within a few hours.

## Step 12: After launch

1. Keep the old hosting for 30 days, then **turn off its auto-renew** and let it end.
2. Check Search Console weekly for 404 errors.
3. Check Neon usage monthly. Keep it under 80 CU-hours.
4. Check Cloudinary usage monthly. Stored images, delivered images and resizing share 25 credits a month.
5. Every 3 months, test a backup. In GitHub Actions, download the newest backup, then restore it into a new Neon branch:

       gpg -d backup.dump.gpg > backup.dump
       pg_restore --no-owner -d 'BRANCH-STRING' backup.dump

## When something goes wrong

### Render deploy failed

Open your service on Render, click the failed deploy, and read the end of the log.

| The log says | What it means | Fix |
|---|---|---|
| `STARTUP STOPPED: ADMIN_TOKEN is the public local token` | Render has the local token | Under **Environment**, set `ADMIN_TOKEN` to your own from Step 4 |
| `STARTUP STOPPED: ADMIN_TOKEN is missing...` or `ORIGIN_SECRET is missing...` | The value is missing or too short | Add it from Step 4 |
| `STARTUP STOPPED: DATABASE_URL must be...` | The Neon string is missing, or has quotes around it | Paste the **pooled** string with no quotes |
| `go.mod file not found` or `no Go files` | Wrong folder | Under **Settings**, set Root Directory to `apps/api` |
| `no such file or directory: ./app` | Wrong commands | Set Build to `go build -o app .` and Start to `./app` |
| `HTTP health check failed` | The check can't reach the API | Set Health Check Path to `/api/health` |
| `Exited with status 1` | The real reason is just above this line | Read the lines above it |

After changing a setting, click **Manual Deploy → Deploy latest commit**.

### Other problems

| Problem | Fix |
|---|---|
| The shop opens but checkout shows an error | `ORIGIN_SECRET` must match on Render and in the Worker. Repeat Step 7, part 4 |
| `/admin/` says the token is wrong | Paste `ADMIN_TOKEN` again, with no spaces |
| Orders fail with a database error | Try the Neon **direct** string for `DATABASE_URL` |
| Images are missing | Check `IMAGE_BASE`, then re-run the image script while the old site is online |
| Publish button says "not configured" | Add `GITHUB_REPO` and `GITHUB_TOKEN` on Render |
| Publish store fails on `CATALOG_URL` | Add that variable in GitHub, as in Step 8 |
| Pushes build the site but don't deploy | Add the two Cloudflare secrets from Step 8 |

## What happens at each free limit

| Service | What happens | What you do |
|---|---|---|
| Neon compute | Database stops; checkout shows the phone number | Wait for next month, or reduce use |
| Render hours | Service stops | Wait for next month |
| Worker requests | `/api` pauses; browsing continues | Resets at 06:00 Bangladesh time |
| Cloudinary | Image delivery or uploads may stop, so the shop could show no photos | Delete unused images, or wait for the next month |
| GitHub Actions | Publish and backups stop | Wait for next month |

None of these can bill you without a card.

## Not yet confirmed

- That each signup really needs no card (rule 2 covers this).
- Render's Singapore region on Free, its limits, and whether its terms allow the 10-minute keep-awake ping. If not, remove the cron from `wrangler.jsonc`; checkout will sometimes wait about a minute.
- That the Go API works on Neon's pooled connection. It's only been tested on local Postgres. If orders fail, try the direct string.
- That the Actions workflows run. They haven't been run yet.
- Real speed from Bangladesh.
- That Cloudflare's edge cache works on a `workers.dev` address. It's only been tested locally. If not, `/api/stock` is still correct, and the cache starts working on your own domain.
- The image script and admin uploads on a real Cloudinary account. They've only been tested against a simulated one.

## Before taking online payments

Keep COD and manual bKash, Nagad and Rocket. A payment gateway needs merchant approval and takes a fee per sale, so add it only when the shop is ready.
