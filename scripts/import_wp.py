#!/usr/bin/env python3
"""Prepare a private catalog and dry-run plan from a complete, checksummed WordPress export."""
import argparse
import json
from migration.evidence import inspect_evidence
from migration.core import CLASSES, Invalid, POLICIES, approve, archive_note, editorial_audit, legacy_archive, load_bundle, lookup, make_plan, normalize, private, review_csv, write


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    evidence = commands.add_parser('inventory')
    for field in ['dns-zone', 'hosting-inventory', 'output']:
        evidence.add_argument('--' + field, required=True)
    evidence.add_argument('--sql-backup')
    evidence.add_argument('--uploads-backup')
    evidence.add_argument('--owner-waived-full-backup', action='store_true')
    prepare = commands.add_parser('prepare')
    prepare.add_argument('source')
    prepare.add_argument('--output', required=True)
    prepare.add_argument('--target', help='Private catalog-snapshot JSON; absent means create-only empty target')
    prepare.add_argument('--policy', choices=['create', 'reconcile'], default='create')
    prepare.add_argument('--assets', help='Private, verified asset manifest; rewrites references before generating the reviewed plan')
    prepare.add_argument('--overrides', help='Explicit owner stock/content corrections, keyed by source product ID')
    archive = commands.add_parser('archive')
    archive.add_argument('source'); archive.add_argument('--output', required=True)
    search = commands.add_parser('lookup')
    search.add_argument('archive'); search.add_argument('--order-id', required=True)
    journal = commands.add_parser('note')
    journal.add_argument('archive')
    for field in ['order-id', 'key', 'kind', 'note', 'operator']:
        journal.add_argument('--' + field, required=True)
    approval = commands.add_parser('approve')
    for field in ['plan', 'catalog', 'review', 'policies', 'owner', 'output']:
        approval.add_argument('--' + field, required=True)
    args = parser.parse_args()
    if args.command == 'inventory':
        write(args.output, inspect_evidence({k: getattr(args, k) for k in ('sql_backup', 'uploads_backup', 'dns_zone', 'hosting_inventory') if getattr(args, k)}, owner_waived_full_backup=args.owner_waived_full_backup))
        print('Private evidence checksums recorded. Restore and owner verification are still required.')
    elif args.command == 'prepare':
        bundle = load_bundle(args.source)
        overrides = json.loads(private(args.overrides).read_text()) if args.overrides else {}
        catalog = normalize(bundle, overrides)
        if args.assets:
            from migration.assets import rewrite
            catalog = rewrite(catalog, json.loads(private(args.assets).read_text()))
        target = json.loads(private(args.target).read_text()) if args.target else {'records': [], 'imported': []}
        if target.get('phase', 'prelaunch') != 'prelaunch' or target.get('orders', 0):
            raise Invalid('Target already accepts new-store orders; migration is closed')
        output = private(args.output)
        catalog_path, plan_path = output / 'catalog.json', output / 'plan.json'
        write(catalog_path, catalog)
        plan = make_plan(catalog, target, args.policy)
        write(plan_path, plan)
        review_csv(output / 'product-review.csv', catalog)
        write(output / 'editorial-review.json', editorial_audit(catalog))
        write(output / 'policy-approval.template.json', {**{key: False for key in POLICIES}, 'target_settings_hash': target.get('settings_hash', ''), 'target_facts': target.get('settings', {}), 'source_identity': bundle.get('site_settings', {}), 'retained_decisions': {r['kind'] + ':' + r['key']: 'review-required' for r in plan['retained']}})
        write(output / 'source-inventory.json', {'manifest': bundle['manifest'], 'source_counts': {k: len(bundle[k]) for k in CLASSES}, 'required_owner_evidence': ['owner backup decision', 'DNS zone', 'mailboxes and other hosted sites', 'Stellar Plus renewal/end date', 'commercial policy approval', 'legacy archive coverage approval']})
        print(json.dumps({'changes': len(plan['records']), 'conflicts': len(plan['conflicts']), 'quarantined_products': sum(bool(r['issues']) for r in catalog['review']), 'source_counts': {k: len(bundle[k]) for k in CLASSES}}))
    elif args.command == 'archive':
        print(json.dumps(legacy_archive(load_bundle(args.source), args.output)))
    elif args.command == 'note':
        archive_note(args.archive,args.order_id,args.key,args.kind,args.note,args.operator)
        print('Private legacy action recorded; current stock and new-store accounts were not changed.')
    elif args.command == 'lookup':
        # Intentional private output for an authenticated local operator; never expose as public HTTP.
        print(json.dumps(lookup(args.archive, args.order_id), ensure_ascii=False, indent=2))
    else:
        result = approve(private(args.plan), private(args.catalog), private(args.review), private(args.policies), args.owner)
        write(args.output, result)
        print('Approval bound to the exact reviewed plan. No database changes made.')


if __name__ == '__main__':
    try:
        main()
    except (Invalid, OSError, ValueError, KeyError) as error:
        raise SystemExit('Migration stopped: ' + str(error))
