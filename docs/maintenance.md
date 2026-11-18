# Routine maintenance and growth decisions — task 49

The owner runs the shop checks and approves business decisions. The repository maintainer investigates failures, prepares tested fixes and records evidence. If the owner is also the maintainer, keep both responsibilities on the same checklist. Before delegating, record the named backup operator and verify their account/recovery access privately.

Keep the application stack at $0: Free plans, no payment methods, no automatic reload, no paid add-ons or overage. A warning starts investigation; it never authorizes an upgrade. Domain renewal remains a separate Namecheap responsibility. [Current measured baseline and remaining owner readings](maintenance-baseline.md).

## Calendar in Bangladesh time (UTC+6)

| When | Owner checklist | Evidence and response |
| --- | --- | --- |
| Daily, 10:00 | Admin → Orders: reconcile new/pending orders, payment-provider transaction records, failed/uncertain payments, cancellations, stock and fulfillment. Never mark a manual payment paid from a screenshot alone. Admin → Operations: inspect service errors and failed/uncertain email. | Keep order/payment details in the private fulfillment record. A checkout response count is not a count of distinct orders. Escalate an unexplained total, stock change, duplicate payment or missing confirmed order immediately. |
| Daily, 10:00 | Run the read-only check below. Verify Nightly backup and Backup freshness are green and the artifact is nonempty/unexpired. | Backup is scheduled at 02:17 and freshness at 04:37. A scheduled start may be delayed. A backup older than 26 hours needs same-day repair. A green workflow alone does not prove offline recovery. |
| Friday, 10:30 | Review every provider quota and the week's errors, cold starts, lost purchases, notification delivery and broken links. Open home → category → product → cart → checkout (without submitting), tracking, contact and one Bangla URL on a phone. Check one product image and Search Console's new 404/indexing reports. | Record readings, units, observation time, allowance, billing/reset window and week-on-week growth privately. Check failed notification tags in Brevo. For an unexpected broken legacy URL, repair its exact reviewed mapping; do not add broad redirects. Use the existing private URL ledger for a full crawl after a content/release problem. |
| First day of each month, 11:00 | Maintainer: review Dependabot, dependency advisories, security workflow, access/2FA/recovery, token expiry, database/storage/transfer growth, domain expiry and free/no-card status. Owner: review business losses and approve next priorities. | Update dependencies on a branch, run the repository checks and CI, review the concrete release before merging. Keep action revisions pinned. Record unresolved advisories with exposure and a next review date. Schedule token rotation at least 14 days before expiry; never paste values into issues or logs. |
| Every quarter, 11:00 | Owner and maintainer: retrieve an offline encrypted backup and independently held key; restore to a disposable database; reconcile later orders; test mobile guest purchase/tracking and common admin actions on Android Chrome and iPhone Safari. | Record complete recovery time and restore comparisons, physical phone/OS/browser, keyboard, 200% zoom and screen-reader results. Chromium emulation is additional evidence. Escalate if full recovery exceeds two hours or a phone cannot complete the purchase. |

Start daily checks on **19 November 2026**, the weekly review on **20 November**, the monthly review on **1 December**, and the next quarterly drill on **19 February 2027**. Continue any remaining launch observation separately; this cadence does not establish historical handover/hosting evidence. Keep recurring reminders in the owner's existing calendar; this change creates no external subscriptions or monitoring service.

The owner keeps a private log outside Git/web roots with: date/operator, release commit, backup run/age/offline-copy date, quota readings, warm p95/sample count, cold delay/lost-purchase count, incidents, action owner/deadline and next review. Include only aggregates in public reports; customer data, transaction IDs, account IDs and credentials stay private.

## Run the read-only check

Needs Python 3.11+ and an authenticated GitHub CLI (`gh auth status`) with read access to repository Actions metadata:

```sh
python3 scripts/maintenance-check.py
```

It makes one GET each to `/api/health`, `/api/ready` and `/release.json`, then reads GitHub workflow/run/artifact metadata. It verifies readiness, matching production code commits, enabled backup schedules, a successful backup younger than 26 hours with a usable artifact, the latest backup failure and a fresh successful watchdog. Each HTTP request has a 15-second timeout, no redirects and no retry. A cold service may fail the first check: wait about a minute and run it once more, recording both results. Each GitHub call has a 30-second timeout. Do not put this in a frequent cron or keep-awake monitor. Health/readiness read no database; waking the Render process can still cause its normal startup database work.

