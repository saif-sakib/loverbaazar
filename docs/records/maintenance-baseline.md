# Task 49 baseline — 19 November 2026

Task 49's implementation and read-only checks are complete. Provider readings remain an owner action, as requested on 19 November; the task stays **In progress** until its actual usage baseline is recorded. The owner reports tasks through 48 complete. Existing detailed handover/retirement evidence is preserved; this report does not retroactively verify account actions.

## Observed production and backup state

At **01:20 Bangladesh time on 19 November 2026** (18 November 19:20 UTC), `python3 scripts/maintenance-check.py` returned:

| Check | Observation |
| --- | --- |
| Database-free health | HTTP 200; 436 ms |
| Snapshot readiness | HTTP 200, ready; 310 ms |
| Static release metadata | HTTP 200; 110 ms |
| API/store code | Both `a2d4ebe0efd9ea02186e05210e03584d3af8060d` |
| Static release | `C1C1A9AD13A012AF168FE30CF7E4D4D3`, revision 0, fingerprint `31fc5435e4e6c64ce013a088f22c062cb33771e537195969ba5ad05762242332` |
| Backup schedules | `backup.yml` and `backup-watch.yml` active |
| Recent verified backup | [Run 44370755914](https://github.com/saif-sakib/loverbaazar/actions/runs/44370755914), success, created 19 November 00:32:05 Bangladesh time; 593,961-byte encrypted artifact |
| Artifact expiry | **26 November 2026, 00:32:41 Bangladesh time**; download privately before then |
| Freshness check | [Run 44371084704](https://github.com/saif-sakib/loverbaazar/actions/runs/44371084704), success |
| Repository artifact footprint | Four unexpired backup artifacts, **2,278,804 bytes total**, from a read-only GitHub metadata listing; not account-wide storage usage or a dashboard allowance |

This is one availability observation. It establishes neither an uptime percentage nor cold-start delay, real checkout latency, mail delivery, physical-device acceptance or spare quota. The checker exits `1` because unprovided dashboard readings are explicitly unknown, even when public/backup checks pass.

## Usage and business baseline still to record

| Source | Required owner reading | State |
| --- | --- | --- |
| Cloudflare | Account Worker requests/day, per-request CPU analytics/errors, release file count, actual limits/reset | Unknown |
| Render | Shared free hours, bandwidth/build minutes, CPU/memory window, restarts and actual limits/reset | Unknown |
| Neon | Compute hours, current project/account storage and public transfer, branch usage, actual limits/reset | Unknown |
| Cloudinary | Shared credits and storage/transfer/transformation breakdown/trend | Unknown |
| Brevo | Actual recipient sends/day, failures/uncertain deliveries, daily reset and other senders sharing the account | Unknown |
| GitHub | Account artifact/storage allowance and usage, cache usage/configured cap; free/no-card status | Unknown; repository artifact bytes above are measured |
| Commerce/recovery | Natural warm checkout p95/sample count, cold delays/confirmed losses, full operator recovery time, contribution/order, offline archive/key access | Owner record required; prior fixture p95 98–191 ms and fixture restore 1–2 seconds in task 41/36 are not production measurements or full operator recovery time |

Use [the operating checklist](../maintenance.md) and [empty private usage template](../maintenance-usage.example.json). No provider API key, customer export or database query is required by the checker. Owner readings must include observation date and actual allowance; do not infer usage from catalog size.

## Branch cleanup

Removed **11 local merged branches** and their remote counterparts, each verified as an ancestor of `main` with matching local/remote tips: `feat/mobile-shopping-admin`, `feat/release-operations`, `feat/storefront-seo-performance`, `feat/verified-wordpress-migration`, `fix/delivery-charge-copy`, `fix/invoice-print-layout`, `fix/mobile-navigation-invoice`, `fix/release-confirmation-retries`, `fix/reliable-store-ci`, `fix/save-product-photos`, `test/release-acceptance`.

Also removed **three remote branches belonging to already closed Dependabot PRs**: setup-node 7.1.0 (PR #1), upload-artifact 7.0.2 (PR #6) and wrangler 4.162.0 (PR #8). Remote deletion used each observed branch tip as a lease, so a concurrently updated branch would be refused. Earlier stale remote-tracking refs were pruned during fetch.

[PR #22](https://github.com/saif-sakib/loverbaazar/pull/22) merged during this task. After fetching it, removed its `docs/verify-production-handover` local/remote branch and the superseded `docs/namecheap-handover-status` local/remote branch. Both documentation histories were first saved in a **verified complete Git bundle** at `/home/sword/.local/share/loverbaazar/branch-archives/handover-2026-11-19.bundle`, outside the checkout. This preserves the older branch's two unique documentation commits. To recover it if needed: `git fetch /home/sword/.local/share/loverbaazar/branch-archives/handover-2026-11-19.bundle refs/heads/docs/namecheap-handover-status:refs/heads/recovered-handover-status`.

**Final total: 13 old local branches and 16 old remote branches removed.** Only `main` and the task 49 branch remain. The task branch includes the merged PR #22 documentation. Clean worktrees that held old branches were detached at their same commit; files and ignored local artifacts remain intact. No worktree directories, releases or database artifacts were removed.

## Verification

- `python3 -m unittest discover -s scripts -p 'test_maintenance.py' -v`: 12 tests passed, covering read-only request scope, redirect refusal, mismatched/unready/preview responses, stale/failed/disabled backups, expired/empty/unrelated artifacts, quota boundaries and missing/stale/invalid readings. Wired into `scripts/check.sh` for Store CI.
- The production checker made only three public GETs and GitHub metadata reads. No live order, notification, publish, deployment or database operation was initiated.
- Repeated with the empty usage template at 01:24 Bangladesh time: eight public/backup checks passed; all twelve unprovided quota readings stayed unknown, exit `1` as designed. CLI help, shell syntax, documentation links, JSON template, `git diff --check` and the repository security scan passed.

## Actions required

1. Record actual dashboard usage in the private template and run `python3 scripts/maintenance-check.py --usage /absolute/private/path/maintenance-usage.json`. Review warnings rather than treating a nonzero exit as a reason to buy capacity.
2. Set the [maintenance cadence](../maintenance.md#calendar-in-bangladesh-time-utc6), record the backup operator and independent recovery access, and download the verified encrypted backup before its expiry.
3. Finish the baseline and record review outcomes before changing task 49 to Done.
