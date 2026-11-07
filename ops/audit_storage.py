#!/usr/bin/env python3
"""Report on the storage a running instance accumulates. Read-only, never deletes.

docs/operations.md gives single uploads a 1 GiB budget and /tmp 512 MiB, but
nothing watched the data directory as a whole. --budget is that whole-directory
limit and defaults well above one upload; point it at a data directory from cron
and this exits non-zero once the watermark is crossed, leaving a human to decide
what to prune.

  python3 ops/audit_storage.py --data-dir ./pb_data
  python3 ops/audit_storage.py --data-dir /var/lib/fangji/pb_data --json
"""
import argparse
import heapq
import json
import os
import shutil
import stat
import sys
import time
from pathlib import Path

# Mirrors backend/pdf_cache.go and backend/pdf_uploads.go.
TTLs = {
    'pdf-preview-cache-v1': 24 * 3600,
    'pdf-upload-staging-v1': 3600,
}
DEFAULT_BUDGET = 2 * 1024 ** 3


def human(size):
    for unit in ('B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'):
        if abs(size) < 1024 or unit == 'PiB':
            return f'{size:,.1f} {unit}'
        size /= 1024
    return f'{size:,.1f} PiB'


def walk_entries(root, findings, relative=()):
    """Stream each entry/stat once, ignoring links and tolerating swept files.

    A permissions/I/O error is an incomplete audit, never a successful zero-byte
    result. Keep the traversal bounded by directory depth instead of file count.
    """
    try:
        with os.scandir(root) as entries:
            for entry in entries:
                try:
                    info = entry.stat(follow_symlinks=False)
                except FileNotFoundError:
                    continue  # concurrent cache reclamation
                except OSError as error:
                    findings.append({'level': 'error', 'what': f'Cannot inspect {entry.path}: {error}'})
                    continue
                if stat.S_ISLNK(info.st_mode):
                    continue
                parts = (*relative, entry.name)
                yield entry.path, parts, info
                if stat.S_ISDIR(info.st_mode):
                    yield from walk_entries(entry.path, findings, parts)
    except FileNotFoundError:
        pass  # a cache directory may disappear during a sweep
    except OSError as error:
        findings.append({'level': 'error', 'what': f'Cannot scan {root}: {error}'})


def audit(data_dir, now, budget):
    findings = []
    if not data_dir.is_dir():
        return [{'level': 'error', 'what': f'{data_dir} is not a directory'}], {}

    total = 0
    largest = []
    caches = {}
    storage_bytes = None
    database_bytes = None
    for path, parts, info in walk_entries(data_dir, findings):
        directory = stat.S_ISDIR(info.st_mode)
        regular = stat.S_ISREG(info.st_mode)
        if len(parts) == 1 and directory:
            if parts[0] in TTLs:
                caches[parts[0]] = {'bytes': 0, 'entries': 0}
            elif parts[0] == 'storage':
                storage_bytes = 0
        if len(parts) == 1 and regular and parts[0] == 'data.db':
            database_bytes = info.st_size
        if regular:
            total += info.st_size
            item = (info.st_size, path)
            if len(largest) < 10:
                heapq.heappush(largest, item)
            elif item > largest[0]:
                heapq.heapreplace(largest, item)
            if len(parts) > 1 and parts[0] == 'storage' and storage_bytes is not None:
                storage_bytes += info.st_size
            if len(parts) > 1 and parts[0] in caches:
                caches[parts[0]]['bytes'] += info.st_size
        if len(parts) == 2 and parts[0] in caches and (directory or regular):
            caches[parts[0]]['entries'] += 1
            age = now - info.st_mtime
            ttl = TTLs[parts[0]]
            if parts[1].startswith('building-') and age > 3600:
                findings.append({'level': 'warn',
                                 'what': f'{path} is a crashed page-split left for {age / 3600:.0f}h'})
            elif age > 2 * ttl:
                findings.append({'level': 'warn',
                                 'what': f'{path} is {age / ttl:.1f} TTLs old; the in-process sweep has not reclaimed it'})
    try:
        free = shutil.disk_usage(data_dir).free
    except OSError as error:
        findings.append({'level': 'error', 'what': f'Cannot inspect filesystem space: {error}'})
        free = 0
    summary = {'data_dir': str(data_dir), 'total_bytes': total, 'free_bytes': free,
               'budget_bytes': budget}

    if total > budget:
        findings.append({'level': 'error',
                         'what': f'{data_dir} holds {human(total)}, over the {human(budget)} budget'})
    elif total > budget * 0.8:
        findings.append({'level': 'warn', 'what': f'{data_dir} is at {total / budget:.0%} of budget ({human(total)})'})
    if free < max(budget, 1024 ** 3):
        findings.append({'level': 'error', 'what': f'only {human(free)} free on the {data_dir} filesystem'})
    elif free < 5 * 1024 ** 3:
        findings.append({'level': 'warn', 'what': f'only {human(free)} free on the {data_dir} filesystem'})

    for name in TTLs:
        if name not in caches:
            # A renamed directory would otherwise switch these findings off silently.
            findings.append({'level': 'note', 'what': f'{name} is absent, so its TTL is not audited'})
            continue
        summary[name] = caches[name]
    if database_bytes is not None:
        summary['data.db'] = {'bytes': database_bytes}
    if storage_bytes is not None:
        summary['storage'] = {'bytes': storage_bytes}
    summary['largest'] = [{'path': path, 'bytes': size} for size, path in sorted(largest, reverse=True)]
    return findings, summary


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--data-dir', default='pb_data', type=Path)
    parser.add_argument('--budget', type=int, default=DEFAULT_BUDGET, help='bytes allowed before this alerts')
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--now', type=float, default=time.time(), help=argparse.SUPPRESS)
    args = parser.parse_args()

    findings, summary = audit(args.data_dir, args.now, args.budget)
    if args.json:
        print(json.dumps({'summary': summary, 'findings': findings}, ensure_ascii=False, indent=2))
    else:
        for key, value in sorted(summary.items()):
            if key in ('largest',):
                continue
            if isinstance(value, dict):
                print(f'{key:28} {human(value["bytes"])}')
            elif isinstance(value, int):
                print(f'{key:28} {human(value)}')
        for entry in summary.get('largest', [])[:5]:
            print(f'{"  " + Path(entry["path"]).name:30} {human(entry["bytes"])}')
        for finding in findings:
            stream = sys.stderr if finding['level'] == 'error' else sys.stdout
            print(f'{finding["level"].upper():5} {finding["what"]}', file=stream)
        if not findings:
            print('no storage findings')
    return 1 if any(finding['level'] == 'error' for finding in findings) else 0


if __name__ == '__main__':
    sys.exit(main())
