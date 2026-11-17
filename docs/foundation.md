# Tasks 1–8 implementation and operating notes

## Local setup and isolation

Use Node 22 (also recorded in `.nvmrc`), the Go version from `apps/api/go.mod`, Docker and Python 3. `./scripts/check.sh --browsers` installs locked npm dependencies and Chromium, checks Go formatting/vet, and runs Worker and API race tests. `./scripts/check.sh` skips browser downloading. To run browser checks start the complete shop through `./scripts/dev.sh`, then run `npm run test:ui` in `apps/store`; `CHROME_PATH` can select an already installed Chromium.

For a separate full-stack fixture while the normal shop stays running:

```sh
LB_ISOLATED=1 LB_API_PORT=18080 LB_STORE_PORT=18787 LB_DB_PORT=55435 ./scripts/dev.sh
```

Then run UI checks with `SHOP_URL=http://127.0.0.1:18787`. The isolated process owns its container, API, Worker process group and temporary build directory. Ctrl+C/TERM removes those resources. The normal `lbpg` database and an already running shop are untouched. Bindings use loopback. Startup rejects occupied ports and has bounded database/API waits. Existing `lbpg` containers created before this change may still have the original broader Docker port binding; recreate that binding only after backing up its data, or restrict it locally.

`./scripts/test-api.sh` always creates a disposable PostgreSQL 17 container on a random loopback port with database **lb_test**, clears external integration credentials, runs race tests and removes only its container. A manually supplied destructive test URL must parse to a literal loopback host and `/lb_test`, with only an optional `sslmode` query parameter (no database/host/port/service overrides). Never rename a business database to `lb_test`; that name is reserved for disposable fixtures. Old commands using a database named `lb` are deliberately refused.

## Data contracts

- Money is whole taka, 0–1,000,000,000 per price/fee/threshold. Checkout accepts at most 50 input lines and 20 units per product. These bounds keep multiplication, additions and discounts within BIGINT and JavaScript's exact integer range. Existing out-of-range prices fail checkout instead of wrapping; reconcile legacy data before selling it.
- Product create accepts initial `stock` in 0–1,000,000. Updates accept signed integer `stockDelta` within ±1,000,000. Fractional/coerced numbers are rejected. Sold stock is always adjusted relatively. The current negative-adjustment floor of zero is retained.
- `id` is positive. Slugs permit letters/marks/digits/dashes/underscores, including one layer of percent-encoded Bangla. Decoded slashes, dot segments, malformed/nested escapes and control characters are rejected. Category paths validate each segment.
- Product lists `cats`, `tags`, `images`, `attrs` have defined shapes; image/link URLs must be local absolute paths or HTTP(S), without embedded credentials. Attribute names/values are strings. Frozen build validation rejects duplicate IDs/slugs, unsupported money, missing collections and unknown category/tag references. A variant must be represented as its own sellable SKU until an explicit option/inventory model is implemented; attributes are descriptive, not independently stocked variants.
- Editorial HTML is parsed with the HTML5 parser and allowlisted; executable elements, event/style attributes and unsafe URL schemes are removed on save. CSP and `esc()` remain required. Existing saved/imported HTML is also sanitized while creating catalog/content snapshots; stored text is not silently rewritten. Validate business content during migration and release crawling.
- JSON writes require JSON content type and exactly one value. Origin/Sec-Fetch-Site checks reject cross-site writes. The Worker replaces `X-Shop-Host` and `X-Client-IP`; the API trusts the forwarded host only after origin authentication. Admin/customer/private responses are not cached. Tracking still requires the matching phone and order number.
- Public stock/catalog/storefront and authenticated frozen build reads use memory. Readiness uses memory only. Account/admin/order tracking are private database reads. No health or public browsing probe queries PostgreSQL.

## Environment contract

`APP_ENV=local` requires `DEV=1`; production refuses local upload/build settings and the documented local admin token. `APP_ENV=preview` uses secure cookies and origin/admin authentication, permits isolated bot testing and suppresses all outgoing mail. Preview must have its own fixture database and credentials; environment labeling alone does not isolate a database. `APP_ENV=production` is the default and requires both `TURNSTILE_SECRET` and public `TURNSTILE_SITE`. The server verifies the challenge's returned hostname against the Worker-authenticated hostname.

`BUILD_ENV=local|preview|production` controls the static artifact. The default is preview. Non-production output adds a site-wide `X-Robots-Tag: noindex, nofollow`, robots disallow and HTML noindex. Production builds require `CATALOG_URL`, `BUILD_ID`, `BUILD_KEY` and `PUBLIC_TURNSTILE_SITE`, preventing seed fallback or botless production output. `SITE_ORIGIN` controls canonical URLs; set the intended preview or production origin explicitly. Indexing controls are not authentication.

## Schema and startup

The migration runner holds a PostgreSQL transaction advisory lock, applies baseline schema and foundation migration atomically, and records SHA-256 checksums in `schema_migrations`. It adopts an existing schema using its idempotent baseline, then adds the new fields/tables/triggers. Repeat starts do not repeat migrations. To change a deployed schema, append another migration entry/file; do not edit an applied migration, whose changed checksum stops readiness. Content updates retain their existing once-only IDs and owner-rewrite protection.

`/api/health` remains a process-only `ok`. `/api/ready` returns 503 until stock/catalog/storefront snapshots exist and includes the release version without touching PostgreSQL. It is origin-protected in production; probe it through the Worker. Startup migration or content-update failures never produce ready snapshots. Frontend/API release coordination is expanded in task 32. Schema rollback means compatible code rollback: do not drop columns or restore an old database over new orders.

