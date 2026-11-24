# LoverBaazar architecture and delivery plan

**Goal:** a fast, mobile-first Bangladesh store at $0 application running cost, serving `loverbaazar.com` on the free stack while retaining a tested rollback and deferring Stellar Plus retirement until owner confirmation.

The [numbered roadmap](docs/roadmap.md) is the source of truth for requests such as **"Do task 1"**. It keeps the original task numbers and appends new work. The [architecture audit](docs/architecture-audit.md) records the source findings, local test results and provider constraints behind the plan.

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
| Checks, publishing, backups | GitHub Actions | CI, coordinated deploys, security scans, and encrypted nightly backups with freshness checks (tasks 31–36) |
| Registration | Existing Namecheap domain | Keep registration and renewal; hosting is a separate service |

No payment method, paid plan, paid add-on or automatic overage is permitted on the application stack. Domain renewal remains the owner's existing expense. Provider limits and exhaustion behavior vary; verify the actual accounts rather than treating every free limit as the same kind of monthly pause. See the [official-source constraints](docs/architecture-audit.md#free-hosting-facts-checked-against-official-documentation).

Render Free can sleep and is not an availability guarantee. Static browsing should survive API failure, but checkout needs a working API/database. The application must explain outages, prevent duplicate orders/payments and provide operational recovery. A health cron does not remove those limits.

## Release and domain strategy

Local and CI verification, catalog acceptance, Cloudflare DNS activation, and the `loverbaazar.com` cutover have been executed (tasks 43–45 are Done; tasks 46–47 remain in live observation and verification).

Preserve legacy URLs and a tested rollback path throughout observation. Retire WordPress and Stellar Plus (task 48) only after observation, mailbox/other-site checks, and explicit owner confirmation within the already-paid term.

## Future work

Do not buy infrastructure in anticipation of growth. Task 49 establishes measured upgrade triggers; task 50 compares a Namecheap or other VPS at the time the owner approves a budget. The Go application and PostgreSQL model remain portable. Multiple API replicas require coordinated snapshot/rate-limit behavior before horizontal scaling.

Real payment gateways, paid SMS, promotions and optional back-office features are future backlog decisions (tasks 51–55). Color/brand filters depend on valid product attributes. Tasks 17–25 established the verified migration/SEO rules and owner data decisions, and remaining post-launch SEO, invoice, retention, email, and security follow-ups are tracked in tasks 56–65. Account recovery must match the actual verified identity and available free channels.
