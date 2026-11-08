#!/usr/bin/env python3
"""Read-only container/storage samples; does not read DB rows or credentials."""
import argparse
import datetime
import errno
import json
import logging
import os
import stat
from logging.handlers import RotatingFileHandler
import re
import shutil
import subprocess
import time
from pathlib import Path

from audit_storage import TTLs, walk_entries

RECEIPT_LIMIT = 8192
DEFAULT_BACKUP_MAX_AGE = 24 * 3600


def timestamp(value):
    return datetime.datetime.fromtimestamp(value, datetime.timezone.utc).isoformat()


def cache_sizes(data_dir):
    """Inspect only known cache metadata; never follow cache-root links."""
    result = {}
    for name in TTLs:
        root = data_dir / name
        try:
            mode = root.lstat().st_mode
            if not stat.S_ISDIR(mode):
                result[name] = {'status': 'gap', 'error_type': 'Symlink' if stat.S_ISLNK(mode) else 'NotDirectory'}
                continue
        except FileNotFoundError:
            result[name] = {'status': 'absent', 'bytes': 0, 'files': 0}
            continue
        except OSError as error:
            result[name] = {'status': 'gap', 'error_type': type(error).__name__}
            continue
        findings, size, files = [], 0, 0
        for _, _, info in walk_entries(root, findings):
            if stat.S_ISREG(info.st_mode):
                size += info.st_size
                files += 1
        if findings:
            # Do not log file names or exception messages from storage paths.
            result[name] = {'status': 'gap', 'error_type': 'IncompleteScan', 'partial_bytes': size,
                            'errors': len(findings)}
        else:
            result[name] = {'status': 'ok', 'bytes': size, 'files': files}
    return result


class CacheSampler:
    """Cache directory walks separately from cheap runtime samples."""
    def __init__(self, interval=300):
        self.interval = interval
        self.previous = None
        self.directory = None

    def get(self, data_dir, now=None, tick=None):
        now = time.time() if now is None else now
        tick = time.monotonic() if tick is None else tick
        directory = Path(data_dir).absolute()
        if self.previous is None or self.directory != directory or tick - self.tick >= self.interval:
            self.previous = cache_sizes(directory)
            self.sampled_at, self.tick, self.directory = now, tick, directory
        return {'sampled_at': timestamp(self.sampled_at), 'age_seconds': max(0, tick - self.tick), 'directories': self.previous}


