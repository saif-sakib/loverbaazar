#!/usr/bin/env python3
"""Read-only maintenance report. No database access, admin token, writes or retries."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import re
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, Request

MAX_BYTES = 1024 * 1024
METRICS = {
    'cloudflare.requests': 'day',
    'cloudflare.cpu_ms': 'current',
    'cloudflare.asset_files': 'current',
    'render.hours': 'month',
    'render.bandwidth': 'month',
    'render.build_minutes': 'month',
    'neon.compute_hours': 'month',
    'neon.storage': 'current',
    'neon.transfer': 'month',
    'cloudinary.credits': 'rolling30d',
    'brevo.sends': 'day',
    'github.storage': 'current',
}


def instant(value):
    stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if stamp.tzinfo is None:
        raise ValueError('Timestamp requires a timezone')
    return stamp


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def public_get(site, path, timeout):
    started = time.monotonic()
    try:
        req = Request(site + path, headers={'User-Agent': 'loverbaazar-maintenance/1.0'})
        with build_opener(NoRedirect).open(req, timeout=timeout) as response:
            body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise ValueError('Oversized response')
            return response.status, body, round((time.monotonic() - started) * 1000)
    except HTTPError as error:
        status = error.code
        error.close()
        return status, b'', round((time.monotonic() - started) * 1000)
    except (URLError, OSError, ValueError):
        return 0, b'', round((time.monotonic() - started) * 1000)


def public_checks(site, timeout):
    checks = []
    payloads = {}
    for path in ('/api/health', '/api/ready', '/release.json'):
        status, body, elapsed = public_get(site, path, timeout)
        valid = status == 200 and (path != '/api/health' or body.strip() == b'ok')
        if path != '/api/health':
            try:
                data = json.loads(body)
                valid = valid and isinstance(data, dict)
                if path == '/api/ready':
                    valid = valid and data.get('ready') is True and bool(re.fullmatch(r'[a-f0-9]{40}', data.get('version', '')))
                else:
                    valid = valid and data.get('environment') == 'production' and bool(re.fullmatch(r'[a-f0-9]{40}', data.get('commit', '')))
                if valid:
                    payloads[path] = data
            except (ValueError, TypeError, AttributeError):
                valid = False
        checks.append({'check': path, 'status': 'pass' if valid else 'action',
                       'http': status, 'elapsedMs': elapsed})
    ready, release = payloads.get('/api/ready'), payloads.get('/release.json')
    checks.append({'check': 'release-match', 'status': 'pass' if ready and release and ready['version'] == release['commit'] else 'action',
                   'commit': release['commit'] if release else None})
    return checks


def gh(path):
    # Only fixed GitHub REST GET endpoints; never inherit a hostname from input.
    result = subprocess.run(['gh', 'api', '--method', 'GET', '--hostname', 'github.com', path],
                            check=True, capture_output=True, text=True, timeout=30)
    return json.loads(result.stdout)


def backup_checks(repo, now):
    prefix = f'repos/{repo}/actions'
    checks = []
    try:
        workflows = gh(prefix + '/workflows?per_page=100')['workflows']
        for filename in ('backup.yml', 'backup-watch.yml'):
            workflow = next((w for w in workflows if w['path'] == '.github/workflows/' + filename), None)
            checks.append({'check': filename + '-enabled',
                           'status': 'pass' if workflow and workflow['state'] == 'active' else 'action'})
        runs = gh(prefix + '/workflows/backup.yml/runs?branch=main&per_page=10')['workflow_runs']
        good = next((r for r in runs if r.get('conclusion') == 'success'
                     and timedelta(0) <= now - instant(r['created_at']) < timedelta(hours=26)), None)
        if not good:
            checks.append({'check': 'verified-backup', 'status': 'action', 'reason': 'No successful backup within 26 hours'})
            return checks
        artifacts = gh(prefix + f'/runs/{good["id"]}/artifacts?per_page=100')['artifacts']
        artifacts = [a for a in artifacts if a['name'].startswith('loverbaazar-verified-backup-')
                     and not a['expired'] and a['size_in_bytes'] > 0 and instant(a['expires_at']) > now]
        checks.append({'check': 'verified-backup', 'status': 'pass' if artifacts else 'action',
                       'run': good['html_url'], 'createdAt': good['created_at'],
                       'artifacts': [{k: a[k] for k in ('size_in_bytes', 'expires_at')} for a in artifacts]})
        latest = runs[0] if runs else {}
        if latest.get('status') == 'completed' and latest.get('conclusion') != 'success':
            checks.append({'check': 'latest-backup', 'status': 'action', 'reason': 'Latest backup failed; earlier success does not clear it'})
        watch = gh(prefix + '/workflows/backup-watch.yml/runs?branch=main&per_page=1')['workflow_runs']
        watch = watch[0] if watch else {}
        recent = bool(watch) and timedelta(0) <= now - instant(watch['created_at']) < timedelta(hours=26)
        checks.append({'check': 'backup-freshness-watch', 'status': 'pass' if recent and watch.get('conclusion') == 'success' else 'action'})
    except (subprocess.SubprocessError, OSError, ValueError, KeyError, TypeError):
        checks.append({'check': 'github-backup-access', 'status': 'unknown', 'reason': 'Could not verify GitHub metadata; check gh authentication and connectivity'})
    return checks


def usage_checks(data, now):
    if not isinstance(data, dict) or set(data) - set(METRICS):
        raise ValueError('Usage file must be an object with only the documented metric names')
    checks = []
    for name, period in METRICS.items():
        row = data.get(name)
        result = {'check': name, 'status': 'unknown', 'reason': 'Owner dashboard reading required'}
        if row is not None:
            if not isinstance(row, dict) or set(row) != {'used', 'limit', 'period', 'observedAt'}:
                raise ValueError('Each reading needs used, limit, period and observedAt')
            if row['period'] != period:
                raise ValueError('Usage period does not match the documented metric')
            used, limit = row['used'], row['limit']
            if any(type(v) not in (int, float) or not math.isfinite(v) for v in (used, limit)) or used < 0 or limit <= 0:
                raise ValueError('Usage must be finite and nonnegative; limit must be positive')
            age = now - instant(row['observedAt'])
            if age < timedelta(0) or age > timedelta(hours=26 if period == 'day' else 8 * 24):
                result['reason'] = 'Dashboard reading is stale or in the future'
            else:
                percent = used / limit * 100
                result = {'check': name, 'status': 'action' if percent >= 85 else 'warning' if percent >= 70 else 'pass',
                          'percent': round(percent, 2), 'urgent': percent >= 95, 'observedAt': row['observedAt']}
        checks.append(result)
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--site', default='https://loverbaazar.com', help='Canonical production origin')
    parser.add_argument('--repo', default='saif-sakib/loverbaazar')
    parser.add_argument('--usage', type=Path, help='Private dashboard readings; see docs/maintenance.md')
    parser.add_argument('--timeout', type=int, choices=range(1, 61), default=15, metavar='1..60')
    args = parser.parse_args()
    site = urlsplit(args.site)
    if site.scheme != 'https' or not site.hostname or site.username or site.password or site.path not in ('', '/') or site.query or site.fragment:
        parser.error('--site must be an HTTPS origin without credentials, path or query')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repo):
        parser.error('--repo must be owner/repository')
    now = datetime.now(timezone.utc)
    try:
        if args.usage and args.usage.stat().st_size > MAX_BYTES:
            raise ValueError('Oversized usage file')
        data = json.loads(args.usage.read_text()) if args.usage else {}
        usage = usage_checks(data, now)
    except (OSError, ValueError, TypeError, AttributeError, OverflowError):
        parser.exit(2, 'Invalid usage file. See docs/maintenance.md; file contents were not printed.\n')
    checks = public_checks(args.site.rstrip('/'), args.timeout) + backup_checks(args.repo, now) + usage
    print(json.dumps({'observedAt': now.isoformat(), 'checks': checks}, indent=2))
    return int(any(c['status'] != 'pass' for c in checks))


if __name__ == '__main__':
    raise SystemExit(main())