The report contains aggregate statuses and request timings, never an admin token or customer data. Those three timings are availability probes, **not checkout p95**. Exit `0` means every checked item passed; `1` means warning, action or unknown; `2` means invalid arguments/usage file. Missing dashboard access must remain `unknown`.

For quota checks, copy [the empty usage template](maintenance-usage.example.json) outside Git, replace each `null` with the current dashboard reading, and run:

```sh
python3 scripts/maintenance-check.py --usage /absolute/private/path/maintenance-usage.json
```

Each reading uses this shape (illustrative schema only; substitute actual readings and timestamp):

```json
{"used": 0, "limit": 100000, "period": "day", "observedAt": "2026-11-19T10:00:00+06:00"}
```

Use the same unit for `used` and `limit`. Zero means a measured zero, never an unknown. Daily readings expire after 26 hours; other readings after eight days. Future/undated readings are refused or unknown. Only the documented metric names and fields are accepted, so a copied secret field is not echoed. Review quotas daily once any reaches 70%, even though the non-daily file freshness allowance supports the normal weekly cadence.

## Quotas and free remedies

The documented limits below were checked against provider sources on **19 November 2026**. They are reference ceilings; the owner must use the actual account's allowance and reset window. `current` measures a present resource/limit, not a monthly consumption budget. For Worker CPU record a representative high-percentile CPU value from analytics and inspect per-request limit failures separately. Record Render CPU/memory in the private review log alongside the quota file.

