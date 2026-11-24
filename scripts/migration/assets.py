"""Bounded, resumable migration of publicly referenced hosting assets. No admin record rewrites."""
import base64
import hashlib
import json
import math
import os
import re
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
from .core import Invalid, digest, file_hash, now, private

URL = re.compile(r'https?://[^\s\"\'<>\\)]+|/wp-content/[^\s\"\'<>\\)]+')

def ascii_name(value, fallback):
    return re.sub('[^a-z0-9]+', '-', urllib.parse.unquote(str(value)).lower()).strip('-') or fallback

def inventory(catalog, previous=None):
    manifest = previous or {'version': 1, 'origin': catalog['origin'], 'assets': {}}
    if manifest['origin'] != catalog['origin']:
        raise Invalid('Asset manifest belongs to another origin')
    used = {v['public_id'] for a in manifest['assets'].values() for v in [a, *a.get('history', [])]}
    def visit(value, folder, name, alt=''):
        if isinstance(value, dict):
            for k, v in value.items():
                # Do not copy private data or metadata credentials into an asset inventory.
                if k not in {'sourceModified'}:
                    visit(v, folder, name, value.get('alt', alt))
        elif isinstance(value, list):
            for v in value:
                visit(v, folder, name, alt)
        elif isinstance(value, str):
            for raw in URL.findall(value):
                source = urllib.parse.urljoin(catalog['origin'], raw.replace('&amp;', '&')).rstrip('.,;')
                u = urllib.parse.urlsplit(source)
                if '/wp-content/' not in u.path:
                    continue
                if u.hostname not in {urllib.parse.urlsplit(catalog['origin']).hostname, 'www.' + urllib.parse.urlsplit(catalog['origin']).hostname} or u.username:
                    raise Invalid('Unapproved asset host')
                original_source = source
                if u.scheme == 'http':
                    source = urllib.parse.urlunsplit(u._replace(scheme='https'))
                if source in manifest['assets']:
                    aliases = manifest['assets'][source].setdefault('aliases', [])
                    if original_source not in aliases: aliases.append(original_source)
                    continue
                n = 1
                while f'{folder}/{name}-{n}' in used:
                    n += 1
                pid = f'{folder}/{name}-{n}'
                used.add(pid)
                manifest['assets'][source] = {'public_id': pid, 'alt': alt or name.replace('-', ' '), 'status': 'pending', 'aliases': [original_source]}
    for record in catalog['records']:
        if record['value'].get('draft') or record['kind'] == 'product' and (record['value'].get('sourceStatus', 'publish') != 'publish' or record['value'].get('sourceProtected')):
            continue
        v, kind = record['value'], record['kind']
        name = ascii_name(v.get('slug'), f'{kind}-{record["key"]}')
        if kind == 'product':
            category = next(iter(v.get('cats', [])), 'other')
            folder = 'loverbaazar/products/' + ascii_name(category, 'other')
        else:
            folder = 'loverbaazar/' + {'page': 'pages', 'post': 'blog', 'cat': 'site/categories', 'tag': 'site/tags'}[kind] + '/' + name
        visit(v, folder, name, v.get('name', v.get('title', '')))
    visit(catalog.get('site', {}), 'loverbaazar/site', 'site')
    return manifest

class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, hosts):
        self.hosts = hosts
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_source(newurl, self.hosts)
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def validate_source(url, hosts):
    u = urllib.parse.urlsplit(url)
    if u.scheme != 'https' or u.hostname not in hosts or u.username or u.port not in {None, 443}:
        raise Invalid('Only approved HTTPS asset hosts are allowed')

