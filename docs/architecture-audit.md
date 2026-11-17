# Architecture audit — 17 November 2026

This is the baseline for the [numbered roadmap](roadmap.md). The audit and planning request is complete; the roadmap's implementation tasks remain Planned.

## Scope and confidence

Reviewed the application architecture across the Go API and SQL schema, checkout/customer/admin paths, Astro route templates and shared layout, storefront/admin JavaScript and CSS, Worker routing/cache, existing tests, import/image scripts, local tooling, Dockerfile, environment example, publishing/backup workflows and launch documentation. Generated catalog/seed/raw-data directories and existing `dist` were excluded as required by the repository instructions. No real secret files or credential values were opened or displayed.

This is a repository architecture review with local verification. It does not certify the production database, owner-approved inventory, current WordPress export, Namecheap billing/email, DNS zone, Search Console or hosting dashboards. Those require the evidence and account steps identified in the roadmap. No remote deployment, database migration, DNS change or hosting cancellation was performed.

## Keep the architecture

The current static Astro + Cloudflare assets + small Go API + PostgreSQL design is appropriate to the owner's $0 constraint. Keep it. There is no identified reason to introduce a new frontend framework, microservices, Kubernetes, Redis, a paid object store or a VPS before launch.

The strongest existing protections are real PostgreSQL transactions, relative stock updates, server-calculated whole-taka totals, checkout idempotency, guest fraud checks, restricted admin routes, origin authentication, and in-memory public snapshots. Existing tests cover several concurrency and privacy cases. These are assets to preserve while closing the gaps below.

## Findings tied to the source

| Finding | Evidence and implication | Roadmap tasks |
| --- | --- | --- |
| CI coverage and trigger gaps | [publish.yml](../.github/workflows/publish.yml) tests code pushes to `main`; no `pull_request` trigger. It runs API tests and JavaScript syntax, but omits the Worker and browser suites. Manual/content dispatches skip the API test job. | 31–32 |
| API/store release coordination needs proof | The workflow deploys the store, while [go-live.md](go-live.md) configures independent Render auto-deployment. No repository configuration demonstrates both sides releasing a tested, compatible revision. Live Render settings were not inspected. | 7, 32–33 |
| Publish acceptance is treated as completion | [adminPublish](../apps/api/admin.go) returns after GitHub accepts dispatch. [admin.js](../apps/store/public/admin.js) immediately clears the local dirty marker. A failed build can leave the owner believing saved edits are published. State is also device-local. | 8, 16 |
| Old images can disappear before Publish | Product/settings/content saves call cleanup in [admin.go](../apps/api/admin.go). References are checked against current database content; the previous static release and rollback versions are not represented. A photo replacement can therefore remove an asset still used by the public site. | 8, 20, 36 |
| Import is an initial snapshot, not a launch sync | [import_wp.py](../scripts/import_wp.py) reads a fixed set of JSON dump files. [seed](../apps/api/main.go) leaves existing product rows untouched and assigns 100 units to imported in-stock products. Re-running seed cannot reconcile changed prices or actual quantities. | 17–18, 21, 23, 45 |
| Source currency interpretation is assumed | The importer divides source prices by 100. Internal BIGINT whole-taka storage is correct; import conversion must instead validate the source API's currency/minor-unit representation and reject unsupported fractions. | 2, 18 |
| Customer/order/SEO migration is not implemented | The import script does not import customer records, legacy orders or Rank Math fields. [PLAN.md](../PLAN.md) previously listed these as outstanding. A private archive or tested migration and account recovery policy is needed. | 17–19, 25 |
| Product representation needs a real-data audit | Imported attributes are present, but there is no demonstrated selectable variant/SKU inventory model. Actual variable products, bundles, warranty and stock-management modes were not reviewed. Unsupported sellable combinations must be resolved before launch. | 2, 18, 21 |
| Publication and live SEO can diverge | [product template](../apps/store/src/pages/product/[slug].astro), category copy and [feed.xml.ts](../apps/store/src/pages/feed.xml.ts) embed build-time prices/availability. Browser values update from `/api/stock`. Define freshness for HTML, structured data and feeds without accidentally publishing pending name/photo edits. | 8, 25–26 |
| SEO foundations exist but migration coverage is unproven | [Base.astro](../apps/store/src/layouts/Base.astro) supplies canonical/social/Store markup; route templates add Product/Breadcrumb/BlogPosting data. [robots.txt](../apps/store/public/robots.txt), sitemap integration and redirects exist. Generic category metadata, hard-coded locality/brand fallbacks, noindex/sitemap alignment and broad redirects need validation against the real old URL inventory. | 24–26, 40 |
| Preview indexing is not environment-aware | Canonical domain and robots configuration target `loverbaazar.com`; no preview-wide indexing protection is demonstrated. A public `workers.dev` preview should not become a duplicate searchable shop. Noindex is not access control for private data. | 3, 24–25, 33 |
| Rich HTML is a trust boundary | Templates render product/page HTML with `set:html`. The importer uses regex cleanup; admin content is trusted. Review allowlisted markup, URL schemes, customer escaping, JSON-LD serialization and actual CSP behavior. Existing `esc()` usage and CSP are useful protections, not a complete HTML sanitizer. | 5, 25, 40–41 |
| Health is correctly lightweight; readiness differs | [main.go](../apps/api/main.go) answers `/api/health` without database access while startup schema/snapshot work runs in the background. Startup failures are logged; operational readiness must detect absent snapshots separately without adding database reads to health/public browsing. | 7, 37 |
| Validation can be strengthened at API boundaries | Product input uses generic maps and converts `stockDelta` from floating point in [admin.go](../apps/api/admin.go). Typed bounded integers, money overflow checks, slug/path safety and structured input errors deserve targeted work. | 2, 5–6 |
| Backups exist, recovery is unproven | [backup.yml](../.github/workflows/backup.yml) encrypts nightly dumps and retains artifacts for 30 days. No restore workflow, measured recovery, media/config backup or missed-backup alarm is provided. Encryption keys need a separately recoverable owner copy. | 35–37 |
| Email delivery is best effort | [shop.go](../apps/api/shop.go) sends notifications asynchronously and logs failures. Orders are committed first, which is correct. There is no durable delivery status/retry record. The launch guide incorrectly says customers receive no email, although checkout sends confirmation when an email is supplied. | 34–36 |
| Mobile support exists; make it an enforceable standard | The store has mobile navigation, safe-area handling, a buy bar and responsive admin controls. CSS contains accumulated desktop rules and narrow-screen overrides. The 375 px home screenshot is usable, but its large hero delays category/product discovery. Refine and measure; avoid a cosmetic rewrite. | 9–16, 27–30, 39 |
| Tests leave important end-to-end gaps | Browser shopping tests mock stock/search/account/checkout and abort images. Backend and Worker tests are separate. Successful mocked tests cannot prove image availability, real Turnstile, email, production routing or the complete purchase/publish path. | 20, 31, 38–42 |
| Launch guide needs revision before use | [go-live.md](go-live.md) assumes a fixed product count, describes old email behavior, and suggests reverting nameservers as rollback. A faster rollback normally restores the previous web route/record inside the active DNS zone; neither rollback nor a database restore may discard new orders. Replace assumptions with task evidence. | 17, 32–36, 43–48 |

