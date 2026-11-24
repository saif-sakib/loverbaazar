# Repository commands

Run the commands from the repository root. The [local setup guide](../docs/foundation.md#local-setup-and-isolation) explains prerequisites, ports, and disposable fixtures.

| Work | Entry points |
| --- | --- |
| Local demo and development | [dev.sh](dev.sh). Set `LB_ISOLATED=1` for disposable data. |
| Code and API checks | [check.sh](check.sh) installs locked dependencies and runs the code checks. [test-api.sh](test-api.sh) uses a disposable `lb_test` database. |
| Storefront and checkout | [test-mobile.sh](test-mobile.sh) starts an isolated shop. Use `--ci` for build, UI, and accessibility checks. See [storefront tests](../apps/store/tests/README.md) for browser options. |
| WordPress export and migration | [export-wordpress.php](export-wordpress.php), [import_wp.py](import_wp.py), [images_to_cloudinary.py](images_to_cloudinary.py), and [url-ledger.py](url-ledger.py) follow the [migration guide](../docs/migration.md). Rehearse with [test-migration.sh](test-migration.sh) and [test-wordpress-export.sh](test-wordpress-export.sh). |
| Coordinated release | The [Publish store workflow](../.github/workflows/publish.yml) calls the release helpers. The [publication protocol](../docs/foundation.md#publication-protocol) describes their inputs and recovery behavior. |
| Backups and recovery | [backup-store.py](backup-store.py) handles encrypted backups. Use [test-backup.sh](test-backup.sh) for an isolated rehearsal. See the [backup runbook](../docs/maintenance.md#missed-backup--recovery-drill). |
| Maintenance and security | [maintenance-check.py](maintenance-check.py) reports readiness and backup status. [security-check.py](security-check.py) runs the repository security checks used by CI. |
