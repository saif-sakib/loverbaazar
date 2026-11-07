# LoverBaazar

Bangladesh home-appliance shop. Replaces WordPress at loverbaazar.com.

**Hard rule: $0 running cost.** No card on any account, and nothing that can bill past a limit. Only the domain costs money. So no AWS, R2, Vercel Pro or paid plans until the owner asks to migrate.

**Stack:** Astro static store and admin (`apps/store`) · Go API, chi + pgx (`apps/api`: `main.go` core, `shop.go` customers, `admin.go` admin) · Cloudflare Worker (`edge/worker.js`) · Neon Postgres · Render Free · Cloudinary · Brevo.

## Run and check

    ./scripts/dev.sh                     # shop on :8787, API on :8080, Ctrl+C stops
    cd apps/api && gofmt -l . && go vet .
    TEST_DATABASE_URL=... go test -count=1 .   # throwaway database only, it erases every table

`astro dev` cannot reach `/api`. Always test through `dev.sh`. Local admin token: `local-admin-token-for-this-computer-only`. Every setting is listed in `.env.example`; real secrets live in the hosting dashboards, never in the repo.

## Rules

- Browsing must never touch the database. Prices and stock come from `/api/stock`, an in-memory snapshot. Only writes refresh it.
- The server computes every total. Never trust browser prices.
- Change stock only with relative updates: `SET stock=stock-$1 WHERE stock>=$1`. Admin saves send `stockDelta`, never a stock number.
- Inside a transaction, query only through `tx`. A second pool connection there can deadlock checkout.
- Public read endpoints serve in-memory snapshots. Call `refresh()` after any write that changes them.
- Money is whole taka in BIGINT. No ×100.
- `/api/health` must never touch the database.
- Keep all old URLs: `/product/x/`, `/product-category/a/b/`, `/product-tag/x/`, trailing slashes.
- Static paths use `fileSlug()`. Percent-encoded Bangla slugs answer 404 without it.
- Checkout needs no login. Keep it that way: guests are protected by `fraudCheck`, rate limits and Turnstile.
- Escape customer text with `esc()` in `app.js` and the admin page.
- Admin edits to names, photos, new products, categories, pages or `site` settings need Publish. Price, stock, coupons and `live` settings are live.
- All images live in the `loverbaazar` Cloudinary folder. `IMAGE_BASE` in `wrangler.jsonc` moves old addresses at build time, and the Worker redirects old links.
- Settings defaults live only in `apps/api/defaults.json`. Don't hard-code shop details, delivery charges or payment numbers.
- `script-src` has no `unsafe-inline`: keep JavaScript in `public/*.js`.

## Saving tokens

- Don't read `apps/store/src/data/*`, `apps/api/seed/*`, `data/raw/*` or `dist`. They're large generated data.
- Read only the file you're changing. `docs/go-live.md` is for launch only.
- Don't start long-running commands in the foreground.
- Don't use `pkill -f` with text that appears in your own command. It kills your shell.

Skills: `run-local`, `test-shop`, `go-live`. Stack reasons: `PLAN.md`.
