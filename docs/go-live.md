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
| Brevo API key | Lets the shop send you order emails | Step 9 |
| Turnstile site key and secret key | Bot protection at checkout | Step 9 |

On a Linux computer, you can run every command below in a terminal, from the project folder unless a step says otherwise.

## Step 1: Back up the old site

1. Log in to Namecheap, open your hosting, and open **cPanel**.
2. Open **Backup** or **Backup Wizard**, and download a **Full Backup**. If that isn't offered, download the database from **phpMyAdmin** (Export) and the `wp-content` folder from **File Manager** (Compress, then Download).
3. Keep one copy on your computer and one in Google Drive.
4. In cPanel, open **Email Accounts** and write down every mailbox. Download any mail you want to keep.

**Check:** you can open the backup file on your computer, and it isn't empty.

## Step 2: Put the code on GitHub

Your code is already at `github.com/saif-sakib/loverbaazar`, so just confirm these two things:

1. Open the repo on GitHub. It can be **Public** or **Private**: both are free and both work. Because a public repo can be read by anyone, never commit a real password or key. To change it, go to **Settings → General → Danger Zone → Change visibility**.
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
   Then open **Settings** and check that **Auto-Deploy** is on. If it's off, new code on GitHub never reaches your live API until you click **Manual Deploy → Deploy latest commit**.
8. Copy the address at the top of the page, such as `https://loverbaazar-api.onrender.com`. Save it as **Render URL**.

Only ever create **one** Render service. The free 750 hours cover one service for a full month.

