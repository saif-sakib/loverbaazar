# Verified WordPress migration — tasks 17–23

The repository implementation is complete for preparation, validation, private archival, asset staging, approval and rehearsal. Actual source capture, Cloudinary delivery, catalog/policy approval and final reconciliation remain pending because the owner has not exported WordPress locally. No real product database, customer record, domain routing or hosting subscription was changed.

Start with [the WordPress export instructions](wordpress-export.md). Keep raw exports, databases, backup files, manifests, review sheets and approvals outside the public repository and all web roots. Tools create private artifacts with 0600 files/0700 new directories. Only sanitized aggregate evidence and reviewed public asset redirects belong in Git.

## Task coverage and remaining acceptance

| Task | Implemented | Still required |
| --- | --- | --- |
| 17 | Read-only paginated WordPress/WooCommerce CLI exporter; checksummed manifests with explicit zero counts; source version/time/currency/HPOS metadata; backup readability/checksum tool; public DNS capture | Fresh real structured export and recorded owner waiver for the full WordPress backup; complete private DNS/mailbox/other-site/renewal inventory; additional traffic/backlink URL sources where available |
| 18 | Exact Decimal currency conversion; whole-taka validation; real quantities; duplicate/relationship/Bangla slug checks; create/reconcile policy; quarantine; full-target/settings-bound atomic importer; safe reruns and deletion protection | Run against the actual source and isolated target; resolve every launch-product exception |
| 19 | Private SQLite archive with original IDs/statuses/timestamps/currency/totals/refunds/notes; source-stock-reduction summaries; Dhaka display; idempotent fulfillment/support journal; no checkout replay/account attachment | Owner-approved retention/coverage and real historical order/customer reconciliation, including outstanding obligations |
| 20 | Inventory product/description/category/page/blog/site assets; bounded downloads; deterministic names; resume and new-version retention; Free-account quota/identity/delivery checks; catalog rewrite and exact legacy-asset redirects | Actual approved account usage and real source/destination transfer/verification; all hosting-only dependencies resolved |
| 21 | Product review CSV bound to exact record values and plan hash; explicit active-product price/stock/description/image/warranty approvals; quarantine shown/enforced in admin | Owner review of actual sellable records and source-to-target/build-input comparison |
| 22 | Sanitized editorial imports, preserved SEO metadata, demo/shortcode/claim/link audit, required public policy-page checks, settings-bound commercial approval and dominant-script language metadata | Actual business/policy corrections and owner approval. No commercial promises are invented or silently overwritten |
| 23 | Disposable end-to-end import/rerun/source-delta/admin-conflict/build-snapshot/archive/restore/deletion/post-sale closure rehearsal | Repeat using the real dataset, resolve/approve exceptions, capture a real restore point and authorize the eventual single-writer cutover |

Test results and limits: [migration verification](migration-results.md).

## Export and inventory

`scripts/export-wordpress.php` uses WooCommerce data APIs rather than assuming orders live in WordPress posts. It exports products and variations, terms, documents, attachments, orders and customer profiles in bounded pages, preserving Rank Math fields and redirects. Each file has SHA-256/count metadata. The source is not assumed frozen during the initial export; a final authorized freeze must precede the last export. Protected pages become private drafts; unaddressable drafts/trash are retained in the private source with an explicit disposition.

The public-only [DNS capture](migration-public-dns.json) was collected on 18 November 2026, Asia/Dhaka. It is not proof of the full zone, mailbox ownership, correct delivery or paid-through dates. The existing website was inspected read-only; it is not treated as a complete product/stock/customer export.

Optional private backup evidence inventory:

```sh
python3 scripts/import_wp.py inventory \
  --owner-waived-full-backup \
  --dns-zone /private/backups/cloudflare-zone.txt \
  --hosting-inventory /private/backups/hosting-mailboxes.txt \
  --output /private/work/backup-evidence.json
```

Gzip/ZIP checks verify stream/CRC readability; archive paths are checked without extracting. They do not prove a database/files restore or certify owner-entered billing/mailbox information. The inspection has a 5 GiB unpacked-size limit and fails rather than partially certifying a larger backup.

## Prepare and review the real catalog

The following are operator steps for an isolated prelaunch target, not instructions to run against the live customer database. No production migration is authorized by this document.

1. Build the API binary into a private working directory. Set `DATABASE_URL` privately to the dedicated prelaunch fixture/copy, with `APP_ENV=preview` or `local`. Do not put credentials in command files or Git.
2. Capture the target through the CLI. Snapshot output includes actual product/content values, hashes, gate state and current effective site/live settings, read consistently in one transaction:

   ```sh
   /private/work/api catalog-snapshot /private/work/target.json
   ```

