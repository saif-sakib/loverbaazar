#!/usr/bin/env python3
"""Create and verify encrypted LoverBaazar database snapshots; restore only to an empty local drill database."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone
from urllib.parse import parse_qsl, unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
FILES = {'database.pgdump', 'manifest.json', 'legacy-assets.json'}
BUDGET = 64 * 1024 * 1024


class BackupError(Exception):
    pass


def command(args, *, env=None, stdin=None, stdout=subprocess.PIPE, text_input=None):
    try:
        result = subprocess.run(args, env=env, stdin=stdin, stdout=stdout, stderr=subprocess.DEVNULL,
                                input=text_input, check=True, timeout=240)
    except (OSError, subprocess.SubprocessError) as error:
        raise BackupError(f'{args[0]} failed while processing the backup. Check connectivity, tool versions and the key.') from error
    return result.stdout


def pg(tool, *args, url='', stdin=None, stdout=subprocess.PIPE):
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    values = {'PGCONNECT_TIMEOUT': '15'}
    if url:
        u = urlsplit(url)
        query = dict(parse_qsl(u.query))
        values.update(PGHOST=u.hostname, PGPORT=str(u.port or 5432), PGDATABASE=unquote(u.path[1:]),
                      PGUSER=unquote(u.username or ''), PGPASSWORD=unquote(u.password or ''))
        for name, variable in {'sslmode': 'PGSSLMODE', 'channel_binding': 'PGCHANNELBINDING', 'sslrootcert': 'PGSSLROOTCERT'}.items():
            if name in query:
                values[variable] = query[name]
    env.update(values)
    prefix = []
    if os.environ.get('BACKUP_PG_DOCKER') == '1':
        prefix = ['docker', 'run', '--rm', '-i', '--network', 'host']
        for name in values:
            prefix.extend(['-e', name])
        prefix.append('postgres:18-alpine')
    return command([*prefix, tool, *args], env=env, stdin=stdin, stdout=stdout)


def key():
    passphrase = os.environ.get('BACKUP_PASSPHRASE', '')
    if len(passphrase) < 32 or any(c in passphrase for c in '\r\n'):
        raise BackupError('Set BACKUP_PASSPHRASE to the strong key stored outside hosting accounts.')
    return passphrase.encode() + b'\n'


def database_url(name, local_only=False):
    value = os.environ.get(name, '')
    url = urlsplit(value)
    if url.scheme not in {'postgres', 'postgresql'} or not url.hostname or '-pooler' in url.hostname or url.fragment or not url.path.lstrip('/') or ',' in url.hostname:
        raise BackupError(f'Set {name} to a direct PostgreSQL connection string.')
    query = dict(parse_qsl(url.query, keep_blank_values=True))
    if any(k not in {'sslmode', 'channel_binding', 'sslrootcert'} for k in query) or 'sslrootcert' in query and query['sslrootcert'] != 'system':
        raise BackupError(f'{name} contains an unsupported connection option.')
    loopback = url.hostname in {'127.0.0.1', '::1'}
    if local_only and (not loopback or url.path != '/lb_restore' or not url.port):
        raise BackupError('Restore target must be a fresh loopback database named lb_restore on an explicit port.')
    if not loopback and query.get('sslmode') not in {'require', 'verify-ca', 'verify-full'}:
        raise BackupError('Remote backup connections require TLS.')
    return value


def workspace(path):
    resolved = Path(path).expanduser().resolve()
    if resolved == ROOT or ROOT in resolved.parents or any(part in {'public_html', 'htdocs', 'www'} for part in resolved.parts):
        raise BackupError('Keep database artifacts in a private directory outside the checkout and web roots.')
    return resolved


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def crypt(gpg_home, archive, file, decrypt=False):
    args = ['gpg', '--homedir', str(gpg_home), '--batch', '--pinentry-mode', 'loopback', '--passphrase-fd', '0']
    action = ['--decrypt'] if decrypt else ['--symmetric', '--cipher-algo', 'AES256', '--s2k-digest-algo', 'SHA512',
                                          '--s2k-mode', '3', '--s2k-count', '65011712']
    command([*args, *action, '--output', str(file), str(archive)], text_input=key())


def check_dump(dump, full=False):
    with dump.open('rb') as stream:
        toc = pg('pg_restore', '--list', stdin=stream).decode()
    required = ('orders', 'order_items', 'settings', 'products', 'content', 'releases', 'schema_migrations')
    if any(not re.search(rf'TABLE DATA public {table} ', toc) for table in required):
        raise BackupError('Database archive is missing required storefront tables.')
    if full:
        with dump.open('rb') as stream:
            pg('pg_restore', '--file=/dev/null', stdin=stream, stdout=subprocess.DEVNULL)


def decode(encrypted, directory, gpg_home, full=True):
    if not encrypted.is_file() or not 0 < encrypted.stat().st_size <= BUDGET:
        raise BackupError('Missing, empty or oversized encrypted backup.')
    bundle = directory / 'package.tar'
    crypt(gpg_home, encrypted, bundle, decrypt=True)
    with tarfile.open(bundle) as source:
        members = source.getmembers()
        if len(members) != len(FILES) or {m.name for m in members} != FILES or any(not m.isfile() or m.size > BUDGET for m in members):
            raise BackupError('Backup package has unexpected contents.')
        source.extractall(directory, filter='data')
    manifest = json.loads((directory / 'manifest.json').read_text())
    if manifest.get('format') != 1 or any(manifest.get('sha256', {}).get(name) != digest(directory / name) for name in FILES - {'manifest.json'}):
        raise BackupError('Backup manifest checksum verification failed.')
    check_dump(directory / 'database.pgdump', full)
    return manifest


def make(output, gpg_home):
    if output.exists() or not output.parent.is_dir():
        raise BackupError('Output requires an existing private parent and a new filename.')
    url = database_url('BACKUP_DATABASE_URL')
    # Stage beside the destination to publish atomically, without overwriting a previous archive.
    with tempfile.TemporaryDirectory(prefix='.lb-backup-', dir=output.parent) as temp:
        stage = Path(temp)
        dump = stage / 'database.pgdump'
        started = datetime.now(timezone.utc).isoformat()
        with dump.open('wb') as stream:
            pg('pg_dump', '-Fc', '--no-owner', '--no-privileges', url=url, stdout=stream)
        if not 0 < dump.stat().st_size < BUDGET:
            raise BackupError('Database dump is empty or exceeds the 64 MiB backup budget.')
        check_dump(dump)
        with dump.open('rb') as stream:
            migration = pg('pg_restore', '--data-only', '-t', 'schema_migrations', '-f', '-', stdin=stream).decode()
        schema = re.findall(r'^([0-9]+)\t([a-f0-9]{64})\t', migration, flags=re.M)
        if not schema:
            raise BackupError('Snapshot does not contain schema revision metadata.')
        legacy = stage / 'legacy-assets.json'
        legacy.write_bytes((ROOT / 'apps/store/public/legacy-assets.json').read_bytes())
        revision = os.environ.get('GITHUB_SHA') or command(['git', '-C', str(ROOT), 'rev-parse', 'HEAD']).decode().strip()
        if not re.fullmatch(r'[a-f0-9]{40}', revision):
            raise BackupError('Could not identify backup config revision.')
        manifest = {'format': 1, 'startedAt': started, 'configCommit': revision,
                    'schemaMigrations': [{'version': int(v), 'checksum': h} for v, h in schema],
                    'sha256': {name: digest(stage / name) for name in FILES - {'manifest.json'}},
                    'configuration': ['render.yaml', '.env.example', 'apps/store/wrangler.jsonc'],
                    'media': 'Stored image references are in the database snapshot. Preserve the verified original media and migration manifest separately.'}
        (stage / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True))
        package = stage / 'backup.tar'
        with tarfile.open(package, 'w') as archive:
            for name in sorted(FILES):
                archive.add(stage / name, name, recursive=False)
        candidate = stage / 'backup.tar.gpg'
        crypt(gpg_home, package, candidate)
        verified = stage / 'verified'
        verified.mkdir(mode=0o700)
        decode(candidate, verified, gpg_home)
        candidate.chmod(0o600)
        os.link(candidate, output)
    return manifest


def restore(archive, directory, gpg_home):
    url = database_url('RESTORE_DATABASE_URL', local_only=True)
    manifest = decode(archive, directory, gpg_home)
    if pg('psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-c',
          "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='public'", url=url).strip() != b'0':
        raise BackupError('Restore target is not an empty database.')
    with (directory / 'database.pgdump').open('rb') as stream:
        pg('pg_restore', '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', '-d', 'lb_restore',
           url=url, stdin=stream, stdout=subprocess.DEVNULL)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('create', 'verify', 'restore'))
    parser.add_argument('archive', help='Private output/archive path outside Git')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        archive = workspace(args.archive)
        with tempfile.TemporaryDirectory(prefix='lb-db-package-') as temp:
            work = Path(temp)
            gpg_home = work / 'gnupg'
            gpg_home.mkdir(mode=0o700)
            if args.mode == 'create':
                manifest = make(archive, gpg_home)
            elif args.mode == 'restore':
                manifest = restore(archive, work, gpg_home)
            else:
                manifest = decode(archive, work, gpg_home)
        print(json.dumps({'event': 'backup_' + args.mode + '_verified', 'startedAt': manifest['startedAt'],
                          'bytes': archive.stat().st_size, 'configCommit': manifest['configCommit']}))
    except (BackupError, OSError, ValueError, KeyError, tarfile.TarError) as error:
        message = str(error) if isinstance(error, BackupError) else 'Backup file or configuration could not be verified.'
        parser.exit(1, f'{message}\n')


if __name__ == '__main__':
    main()