Some rows identify a missing guarantee or a risk inferred from source, not a reproduced customer failure. Each implementation task must confirm the behavior and add a meaningful regression check where needed.

## Verification performed

| Check | Result | Scope |
| --- | --- | --- |
| `gofmt -l .` in `apps/api` | Pass; no output | Current Go source formatting |
| `go vet .` in `apps/api` | Pass | Static Go checks |
| `go test -race -count=1 .` | Pass, 23.122 seconds | Current API source; PostgreSQL 17 in disposable `lb-architecture-audit-20261117`, bound only to `127.0.0.1:55434`; container removed afterward |
| `node --test edge/worker.test.mjs` | 5/5 pass | Cache deduplication, stale fallback, origin failure and cache-write failure |
| Fresh Astro build | Pass; 593 pages, 4.07 seconds reported | Read the running local API's in-memory catalog/storefront, output to a separate temporary directory; no deployment |
| `npm run test:ui` with `CHROME_PATH` | 18/18 pass, about 51 seconds | Existing local shop on `127.0.0.1:8787`; mocked shopping writes, read-only local admin checks; 320/375/768/1440 px layout coverage |
| Mobile home screenshot | No page overflow or browser JS errors at 375 × 812 | Local Chromium emulation; visual review of the first viewport |

The first browser attempt could not start because Playwright's expected Chromium executable was missing. Re-running with an already installed Chromium through the test suite's documented `CHROME_PATH` override passed. This does not verify the exact browser version Playwright would download. Task 1 makes browser installation and toolchain parity reproducible.

