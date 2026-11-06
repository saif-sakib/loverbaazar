# LoverBaazar Rebuild Plan (Final, Zero-Cost)

Replace the WordPress/WooCommerce store at loverbaazar.com with the stack that is best for the shop, runs at $0 on free tiers (a card on file is fine), and moves to a VPS or AWS later without a rewrite.

Chosen for the shop alone, not for any team's skills or size. Checked 7 November 2026; re-check limits before launch.

---

## 1. Final stack

| Layer | Choice | Free allowance |
|---|---|---|
| Storefront | **Astro** static pages on **Cloudflare** | Unlimited static requests |
| CDN, DNS, WAF, bot check | **Cloudflare**, Turnstile | Free plan |
| API | **Go** (chi, pgx, sqlc), same binary runs in Docker | Runs on the host below |
| API hosting | **AWS Lambda**, Singapore, arm64 | 1M requests, 400,000 GB-seconds/month |
| API routing | Thin **Cloudflare Worker** for `/api/*` | 100,000 requests/day |
| Database | **PostgreSQL on Neon**, Singapore | 100 CU-hours, 1 GB |
| Images, stock file, backups | **Cloudflare R2** | 10 GB, 1M writes, 10M reads/month, free bandwidth |
| Admin | **React** static app behind **Cloudflare Access** | Free plan |
| Order email | **Brevo** | 300 emails/day |
| Receiving email | **Cloudflare Email Routing** to Gmail | Free |
| Monitoring | **UptimeRobot, Sentry** | Free plans |
| Code | **Private GitHub repo, Actions** | 2,000 minutes/month |

**Expected bill: $0, plus the domain renewal** (about $10–15 a year). Cash on Delivery has no gateway fee. A card stays on file for AWS and R2, and section 4 keeps the bill at zero.

---

## 2. Why this is best for the shop

- **Static storefront:** browsing is the fastest it can be, has no quota, and stays up if the API or database fails.
- **PostgreSQL:** orders, stock and payments are relational and need real transactions. It's also the part you never want to migrate away from, and it runs everywhere: Neon, a VPS, AWS RDS.
- **Go:** it suits small free servers best. Measured on the same laptop against FastAPI and Django: 14 ms cold start vs 750–930 ms, 12 MB memory vs 53–80 MB, and about 6–16× the throughput. That also means a smaller VPS and lower AWS bills later. A single small binary in Docker moves anywhere.
- **Not Node, Java, C#, Rust, Django, FastAPI, MongoDB:** all could work. None beats Go + Postgres on this mix of free-host fit, running cost and portability. Django's built-in admin is its one real advantage, but a shop still needs custom order, courier and invoice screens.
- **No microservices:** one modular application (`catalog`, `orders`, `inventory`, `customers`, `payments`, `shipping`).

### Rejected free options

| Option | Why not |
|---|---|
| **Vercel Hobby** | Its terms say Hobby is for non-commercial personal use only, and a shop is commercial. It also adds nothing here: Cloudflare gives unlimited static traffic. Vercel Pro is $20/month, which breaks the $0 rule |
| Render Free | Sleeps after 15 idle minutes, takes about a minute to wake, and Render says not to use it for production |
| Supabase Free | Pauses after 1 week of inactivity |
| Cloudflare D1 | 10 GB limit and SQLite, so a forced migration later |

---

## 3. Architecture

```
              Customer
                 │
        Cloudflare CDN + WAF
     ┌───────────┼──────────────┐
     ▼           ▼              ▼
 Static Astro   /api/* Worker   images + stock.json
 pages, cart    (secret header) (R2 + CDN cache)
 in browser      │                ▲
                 ▼                │ writes on change
         AWS Lambda: Go API ──────┘
                 │
         Neon Postgres (Singapore)

 admin.loverbaazar.com ── Cloudflare Access ── same Go API
 GitHub Actions ── nightly encrypted backup ── R2
```

**Browsing never touches the API or database.** Go writes a small `stock.json` to R2 when a price or stock level changes, and browsers read it from the CDN with a 60-second cache. Only checkout, tracking and admin reach Lambda, so Neon sleeps the rest of the time.