## Publication protocol

1. An authenticated admin POST `/api/admin/publish` captures products/content/settings in one repeatable-read transaction, records an editorial revision, and stores a frozen release plus a hashed, one-day build credential. The public build request reads only the cached immutable payload. Startup reloads unexpired build payloads into memory.
2. GitHub dispatch gets the release ID/key, not the admin password. `scripts/release.mjs` masks the key before writing it to the job environment and marks the run running. `shop.ts` reads this one payload, avoiding separate catalog/content reads or silent seed fallback.
3. The workflow builds, deploys, then reads the actual `release.json` and checks both release ID and code commit. Only then does it acknowledge published. An acknowledged failure never clears pending edits; a late failure cannot replace a confirmed success. A late older completion cannot supersede a newer confirmed release. Workflows serialize promotion rather than cancelling a deployment in progress.
4. Admin GET `/api/admin/publish` reads persistent revision/status across devices. Queued/running runs are polled only while active. One-day abandoned jobs become failed on status read. New edits made during a build remain pending after that build completes. Local Publish also records build exit status and uses the isolated output directory where configured.
5. A code-only/manual workflow without an admin dispatch must use a separate `PUBLISH_TOKEN` to prepare a release from the **last published editorial payload**, merging current live prices/stock/settings. It refuses to bootstrap from unpublished content. Bootstrap is an explicit admin Publish after the API and workflow configuration are installed. There is no automatic price-refresh scheduler in this task; task 26 establishes its cadence using this safe code-release path.

New routes: scoped-token POST `/api/publish/prepare`; build-key GET `/api/build/{id}`; build-key POST `/api/build/{id}/result` with state/commit; admin GET `/api/admin/publish`. None accepts a callback based only on a guessed release ID. Build credentials expire after one day and cannot access customer/account/admin data. Never place the build key in a URL or committed file.

A successfully deployed artifact with a failed/unreachable acknowledgment remains pending rather than claiming success. Inspect the visible `release.json`, then retry the authenticated callback via the workflow once connectivity returns; do not blindly redeploy an older artifact. Restoring the API from an old database also requires reconciling the visible artifact/release state before publication.

Image replacements/deletions queue retired URLs instead of destroying old assets on Save. Cleanup always checks current data, the last two confirmed publications and current queued/running publications. Explicit cleanup of abandoned uploads remains available; empty cleanup requests sweep queued retirements older than 30 days. Retired originals protected by a rollback release remain retained beyond the grace period. Keep at least those two known working releases and their assets. Release payload retention keeps the newest ten records plus the two latest published records and records under one day old. Quota monitoring is still needed; this policy is not an unlimited Cloudinary budget.

## Repository/account security

`security-check.py --history` scans reachable source history for recognized GitHub/Brevo/private-key signatures and forbidden tracked secret/export filenames, reporting paths only. It deliberately excludes generated catalog/seed/raw data and lockfiles; it is a narrow automated check, not proof that no possible secret/PII exists. The current scan covered 27 revisions with zero flagged paths. Rotate any confirmed exposure before removing it from history.

Actions have explicit read-only default permissions; action code is pinned to upstream commit IDs. Dependency update PRs cover npm, Go and Actions. The new PR security workflow has no production secrets. Do not use `pull_request_target` with untrusted checkout or give fork workflows deploy/backup credentials. Full functional PR CI remains task 31.

Read-only GitHub verification found the public repository `saif-sakib/loverbaazar`, authenticated account 2FA enabled, read-only default workflow permissions, workflow PR approval disabled, and **no protection on main**. No branch/account settings were changed. Require pull requests, disable force pushes/deletions, and require available security checks after this workflow is installed. Add the task-31 functional checks once they exist. For a solo owner, use checks rather than an impossible mandatory second-person approval rule.

Use a scoped Cloudflare Workers token, a selected-repository dispatch token with only the permission needed for dispatch, a distinct scoped `PUBLISH_TOKEN`, separate admin/origin secrets, least-privilege database roles, and owner-managed recovery codes. Keep backup decryption material separately recoverable. Verify Cloudflare/Render/Neon/Cloudinary/Brevo account 2FA/recovery and free-tier/no-card status in their dashboards; those accounts were not accessible in this implementation session.

## Actions required

1. Review and push these changes through your normal code-review process when ready to install them; pushing main may deploy under the existing workflow. No domain change is required.
2. In Render, set `APP_ENV` deliberately. For production set `TURNSTILE_SITE` to the same public key used by the build, with its existing matching secret. Configure production only after its widget is present. Use an isolated preview environment for initial verification.
3. Generate a separate random `PUBLISH_TOKEN` (32+ characters). Save it in Render and as the GitHub Actions secret `PUBLISH_TOKEN`; never copy your admin password into GitHub. Set `CATALOG_URL`, `STORE_URL`, `SITE_ORIGIN` and `STORE_ENV=preview` to the intended preview deployment. Keep the Cloudflare deployment credentials in their existing Actions secrets.
4. Deploy the API changes first. Then use admin Publish to bootstrap a confirmed frozen catalog through the new workflow. Verify a failed build retains pending edits, a successful build clears only its revision, another admin device sees status, and replaced images stay available.
5. Enable main-branch protection once the security workflow is installed; verify 2FA/recovery ownership on the other service accounts. These account-level acceptance steps and the real cloud publication/callback checks remain pending.
6. Restart your ordinary `./scripts/dev.sh` when you want to use the new API locally. Existing data is migrated in place; do not erase `lbpg`. Test an upgrade on a copied/throwaway database first before applying it to business data.
