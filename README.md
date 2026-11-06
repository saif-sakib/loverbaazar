# LoverBaazar

Astro storefront on Cloudflare, Go API on AWS Lambda, PostgreSQL on Neon, images on Cloudflare R2. See [PLAN.md](PLAN.md).

## Run locally

Needs Docker, Go and Node. From the project folder:

    ./scripts/dev.sh

It starts Postgres, builds the store, seeds the products and starts the API and Worker. It then prints the shop link and a new admin token. Press Ctrl+C to stop.

## Deploy ($0)

**Before anything else:** create an AWS Budget alert at $1.

1. **Neon:** create a project in Singapore, limit compute to 0.25 CU, copy the *pooled* connection string.
2. **Seed:** `DATABASE_URL=... go run . seed seed/products.json`
3. **R2:** create a bucket, an API token and a custom domain such as `images.loverbaazar.com`. Add a CORS rule allowing GET from `https://loverbaazar.com`. Upload `wp-content/uploads` from the backup so URLs match `PUBLIC_IMAGE_BASE/<year>/<month>/<file>`.
4. **Lambda** (`provided.al2023`, arm64, 256 MB, Singapore, Function URL, low reserved concurrency):

       cd apps/api && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -tags lambda.norpc -ldflags='-s -w' -o bootstrap . && zip api.zip bootstrap

   Environment: `DATABASE_URL`, `ORIGIN_SECRET`, `ADMIN_TOKEN` (32+ characters), `R2_ACCOUNT_ID`, `R2_KEY`, `R2_SECRET`, `R2_BUCKET`, `IMAGE_BASE`, `SHIP_DHAKA`, `SHIP_OUTSIDE`, `BREVO_KEY`, `SHOP_EMAIL`, `TURNSTILE_SECRET`, `DEPLOY_HOOK`.
5. **Cloudflare:** put the Function URL in `apps/store/wrangler.jsonc`, then:

       cd apps/store && npx wrangler secret put ORIGIN_SECRET && npm run deploy

   Build variables: `PUBLIC_STOCK_URL`, `PUBLIC_IMAGE_BASE`, `PUBLIC_TURNSTILE_SITE`, `PUBLIC_SHIP_DHAKA`, `PUBLIC_SHIP_OUTSIDE`, and `CATALOG_URL=https://loverbaazar.com/api/catalog` once admin is the source of truth.
6. **Admin:** protect `/admin/*` and `/api/admin/*` with Cloudflare Access.
7. **Backups:** add a nightly encrypted `pg_dump` to R2 before taking real orders.

## Refresh the catalogue from WordPress

Put the API dumps in `data/raw`, then run `python3 scripts/import_wp.py`.
