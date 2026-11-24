# Foundation verification — 17 November 2026

Tasks 1–8 have repository implementations. Tasks 4 and 8 retain account/cloud acceptance work; their roadmap status is intentionally not Done. The other six tasks passed the local acceptance scope. Account access and deployment are not inferred from passing tests.

| Verification | Result |
| --- | --- |
| Complete API suite with `GOTOOLCHAIN=go1.26.0 ./scripts/test-api.sh` | 68 test functions; race suite passed (20.884 seconds reported on the final run) using a disposable PostgreSQL 17 container and `lb_test` database |
| New API regression coverage | Loopback test-target enforcement; integer/slug/HTML validation; cross-origin/content-type/JSON rejection; request-bound receipt retry; concurrent migration locks/checksums; frozen snapshot consistency and zero-DB build reads; pending later edits; rollback-image protection; late callback safety; published-only code refresh; production configuration/challenge hostname/preview mail isolation |
| Go formatting and vet | Passed with declared Go 1.26.0 tooling |
| Worker regression checks | 5/5 passed |
| Browser and bundle-contract checks | 20/20 passed on the isolated shop at `127.0.0.1:18787`; installed Chromium via documented `CHROME_PATH` override; includes pending-publication UI confirmation. After the final UI race fix, both focused publication checks passed (21 distinct checks covered overall) |
| Node 22 build | Fresh 593-page preview build passed in a Node 22 Debian container; 3.91 seconds reported |
| Preview HTTP headers | Served `X-Robots-Tag: noindex, nofollow`; production fallback/Turnstile/frozen-build guards enforced in build configuration |
| Real local publication | Initial Publish confirmed; a deliberately invalid price in the disposable fixture made the next frozen build fail, kept the visible `release.json` unchanged and kept edits pending; restoring the fixture then republishing succeeded |
| YAML/JavaScript/shell/whitespace | Workflow YAML parsed; relevant JS and shell syntax checks and `git diff --check` passed |
| Reachable source history scan | 27 revisions, zero flagged credential/private-export paths within the scanner's documented scope |
| GitHub read-only account checks | Public repository; authenticated account 2FA enabled; default workflow permissions read-only; workflow PR approval disabled; main branch not protected |

The initial UI run used route mocks that counted the new publication-status GET as a Publish write. Those mocks now count POST only. Another run overlapped a local publication/rebuild and timed out on a cart selector; the clean isolated run passed all 20 checks. The local failure/retry fixture was also corrected to restore both current and regular prices and to create a distinct pending edit on every run. Its final success/failure/retry run passed. No known unresolved test failure remains in the final results above.

Local fixtures used separate containers, ports and output directories. The ordinary local shop/database, WordPress, Namecheap domain and remote production data were not changed. The test runner removed disposable API databases; the full-stack fixture is also removed after verification. New schema migrations have not been applied to the ordinary local shop or a remote database.

## Remaining account and cloud acceptance

Repository work cannot establish production account recovery, install unpushed workflows or demonstrate a real cloud deploy callback. Task 4 remains pending main-branch protection and the other service-account access/recovery checks. Task 8 remains pending configuring its scoped token/variables, deploying the API and workflow, then demonstrating real successful/failed/superseded publication and cross-device status. Follow [the publication protocol](../foundation.md#publication-protocol) on an isolated preview before production.

No DNS change, hosting cancellation, paid plan, new payment method, remote deployment or customer notification was performed. Changes remain in the workspace for review. Full functional pull-request CI is task 31; main-branch API checks and the new security workflow are not presented as a substitute.

## Actions required

1. Follow the setup and account steps in the [foundation guide](../foundation.md), keeping the deployment in preview until launch readiness.
2. Restart the ordinary local dev server when ready to use the implementation. Never erase `lbpg` to install the migrations.
3. Complete and verify the account/cloud acceptance steps before marking tasks 4 and 8 Done.
