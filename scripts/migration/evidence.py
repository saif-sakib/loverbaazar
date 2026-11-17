"""Record private backup evidence without extracting files or printing customer data."""
import gzip
from pathlib import Path
import tarfile
import zipfile
from datetime import datetime, timezone
from .core import Invalid, file_hash, private

REQUIRED = {'sql_backup', 'uploads_backup', 'dns_zone', 'hosting_inventory'}

def inspect_evidence(paths, max_unpacked=5 * 1024 ** 3):
    if set(paths) != REQUIRED:
        raise Invalid('Provide SQL, uploads/files, DNS and hosting/mailbox evidence explicitly')
    result = {}
    for kind, raw in paths.items():
        p = private(raw)
        if not p.is_file() or p.stat().st_size == 0:
            raise Invalid('Evidence file is missing or empty: ' + kind)
        check = 'readable file; contents need owner/restore verification'
        if p.suffix == '.gz':
            total = 0
            with gzip.open(p, 'rb') as f:
                for chunk in iter(lambda: f.read(64 * 1024), b''):
                    total += len(chunk)
                    if total > max_unpacked:
                        raise Invalid('Backup exceeds the declared unpacked-size inspection limit')
            check = 'gzip CRC and stream verified; restore still required'
        if p.name.endswith(('.tar', '.tar.gz', '.tgz')):
            with tarfile.open(p) as archive:
                for member in archive:
                    if member.name.startswith('/') or '..' in Path(member.name).parts:
                        raise Invalid('Unsafe archive path; do not extract automatically')
            check += '; tar listing verified without extraction'
        elif p.suffix == '.zip':
            with zipfile.ZipFile(p) as archive:
                if sum(info.file_size for info in archive.infolist()) > max_unpacked:
                    raise Invalid('ZIP exceeds inspection size limit')
                if any(info.filename.startswith('/') or '..' in Path(info.filename).parts for info in archive.infolist()) or archive.testzip():
                    raise Invalid('Invalid or unsafe ZIP backup')
            check = 'ZIP CRC verified without extraction; restore still required'
        result[kind] = {'filename': p.name, 'bytes': p.stat().st_size, 'sha256': file_hash(p), 'modified_utc': datetime.fromtimestamp(p.stat().st_mtime, timezone.utc).isoformat(), 'readability': check}
    return {'evidence': result, 'restore_verified': False, 'owner_approval': False}