**Checkout:** the browser sends only product IDs and quantities. In one transaction, Go reads real prices, creates the order and reduces stock with `SET stock = stock - $1 WHERE stock >= $1`, which prevents overselling.

**When things break:**

| Failure | What customers see |
|---|---|
| API or Neon down | Browsing and cart still work; checkout shows your phone and WhatsApp number |
| Idle store | First checkout after a quiet spell may take about a second while Lambda and Neon wake |
| Neon compute used up | Same as API down, until the 1st of next month |
| Bad deploy | Roll back in seconds |
| Cloudflare outage | Site down; accepted at $0 |

---

## 4. Rules that keep the bill at $0

AWS and R2 bill past the free allowance rather than stopping, so set these up **before** launch:

1. **AWS Budget alert at $1**, and Lambda **reserved concurrency** set low so bots can't run up usage.
2. **Upgrade the AWS account to the Paid plan.** The Free plan closes after 6 months; Lambda's free allowance continues on Paid.
3. **Lambda checks the Worker's secret header** and rejects everything else. Cloudflare rate limits cover `/api/checkout`.
4. **R2 Standard storage only.** Infrequent Access isn't in the free tier. Serve images through the CDN cache.
5. **Database pool can empty:** `MinConns=0`, `MaxConns` 1–2, Neon's pooled connection string. A pinned-awake database uses 182 CU-hours, not 100.
6. **Limit Neon to 0.25 CU** and alert at 80 CU-hours. Neon stops at its limit and doesn't bill you.
7. **Background jobs run daily, not hourly.** Each one wakes the database.
8. **Point uptime checks at a static page,** so they don't use Lambda or wake Neon.
9. **Build static pages on Cloudflare,** using its 3,000 free build minutes.
10. **Back up every night.** Neon Free keeps only 6 hours of history. Send encrypted dumps to R2, and test a restore every 3 months.

---

## 5. Security

- No WordPress, PHP or plugins left to attack.
- Admin sits behind Cloudflare Access, and Go also verifies the Access token on every request.
- Server computes all totals; browser prices are ignored.
- sqlc parameterised queries; strict input validation; Content-Security-Policy header.
- Turnstile on checkout, rate limits by IP and phone.
- Random order tokens; tracking needs order number and phone.
- Secrets live in host settings, never in Git. No card data touches your server.

---

## 6. Build phases

Rough total: **6–8 weeks part time.**

**Phase 0: Protect (1–2 days)**
- [ ] Full backup of database and `wp-content`, in two places
- [ ] Create read-only WooCommerce API keys
- [ ] Export Search Console top pages
- [ ] List the mailboxes on the hosting

**Phase 1: Foundations (3–4 days)**
- [ ] Private repo, CI, secret scanning
- [ ] Create AWS, Neon, Cloudflare and Brevo accounts; set the Budget alert first
- [ ] Deploy Go to Lambda through the Worker, connect Neon
- [ ] Measure cold-start speed from Bangladesh. If it fails, use Fly.io ($2.19/month) or Render
- [ ] Nightly backup and one test restore

**Phase 2: Migrate data (2–3 days)**
- [ ] Re-runnable script for 290 products, 62 categories, 280 tags, customers, orders
- [ ] Keep every slug; copy Rank Math SEO fields
- [ ] Convert 1,087 media files to AVIF and WebP, upload to R2
- [ ] Store money as whole taka in BIGINT (all current prices are whole taka)

**Phase 3: Storefront (1–2 weeks)**
- [ ] Home, category, product, tag, cart, static pages, Pagefind search
- [ ] Sitemaps, structured data, `stock.json` island
- [ ] Target: under 50 KB JavaScript, Lighthouse mobile 95+

**Phase 4: Checkout (1 week)**
- [ ] COD with shipping rules
- [ ] Manual bKash, Nagad and Rocket with transaction ID, verified by admin
- [ ] Turnstile, confirmation email, order tracking, "call us" fallback

