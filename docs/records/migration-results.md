# Migration verification — 18 November 2026

Repository implementation and fixture acceptance for tasks 17–23 are complete. Real-source acceptance remains pending. The owner confirmed that WordPress has not been exported locally; no actual catalog, legacy order coverage, stock quantity, commercial promise or Cloudinary transfer is represented as owner-approved.

| Check | Result |
| --- | --- |
| Python migration tests | 16/16 passed: integrity/explicit zero coverage; exact currency/precision; unmanaged/backorder/variant quarantine; duplicate IDs/SKUs/decoded Bangla/cycles; 431 products; create/reconcile policy; deletion protection; private archive/journal/Dhaka time; approval binding and CSV corrections; inert HTML/editorial findings; backup CRC/path inspection; source/destination identity, signatures, quota, resume, replacement retention and revalidation; protected-content exclusion |
| API race suite | Passed with `GOTOOLCHAIN=go1.26.0 ./scripts/test-api.sh` (16.272 seconds reported on the verified full run; focused migration checks also passed after final validation changes); disposable `lb_test` PostgreSQL 17 container removed afterward |
| New importer API/DB regression checks | Identical batch rerun; stale-stock/full-target rejection; atomic rollback on duplicate slug; exact approval/settings binding; immutable deletion tombstones; quarantine activation rejected; permanent closure after the first order; unknown seed stock stays zero/inactive; remote fixture guard |
| Real WordPress source-side integration | Passed against disposable WordPress **7.1.4**, WooCommerce **11.3.0**, PHP 8.3/MariaDB: **105 product/variation records**, paginated export, actual post-order quantity, variable/variation quarantine, order/customer profiles, source stock-reduction flag, Rank Math metadata, Bangla page, password-protected page staying private, source versions/HPOS metadata and private archive |
| End-to-end migration rehearsal | Passed: source checksums → CLI preparation/asset plan → target snapshot → owner-fixture approval → atomic import → same batch rerun → zero-change fresh dry run → API build/stock snapshots → private old-order archive → source delta → stale admin stock conflict → reviewed delta → legacy status refresh → PostgreSQL dump/restore → deletion refusal → permanent post-order closure |
| Rehearsal amounts/counts | One synthetic product; two archived old orders; one initially outstanding source order; legacy total **BDT 2250.50** retained exactly; historical archive created **zero** live orders |
| Measured fixture restore | **0.540 seconds**, with **2.442 seconds** for the recorded whole migration rehearsal. These tiny-fixture times do not predict production duration; measure again using the actual dataset |
| Browser/contract suite | **40/40 passed** on the isolated full stack, including eight-width storefront layouts and all mobile admin sections; 113.575 seconds reported |
| Real new-store shopping/admin journey | Passed with `scripts/test-mobile.sh`: create/Publish/filter/buy/receipt/privacy/fulfill/concurrent stock/cancel/CSV and a final-unit race yielding one 200 and nineteen 409 |
| Worker regression checks | **6/6 passed**; exact legacy asset GET/HEAD redirects, rejected unsafe targets, preserved 404s and POST 405; price cache tests remain passing |
| Static/syntax checks | PHP exporter lint; Python compile; Go formatting/vet; JavaScript and shell syntax; whitespace checks passed |
| Public DNS evidence | Seven read-only lookups captured in `migration-public-dns.json`; no query failures. This is not a full zone or proof of mailbox/hosting/billing ownership |

The source-side integration created its own WordPress files, MariaDB database, Docker network and fake users/orders. It published no public port and used no real email address/account; mail attempts could not connect to a local sender. Those resources were removed. API/rehearsal/browser fixtures used separate owned PostgreSQL containers and temporary output; ordinary `lbpg` was not reset or migrated.

No real WordPress export, Namecheap backup, Neon data reconciliation, Cloudinary upload, old-order import, customer account mapping, mail configuration, DNS change, hosting cancellation, card or paid account was performed. The earlier real-phone gates remain as recorded in the mobile report.

The initial source-side test caught test-environment memory and fixture-user setup issues, then an exporter variable-scope bug under WP-CLI. The exporter now declares its shared variables explicitly and uses typed WooCommerce variation responses. Current source integration passes. Source and target approval checks also cover HTML serialization so a fresh dry run remains idempotent after server-side sanitization.

## Repeatable checks

```sh
PYTHONPATH=scripts python3 -m unittest discover -s scripts/migration -p 'test_*.py' -v
./scripts/test-api.sh
./scripts/test-migration.sh
./scripts/test-wordpress-export.sh
./scripts/test-mobile.sh
node --test edge/worker.test.mjs
```

The WordPress test requires local Docker image/plugin downloads, creates no publicly exposed service and removes its fixtures. It validates the exporter with a real WooCommerce data layer; it does not certify every plugin/version/storage arrangement in the owner's actual site. The actual source manifest records that site's versions and HPOS mode.

Cloudinary HTTP/account behavior is covered with controlled test responses, including signed upload request construction and destination byte checks. Actual free-plan/card/quota state, upload delivery and retained-release behavior must be verified on the owner's account before task 20 is Done. Unsupported media, missing dimensions and unverified commercial facts remain visible exceptions.

## Remaining real-data acceptance

| Task | Evidence still needed |
| --- | --- |
| 17 | Fresh readable/checksummed real SQL/files/structured exports; actual counts and outstanding orders; private full DNS/mailbox/other-site/renewal inventory |
| 18 | Actual source/target dry run, relationship checks and resolved source exceptions |
| 19 | Approved real archive coverage, legacy totals/statuses/refunds/obligations, access/retention and exclusion dispositions |
| 20 | Actual bytes/usage/delivery/redirect verification; zero required old-host references; owner account checks |
| 21 | Actual owner-approved physical quantity/reservation, price, SKU/options, descriptions, photos and warranty/returns per launch product |
| 22 | Verified identity/contact/payment/delivery/policy facts and corrected editorial content |
| 23 | Real-data rerun/delta/restore/build-input reconciliation and measured, authorized single-writer handoff |

## Actions required

1. Merge the reviewed PR so the export script is available from `main`.
2. Follow [the private WordPress backup/export instructions](../wordpress-export.md) and provide the local source directory path.
3. Review the actual catalog, outstanding old orders, asset failures and business policies produced from those files. Finish the isolated real-data rehearsal before marking tasks 17–23 Done or changing the domain/hosting.
