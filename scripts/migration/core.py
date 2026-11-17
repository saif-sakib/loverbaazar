"""Private, deterministic migration artifacts. Never imports customer data into storefront accounts."""
from __future__ import annotations
import csv
import hashlib
import html
from html.parser import HTMLParser
import json
from decimal import Decimal, InvalidOperation
from pathlib import Path
import re
import sqlite3
import tempfile
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import unicodedata
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
CLASSES = ('products', 'categories', 'tags', 'pages', 'posts', 'orders', 'customers', 'attachments', 'redirects')
RESERVED = {'admin', 'api', 'blog', 'cart', 'checkout', 'contact-us', 'my-account', 'offers', 'product', 'product-category', 'product-tag', 'search', 'shop', 'track', 'wishlist', 'home', 'sample-page'}
TERMINAL = {'completed', 'cancelled', 'refunded', 'failed', 'trash'}
POLICIES = ('identity_contacts', 'delivery_fees_times', 'payment_accounts', 'warranty_returns_refunds', 'terms_privacy', 'editorial_claims')

class Invalid(ValueError):
    pass

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()

def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()

def file_hash(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def now():
    return datetime.now(timezone.utc).isoformat()

def private(path):
    p = Path(path).expanduser().resolve()
    if p == ROOT or ROOT in p.parents:
        raise Invalid('Migration artifacts must stay outside the public repository and web roots')
    if any(part in {'public_html', 'www', 'htdocs', 'public', 'dist'} for part in p.parts):
        raise Invalid('Choose a private directory outside a web root')
    return p

def write(path, value):
    p = private(path)
    p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(dir=p.parent, prefix='.' + p.name + '.', delete=False) as f:
        temp = Path(f.name)
        f.write(canonical(value) + b'\n')
    temp.replace(p)

def text(value):
    return html.unescape(re.sub(r'<[^>]*>', ' ', str(value or ''))).strip()

def slug(value, nested=False):
    try:
        s = unquote(str(value), errors='strict')
    except (UnicodeError, ValueError):
        raise Invalid('Invalid slug encoding')
    parts = s.split('/') if nested else [s]
    if not s or len(s.encode()) > 240 or any(not x or any(c not in '_-' and unicodedata.category(c)[0] not in 'LMN' for c in x) for x in parts):
        raise Invalid('Invalid or double-encoded slug')
    return s

def whole(value, maximum=1_000_000_000):
    if isinstance(value, bool) or value is None:
        raise Invalid('Explicit whole number required')
    try:
        n = Decimal(str(value))
        if not n.is_finite() or n != n.to_integral_value() or not 0 <= n <= maximum:
            raise Invalid('Fractional, negative or excessive amount')
        return int(n)
    except InvalidOperation:
        raise Invalid('Invalid numeric value')

def price(p, key, currency):
    if 'prices' in p:
        data = p['prices']
        if data.get('currency_code') != 'BDT':
            raise Invalid('Product currency must be BDT')
        precision = whole(data.get('currency_minor_unit'), 6)
        raw = data.get(key if key != 'regular_price' else 'regular_price')
        n = Decimal(str(raw)) / (10 ** precision)
        return whole(n)
    if currency != 'BDT':
        raise Invalid('Source currency must be BDT')
    return whole(p.get(key))

class InertHTML(HTMLParser):
    allowed = set('p br strong b em i u s h2 h3 h4 ul ol li blockquote table thead tbody tr th td a img figure figcaption hr div span'.split())
    blocked = {'script', 'style', 'iframe', 'object', 'embed', 'form', 'svg'}
    void = {'br', 'img', 'hr'}
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.depth = [], 0
    def handle_starttag(self, tag, attrs):
        if tag in self.blocked:
            self.depth += 1
        if self.depth or tag not in self.allowed:
            return
        safe = []
        for k, v in attrs:
            v = v or ''
            if k in {'title', 'alt'} or k in {'src', 'href'} and safe_url(v, link=k == 'href'):
                safe.append(f' {k}="{html.escape(v, quote=True)}"')
        self.out.append('<' + tag + ''.join(safe) + '>')
    def handle_endtag(self, tag):
        if tag in self.blocked and self.depth:
            self.depth -= 1
        elif not self.depth and tag in self.allowed and tag not in self.void:
            self.out.append('</' + tag + '>')
    def handle_data(self, data):
        if not self.depth:
            self.out.append(html.escape(data))

def safe_url(value, link=False):
    if not value or any(ord(c) < 32 for c in value) or '\\' in value:
        return False
    u = urlsplit(value)
    return not u.username and (u.scheme in {'https', 'http'} and bool(u.hostname) or not u.scheme and not u.netloc and value.startswith('/') and not value.startswith('//') or link and u.scheme in {'tel', 'mailto'})

def clean(value):
    parser = InertHTML()
    parser.feed(str(value or ''))
    return ''.join(parser.out)

def rendered(value):
    return value.get('raw', value.get('rendered', '')) if isinstance(value, dict) else str(value or '')

def load_bundle(folder):
    folder = private(folder)
    manifest = json.loads((folder / 'manifest.json').read_text())
    if manifest.get('version') != 1 or urlsplit(manifest.get('origin', '')).scheme != 'https':
        raise Invalid('Expected version 1 manifest and HTTPS origin')
    datetime.fromisoformat(manifest['started_at'].replace('Z', '+00:00'))
    datetime.fromisoformat(manifest['finished_at'].replace('Z', '+00:00'))
    result = {'manifest': manifest}
    for kind in CLASSES:
        entry = manifest.get('files', {}).get(kind)
        if not entry or entry.get('file') != f'{kind}.jsonl':
            raise Invalid(f'Missing explicit coverage for {kind}; zero records still require an empty file')
        path = folder / entry['file']
        if path.is_symlink() or file_hash(path) != entry['sha256']:
            raise Invalid(f'Checksum mismatch: {kind}')
        with path.open() as f:
            rows = [json.loads(line) for line in f if line.strip()]
        if len(rows) != entry['count'] or not all(isinstance(row, dict) for row in rows):
            raise Invalid(f'Record count/type mismatch: {kind}')
        result[kind] = rows
    settings = folder / 'site-settings.json'
    if manifest.get('settings_sha256') and not settings.exists():
        raise Invalid('Advertised site-settings file is missing')
    if settings.exists():
        if file_hash(settings) != manifest.get('settings_sha256'):
            raise Invalid('Settings checksum mismatch')
        result['site_settings'] = json.loads(settings.read_text())
    return result

def unique(rows, key, label):
    seen = set()
    for r in rows:
        value = key(r)
        if value in seen:
            raise Invalid(f'Duplicate {label}: {value}')
        seen.add(value)

def normalize(bundle, overrides=None):
    overrides = overrides or {}
    records, review, ledger, excluded = [], [], [], []
    currency = bundle['manifest'].get('currency')
    unique(bundle['products'], lambda p: whole(p['id']), 'product ID')
    unique(bundle['categories'], lambda p: whole(p['id']), 'category ID')
    cats = {whole(c['id']): c for c in bundle['categories']}
    paths = {}
    def cat_path(cid, stack=()):
        if cid in stack or cid not in cats:
            raise Invalid('Category cycle or missing parent')
        c = cats[cid]
        parent = whole(c.get('parent', 0))
        return (cat_path(parent, stack + (cid,)) + '/' if parent else '') + slug(c['slug'])
    for cid, c in cats.items():
        paths[cid] = cat_path(cid)
        value = {'id': cid, 'name': text(c['name']), 'slug': slug(c['slug']), 'parent': whole(c.get('parent', 0)), 'path': paths[cid], 'html': clean(c.get('description', '')), 'count': c.get('count', 0), 'seo':c.get('seo', {})}
        if c.get('image'):
            value['image'] = c['image']
        records.append({'kind': 'cat', 'key': value['slug'], 'value': value})
        ledger.append({'source':c.get('link', '/product-category/' + paths[cid] + '/'),'destination':'/product-category/' + paths[cid] + '/','source_id':cid})
    for t in bundle['tags']:
        value = {'name': text(t['name']), 'slug': slug(t['slug']), 'seo':t.get('seo', {})}
        records.append({'kind': 'tag', 'key': value['slug'], 'value': value})
        ledger.append({'source':t.get('link', '/product-tag/' + value['slug'] + '/'),'destination':'/product-tag/' + value['slug'] + '/','source_id':t.get('id')})
    for source in bundle['products']:
        correction = overrides.get(str(source['id']), {})
        if 'id' in correction and correction['id'] != source['id']:
            raise Invalid('Source product IDs are immutable; corrections cannot remap identities')
        p = {**source, **correction}
        pid, issues = whole(p['id']), []
        if not p.get('slug') and p.get('status') != 'publish':
            excluded.append({'kind':'product','id':pid,'reason':'unaddressable draft retained in private source'})
            continue
        if p.get('protected_content'): issues.append('password-protected-source-content')
        if p.get('type') != 'simple' or p.get('parent_id', 0) or p.get('variations') or any(a.get('variation') for a in p.get('attributes', [])):
            issues.append('unsupported-options-or-product-type')
        if p.get('sold_individually'):
            issues.append('sold-individually-needs-supported-limit')
        if p.get('virtual') or p.get('downloadable') or p.get('tax_status', 'none') == 'taxable' and bundle['manifest'].get('tax_enabled'):
            issues.append('unsupported-delivery-or-tax-behavior')
        try:
            current = price(p, 'price', currency)
            regular = price(p, 'regular_price', currency)
            if regular < current:
                issues.append('regular-price-below-selling-price')
        except (Invalid, InvalidOperation):
            current = regular = 0
            issues.append('invalid-currency-or-whole-taka-price')
        try:
            if bundle['manifest'].get('stock_management_enabled') is False and not (correction.get('manage_stock') is True and correction.get('stock_quantity') is not None):
                raise Invalid('Global source stock management is disabled; verified owner quantities are required')
            if p.get('manage_stock') is not True or p.get('backorders') not in {'no', False}:
                raise Invalid('Unknown stock or backorders')
            stock = whole(p.get('stock_quantity'), 1_000_000)
            if (p.get('stock_status') == 'outofstock' and stock > 0) or p.get('stock_status') == 'instock' and stock == 0:
                raise Invalid('Conflicting stock status')
        except Invalid:
            stock = 0
            issues.append('unverified-or-unsupported-stock')
        images = [{'src': i['src'], 'thumb': i.get('thumbnail') or i['src'], 'alt': text(i.get('alt') or p['name']), 'width': i.get('width'), 'height': i.get('height')} for i in p.get('images', []) if i.get('src') and safe_url(i['src'])]
        if not images:
            issues.append('missing-product-photo')
        desc, short = rendered(p.get('description')), rendered(p.get('short_description'))
        if re.search(r'\[(?:/?[a-zA-Z_]+)(?:\s|\])', desc + short):
            issues.append('wordpress-shortcode-needs-editorial-review')
        ps = slug(p['slug'])
        product_cats = []
        for c in p.get('categories', []):
            cid = whole(c['id'])
            if cid not in cats:
                raise Invalid('Product refers to missing category')
            product_cats.append(slug(cats[cid]['slug']))
        value = {'id': pid, 'slug': ps, 'name': text(p['name']), 'sku': str(p.get('sku') or '').strip(), 'price': current, 'regular': max(current, regular), 'stock': stock, 'active': p.get('status') == 'publish' and not issues,
                 'inStock': stock > 0, 'cats': product_cats, 'tags': [slug(t['slug']) for t in p.get('tags', [])], 'images': images, 'desc': clean(desc), 'short': text(short)[:300],
                 'attrs': [{'name': text(a['name']), 'values': [text(x.get('name', '')) if isinstance(x, dict) else text(x) for x in a.get('options', a.get('terms', [a['option']] if a.get('option') else []))]} for a in p.get('attributes', [])],
                 'migrationBlocked': bool(issues), 'migrationIssues': issues, 'sourceType': p.get('type'), 'sourceStatus': p.get('status'), 'sourceProtected': bool(p.get('protected_content')), 'seo': p.get('seo', {}), 'sourceModified': p.get('date_modified_gmt', '')}
        records.append({'kind': 'product', 'key': str(pid), 'value': value})
        review.append({'id': pid, 'name': value['name'], 'sku': value['sku'], 'price': current, 'stock': stock, 'active': value['active'], 'issues': ';'.join(issues), 'record_sha256': digest(value)})
        ledger.append({'source': p.get('permalink', f'/product/{ps}/'), 'destination': f'/product/{ps}/', 'source_id': pid})
    unique([r for r in records if r['kind'] == 'product'], lambda r: r['value']['slug'], 'decoded product slug')
    unique([r for r in records if r['kind'] == 'product' and r['value']['sku']], lambda r: r['value']['sku'].casefold(), 'SKU')
    for kind, rows in [('page', bundle['pages']), ('post', bundle['posts'])]:
        for p in rows:
            if (not p.get('slug') or p.get('status') in {'auto-draft','trash','inherit'}) and p.get('status') != 'publish':
                excluded.append({'kind':kind,'id':p['id'],'reason':'unpublished/unaddressable content retained in private source'})
                continue
            key = slug(p['slug'])
            ledger.append({'source': p.get('link', f'/{key}/'), 'destination': f'/{key}/', 'source_id': p['id']})
            if key in RESERVED:
                excluded.append({'kind': kind, 'id': p['id'], 'slug': key, 'reason': 'application-route-or-demo; owner must reconcile content/redirect'})
                continue
            body = rendered(p.get('content', p.get('html', '')))
            value = {'slug': key, 'title': text(rendered(p.get('title'))), 'html': clean(body), 'draft': p.get('status') != 'publish' or bool(p.get('protected_content')), 'seo': p.get('seo', {})}
            if kind == 'post':
                value.update(date=str(p.get('date_gmt') or p.get('date', ''))[:10], excerpt=text(rendered(p.get('excerpt')))[:180])
            records.append({'kind': kind, 'key': key, 'value': value})
    unique(records, lambda r: (r['kind'], r['key']), 'record identity')
    unique([r for r in records if r['kind'] in {'page', 'post'}], lambda r: r['key'], 'page/post route')
    known_tags = {r['key'] for r in records if r['kind'] == 'tag'}
    if any(t not in known_tags for r in records if r['kind'] == 'product' for t in r['value']['tags']):
        raise Invalid('Product refers to missing tag')
    return {'version': 1, 'origin': bundle['manifest']['origin'], 'source_manifest_sha256': digest(bundle['manifest']), 'records': sorted(records, key=lambda r: (r['kind'], r['key'])), 'review': review, 'url_ledger': ledger, 'excluded': excluded, 'site': bundle.get('site_settings', {})}

def comparable(value):
    result = dict(value)
    for k in ('html','desc'):
        if k in result: result[k] = clean(result[k])
    return result

def make_plan(catalog, target, policy='create'):
    rows = {(r['kind'], r['key']): r for r in target.get('records', [])}
    tombstones = set(target.get('imported', [])) - {f'{k}:{key}' for k, key in rows}
    changes, conflicts = [], []
    for source in catalog['records']:
        key = (source['kind'], source['key'])
        existing = rows.get(key)
        if ':'.join(key) in tombstones:
            conflicts.append({'kind': key[0], 'key': key[1], 'reason': 'previously-imported-record-was-deleted; do not resurrect'})
            continue
        if existing and comparable(existing['value']) == comparable(source['value']):
            continue
        if existing and policy != 'reconcile':
            conflicts.append({'kind': key[0], 'key': key[1], 'reason': 'existing-record-needs-explicit-reconcile-policy'})
            continue
        changes.append({**source, 'expected': existing['hash'] if existing else 'absent'})
    # Missing source rows never imply deletion. They need a separately reviewed hide/archive decision.
    missing = [{'kind': k, 'key': key, 'reason': 'not-in-source; retained', 'active': rows[(k,key)]['value'].get('active', not rows[(k,key)]['value'].get('draft', False))} for k, key in rows if (k, key) not in {(r['kind'], r['key']) for r in catalog['records']}]
    return {'version': 1, 'origin': catalog['origin'], 'source_manifest_sha256': catalog['source_manifest_sha256'], 'records': changes, 'conflicts': conflicts, 'retained': missing, 'catalog_sha256': digest(catalog), 'settings_hash': target.get('settings_hash', ''), 'target_hash': target.get('target_hash', '')}

def csv_safe(value):
    s = str(value)
    return "'" + s if s.lstrip().startswith(('=', '+', '-', '@', '\t', '\r')) else s

def review_csv(path, catalog):
    p = private(path)
    p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with p.open('w', newline='') as f:
        p.chmod(0o600)
        fields = ['id', 'name', 'sku', 'price', 'stock', 'active', 'issues', 'record_sha256', 'approved', 'price_verified', 'stock_verified', 'description_verified', 'images_verified', 'warranty_returns_verified']
        w = csv.DictWriter(f, fields)
        w.writeheader()
        for row in catalog['review']:
            w.writerow({k: csv_safe(row.get(k, '')) for k in fields})

def approve(plan_path, catalog_path, review_path, policies_path, owner):
    plan = json.loads(Path(plan_path).read_text())
    catalog = json.loads(Path(catalog_path).read_text())
    if plan['conflicts'] or plan['catalog_sha256'] != digest(catalog):
        raise Invalid('Resolve plan conflicts and regenerate the review')
    policies = json.loads(Path(policies_path).read_text())
    if policies.get('target_settings_hash', '') != plan.get('settings_hash', ''):
        raise Invalid('Policy approval belongs to another target settings snapshot')
    if not owner.strip() or any(policies.get(k) is not True for k in POLICIES):
        raise Invalid('Explicit owner commercial-policy approval is required')
    for retained in plan.get('retained', []):
        decision = policies.get('retained_decisions', {}).get(retained['kind'] + ':' + retained['key'])
        if decision != 'keep' and not (decision == 'keep-hidden' and not retained['active']):
            raise Invalid('Explicit keep/hide review is required for target records missing from the source')
    policy_pages = {r['key'] for r in catalog['records'] if r['kind'] == 'page' and not r['value'].get('draft')}
    policy_pages |= {r['key'] for r in plan.get('retained', []) if r['kind'] == 'page' and r.get('active')}
    if not {'about-us', 'how-to-buy', 'terms-conditions', 'privacy-policy'} <= policy_pages:
        raise Invalid('Required public identity/buying/terms/privacy pages are missing; finish editorial reconciliation')
    with Path(review_path).open() as f:
        rows = list(csv.DictReader(f))
    unique(rows, lambda r: r['id'], 'review ID')
    approvals = {r['id']: r for r in rows}
    active = [r for r in catalog['review'] if r['active']]
    if not active:
        raise Invalid('No verified sellable products')
    for record in active:
        row = approvals.get(str(record['id']), {})
        if any(row.get(k) != csv_safe(record[k]) for k in ('id', 'name', 'sku', 'price', 'stock', 'active', 'issues')):
            raise Invalid('Apply corrections through overrides and regenerate the plan/review; CSV edits do not change the catalog')
        if row.get('record_sha256') != record['record_sha256'] or any(row.get(k, '').strip().lower() != 'yes' for k in ('approved', 'price_verified', 'stock_verified', 'description_verified', 'images_verified', 'warranty_returns_verified')):
            raise Invalid(f"Product {record['id']} is not fully reviewed")
    return {'version': 1, 'plan_sha256': file_hash(plan_path), 'catalog_sha256': digest(catalog), 'review_sha256': file_hash(review_path), 'policies_sha256': file_hash(policies_path), 'owner': owner.strip(), 'approved_at': now()}

def scrub_private_credentials(value):
    if isinstance(value, dict):
        return {k: scrub_private_credentials(v) for k, v in value.items() if not re.search(r'password|user_pass|secret|token|order_key|session|api_key|apikey|consumer_key|access_key|private_key|auth_key|authorization|credential|payment_url|receipt_url', k, re.I)}
    if isinstance(value, list):
        return [scrub_private_credentials(v) for v in value if not isinstance(v, dict) or not re.search(r'password|user_pass|secret|token|order_key|session|api_key|apikey|consumer_key|access_key|private_key|auth_key|authorization|credential|payment_url|receipt_url', str(v.get('key', '')), re.I)]
    return value

def legacy_archive(bundle, path):
    path = private(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    unique(bundle['orders'], lambda r: str(r['id']), 'legacy order ID')
    unique(bundle['customers'], lambda r: str(r['id']), 'legacy customer ID')
    origin = bundle['manifest']['origin']
    connection = sqlite3.connect(path)
    path.chmod(0o600)
    try:
        with connection:
            connection.executescript('CREATE TABLE IF NOT EXISTS records(origin TEXT,kind TEXT,id TEXT,phone TEXT,status TEXT,total TEXT,data TEXT,PRIMARY KEY(origin,kind,id)); CREATE TABLE IF NOT EXISTS sources(origin TEXT PRIMARY KEY,manifest TEXT); CREATE TABLE IF NOT EXISTS actions(origin TEXT,id TEXT,action_key TEXT,at TEXT,kind TEXT,note TEXT,operator TEXT,PRIMARY KEY(origin,id,action_key));')
            counts, totals, outstanding, obligations = {}, {}, 0, {}
            for kind in ('orders', 'customers'):
                counts[kind] = len(bundle[kind])
                for record in bundle[kind]:
                    safe = scrub_private_credentials(record)
                    phone = re.sub(r'\D', '', str(safe.get('billing', {}).get('phone', '')))
                    total, status = '', str(safe.get('status', ''))
                    if kind == 'orders':
                        total = str(safe['total'])
                        try:
                            amount = Decimal(total)
                            if not amount.is_finite() or amount < 0:
                                raise Invalid('Invalid legacy order total')
                        except InvalidOperation:
                            raise Invalid('Invalid legacy order total')
                        currency = safe.get('currency')
                        if not currency:
                            raise Invalid('Legacy order currency is missing')
                        totals[currency] = totals.get(currency, Decimal(0)) + amount
                        outstanding += status not in TERMINAL
                        if status not in TERMINAL:
                            state = 'already_reduced' if safe.get('legacy_stock_reduced') is True else 'not_reduced' if safe.get('legacy_stock_reduced') is False else 'unknown_reduction'
                            for item in safe.get('line_items', []):
                                identity = str(item.get('product_id', 0)) + ':' + str(item.get('variation_id', 0))
                                quantity = whole(item.get('quantity'), 1_000_000)
                                bucket = obligations.setdefault(identity, {'already_reduced':0,'not_reduced':0,'unknown_reduction':0})
                                bucket[state] += quantity
                    connection.execute('INSERT INTO records VALUES(?,?,?,?,?,?,?) ON CONFLICT(origin,kind,id) DO UPDATE SET phone=excluded.phone,status=excluded.status,total=excluded.total,data=excluded.data', (origin, kind, str(safe['id']), phone, status, total, canonical(safe).decode()))
            connection.execute('INSERT OR REPLACE INTO sources VALUES(?,?)', (origin, canonical(bundle['manifest']).decode()))
        return {'counts': counts, 'totals_by_currency': {k: str(v) for k, v in totals.items()}, 'outstanding_orders': outstanding, 'outstanding_gross_units_by_product_variation': obligations, 'account_mapping': 'none; historical records never attach by matching phone'}
    finally:
        connection.close()

def lookup(path, order_id):
    c = sqlite3.connect(f'file:{private(path)}?mode=ro', uri=True)
    try:
        raw = c.execute("SELECT origin,data FROM records WHERE kind='orders' AND id=?", (str(order_id),)).fetchall()
        records = []
        for origin, data in raw:
            record = json.loads(data)
            records.append(record)
            record['archive_origin'] = origin
            created = record.get('date_created_gmt')
            if created:
                stamp = datetime.fromisoformat(created.replace('Z', '+00:00'))
                if stamp.tzinfo is None: stamp = stamp.replace(tzinfo=timezone.utc)
                record['archive_created_dhaka'] = stamp.astimezone(ZoneInfo('Asia/Dhaka')).isoformat()
            record['archive_only'] = True
            actions = c.execute('SELECT at,kind,note,operator FROM actions WHERE origin=? AND id=? ORDER BY at', (origin,str(order_id))).fetchall()
            record['archive_actions'] = [dict(zip(('at','kind','note','operator'), a)) for a in actions]
        return records
    finally:
        c.close()

def editorial_audit(catalog):
    issues = []
    paths = {f"/{r['value']['slug']}/" for r in catalog['records'] if r['kind'] in {'page', 'post'}} | {f"/product/{r['value']['slug']}/" for r in catalog['records'] if r['kind'] == 'product'}
    paths |= {f"/product-category/{r['value']['path']}/" for r in catalog['records'] if r['kind'] == 'cat'}
    paths |= {'/', '/shop/', '/cart/', '/checkout/', '/search/', '/track/', '/my-account/', '/contact-us/', '/wishlist/', '/blog/', '/offers/'}
    for r in catalog['records']:
        body = ' '.join(str(r['value'].get(k, '')) for k in ('name', 'title', 'html', 'desc', 'short'))
        for label, pattern in [('demo-content', r'lorem ipsum|\bhoodies\b|sample page|starter template'), ('shortcodes', r'\[/?[a-zA-Z_]+(?:\s|\])'), ('commercial-claim-needs-owner-review', r'guarantee|warranty|refund|free delivery|cash on delivery|গ্যারান্টি|ওয়ারেন্টি')]:
            if re.search(pattern, body, re.I):
                issues.append({'kind': r['kind'], 'key': r['key'], 'issue': label})
        for href in re.findall(r'href=[\'\"]([^\'\"]+)', body):
            u = urlsplit(html.unescape(href))
            if (not u.netloc or u.netloc == urlsplit(catalog['origin']).netloc) and not u.scheme in {'tel', 'mailto'} and u.path and u.path not in paths and not u.path.startswith('/wp-content/'):
                issues.append({'kind': r['kind'], 'key': r['key'], 'issue': 'unresolved-internal-link', 'path': u.path})
    return issues


def archive_note(path, order_id, key, kind, note, operator):
    if kind not in {'confirmed', 'shipped', 'delivered', 'cancelled', 'returned', 'payment-review', 'support'} or not key.strip() or not operator.strip() or not note.strip():
        raise Invalid('Explicit journal key, supported action, operator and note required')
    c = sqlite3.connect(f'file:{private(path)}?mode=rw', uri=True)
    try:
        with c:
            origins = c.execute("SELECT origin FROM records WHERE kind='orders' AND id=?", (str(order_id),)).fetchall()
            if len(origins) != 1:
                raise Invalid('Order is missing or ambiguous across source sites')
            origin = origins[0][0]
            old = c.execute('SELECT kind,note,operator FROM actions WHERE origin=? AND id=? AND action_key=?', (origin,str(order_id),key)).fetchone()
            if old:
                if old != (kind,note,operator): raise Invalid('Journal key already belongs to another action')
                return
            c.execute('INSERT INTO actions VALUES(?,?,?,?,?,?,?)', (origin,str(order_id),key,now(),kind,note,operator))
    finally:
        c.close()
