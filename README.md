# LoverBaazar

Run a disposable local demo (needs Docker, Go per `apps/api/go.mod`, Node per `.nvmrc`): `LB_ISOLATED=1 ./scripts/dev.sh`, then open http://127.0.0.1:8787/. Use `./scripts/dev.sh` for existing verified local inventory. Unknown legacy quantities are quarantined, never invented.

For setup/checks use `./scripts/check.sh --browsers`; isolated test commands and environment/release contracts are in [docs/foundation.md](docs/foundation.md).

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

    apps/api/        Go API: main.go core, shop.go customers, admin.go admin, notifications.go email, release.go frozen builds, product_photos.go uploads, operations.go ops, safety.go validation, catalog_migration.go importer, schema.sql & migrations*.sql
    apps/store/      Astro storefront, admin panel (public/admin.js, public/invoice.js), legacy-urls.json, tests/
    edge/worker.js   Cloudflare Worker: /api proxy, legacy redirects, caching, security headers
    scripts/         Local dev (dev.sh), checks (check.sh, test-*.sh), release/backup/maintenance/security & WordPress migration
    docs/            Operating runbooks, roadmap, and point-in-time verification records
    .github/         CI, coordinated deploys, security scan, nightly backups and freshness watch

Admin covers orders, products, categories, coupons, customers, reviews, messages, pages, blog and shop settings.

- Verified WordPress migration: [docs/migration.md](docs/migration.md)
- Export WordPress privately: [docs/wordpress-export.md](docs/wordpress-export.md)
- Go live for $0: [docs/go-live.md](docs/go-live.md)
- Storefront SEO, mobile performance and accessibility: [docs/seo-performance.md](docs/seo-performance.md)
- A-to-Z owner operating guide: [docs/operations-index.md](docs/operations-index.md)
- Old orders, accounts and backup retention: [docs/data-retention.md](docs/data-retention.md)
- Numbered implementation and launch tasks: [docs/roadmap.md](docs/roadmap.md)
- Routine maintenance and measured upgrade triggers: [docs/maintenance.md](docs/maintenance.md)
- Architecture audit and verified baseline: [docs/architecture-audit.md](docs/architecture-audit.md)
- Why this stack: [PLAN.md](PLAN.md)
- Rules for changing the code: [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md)