**Check:** open your Render URL followed by `/api/health` in a browser. It should show `ok`. If the deploy failed, see [Render deploy failed](#render-deploy-failed).

## Step 6: Images (Cloudinary)

All images go in one Cloudinary folder called `loverbaazar`, sorted like `products/rice-cooker/kiam-rice-cooker-1`. Old images move later, in Step 7.

1. Go to [cloudinary.com](https://cloudinary.com), and sign up for the **Free** plan.
2. In the console, open **Settings → API Keys** (or the **Dashboard**). Save the **Cloud name**, **API Key** and **API Secret**.
3. In the terminal, set the three values for this session:

       export CLOUDINARY_CLOUD=your-cloud-name
       export CLOUDINARY_KEY=your-api-key
       export CLOUDINARY_SECRET=your-api-secret

4. On Render, open your service, then **Environment**, and add these so admin can upload new photos. Saving restarts the service.

   | Name | Value |
   |---|---|
   | `CLOUDINARY_CLOUD` | Your cloud name |
   | `CLOUDINARY_KEY` | Your API key |
   | `CLOUDINARY_SECRET` | Your API secret |

**Check:** Render restarts, and `/api/health` still shows `ok`.

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

7. Move the old images while your old site is online. It copies only images the shop uses, gives them clear names, and updates every address. It's safe to re-run until it says `failed: 0`:

       export SHOP=https://YOUR-SHOP.workers.dev ADMIN_TOKEN=... CLOUDINARY_CLOUD=... CLOUDINARY_KEY=... CLOUDINARY_SECRET=...
       python3 scripts/images_to_cloudinary.py

8. Save your `wrangler.jsonc` change:

       git add apps/store/wrangler.jsonc
       git commit -m "Set API and image addresses"
       git push

**Check:**

1. The `workers.dev` address opens the shop, and images show.
2. `/admin/` on that address accepts your `ADMIN_TOKEN`.
3. Place one test order, find it in admin under **Orders**, then set it to **cancelled**.

## Step 8: Automatic publishing (GitHub)

This makes the **Publish** buttons in admin work.

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

**Check:** in admin, click **Publish now** at the bottom of the left menu. In the GitHub repo's **Actions** tab, **Publish store** should start within a few seconds and turn green in about 3 minutes.

## Step 9: Backups, order emails and bot protection

Do these three parts in order. Every value here is secret except the Turnstile site key.

### Part A: Nightly backups

1. Make up a long passphrase, at least 5 random words, and save it in your notes file.
2. In the GitHub repo, open **Settings → Secrets and variables → Actions**. On the **Secrets** tab, add:

   | Name | Value |
   |---|---|
   | `BACKUP_DATABASE_URL` | Neon **direct** string, the one without `-pooler` |
   | `BACKUP_PASSPHRASE` | Your passphrase |

3. Open the **Actions** tab, click **Nightly backup** in the left list, then **Run workflow → Run workflow**.
4. Wait about a minute, then refresh.

**Check:** the run has a green tick. After that it runs by itself at 02:00 Bangladesh time. Each backup is encrypted, so it's safe even if the repo is public, as long as your passphrase is strong.

### Part B: Order emails (Brevo)

Brevo emails **you** whenever an order or a contact message arrives. Customers get nothing from it. It's optional: the shop works without it, and every order is always in admin.

The menus below come from Brevo's help pages. If a name doesn't match exactly, look for the closest one.

**1. Create the account**

1. Go to [brevo.com](https://brevo.com), and click **Sign up free**.
2. Use the email address you want order emails sent to, such as your shop Gmail.
3. Open the confirmation email from Brevo, and click the link.
4. Fill in the short profile form. Use `LoverBaazar` as the company name. If it asks about a plan, choose **Free**. If it asks for a card, stop (see the rules at the top).

The Free plan allows 300 emails a day, far more than this shop needs.

**2. Confirm your sender address**

1. Click your account name at the top right, then **Senders, Domains & Dedicated IPs**, then the **Senders** tab.
2. Click **Add sender**.
3. Enter `LoverBaazar` as the name, and the same email address you signed up with.
4. Brevo sends a code or link to that address. Open it to confirm.

**Check:** the sender shows as verified.

If you use a Gmail address, Brevo may send from an address ending in `@brevosend.com` instead. That's normal, because Gmail addresses can't be authenticated. The email still reaches you.

**3. Create the API key**

1. Open the same account menu, then **SMTP & API**.
2. Open the **API Keys** tab, not the SMTP tab.
3. Click **Generate a new API key**, and name it `loverbaazar-shop`.
4. Copy the key straight away, and save it in your notes file. Brevo only shows it once.

**Check:** the key starts with `xkeysib-`. If it starts with `xsmtpsib-`, that's an SMTP key and it won't work.

**4. Stop Brevo blocking Render**

Render's free plan has no fixed address, and Brevo can reject calls from addresses it doesn't know.

1. Open the account menu, then **Settings → Security → Authorized IPs**.
2. Turn off the option that blocks unknown IP addresses.

If you can't find it, carry on. If the test below fails with `401`, come back here, or click the link in any security email Brevo sends you.

**5. Give the key to the shop**

1. On Render, open `loverbaazar-api`, then **Environment**.
2. Add these two, with no quotes and no spaces:

   | Name | Value |
   |---|---|
   | `BREVO_KEY` | The key from part 3 |
   | `SHOP_EMAIL` | The sender address you confirmed in part 2, exactly |

3. Click **Save, rebuild, and deploy**, and wait for the log to say the service is live.

**6. Test it**

1. Open your shop's **Contact** page, and send yourself a short message.
2. Wait 2 minutes, and look in your inbox and your Spam folder.
3. If it's in Spam, open it and click **Not spam**. Do this once and later ones should arrive normally.

**Check:** the message arrives. If it doesn't, on Render open **Logs**, and find what's printed just after you sent it:

| Render log | What it means | Fix |
|---|---|---|
| Nothing about Brevo | `BREVO_KEY` or `SHOP_EMAIL` is missing | Add both, then redeploy |
| `brevo: status 401: ...` | The key is wrong, or Brevo blocked Render. The end of the line says which | Paste the `xkeysib-` key again, and repeat part 4 |
| `brevo: status 400: ...` | `SHOP_EMAIL` isn't your verified sender | Make them match exactly |

### Part C: Bot protection (Turnstile)

**Required before launch.** Checkout needs no login, so this is what stops bots filling your orders.

**Follow this order exactly.** If the secret reaches Render before the box is on the shop, every order fails with "bot check failed".

1. Open [Turnstile in Cloudflare](https://dash.cloudflare.com/?to=/:account/turnstile), and click **Add widget**.
2. Fill it in. The next point covers **Hostname Management**.

   | Field | Value |
   |---|---|
   | Widget name | `LoverBaazar checkout` |
   | Widget mode | **Managed** |
   | Pre-clearance | **No** |

3. Under **Hostname Management**, click **Add Hostnames**, then add your two addresses one at a time:

   1. Type `loverbaazar.loverbaazar.workers.dev`, with no `https://` and no `/` at the end.
   2. Wait for the spinner to stop. **"No results" is normal.** That list only searches domains already on your Cloudflare account, and neither address is yet.
   3. Click **Add "loverbaazar.loverbaazar.workers.dev" as a custom hostname** just below it. If you only press Enter, the box clears and nothing is added. On a keyboard, press the Down arrow first, then Enter.
   4. Do the same for `loverbaazar.com`. It also covers `www.loverbaazar.com`, so don't add that one.
   5. Click **Add**, and check that both addresses are listed.

4. Scroll to the bottom, and click **Create**. Save the **Site key** and the **Secret key**.
5. In GitHub, open **Settings → Secrets and variables → Actions**. On the **Variables** tab, add `TURNSTILE_SITE` with the **site key**.
6. In admin, click **Publish now**, and wait for **Publish store** to turn green in the **Actions** tab.
7. Put an item in your cart, open checkout, and confirm the Turnstile box appears.
8. Only now, on Render, add `TURNSTILE_SECRET` with the **secret key**. Click **Save, rebuild, and deploy**.

**Check:** place a test order. It should go through, then set it to **Cancelled** in admin.

If it fails, the box or Render's **Logs** tell you why:

| What you see | What it means | Fix |
|---|---|---|
| The box shows error `110200` | That address isn't on the widget | Add it under **Hostname Management**, then wait a few minutes |
| No box on checkout | `TURNSTILE_SITE` is missing, or Publish hasn't finished | Repeat points 5 and 6 |
| `turnstile: refused [invalid-input-secret]` | The secret key on Render is wrong | Paste it again from the widget's page |
| `turnstile: refused [invalid-input-response]` | The site key and secret key come from different widgets | Use both from the same widget |
| `turnstile: refused [timeout-or-duplicate]` | The customer waited too long, or pressed twice | Nothing to fix. They can press **Place order** again |

## Step 10: Prepare the shop

Open `/admin/`. Your changes appear for customers after you click **Publish changes** in the yellow bar, unless the page says they're live.

1. **Settings → Delivery and payment:** check each charge (0 means free), add delivery times, and check every payment number. Send yourself ৳10 to prove each number is right.
2. **Settings → Shop details:** check your phone, WhatsApp, address and email. Add opening hours and your return policy.
3. **Products:** enter real stock numbers. Most in-stock products still show the imported figure of 100. These save by themselves.
4. **Website → Pages:** read Terms & Conditions and Privacy Policy carefully. They're your legal promises to customers.
5. **Publish changes.**

Then, on a real phone: browse, order, track the order, and cancel it.

**Check:** a friend on another phone can place an order, and you can see it in admin.

## Step 11: Switch the domain

This moves `loverbaazar.com` from your old site to the new shop. Pick a quiet time, late at night, and allow 2 to 3 hours of waiting. Customers see the old site until part 3, and that part only takes about 5 minutes.

**Don't start until Steps 9 and 10 pass.**

### Part 1: Move the domain to Cloudflare

Nothing changes for customers yet.

1. In Cloudflare, click **Add a domain**, enter `loverbaazar.com`, and choose the **Free** plan.
2. Cloudflare imports your DNS records. Open cPanel's **Zone Editor** beside it, and compare the two lists, especially **MX** and **TXT** records. Add anything that's missing. These control your email.
3. Cloudflare shows two nameservers. Write them down.
4. In Namecheap, open **Domain List → Manage**. Under **Nameservers**, choose **Custom DNS**, enter the two names, and tick to save.
5. Wait for Cloudflare's email saying the domain is **Active**. It usually takes under an hour, and can take a few.

**Check:** `loverbaazar.com` still opens the old site, and an email sent to your domain still arrives.

### Part 2: Move your email, if you use it

Skip this if nobody uses an `@loverbaazar.com` address.

Your old mailboxes stop working when the hosting ends in Step 12, so forward them to Gmail:

1. Check that you downloaded any mail you want to keep (Step 1).
2. In Cloudflare, open **Email → Email Routing**, then **Get started**.
3. Enter the address, such as `info@loverbaazar.com`, and your Gmail address. Confirm the email Cloudflare sends to Gmail.
4. Click **Add records and enable**.

**Check:** send a test message to that address from a different account. It should reach Gmail.

### Part 3: Point the domain at the new shop

The shop is unavailable for a few minutes here, so have everything ready first.

1. In `apps/store/wrangler.jsonc`, add this line after `"name"`, then save and commit, but **don't push yet**:

       "routes": [{ "pattern": "loverbaazar.com", "custom_domain": true }],

       git add apps/store/wrangler.jsonc
       git commit -m "Serve the shop on loverbaazar.com"

2. In Cloudflare, open **DNS → Records** for your domain. Delete the **A** record, and any **CNAME** record, named `loverbaazar.com` or `@`. Leave **MX** and **TXT** records alone. The new address can't be set up while the old one exists.
3. Straight away, push:

       git push

4. In the GitHub repo's **Actions** tab, wait for **Publish store** to turn green, about 3 minutes.
5. Open `https://loverbaazar.com`. You may need a private browser window.

**Check:** the new shop opens with a padlock.

### Part 4: Finish up

1. **Tell the shop its new address.** In GitHub, on the **Variables** tab, change `CATALOG_URL` to `https://loverbaazar.com/api/catalog`. Then open **Actions → Publish store → Run workflow**.
2. **Make www work.** In Cloudflare **DNS → Records**, add a **CNAME** with name `www`, target `loverbaazar.com`, and the orange cloud on. Then open **Rules**, and create a redirect from `www.loverbaazar.com` to `loverbaazar.com` using the **Redirect from WWW to root** template.
3. **Add a rate limit.** Open **Security → WAF → Rate limiting rules**, and create one rule. Set it to match when the URI path contains `/api/login` or `/api/checkout`, allow 20 requests per 10 seconds, and block after that. Keep it generous, because many customers in Bangladesh share one mobile address.
4. **Tell Google.** In [Google Search Console](https://search.google.com/search-console), add `loverbaazar.com` as a **Domain** property, and follow its steps to prove you own it. Then open **Sitemaps**, and submit `https://loverbaazar.com/sitemap-index.xml`.
5. **Place a real test order** on `loverbaazar.com`, then cancel it.

**Check:** images show, an old product address still works, `www.loverbaazar.com` lands on the shop, the Turnstile box shows, and your test order appears in admin.

**If something is badly wrong:** in Namecheap, put the nameservers back to **Namecheap BasicDNS** or your hosting's nameservers. The old site returns within a few hours.

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
| Images are missing | Re-run the image script while the old site is online |
| New code on GitHub isn't live | On Render, click **Manual Deploy → Deploy latest commit**, then **Publish now** in admin. Check **Auto-Deploy** is on |
| A delivery charge, page or blog change doesn't show | Click **Publish now** in admin. Render must finish deploying first |
| Every order says "bot check failed" | Remove `TURNSTILE_SECRET` from Render, then redo Step 9 Part C in order |
| `wrangler` says the domain already has DNS records | Delete the A and CNAME records for `loverbaazar.com`, as in Step 11 Part 3 |
| Publish button says "not configured" | Add `GITHUB_REPO` and `GITHUB_TOKEN` on Render |
| Publish store fails on `CATALOG_URL` | Add that variable in GitHub, as in Step 8 |
| Pushes build the site but don't deploy | Add the two Cloudflare secrets from Step 8 |

### Changing the database password

Do this if the password may ever have been seen by anyone else.

1. In Neon, open **Roles**, find your role, and click **Reset password**.
2. On Neon's **Connect** screen, copy both new strings, pooled and direct.
3. On Render, update `DATABASE_URL` with the **pooled** string, then deploy.
4. In GitHub's **Secrets** tab, update `BACKUP_DATABASE_URL` with the **direct** string.
5. Update your notes file. Run **Nightly backup** once to prove it still works.

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
- Real speed from Bangladesh.
- That Cloudflare's edge cache works on a `workers.dev` address. It's only been tested locally. If not, `/api/stock` is still correct, and the cache starts working on your own domain.
- Admin photo uploads from Render itself. They've been tested against the real Cloudinary account, but from a computer.
- Brevo's exact menu names. Its help site couldn't be read directly when this was written.

## Before taking online payments

Keep COD and manual bKash, Nagad and Rocket. A payment gateway needs merchant approval and takes a fee per sale, so add it only when the shop is ready.
