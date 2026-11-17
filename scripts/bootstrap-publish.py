#!/usr/bin/env python3
"""Explicit first Publish through the existing Worker; prompts privately for ADMIN_TOKEN."""
import argparse
import getpass
import json
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward the admin credential to another address.
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('shop', help='HTTPS preview shop origin, without /api')
    args = parser.parse_args()
    origin = urllib.parse.urlsplit(args.shop)
    if (origin.scheme != 'https' or not origin.hostname or origin.username
            or origin.password or origin.query or origin.fragment
            or origin.path not in ('', '/')):
        parser.error('Use the HTTPS shop origin only, without credentials, a path or query')
    password = getpass.getpass('Enter your existing preview admin password: ').strip()
    if not password:
        parser.error('The existing admin password is required')
    request = urllib.request.Request(
        args.shop.rstrip('/') + '/api/admin/publish',
        data=b'{}',
        headers={
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            # Cloudflare blocks the default Python urllib agent on workers.dev.
            'User-Agent': 'loverbaazar-release/1.0',
            'X-Admin-Token': password,
        },
        method='POST',
    )
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=90) as response:
            result = json.load(response)
        print(result.get('message', 'Publish request accepted.'))
        print('Open GitHub Actions → Publish store and wait for the run to finish.')
        return 0
    except urllib.error.HTTPError as error:
        print(f'Publish failed (HTTP {error.code}): {error.read(1000).decode(errors="replace")}')
    except (urllib.error.URLError, TimeoutError, ValueError):
        print('The publish response could not be confirmed. Check GitHub Actions before retrying.')
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
