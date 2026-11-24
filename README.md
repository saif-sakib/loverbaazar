# LoverBaazar

Bangladesh home-appliance and furniture shop. The [architecture plan](PLAN.md) records the stack choices and the $0 running-cost rule.

## Run locally

Install Docker, Python 3, the Go version in [go.mod](apps/api/go.mod), and the Node version in [.nvmrc](.nvmrc). From the repository root, start a shop with disposable fixture data.

```sh
LB_ISOLATED=1 ./scripts/dev.sh
```

Open the shop at `http://127.0.0.1:8787/`. Open `/admin/` and use `local-admin-token-for-this-computer-only` for the local API. Use `./scripts/dev.sh` to work with existing local inventory. The [setup guide](docs/foundation.md#local-setup-and-isolation) describes alternate ports and isolated tests.

```sh
./scripts/check.sh --browsers
./scripts/test-mobile.sh --ci
```

## Configuration

- [.env.example](.env.example) lists settings and their destinations. `dev.sh` provides local defaults. Use an ignored `.env` for optional local integrations.
- Store production credentials in the relevant hosting dashboards. Generate the live Render `ADMIN_TOKEN` with `openssl rand -hex 32`.
- Edit shop details, delivery charges, and payment numbers under **Admin → Settings**. The initial values come from [API defaults](apps/api/defaults.json).

## Project layout

| Path | Contents |
| --- | --- |
| [apps/api](apps/api/) | Go API, order and catalog logic, release snapshots, schema and migrations |
| [apps/store](apps/store/) | Astro storefront and Admin, browser assets, SEO build, and [storefront tests](apps/store/tests/README.md) |
| [edge](edge/) | Cloudflare Worker, API proxy, redirects, caching, and security headers |
| [scripts](scripts/README.md) | Local development, tests, WordPress migration, release, backup, and maintenance commands |
| [.github/workflows](.github/workflows/) and [render.yaml](render.yaml) | CI, coordinated releases, hosting, security scans, and backups |
| [docs](docs/README.md) | Runbooks, roadmap, and verification records |

## Start here

- Read the [operating guide](docs/operations-index.md) for daily shop work.
- Use the [numbered roadmap](docs/roadmap.md) to find task status, dependencies, and the latest verification.
- Follow the [contributor rules](AGENTS.md) when editing the project. [CLAUDE.md](CLAUDE.md) imports the same rules.