3. Prepare a dry run:

   ```sh
   python3 scripts/import_wp.py prepare /private/source \
     --target /private/work/target.json --policy reconcile --output /private/work/review
   ```

   The default policy is create-only; existing records require explicit reconciliation. Output includes `catalog.json`, `plan.json`, `source-inventory.json`, `product-review.csv`, `editorial-review.json` and a policy-approval template. No database write occurs.

4. Resolve quarantined products. Unknown/unmanaged stock, backorders, fractional prices, unsupported variable/option/sold-individually behavior, unsupported tax/delivery behavior and missing photos cannot become sellable automatically. `in_stock=true` never becomes an invented quantity. Keep inactive items inactive. Use explicit source corrections or an owner-authored `--overrides` JSON keyed by source product ID, then regenerate the catalog/review. Do not clear quarantine merely to make a count match.
5. Review names/models, SKU/options, categories, current/regular price, physical quantities/reservations, description/specifications, real photos, warranty/returns and active status. In the CSV, enter `yes` in the approval/verification columns only after checking them. Editing a CSV price/stock/name does not change the catalog and is rejected; corrections must regenerate the plan.
6. Review the actual target facts in `policy-approval.template.json`: identity/contacts, delivery fees/times, payment accounts, warranty/returns/refunds, terms/privacy and editorial claims. Preserve its target-settings hash. Resolve shortcodes, demo content, broken internal links and unverified guarantees. The final projection needs public About, How to Buy, Terms and Privacy pages.
7. For target rows absent from the source, record an explicit `retained_decisions` value of `keep`. Use `keep-hidden` only after the target row is actually hidden/draft. Absence never silently deletes a target record; prior imported records deliberately deleted on the target cannot be resurrected. Re-export the target after any edit.
8. Bind owner approval to the exact files:

   ```sh
   python3 scripts/import_wp.py approve \
     --plan /private/work/review/plan.json --catalog /private/work/review/catalog.json \
     --review /private/work/review/product-review.csv \
     --policies /private/work/review/policy-approval.json --owner 'Actual reviewer name' \
     --output /private/work/review/approval.json
   ```

## Assets before hosting retirement

The asset tool no longer replays full stale product saves through the admin API. It stages a verified catalog for the same reviewed importer. Source and destination identities must match; there is no overwrite/delete operation.

```sh
python3 scripts/images_to_cloudinary.py plan \
  --catalog /private/work/review/catalog.json --manifest /private/work/assets.json
python3 scripts/images_to_cloudinary.py download \
  --manifest /private/work/assets.json --files /private/work/files --max-bytes 104857600
```

Review the asset list and real available free-account quota before upload. Use existing Cloudinary credentials in the local operator environment only. Upload refuses paid/unknown account plans, unavailable usage or insufficient conservative credit headroom, and requires an explicit byte budget. No card, paid plan, automatic upgrade or eager transformation is introduced.

```sh
python3 scripts/images_to_cloudinary.py upload \
  --manifest /private/work/assets.json --files /private/work/files --max-bytes 104857600
python3 scripts/images_to_cloudinary.py rewrite \
  --catalog /private/work/review/catalog.json --manifest /private/work/assets.json \
  --output /private/work/verified-catalog.json
python3 scripts/images_to_cloudinary.py redirects \
  --manifest /private/work/assets.json --output /private/work/legacy-assets.json
```

The 100 MiB example is a byte ceiling, not a promise that this account has that capacity. Existing assets/derivatives and historical source versions remain accounted for; unknown quota stops upload. The Free check cannot certify a dashboard's card/recovery settings, which the owner still verifies. Unsupported file formats or uncertain dimensions require explicit correction/review; they are never silently dropped. Private/protected documents and products are not copied to public storage.

Use `renew --manifest … --source-url …` to allocate the next deterministic image number after an existing URL's bytes change. The old destination/checksum/bytes remain in manifest history and are not overwritten or deleted. Review the replacement and rerun download/upload/verification. Downloads are stored separately by source/version so old local versions survive. Rollback retains the previous published catalog and redirect map.

Before final reconciliation, rerun `download` with `--revalidate`, then `upload` to recheck source and destination identity. Changed source bytes fail without overwriting the retained version; use `renew` and review the replacement. Regenerate the review against a fresh target snapshot using the verified manifest:

```sh
python3 scripts/import_wp.py prepare /private/source --assets /private/work/assets.json \
  --target /private/work/fresh-target.json --policy reconcile --output /private/work/verified-review
```

Obtain approval again. A pre-rewrite approval cannot authorize the changed catalog.

