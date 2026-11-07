# LoverBaazar

Run locally (needs Docker, Go, Node): `./scripts/dev.sh`, then open http://127.0.0.1:8787/

## Admin token

| Where | Token | Set in |
|---|---|---|
| This computer | `local-admin-token-for-this-computer-only` | `scripts/dev.sh`, automatically |
| Live shop | One you generate with `openssl rand -hex 32` | Render, as `ADMIN_TOKEN`. Never in this repo |

Open `/admin/` and paste the token. The live API refuses to start with the local token.

## Settings and secrets

There is no `.env` file by default, on purpose. `dev.sh` sets up everything for local use, and real
secrets live in the Render, GitHub and Cloudflare dashboards. [.env.example](.env.example) lists every
setting and where it goes. Copy it to `.env` only to try an optional service, such as email, locally.

Shop details, delivery charges and payment numbers aren't environment settings. Change them in
admin, under Settings. Their first values come from `apps/api/defaults.json`.

## Project layout

    apps/api/        Go API: main.go core, shop.go customers, admin.go admin, schema.sql database
    apps/store/      Astro storefront, and the admin panel in public/admin.js
    edge/worker.js   Cloudflare Worker: forwards /api to the Go API
    scripts/         Local start, WordPress import
    docs/go-live.md  Launch guide
    .github/         Tests, deploys, nightly backups

Admin covers orders, products, categories, coupons, customers, reviews, messages, pages, blog and shop settings.

- Go live for $0: [docs/go-live.md](docs/go-live.md)
- Why this stack: [PLAN.md](PLAN.md)
- Rules for changing the code: [CLAUDE.md](CLAUDE.md)