def dimensions(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n') and len(data) >= 24:
        return 'image/png', *struct.unpack('>II', data[16:24])
    if data[:6] in {b'GIF87a', b'GIF89a'} and len(data) >= 10:
        return 'image/gif', *struct.unpack('<HH', data[6:10])
    if data.startswith(b'\xff\xd8'):
        i = 2
        while i + 9 < len(data):
            if data[i] != 255:
                break
            marker = data[i + 1]; i += 2
            if marker in {0xD8, 0xD9}:
                continue
            size = int.from_bytes(data[i:i + 2], 'big')
            if marker in {0xC0, 0xC1, 0xC2}:
                h, w = struct.unpack('>HH', data[i + 3:i + 7]); return 'image/jpeg', w, h
            if size < 2:
                break
            i += size
    if data.startswith(b'RIFF') and data[8:12] == b'WEBP':
        return 'image/webp', None, None
    for prefix, mime in [(b'%PDF-', 'application/pdf'), (b'wOFF', 'font/woff'), (b'wOF2', 'font/woff2')]:
        if data.startswith(prefix):
            return mime, None, None
    raise Invalid('Unsupported or unverified asset bytes; convert/review this file explicitly')

def download(manifest, directory, max_bytes, opener=None, revalidate=False):
    if max_bytes <= 0:
        raise Invalid('A positive, explicit download-byte budget is required')
    directory = private(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    hosts = {urllib.parse.urlsplit(manifest['origin']).hostname}
    hosts |= {'www.' + h for h in list(hosts)}
    opener = opener or urllib.request.build_opener(SafeRedirect(hosts)).open
    used = sum(v.get('bytes', 0) for a in manifest['assets'].values() for v in [a, *a.get('history', [])])
    for source, asset in manifest['assets'].items():
        local = directory / (hashlib.sha256((source + asset['public_id']).encode()).hexdigest() + '.asset')
        if not revalidate and asset.get('sha256') and local.exists() and file_hash(local) == asset['sha256']:
            continue
        try:
            validate_source(source, hosts)
            remaining = max_bytes - used + asset.get('bytes', 0)
            if remaining <= 0:
                raise Invalid('Download budget exhausted')
            request = urllib.request.Request(source, headers={'User-Agent': 'LoverBaazar-private-migration'})
            with opener(request, timeout=60) as response:
                if int(response.headers.get('Content-Length', '0')) > remaining:
                    raise Invalid('Asset exceeds remaining byte budget')
                data = response.read(remaining + 1)
            if len(data) > remaining:
                raise Invalid('Asset exceeds remaining byte budget')
            mime, width, height = dimensions(data)
            checksum = hashlib.sha256(data).hexdigest()
            if asset.get('sha256') and asset['sha256'] != checksum:
                raise Invalid('Source changed; retain the old release and create a reviewed new manifest version')
            local.write_bytes(data); local.chmod(0o600)
            old_bytes = asset.get('bytes', 0)
            old_status = asset.get('status')
            asset.update(downloaded_at=now(), sha256=checksum, bytes=len(data), mime=mime, width=width, height=height, local_file=local.name, status='downloaded')
            if old_status == 'verified': asset['status'] = 'verified'
            asset.pop('failure', None); asset.pop('failure_reason', None)
            used += len(data) - old_bytes
        except (OSError, ValueError, urllib.error.URLError) as error:
            asset.update(status='failed', failure=type(error).__name__, failure_reason=str(error) if isinstance(error, Invalid) else f'Source request failed: {getattr(error, "code", type(error).__name__)}')
    return manifest

def sign(params, secret):
    raw = '&'.join(f'{k}={params[k]}' for k in sorted(params)) + secret
    return hashlib.sha1(raw.encode()).hexdigest()

def cloud_request(path, body=None):
    cloud, key, secret = [os.environ[k] for k in ('CLOUDINARY_CLOUD', 'CLOUDINARY_KEY', 'CLOUDINARY_SECRET')]
    if not re.fullmatch('[a-z0-9_-]+', cloud):
        raise Invalid('Invalid Cloudinary cloud name')
    headers = {}
    if body is None:
        headers['Authorization'] = 'Basic ' + base64.b64encode(f'{key}:{secret}'.encode()).decode()
    else:
        body = {**body, 'timestamp': str(int(time.time()))}
        body['signature'] = sign({k:v for k,v in body.items() if k not in {'file','api_key','resource_type','cloud_name','signature'}}, secret)
        body['api_key'] = key
        body = urllib.parse.urlencode(body).encode()
    req = urllib.request.Request(f'https://api.cloudinary.com/v1_1/{cloud}/{path}', data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)

def check_quota(usage, added_bytes):
    # Fail closed for paid/unknown plans or unavailable usage. Existing/rollback assets remain counted.
    if str(usage.get('plan', '')).casefold() != 'free':
        raise Invalid('Only a verified Cloudinary Free account is allowed')
    credits = usage.get('credits', {})
    try:
        limit, used = float(credits['limit']), float(credits['usage'])
        if not (math.isfinite(limit) and math.isfinite(used) and limit > 0 and used >= 0) or used + 2 * added_bytes / (1024 ** 3) >= limit * .8:
            raise Invalid('Insufficient free-credit headroom; no upload performed')
    except (KeyError, TypeError, ValueError):
        raise Invalid('Could not establish safe free-account quota headroom')

def upload(manifest, directory, max_bytes, save):
    directory = private(directory)
    assets = manifest['assets']
    if any(a.get('status') not in {'downloaded', 'uploaded', 'verified'} for a in assets.values()):
        raise Invalid('Resolve all asset download failures before uploading')
    total = sum(v.get('bytes', 0) for a in assets.values() for v in [a, *a.get('history', [])])
    if not 0 < total <= max_bytes:
        raise Invalid('Asset set exceeds the explicit upload budget')
    check_quota(cloud_request('usage'), total)
    for source, asset in assets.items():
        pid = asset['public_id']
        kind = 'image' if asset['mime'].startswith('image/') else 'raw'
        local = directory / asset['local_file']
        if not local.is_file() or file_hash(local) != asset['sha256']:
            raise Invalid('Downloaded asset changed')
        # Verify identity on every resume; a public-ID collision must never overwrite another asset.
        try:
            remote = cloud_request(f'resources/{kind}/upload/{urllib.parse.quote(pid, safe="")}?context=true')
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
            error.close()
            remote = None
        if remote is None:
            check_quota(cloud_request('usage'), total)
            remote = cloud_request(f'{kind}/upload', {'public_id': pid, 'overwrite': 'false', 'context': 'source_sha256=' + asset['sha256'], 'file': 'data:' + asset['mime'] + ';base64,' + base64.b64encode(local.read_bytes()).decode()})
        if ((remote.get('context') or {}).get('custom') or {}).get('source_sha256') != asset['sha256'] or remote.get('bytes') != asset['bytes'] or remote.get('public_id') != pid:
            raise Invalid('Cloudinary destination identity mismatch; replacement was refused')
        destination = remote.get('secure_url', '')
        if not destination.startswith('https://res.cloudinary.com/' + os.environ['CLOUDINARY_CLOUD'] + '/'):
            raise Invalid('Unexpected destination URL')
        with urllib.request.urlopen(destination, timeout=60) as response:
            delivered = response.read(asset['bytes'] + 1)
        if hashlib.sha256(delivered).hexdigest() != asset['sha256']:
            raise Invalid('Cloudinary delivery checksum mismatch')
        asset.update(verified_at=now(), destination=destination, asset_id=remote['asset_id'], status='verified', width=remote.get('width', asset.get('width')), height=remote.get('height', asset.get('height')))
        save(manifest)
    return manifest

def rewrite(catalog, manifest):
    if catalog['origin'] != manifest['origin']: raise Invalid('Asset manifest belongs to another source origin')
    if any(a.get('status') != 'verified' for a in manifest['assets'].values()):
        raise Invalid('Every required asset must have verified source/destination bytes')
    def walk(value):
        if isinstance(value, dict):
            return {k: walk(v) for k, v in value.items()}
        if isinstance(value, list):
            return [walk(v) for v in value]
        if isinstance(value, str):
            for source, a in sorted(manifest['assets'].items(), key=lambda kv: -len(kv[0])):
                for alias in [source, *a.get('aliases', [])]:
                    value = value.replace(alias, a['destination']).replace(alias.replace('&', '&amp;'), a['destination'])
                relative = urllib.parse.urlsplit(source)
                value = value.replace(relative.path + ('?' + relative.query if relative.query else ''), a['destination'])
            return value
        return value
    result = walk(catalog)
    for record in result['records']:
        if '/wp-content/' in json.dumps(record['value']):
            raise Invalid('Hosting-only reference remains in catalog')
    for row in result['review']:
        row['record_sha256'] = digest(next(r['value'] for r in result['records'] if r['kind'] == 'product' and r['key'] == str(row['id'])))
    return result

def redirects(manifest):
    out = {}
    for source, a in manifest['assets'].items():
        if a.get('status') != 'verified' or not a.get('destination', '').startswith('https://res.cloudinary.com/'):
            raise Invalid('Unverified redirect target')
        path = urllib.parse.urlsplit(source).path
        if not path.startswith('/wp-content/'):
            raise Invalid('Unexpected legacy asset path')
        if path in out and out[path] != a['destination']:
            raise Invalid('Conflicting query-based asset destinations require manual review')
        out[path] = a['destination']
    return out


def renew(manifest, source):
    if source not in manifest['assets']:
        raise Invalid('Unknown asset source')
    old = manifest['assets'][source]
    if not old.get('sha256'):
        raise Invalid('Download/verify the current source version first')
    used = {v['public_id'] for a in manifest['assets'].values() for v in [a, *a.get('history', [])]}
    stem, number = old['public_id'].rsplit('-', 1)
    n = int(number) + 1
    while f'{stem}-{n}' in used: n += 1
    historical = {k:v for k,v in old.items() if k != 'history'}
    manifest['assets'][source] = {'public_id': f'{stem}-{n}', 'alt': old['alt'], 'aliases': old.get('aliases', []), 'status':'pending', 'history': [*old.get('history', []), historical]}
    return manifest