def backup_receipt(path, now=None, max_age=DEFAULT_BACKUP_MAX_AGE):
    """A bounded local success receipt, not a restore/offsite/hash recheck."""
    now = time.time() if now is None else now
    result = {'evidence': 'local_backup_receipt_only', 'restore_verified': False,
              'offsite_verified': False, 'integrity_rechecked': False}
    if path is None:
        return {**result, 'status': 'not_configured'}
    try:
        # O_NONBLOCK also avoids hanging on a FIFO before fstat rejects it.
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
        if Path(path).is_symlink():
            return {**result, 'status': 'invalid', 'error_type': 'Symlink'}
        fd = os.open(path, flags)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                return {**result, 'status': 'invalid', 'error_type': 'NotRegularFile'}
            if info.st_size >= RECEIPT_LIMIT:
                return {**result, 'status': 'invalid', 'error_type': 'TooLarge'}
            raw = stream.read(RECEIPT_LIMIT)
            if len(raw) >= RECEIPT_LIMIT:
                return {**result, 'status': 'invalid', 'error_type': 'TooLarge'}
        def unique_fields(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError('duplicate field')
                value[key] = item
            return value
        receipt = json.loads(raw, object_pairs_hook=unique_fields)
        if not isinstance(receipt, dict) or type(receipt.get('format')) is not int or receipt.get('format') != 1 or receipt.get('status') != 'pass':
            raise ValueError('schema')
        version, files = receipt.get('version'), receipt.get('files')
        if not isinstance(version, str) or not 1 <= len(version) <= 512 or any(ord(char) < 32 or ord(char) > 126 for char in version):
            raise ValueError('version')
        if type(files) is not int or not 1 <= files <= 10**12:
            raise ValueError('files')
        def instant(value):
            if not isinstance(value, str) or len(value) > 64:
                raise ValueError('timestamp')
            parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                raise ValueError('timezone')
            return parsed.timestamp()
        verified = instant(receipt.get('verified_at'))
        if verified > now + 300:
            raise ValueError('future timestamp')
        created = instant(receipt['created_at']) if 'created_at' in receipt else None
        if created is not None and created > verified:
            raise ValueError('timestamp order')
        age = max(0, now - verified)
        result.update(status='expired' if age > max_age else 'current', verified_at=timestamp(verified),
                      age_seconds=age, version=version, files=files, max_age_seconds=max_age)
        if created is not None:
            result['created_at'] = timestamp(created)
        return result
    except FileNotFoundError:
        return {**result, 'status': 'missing'}
    except (ValueError, TypeError, OverflowError, UnicodeError, RecursionError):
        return {**result, 'status': 'invalid', 'error_type': 'InvalidReceipt'}
    except OSError as error:
        if error.errno == errno.ELOOP:
            return {**result, 'status': 'invalid', 'error_type': 'Symlink'}
        return {**result, 'status': 'gap', 'error_type': type(error).__name__}


def sample(data_dir, container=None, *, caches=None, receipt_path=None, backup_max_age=DEFAULT_BACKUP_MAX_AGE):
    result = {'event': 'container_sample', 'ts': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    result['database_bytes'] = (data_dir / 'data.db').stat().st_size if (data_dir / 'data.db').exists() else 0
    result['wal_bytes'] = (data_dir / 'data.db-wal').stat().st_size if (data_dir / 'data.db-wal').exists() else 0
    result['disk_free_bytes'] = shutil.disk_usage(data_dir).free
    if container:
        process = subprocess.run(['docker', 'stats', '--no-stream', '--format', '{{json .}}', container],
                                 capture_output=True, text=True, timeout=15, check=True)
        raw = json.loads(process.stdout)
        result['cpu_percent'] = raw['CPUPerc']
        result['memory_usage'] = raw['MemUsage']
        units = {'B': 1, 'KiB': 1024, 'MiB': 1024**2, 'GiB': 1024**3, 'kB': 1000, 'MB': 1000**2, 'GB': 1000**3}
        match = re.match(r'([0-9.]+)([A-Za-z]+)', raw['MemUsage'])
        if match and match[2] in units:
            result['container_memory_bytes'] = int(float(match[1]) * units[match[2]])
        result['pids'] = raw['PIDs']
    result['cache_usage'] = caches if caches is not None else CacheSampler().get(data_dir)
    result['backup'] = backup_receipt(receipt_path, max_age=backup_max_age)
    gaps = ['cache:' + name for name, value in result['cache_usage']['directories'].items() if value['status'] == 'gap']
    if result['backup']['status'] in ('missing', 'invalid', 'gap'):
        gaps.append('backup_receipt')
    if gaps:
        result['collection_gaps'] = gaps
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--container')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--interval', type=int, default=60)
    parser.add_argument('--cache-interval', type=int, default=300, help='seconds between cache directory walks (minimum 60)')
    parser.add_argument('--backup-receipt', type=Path, help='optional local backup receipt.json; does not recheck backup contents')
    parser.add_argument('--backup-max-age', type=int, default=DEFAULT_BACKUP_MAX_AGE, help='receipt expiry in seconds (default 24 hours)')
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--max-bytes', type=int, default=10*1024*1024)
    parser.add_argument('--backups', type=int, default=5)
    args = parser.parse_args()
    if args.interval < 5 or not args.data_dir.is_dir():
        parser.error('interval must be >=5s and data-dir must exist')
    if args.cache_interval < 60 or args.backup_max_age < 1:
        parser.error('cache-interval must be >=60s and backup-max-age positive')
    if args.max_bytes < 1024 or not 1 <= args.backups <= 30:
        parser.error('max-bytes >=1024 and backups 1..30 required')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(args.output, maxBytes=args.max_bytes, backupCount=args.backups)
    handler.setFormatter(logging.Formatter('%(message)s'))
    caches = CacheSampler(args.cache_interval)
    while True:
        try:
            record = sample(args.data_dir, args.container, caches=caches.get(args.data_dir), receipt_path=args.backup_receipt, backup_max_age=args.backup_max_age)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            record = {'event': 'collection_gap', 'error_type': type(error).__name__,
                      'ts': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        records = [record]
        if record.get('collection_gaps'):
            # Preserve valid CPU/storage samples while the existing aggregator
            # independently marks the observation window incomplete.
            records.append({'event': 'collection_gap', 'ts': record['ts'], 'scopes': record['collection_gaps']})
        for item in records:
            handler.emit(logging.makeLogRecord({'msg': json.dumps(item)}))
        handler.flush()
        if args.once:
            return 1 if record['event'] == 'collection_gap' or record.get('collection_gaps') else 0
        time.sleep(args.interval)


if __name__ == '__main__':
    raise SystemExit(main())
