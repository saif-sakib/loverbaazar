# LoverBaazar data retention

## What happens today

| Copy | Current behavior | Who checks it |
| --- | --- | --- |
| New-store orders and customer accounts in Neon | There is no age-based deletion or anonymization job. An order stays in the database after cancellation or return. Account-session expiry only removes sessions. | Owner reviews approved account requests and order obligations. |
| WordPress and WooCommerce originals | Moving the domain did not erase the original WordPress database, hosting backups or exports. The new storefront does not import old customer identities or passwords. | Owner checks Namecheap hosting status, identifies required records and confirms the eventual disposition. |
| Private historical exports or SQLite archives | The migration tool can make a private archive. Its records do not expire automatically and it is not the new store's account/order history. The existence, scope and retention of any owner-held archive must be inventoried separately. | Owner records the private location and access. |
| New-store backups | GitHub's encrypted backup artifacts are configured for seven days. Expiry removes that artifact. Offline copies and provider recovery history have their own retention and access rules. | Owner and maintainer check nightly success, offline copies, and recoverability. |
| Customer email and print exports | Accepted email jobs clear their stored sending payload. Recipient records in Brevo and queued or failed payloads have separate lifecycles. PDFs, CSVs, mailbox messages and copies held by a courier remain outside a database sweep. | Operator keeps exports private and inventories provider copies. |

There is **no approved removal date** for LoverBaazar's old customer or order records. The shop needs to preserve order amounts, items, fulfillment, stock history and unresolved payments, refunds, returns and warranties. Approval to set a policy or inspect historical data does not execute a deletion.

## Decide and verify the policy under task 59

1. Identify the source, whether the data still exists, who can read it and the purpose of each copy. Inventory WooCommerce, Neon, private archives, replicas, backups, mailbox, Brevo, PDFs and CSVs. Use aggregate counts in reports and keep export files outside Git and web roots.
2. Separate financial records from customer identifiers and contact information. Verify applicable recordkeeping and privacy obligations for the shop before approving dates. Keep orders under dispute or with outstanding payment, fulfillment, refund or warranty needs in the applicable hold. Document who can release that hold.
3. Agree on classes, age from a defined event, eligibility, owner responsibility and backup handling. Decide when to redact contact/address and payment references, and when an unused customer account can be erased. Preserve amounts, line items, stock reconciliation, and the record of authorized actions. Handle support requests only after verifying identity.
4. Implement a report-only review first. Check exclusions, batches, approvals, reversibility, copy expiry, restore reconciliation and predictable handling of repeat runs. Test with disposable data including unpaid, disputed, cancelled, returned and completed orders. Prepare a fresh verified backup and a reviewed release procedure before an authorized live run.
5. Review the public privacy wording in Admin and **Publish** the approved text when the practice is ready. Keep the policy operator and backup schedule aligned.

Hasnahena maintains its own separate rejected-applicant, member and financial-ledger policy. Apply its retention runbook to that project. A shop order and a foundation accounting entry have different requirements.