Audit host: Node 26.10.0, Go 1.27.1. Current CI uses Node 22 and the Go version declared in `go.mod` (1.26). The successful local results do not replace future checks on the intended CI/production versions. Existing local servers were reused; the fresh source build wrote separately, without replacing the running shop's files. No business data was written to the ordinary local shop or a remote database.

Not performed: a real-device usability test, production load test, independent security assessment, full live URL crawl, account audit, real provider integration test, backup restoration or production product reconciliation. These are explicit roadmap work, not assumed passes.

## Free hosting facts checked against official documentation

Checked 17 November 2026; verify again during task 33 and before switching the domain. Account-specific plans and allowances remain unverified. Budget warnings do not constitute spending caps. No card, paid add-on or automatic upgrade is allowed.

| Service | Verified constraint and plan consequence |
| --- | --- |
| Cloudflare | Static asset requests are free/unlimited; Worker invocations have a separate free quota. Current Workers Free limits include 100,000 requests/day and 20,000 static files/version. `/api/*` intentionally invokes the Worker; exceeding its quota can break API access while assets remain available. The reset is midnight UTC, 06:00 Bangladesh time. Test graceful API failure rather than promise uninterrupted checkout. [Asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [Worker limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Render | Free services can sleep after 15 idle minutes and take about a minute to resume. The workspace shares 750 free instance hours/month. Render advises against Free for production. The existing health cron provides no availability guarantee; assess it against current limits and terms. Preserve static browsing, explain checkout outages and measure cold starts. [Render Free documentation](https://render.com/docs/free) |
| Neon | Current Free documentation lists 100 CU-hours/project/month, 1 GB Postgres storage/project, 5 GB public transfer/project/month, and up to six hours of instant restore history. Compute/transfer exhaustion suspends compute; storage exhaustion affects writes. Set owner alerts well below each cap and maintain independent backups. Do not assume an older account has identical allowances. [Neon plans and exhaustion behavior](https://neon.com/docs/introduction/plans) |
| Cloudinary | Free can serve production within its allowance, without a card. Current pricing lists 25 credits shared across relevant resource use; this is not 25 GB of storage plus a separate unlimited image budget. Account usage and all retained image variants must be measured. [Free-plan documentation](https://cloudinary.com/documentation/developer_onboarding_faq_free_plan), [Pricing](https://cloudinary.com/pricing), [Credits](https://cloudinary.com/documentation/developer_onboarding_faq_credits) |
| Brevo | Free includes 300 sends/day; an order can consume more than one send when the owner and customer both receive messages. Provider retry limits apply. Admin orders remain the source of truth when mail is delayed or fails. [Brevo Free limits](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan) |
| GitHub | Standard hosted runner usage for public repositories is free; private repositories have plan-specific included usage. Verify artifact/storage budgets and access separately. Public scheduled workflows can be disabled after 60 days without repository activity, so the nightly backup needs a missed-run check and manual recovery path. [Billing](https://docs.github.com/en/actions/concepts/billing-and-usage), [Scheduled workflow inactivity](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows) |

## Domain and SEO references that shape the plan

Keep registration and renewal at Namecheap; the application can run elsewhere. A Cloudflare Worker custom domain requires an active Cloudflare zone. Export all DNS records before nameserver changes because records are not automatically carried across DNS providers. Protect mail and DNSSEC while changing authority, and verify the current zone before preparing exact instructions. [Cloudflare custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [Namecheap nameserver instructions](https://www.namecheap.com/support/knowledgebase/article.aspx/767/10/how-to-change-dns-for-a-domain/)

Preserving the domain and visible URLs makes this primarily a hosting migration. Test the replacement, prevent preview indexing, preserve verification, monitor crawling and retire the old host only after the handover is proven. URLs that must change need explicit relevant redirects. [Google hosting migration](https://developers.google.com/search/docs/crawling-indexing/site-move-no-url-changes), [URL migration guidance](https://developers.google.com/search/docs/crawling-indexing/site-move-with-url-changes)

Measure product metadata against Google's current Product guidance. The roadmap's Core Web Vitals targets are LCP ≤2.5 seconds, INP ≤200 ms and CLS ≤0.1 at the 75th percentile, separating mobile/desktop field measurements from lab results. These are acceptance targets, not results established by this audit. [Product structured data](https://developers.google.com/search/docs/appearance/structured-data/product), [Core Web Vitals](https://web.dev/articles/vitals)

## Actions required

No account changes are required for this audit. Start [task 1](roadmap.md#task-1--make-local-development-and-testing-reproducible) when ready to implement the roadmap. Owner exports, product approval and hosting/domain actions belong to their explicitly numbered later tasks.
