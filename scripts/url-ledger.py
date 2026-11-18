#!/usr/bin/env python3
"""Compare public WordPress URLs and private export evidence with a candidate build."""
import argparse
from collections import Counter
import csv
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import quote, unquote, urlsplit
from xml.etree import ElementTree

from migration.core import Invalid, load_bundle, private, write

APEX = 'loverbaazar.com'
HOSTS = {APEX, 'www.' + APEX}
NAMESPACE = '{http://www.sitemaps.org/schemas/sitemap/0.9}'


def local_path(value):
    url = urlsplit(value.strip())
    if url.scheme not in {'', 'http', 'https'} or url.netloc.lower() not in HOSTS | {''} or url.query or url.fragment:
        return None
    path = url.path or '/'
    if not path.startswith('/') or path.startswith('//') or re.search(r'%(2f|5c)', path, re.I):
        return None
    decoded = unquote(path, errors='strict')
    if '\\' in decoded or any(part in {'.', '..'} for part in decoded.split('/')) or any(ord(c) < 32 for c in decoded):
        return None
    if '.' not in decoded.rsplit('/', 1)[-1] and not decoded.endswith('/'):
        decoded += '/'
    return decoded


def sitemap_urls():
    queue = [f'https://{APEX}/sitemap_index.xml']
    seen = set()
    while queue:
        url = queue.pop(0)
        if url in seen:
            continue
        if len(seen) >= 50 or not local_path(url) or urlsplit(url).scheme != 'https':
            raise Invalid('Unexpected WordPress sitemap origin or index size')
        seen.add(url)
        try:
            body = subprocess.check_output(['curl', '--fail', '--silent', '--show-error', '--max-time', '20',
                                            '--max-filesize', '4000000', '--proto', '=https', url])
        except subprocess.CalledProcessError as error:
            raise Invalid(f'Could not read public sitemap: {url}') from error
        if len(body) > 4_000_000 or b'<!DOCTYPE' in body.upper():
            raise Invalid('Unexpected sitemap size or DOCTYPE')
        root = ElementTree.fromstring(body)
        if root.tag == NAMESPACE + 'sitemapindex':
            queue.extend(el.text or '' for el in root.findall(NAMESPACE + 'sitemap/' + NAMESPACE + 'loc'))
        elif root.tag == NAMESPACE + 'urlset':
            yield from (el.text or '' for el in root.findall(NAMESPACE + 'url/' + NAMESPACE + 'loc'))
        else:
            raise Invalid('Expected a sitemap XML document')


def run(args):
    entries, suggestions, unknown = {}, [], 0

    def add(value, source):
        nonlocal unknown
        path = local_path(str(value or ''))
        if not value or not path:
            unknown += 1
            return
        entries.setdefault(path, set()).add(source)

    if args.wordpress:
        for value in sitemap_urls():
            add(value, 'WordPress sitemap')
    if args.source:
        source = load_bundle(args.source)
        for kind, field in {'products': 'permalink', 'categories': 'link', 'tags': 'link', 'pages': 'link', 'posts': 'link', 'attachments': 'source_url'}.items():
            for row in source[kind]:
                if row.get('status', 'publish') == 'publish' and not row.get('protected_content') and row.get(field):
                    add(row[field], kind)
        # Rule match types, status and targets require separate review. Keep the source rows private.
        suggestions = source['redirects']
    for filename in args.extra:
        with private(filename).open(encoding='utf-8-sig', newline='') as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames or not any(field in reader.fieldnames for field in ('URL', 'Page', 'Top pages', 'Target URL')):
                raise Invalid('URL evidence CSV requires URL, Page, Top pages, or Target URL column')
            for row in reader:
                add(next((row[field] for field in ('URL', 'Page', 'Top pages', 'Target URL') if row.get(field)), None), 'owner URL export')
    if not entries:
        raise Invalid('No comparable public URLs found')
    build = Path(args.build).resolve()
    if not (build / 'release.json').is_file():
        raise Invalid('Provide the actual candidate build directory')
    redirects = {unquote(parts[0]): parts[1] for line in (build / '_redirects').read_text().splitlines() if len(parts := line.split()) == 3 and parts[2] == '301'}
    assets = json.loads((build / 'legacy-assets.json').read_text())
    dispositions = json.loads(private(args.dispositions).read_text()) if args.dispositions else {}
    if not isinstance(dispositions, dict):
        raise Invalid('URL dispositions must be keyed by legacy path')
    for path, decision in dispositions.items():
        if path not in entries or not isinstance(decision, dict) or not decision.get('evidence'):
            raise Invalid('Every URL disposition needs a ledger path and verification evidence')

    def exists(path):
        rel = path.lstrip('/')
        return (build / (rel + 'index.html' if path.endswith('/') else rel)).is_file()

    results = []
    for path, sources in sorted(entries.items()):
        destination = redirects.get(path)
        if destination:
            state = 'redirect' if exists(unquote(destination)) and unquote(destination) not in redirects else 'invalid-redirect'
        elif path.startswith('/wp-content/') and (destination := assets.get(path) or assets.get(quote(path))):
            state = 'asset-redirect-check-delivery'
        else:
            state = 'preserved' if exists(path) else 'needs-review'
        decision = dispositions.get(path)
        if decision:
            if state == 'needs-review' and decision.get('decision') == 'intentional-404':
                state = 'approved-404'
            elif state == 'asset-redirect-check-delivery' and decision.get('decision') == 'asset-verified' and decision.get('destination') == destination:
                state = 'verified-asset-redirect'
            else:
                raise Invalid('URL disposition does not match the candidate result')
        results.append({'path': path, 'sources': sorted(sources), 'decision': state, 'destination': destination,
                        'evidence': decision.get('evidence') if decision else None})
    counts = dict(Counter(row['decision'] for row in results))
    write(private(args.output), {'counts': counts, 'unsupported_url_records': unknown, 'urls': results, 'rank_math_rules_for_review': suggestions})
    print(json.dumps({'counts': counts, 'unsupported_url_records': unknown, 'rank_math_rules_for_review': len(suggestions)}, sort_keys=True))
    if args.strict and any(key in counts for key in ('needs-review', 'invalid-redirect', 'asset-redirect-check-delivery')):
        raise Invalid('Unresolved URL decisions remain')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wordpress', action='store_true', help='fetch the current public LoverBaazar sitemaps')
    parser.add_argument('--source', help='private WordPress export folder')
    parser.add_argument('--extra', action='append', default=[], help='private owner URL evidence CSV, repeatable')
    parser.add_argument('--build', required=True)
    parser.add_argument('--output', required=True, help='private output file outside this repository')
    parser.add_argument('--dispositions', help='private verified asset/intentional 404 decisions JSON')
    parser.add_argument('--strict', action='store_true')
    try:
        run(parser.parse_args())
    except (Invalid, OSError, ValueError, ElementTree.ParseError) as error:
        parser.exit(1, f'{error}\n')
