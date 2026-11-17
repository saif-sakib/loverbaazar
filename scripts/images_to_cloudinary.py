#!/usr/bin/env python3
"""Plan/download/verify hosting assets offline; never replay stale admin product saves."""
import argparse
import json
from pathlib import Path
from migration.core import Invalid, private, write
from migration import assets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['plan', 'download', 'upload', 'rewrite', 'redirects', 'renew'])
    parser.add_argument('--catalog')
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--files')
    parser.add_argument('--max-bytes', type=int, default=0)
    parser.add_argument('--output')
    parser.add_argument('--source-url')
    parser.add_argument('--revalidate', action='store_true', help='Fetch sources again before final reconciliation; changed bytes are refused')
    args = parser.parse_args()
    path = private(args.manifest)
    manifest = json.loads(path.read_text()) if path.exists() else None
    if args.command == 'plan':
        catalog = json.loads(private(args.catalog).read_text())
        manifest = assets.inventory(catalog, manifest)
    elif manifest is None:
        raise Invalid('Run plan first')
    elif args.command == 'renew':
        manifest = assets.renew(manifest, args.source_url)
    elif args.command == 'download':
        manifest = assets.download(manifest, args.files, args.max_bytes, revalidate=args.revalidate)
    elif args.command == 'upload':
        manifest = assets.upload(manifest, args.files, args.max_bytes, lambda m: write(path, m))
    elif args.command == 'rewrite':
        catalog = json.loads(private(args.catalog).read_text())
        write(args.output, assets.rewrite(catalog, manifest))
    else:
        # A reviewed public-only map can be copied into public/legacy-assets.json for the next build.
        write(args.output, assets.redirects(manifest))
    write(path, manifest)
    print(json.dumps({'assets': len(manifest['assets']), 'bytes': sum(v.get('bytes', 0) for a in manifest['assets'].values() for v in [a, *a.get('history', [])]), 'failed': sum(a.get('status') == 'failed' for a in manifest['assets'].values())}))


if __name__ == '__main__':
    try:
        main()
    except (Invalid, OSError, ValueError, KeyError, TypeError) as error:
        raise SystemExit('Asset migration stopped: ' + type(error).__name__ + '. Check the private manifest and account configuration.')