Copy only the reviewed public `legacy-assets.json` map into `apps/store/public/legacy-assets.json` for the eventual release. Never copy the private asset manifest. The Worker serves exact `/wp-content/*` GET/HEAD redirects to verified Cloudinary paths. Missing/invalid mappings remain real 404s; other methods return 405. WordPress remains available until all required old-host references and downloads are reconciled. Source plugins/themes that the new app does not use are retained in backup, not blindly republished.

## Apply only to an offline prelaunch target

Stop the target API first. `catalog-apply` requires local/preview mode and `MIGRATION_MAINTENANCE=1`, the exact plan hash and owner approval. It holds transaction locks, rechecks the full catalog and current settings, validates every proposed baseline and writes atomically. Stock changes are relative deltas. A changed target fails before any row is committed. Restart the target API after applying, then verify snapshots and Publish through the release protocol.

```sh
MIGRATION_MAINTENANCE=1 /private/work/api catalog-apply \
  /private/work/review/plan.json /private/work/review/approval.json
```

After the first new-store order, a database trigger closes catalog migration permanently; deleting/cancelling orders does not reopen it. The CLI also rejects a target with new orders. This is a prelaunch reconciliation tool, not a postlaunch synchronization job. Any existing new-store order closes this path, including an order somebody calls a test. Preserve those orders and choose a separate order-safe reconciliation after reviewing the real data; do not delete orders or clear the gate to force an import. Existing deployed v1/v2 schema checksums remain unchanged; the guard is additive migration v3.

Normal legacy `seed` is bootstrap-only: missing quantities produce zero stock and quarantine; existing rows remain untouched. Synthetic stock is available only via isolated local `seed-fixture`, never a remote database. To start a disposable demo use `LB_ISOLATED=1 ./scripts/dev.sh`. Existing real target quantities are not reset by deploying this change.

## Old customers and orders

```sh
python3 scripts/import_wp.py archive /private/source --output /private/work/legacy.sqlite
python3 scripts/import_wp.py lookup /private/work/legacy.sqlite --order-id 123
python3 scripts/import_wp.py note /private/work/legacy.sqlite --order-id 123 \
  --key 'shipment-123-1' --kind shipped --operator 'Actual operator' --note 'Actual courier and tracking reference'
```

This is a private operator tool, not a public HTTP endpoint. It keeps original source identifiers, statuses, currency strings, exact decimal totals, timestamps, line items/options, refunds, addresses and notes. Customer profiles stay private and separate from storefront users. Passwords/access keys/sessions are removed; no historical hash or matching-phone registration grants access to the archive. Lookup adds an Asia/Dhaka timestamp and a separate operational journal. Duplicate journal keys are idempotent; changing an existing keyed action is refused. Source reruns update the archived source record while retaining the independent action journal.

`pending`, `on-hold`, `processing` and unknown statuses require fulfillment/payment review. `completed`, `cancelled`, `refunded`, `failed` and `trash` are treated as terminal for the source-status count, not proof that every refund or captured payment is settled. Original refunds/notes must be reviewed. Gross outstanding units are grouped by source product/variation and whether WordPress already reduced stock; these are review figures before refund/shipping reconciliation, not automatic inventory deductions.

Approve the archive's real counts, totals, outstanding orders and coverage/dispositions, including explicit zero-record classes. Decide retention/access with the owner. Reserve any unaccounted old obligations before approving opening stock. An old order fulfilled later must not reduce stock a second time if already deducted from the approved opening quantity; record any necessary one-time relative adjustment in the owner-controlled fulfillment/inventory process.

## Rehearsal and eventual cutover

Run the tools against an isolated real-data copy. Repeat the import, re-export changes from WordPress, compare the proposed delta, verify identifiers/relationships/totals/statuses/URLs/assets and inspect the build's inputs. Resolve every exception or record an individual owner-approved disposition. Capture and restore-test a real target restore point before final acceptance.

At the later authorized launch, record the source of truth and freeze all old checkout/admin/stock writes. Export again, regenerate the delta against the offline prelaunch target, approve actual prices/quantities/outstanding obligations, apply once, restart/verify and publish, then change routing under the launch procedure. Record actual export/apply/build/verification timing. Once the new store accepts orders it is the sole inventory writer. Rollback must reconcile new orders; never restore an old database over postlaunch sales. Do not freeze the live shop or change the domain during this preparation task.

## Actions required

1. Complete the [private export and backup steps](wordpress-export.md), then provide the local source folder path.
2. Review the actual product sheet, old-order obligations, asset failures and policy facts produced from that export. Approve only verified values.
3. Complete the real-data rehearsal and owner sign-off before marking tasks 17–23 Done or proceeding to domain/hosting retirement.
