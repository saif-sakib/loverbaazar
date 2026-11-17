# LoverBaazar architecture and delivery plan

**Goal:** a fast, mobile-first Bangladesh store at $0 application running cost, replacing WordPress only after the data and release checks pass.

The complete implementation plan is [docs/roadmap.md](docs/roadmap.md). Its 50 stable task numbers are the source of truth for requests such as **"Do task 1"**. The [architecture audit](docs/architecture-audit.md) records the source findings, local test results and verified provider constraints behind that plan.

## Architecture decisions

| Part | Current choice | Reason |
| --- | --- | --- |
| Store and admin | Astro static output | Fast mobile pages; browsing does not depend on a database query |
| CDN and API routing | Cloudflare static assets and Worker | Static assets and `/api/*` have separate execution paths |
| Application | One Go API on Render Free | Small portable service; existing Docker image supports a later VPS |
| Database | Neon PostgreSQL | Transactions, relative stock updates and a portable data model |
| Public prices/content | In-memory snapshots | Browsing and builds do not acquire database connections |
| Images | Cloudinary Free | Existing product/site asset workflow and constrained delivery transforms |
| Notifications | Brevo Free | Optional delivery must not determine whether an order saves |
| Checks, publishing, backups | GitHub Actions | Existing workflow foundation, to be strengthened by tasks 31–36 |
| Registration | Existing Namecheap domain | Keep registration and renewal; hosting is a separate service |

No payment method, paid plan, paid add-on or automatic overage is permitted on the application stack. Domain renewal remains the owner's existing expense. Provider limits and exhaustion behavior vary; verify the actual accounts rather than treating every free limit as the same kind of monthly pause. See the [official-source constraints](docs/architecture-audit.md#free-hosting-facts-checked-against-official-documentation).

Render Free can sleep and is not an availability guarantee. Static browsing should survive API failure, but checkout needs a working API/database. The application must explain outages, prevent duplicate orders/payments and provide operational recovery. A health cron does not remove those limits.

## Release and domain strategy

Build and verify locally/through isolated previews, reconcile real products and outstanding WordPress orders, prove backups/restores and finish mobile/SEO/integration checks. Keep WordPress serving the existing domain throughout preparation.

After release approval, prepare DNS/mail records, activate Cloudflare DNS while WordPress remains live, freeze old writes for final reconciliation, then attach the tested shop to `loverbaazar.com`. Preserve old URLs and a tested rollback path. Retire Stellar Plus only after observation, mailbox/other-site checks and owner confirmation, within the already-paid term. These are roadmap tasks 42–48.

## Future work

Do not buy infrastructure in anticipation of growth. Task 49 establishes measured upgrade triggers; task 50 compares a Namecheap or other VPS at the time the owner approves a budget. The Go application and PostgreSQL model remain portable. Multiple API replicas require coordinated snapshot/rate-limit behavior before horizontal scaling.

Real payment gateways, paid SMS, promotions and optional back-office features are future backlog decisions. Color/brand filters depend on valid product attributes. Customer/old-order preservation and Rank Math SEO migration are required decisions in tasks 17–25, not assumptions that the current seed has already solved them. Account recovery must match the actual verified identity and available free channels.
