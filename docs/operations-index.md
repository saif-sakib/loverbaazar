# LoverBaazar operating guide

Use the [numbered roadmap](roadmap.md) for priorities, dependencies, evidence and open owner decisions. Keep the shop on the existing $0 stack within actual allowances. The audit and result files preserve point-in-time evidence. Use the current runbooks below for day-to-day procedures.

| Work | Where to start |
| --- | --- |
| Set up, run and test | [Foundation](foundation.md) for environment, isolated data, API contracts and release protocol. Use `./scripts/dev.sh` through the Worker. Use `LB_ISOLATED=1` or the owned test scripts for destructive fixture checks. |
| Run the shop | [Mobile workflows](mobile-ui.md) and [maintenance](maintenance.md). Orders, inventory quantities, live prices and discounts have live paths. Product names/photos, pages and site settings go through Publish. |
| Preview and download an A4 invoice | In Admin → Orders, click **Invoice** and check the saved details in the preview. When the PDF is ready, click **Download PDF** to save it as the order number, for example `LB-12345678.pdf`. If preparation fails, click **Retry PDF**. The file contains its A4 layout and page margins. The PDF shows the fulfillment status and payment method. A transaction reference requires separate verification. Keep copies with the authorized order records. |
| Store security | [Repository and accounts](foundation.md#repositoryaccount-security) and tasks 4, 5, 31, 41, 60. CI verifies application boundaries and scans known secret patterns. The owner verifies provider access, token lifecycle and alert delivery. Report any suspected exposure privately, then rotate affected credentials and review logs without copying customer data into an issue. |
| Old and current customer records | [Retention](data-retention.md) for current behavior and owner decisions. [Migration](migration.md) for any private WordPress records and outstanding support. |
| Backup and recovery | [Maintenance](maintenance.md#missed-backup--recovery-drill) and tasks 35, 36. Independently verify the encrypted copy and key. Restore to an isolated empty database first. |
| Domain, email and release handover | [Launch checklist](go-live.md) and tasks 43–48. Preserve the registrar registration and separate the domain, mail and hosting decisions. |
| SEO, discoverability and performance | [SEO and performance](seo-performance.md) and [crawl evidence](records/seo-performance-results.md). |
| Costs and growth | [Measured upgrade triggers](maintenance.md#measurements-that-trigger-a-decision) and tasks 49, 50 and 57. Use the owner-held capacity audit for the latest two-project baseline. |

Before merging or changing production, match the relevant roadmap task and verify its acceptance criteria. A passing CI check and a successfully served production release are separate pieces of evidence. Record the live checks only after they have been performed.
