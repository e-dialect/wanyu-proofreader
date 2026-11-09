#!/usr/bin/env python3
"""Verified full-directory backups. Stop the application before invoking."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile


def inventory(root):
    result = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError(f'Symlinks are not supported: {path}')
        if path.is_file():
            with path.open('rb') as stream:
                digest = hashlib.sha256()
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(block)
            result[path.relative_to(root).as_posix()] = digest.hexdigest()
        elif not path.is_dir():
            raise ValueError(f'Unsupported file type: {path}')
    return result


def check_databases(root):
    databases = list(root.rglob('*.db'))
    if not databases:
        raise ValueError('No SQLite databases found')
    for path in databases:
        with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
            if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise ValueError(f'SQLite integrity check failed: {path.name}')


def backup(source, destination, version):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if not source.is_dir() or destination.exists():
        raise ValueError('Source must exist and destination must not exist')
    if source == destination or source in destination.parents:
        raise ValueError('Backup destination must be outside the data directory')
    if not isinstance(version, str) or not 1 <= len(version) <= 512 or any(ord(char) < 32 or ord(char) > 126 for char in version):
        raise ValueError('Version must be a bounded printable image digest or commit')
    created_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    before = inventory(source)
    if not before:
        raise ValueError('Refusing to back up an empty directory')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.backup-', dir=destination.parent) as staging:
        stage = Path(staging)
        stage.chmod(0o700)
        shutil.copytree(source, stage / 'data')
        copied = inventory(stage / 'data')
        if copied != before or inventory(source) != before:
            raise ValueError('Source changed during backup; stop the application and retry')
        check_databases(stage / 'data')
        # SQLite may manage sidecars even on a read-only connection. Record the
        # delivered copy after validation; never open the live source database.
        manifest = {'format': 1, 'version': version, 'created_at': created_at, 'files': inventory(stage / 'data')}
        (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        # This receipt becomes visible only with the atomically published,
        # hash-verified directory. Restore never trusts it instead of the manifest.
        receipt = {'format': 1, 'status': 'pass', 'created_at': created_at,
                   'verified_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   'version': version, 'files': len(manifest['files'])}
        (stage / 'receipt.json').write_text(json.dumps(receipt) + '\n')
        stage.rename(destination)
    return len(manifest['files'])


def restore(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if destination.exists():
        raise ValueError('Restore destination must not exist; existing data is never overwritten')
    if source == destination or source in destination.parents:
        raise ValueError('Restore destination must be outside the backup')
    if (source / 'manifest.json').is_symlink() or (source / 'data').is_symlink():
        raise ValueError('Backup entries must not be symlinks')
    manifest = json.loads((source / 'manifest.json').read_text())
    if manifest.get('format') != 1 or inventory(source / 'data') != manifest.get('files'):
        raise ValueError('Backup manifest mismatch: missing, extra or corrupted files')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.restore-', dir=destination.parent) as staging:
        data = Path(staging) / 'data'
        shutil.copytree(source / 'data', data)
        if inventory(data) != manifest['files']:
            raise ValueError('Backup changed during restore')
        check_databases(data)
        data.chmod(0o700)
        data.rename(destination)
    return manifest['version']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    create = commands.add_parser('backup')
    create.add_argument('source')
    create.add_argument('destination')
    create.add_argument('--version', required=True, help='Application image digest or commit')
    create.add_argument('--application-stopped', action='store_true', required=True,
                        help='Confirm all application writers are stopped (including file uploads)')
    recover = commands.add_parser('restore')
    recover.add_argument('source')
    recover.add_argument('destination')
    args = parser.parse_args()
    if args.command == 'backup':
        print(f'PASS: backed up {backup(args.source, args.destination, args.version)} files')
    else:
        print(f'PASS: restored application version {restore(args.source, args.destination)}')


if __name__ == '__main__':
    main()