**Phase 5: Admin (1–2 weeks)**
- [ ] Cloudflare Access with token verification in Go
- [ ] Products, images, orders, invoices, dashboard, publish button
- [ ] Works well on a phone

**Phase 6: Staging tests (3–5 days)**
- [ ] Real phones on slow data
- [ ] 20 buyers racing for the last item
- [ ] Practise a restore
- [ ] Every old sitemap URL returns 200 or a correct 301

**Phase 7: Cutover (1 day)**
- [ ] **Move email first.** Cancelling hosting deletes your mailboxes
- [ ] Copy DNS to Cloudflare, lower TTLs a day ahead
- [ ] Pause orders, re-run the migration
- [ ] Point Namecheap nameservers to Cloudflare; keep the domain at Namecheap
- [ ] Place a live test order, submit the sitemap

**Phase 8: After launch (30 days)**
- [ ] Keep the old hosting for 30 days
- [ ] Watch Search Console for 404s, and watch CU-hours and errors

### Keep these URLs exactly

`/product/{slug}/`, `/product-category/{parent}/{child}/`, `/product-tag/{slug}/`, all posts and pages with trailing slashes, and the sitemap.

### Replacing plugins

| Today | New |
|---|---|
| WooCommerce | Go API, Postgres, admin |
| YITH Wishlist | Browser storage |
| Easy Login | Guest checkout, optional accounts |
| Contact Form 7, Akismet | Form with Turnstile, sent through Brevo |
| Rank Math | SEO fields, sitemaps, structured data |
| Jetpack, Site Kit | Cloudflare Web Analytics, GA4, Search Console |
| Facebook and Google sync | Product feed built at deploy, Meta Pixel |

---

## 7. Moving to a VPS or AWS later

Stay free until one of these is true for a week: Neon over 80 CU-hours or 0.8 GB, Lambda past its free requests, or checkout feels slow. The code doesn't change at any step.

| Step | Move | Cost (estimate) |
|---|---|---|
| 1 | Neon Launch plan (no base fee, 7-day restore) | $5–20/month |
| 2 | Go API from Lambda to one **Singapore VPS** with Docker and Caddy, once steady traffic makes it cheaper. Keep Neon; don't run Postgres on the VPS | $10–25/month |
| 3 | **AWS:** ECS Fargate, RDS or Aurora, S3 + CloudFront, SQS | $300+/month |

**Keep this easy from day one:**
- Docker image for the API; all config in environment variables
- Standard Postgres, with migrations in Git
- API is stateless, with the same binary on Lambda, a VPS or ECS
- Images on your own subdomain, so they can move to S3 with no URL changes
- Background work in a Postgres outbox table

---

## 8. Risks

| Risk | Plan |
|---|---|
| Unexpected AWS or R2 bill | Budget alert, reserved concurrency, rate limits. Overage is small: $0.20 per million Lambda requests |
| Lambda with Neon pooling misbehaves | Proved in Phase 1, with Fly.io as fallback |
| Google rankings drop | Same URLs and metadata, daily monitoring |
| Admin takes longer than planned | Ship the smallest version first |
| Free tiers change | Standard Postgres and Docker, so you can move in days |

---

## 9. Not verified

- Whether your card works on AWS and Cloudflare
- Cloudflare Access, Turnstile and WAF free features (general knowledge)
- Brevo limit (from an existing project's docs, not an official page today)
- pgx and sqlc on Neon's pooled connection; Phase 1 tests it
- Real speed from Bangladesh, and your real traffic (check Site Kit)
- Go, FastAPI and Django figures are laptop tests without a database
- Migration costs are rough estimates

## Sources

[Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [Static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) · [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/) · [R2 pricing](https://developers.cloudflare.com/r2/pricing/) · [Render free services](https://render.com/docs/free) · [Neon plans](https://neon.com/docs/introduction/plans) · [Vercel fair use](https://vercel.com/docs/limits/fair-use-guidelines) · [Supabase pricing](https://supabase.com/pricing) · [AWS Free Tier](https://aws.amazon.com/free/) · [Cloudflare billing profile](https://developers.cloudflare.com/billing/create-billing-profile/)