| File metric / period | Where to measure and reference ceiling | Free response before exhaustion |
| --- | --- | --- |
| `cloudflare.requests` / `day` | Cloudflare → Workers & Pages → Worker → Metrics; account-wide Free invocations, reference 100,000/day, reset 06:00 Bangladesh time | Stop unnecessary polling/repeated publications; investigate abusive API traffic and rate limits. Static asset traffic and API invocations have different accounting. |
| `cloudflare.cpu_ms` / `current`; `cloudflare.asset_files` / `current` | Worker analytics CPU (reference 10 ms/request); latest release file count (reference 20,000 files/version) | Profile costly Worker logic; remove unused generated files through a tested build. Keep required URLs/assets. A CPU limit error is actionable even below the aggregate warning threshold. [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/) |
| `render.hours`, `render.bandwidth`, `render.build_minutes` / `month` | Render → workspace Billing → Monthly Included Usage; hours shared across workspace, reference 750/month; copy actual included bandwidth/minutes | Leave idle sleep enabled, stop unused preview services, avoid keep-awake traffic and redundant deploys. Check service Metrics for memory/CPU and restarts. With no payment method, exhausted bandwidth suspends services; exhausted build minutes can stop builds. [Render Free](https://render.com/docs/free) |
| `neon.compute_hours` / `month`; `neon.storage` / `current`; `neon.transfer` / `month` | Neon → project Usage/Billing and Monitoring; reference 100 CU-hours, 1 GB project storage, 5 GB public transfer. Include other branches/computes and the account's shared storage cap | Preserve snapshot-only public reads and scale-to-zero. Stop needless database-connected jobs; retain the nightly backup while budgeting its transfer. Never delete orders to free space. Storage can block writes; compute/transfer exhaustion suspends access, including backup reads. [Neon plans](https://neon.com/docs/introduction/plans) |
| `cloudinary.credits` / `rolling30d` | Cloudinary Console → Dashboard usage; reference 25 shared credits | Pause bulk uploads/new transformation batches; keep bounded image sizes. Use Admin → Operations → Check photo cleanup only after reviewing pending/retired references. Preserve published, shared and rollback media. Bandwidth/transforms roll over 30 days; storage is current usage, not a calendar-month reset. [Cloudinary credits](https://cloudinary.com/documentation/developer_onboarding_faq_credits) |
| `brevo.sends` / `day` | Brevo usage and Transactional Logs; reference 300 recipient sends/day, including other integrations | App recipient-attempt budget is at most 240/day UTC; multiple recipients/retries consume it. Compare provider accounting/reset with the app's UTC budget. Stop nonessential tests/bulk mail; use Admin Orders and tracking to fulfill. Do not raise the cap to bypass provider limits. [Brevo Free](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan) |
| `github.storage` / `current` | GitHub owner Settings → Billing usage plus repository Actions artifacts/caches; record account-wide artifact/storage allowance, not just this repository's files | Download/verify offline backups first. Preserve seven-day backup retention; remove only obsolete non-backup artifacts/caches after review. Record cache usage separately and keep its configured allowance within the included free amount. Use standard public runners. [Actions accounting](https://docs.github.com/en/billing/concepts/product-billing/github-actions) |

At **70%**, the owner records a trend and reviews daily; the maintainer identifies the consumer within two working days. At **85%**, the owner pauses optional activity the same day and the maintainer prepares a free reduction/recovery plan. At **95%**, act immediately: preserve recovery artifacts and pause affected operations before they can produce unsafe or unfulfillable orders. These are shop operating thresholds, not provider guarantees or automatic alerts. Free dashboard alerts may be enabled where available; paid alert plans are not required.

For calendar/billing-month consumption, estimate `used / elapsed days × days in period`, including the correct provider reset date. If the projected total exceeds 85% or headroom is less than seven days of recent daily growth, review now even when current usage is below 70%. For storage, use `(limit − used) / positive daily growth` for days of headroom. Cloudinary's rolling window requires its usage trend rather than a calendar projection. Do not extrapolate CPU percentiles or a tiny checkout sample into monthly capacity.

## Measurements that trigger a decision

| Measurement | Investigation / decision trigger | Responsible action |
| --- | --- | --- |
| Checkout service failures | Three genuine service failures in 15 minutes, or >1% 5xx with at least 100 checkout attempts/day; any incorrect money/stock, missing confirmed order or duplicate charge is immediate | Owner checks actual orders/payment records, pauses unsafe ordering and contacts the maintainer with sanitized request references. `4xx` includes expected validation/out-of-stock/abuse and must be investigated separately. Counters reset on API startup and exclude failures that never reach Go; include customer reports/Worker errors. |
| Warm checkout p95 | >2 seconds on two reviews, using at least 20 natural successful guest requests per review under comparable mobile/network conditions | Maintainer records end-to-end durations from controlled browser Network observations or existing provider timings without exporting payloads. Sort milliseconds and take item `ceil(0.95 × n)`. Record device/network and sample count; under 20 samples stays insufficient. Compare the isolated test benchmark separately. Do not create live orders/load just to fill a sample. |
| Cold starts and lost sales | Repeated >90-second recovery or three confirmed abandoned purchases from cold starts in seven days | Owner records cold duration and confirmed lost opportunities separately from retries. Maintainer improves recovery messaging/retry behavior and measures again. No keep-awake loop. |
| CPU / memory | Sustained >85% of the service limit for 15 minutes on two days, or any repeat out-of-memory/restart cycle | Maintainer profiles resource use, snapshot size and queries; owner pauses bulk work. Review the actual instance's available metrics rather than assuming a customer-count ceiling. |
| Recovery | Full restore/access/reconciliation >2 hours; no verified backup in 26 hours; offline archive/key unavailable | Owner and maintainer repair recovery first; pause risky releases/imports. Any lost confirmed order starts an incident immediately. Nightly backup implies up to roughly a day's database gap; preserve later orders and payment records independently. |
| Business loss / sustained limits | Repeated incidents after free fixes, or forecast limits within seven days | Owner estimates confirmed lost orders × contribution per order plus recovery/fulfillment hours × chosen hourly cost. Compare with a written recurring budget, support and recovery responsibility. Only explicit owner commercial approval starts task 50 or a paid integration. |

Admin → Operations provides checkout status groups since startup and notifications; Render logs provide sanitized failing-route/request references. Existing optional `CHECKOUT_METRICS_HOST` status logs count attempts, not unique new orders and not latency samples. Keep optional measurement off unless the owner chooses to configure it. The checker does not compute missing production p95, resource pressure or abandonment automatically.

## Incident runbooks

### Pause and resume safely

1. Owner opens Admin → Settings → Delivery and payment. Turn **Accepting online orders** off, enter an honest **Closed message**, and save. This is live; no Publish is needed. Preserve the previous message privately.
2. Confirm a fresh checkout shows the closed notice; do not submit a real order to test closure. Preserve orders already received and verify payment before asking anyone to retry. Keep product browsing available.
3. If admin cannot save and ordering could still accept unsafe writes, the owner can suspend the existing API from its Render service controls until repaired. API-dependent journeys will be unavailable while static pages remain. If the API/database is already unavailable, checkout cannot safely complete: avoid repeated writes or restarts. Have the maintainer help if the account lacks a suspend control; do not switch traffic back to old WordPress to bypass the fault.
4. Maintainer identifies whether the problem is API sleep/outage, quota, release mismatch, stock/payment data or abuse. Record commit, timestamp, failing path/status and request reference only.
5. Repair within the existing free plan; resume the API if suspended, run the checker once and reconcile payments/orders/stock. Owner re-enables online orders only after the fault is resolved and controlled acceptance passes. Reconcile uncertain attempts before any customer retries payment.

### Mail unavailable or uncertain

1. Owner uses Admin → Operations to inspect status and recipient attempts; Admin → Orders remains the source of fulfillment truth.
2. For **uncertain**, search Brevo Transactional Logs using the displayed `lb-order-mail-…` tag. Retry only after confirming the earlier attempt was not accepted. Accepted by Brevo is not proof of inbox delivery.
3. Check provider quota/configuration before retrying failed rows. Respect the three-attempt bound and 240/day application ceiling. If quota is exhausted, wait for reset and review pending rows; avoid repeated test emails. Contact customers through the shop's existing agreed channel when necessary, recording fulfillment privately.
4. Maintainer repairs credentials/sender configuration through hosting dashboards if needed. For a prolonged provider fault the owner may remove `BREVO_KEY` in Render and apply that environment change to pause sends, recording when to restore it. Do not disable order capture merely because an optional email failed. Recheck pending/uncertain rows after recovery.

### Missed backup / recovery drill

1. Check GitHub → Actions → Nightly backup and Backup freshness. If disabled, re-enable the existing workflow. Public scheduled workflows may disable after 60 days without repository activity, so the daily owner check must remain independent of both schedules. [GitHub workflow behavior](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)
2. Maintainer fixes the failed job's connection/key/quota issue without copying secrets to a log. Owner runs **Nightly backup → Run workflow → main**, then checks its verified artifact and the freshness workflow. Do not disable the backup to hide an alert.
3. Download the successful run's encrypted artifact to a private directory outside Git/web roots before its seven-day expiry. Retrieve `BACKUP_PASSPHRASE` from the independent password store without echoing it. Run `python3 scripts/backup-store.py verify /absolute/private/path/loverbaazar.tar.gpg`; use `BACKUP_PG_DOCKER=1` if the matching PostgreSQL tools are not installed. Verify before replacing an older offline copy; keep a rolling set of seven daily and three month-end archives where private offline space permits, with the key stored separately.
4. Quarterly, run `BACKUP_PG_DOCKER=1 ./scripts/test-backup.sh` for the disposable fixture rehearsal. Separately restore the downloaded real archive into a **fresh empty loopback PostgreSQL 18** database named `lb_restore`, on an explicit isolated port. Set `RESTORE_DATABASE_URL` privately, then run `BACKUP_PG_DOCKER=1 python3 scripts/backup-store.py restore /absolute/private/path/loverbaazar.tar.gpg`. The script refuses remote/nonempty/ordinary local-shop targets. Never point this command at production.
5. Time from retrieving archive/key through final validation. Compare order counts/totals/items, stock, content/live settings, migration metadata and image references with the archive's capture-time private records. Fixture checks alone do not validate the real archive. Preserve/export source orders created after capture and their payments, reconcile stock, and record how to replay/reconcile them before any real recovery. Delete only the drill's own container/private restored data afterward.
6. A real database replacement requires its own reviewed recovery plan with ordering closed and later orders preserved. The drill command grants no permission to replace production data.

### Bad release, missing images or expiring access

1. Freeze new editorial publication/bulk uploads. Record the current `/release.json` commit/artifact and Admin → Publish state. A dispatch acknowledgement is not publication success.
2. For incomplete promotion, inspect the existing Publish store workflow's recovery result; its guarded recovery restores the previous Worker only when the failed candidate is still current. Maintainer checks compatibility/readiness and required CI, then prepares a tested fix or reviewed rollback for the owner. Do not rerun an old workflow blindly: promotion enforces current main. Code rollback does not restore the database and must not remove later orders.
3. For missing images, keep published/shared/rollback references, check Cloudinary quota and exact stable asset paths, and replace a broken asset through the normal save/Publish process. Do not delete media or clear quarantine to make a check pass.
4. For expiring/lost credentials, use the verified owner/recovery account, issue a least-privilege replacement and update the exact Render/Cloudflare/GitHub secret listed in `.env.example`. Test the affected path before revoking the old token; for a confirmed compromise revoke promptly and follow the incident plan. Keep independent backup-key access. No account plan change is needed for token rotation.

## Actions required

1. Owner fills the private usage file from the dashboards above and records Render CPU/memory, checkout latency/cold-loss observations, account free/no-card status and reset windows. Unknown readings keep task 49 **In progress**; this is the owner's requested remaining action.
2. Add the recurring calendar reminders and record the backup operator/recovery access in the private operating log. Begin the daily and weekly checklist on the dates above.
3. At each review, record outcomes and act on thresholds. No service is upgraded automatically; optional growth work uses the numbered roadmap backlog.
