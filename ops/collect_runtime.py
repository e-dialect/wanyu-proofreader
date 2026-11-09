#!/usr/bin/env python3
"""Read-only container/storage samples; does not read DB rows or credentials."""
import argparse
import datetime
import json
import re
import shutil
import subprocess
import time
from pathlib import Path


def sample(data_dir, container=None):
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
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--container')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--interval', type=int, default=60)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    if args.interval < 5 or not args.data_dir.is_dir():
        parser.error('interval must be >=5s and data-dir must exist')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    while True:
        try:
            record = sample(args.data_dir, args.container)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            record = {'event': 'collection_gap', 'error_type': type(error).__name__,
                      'ts': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        with args.output.open('a') as output:
            output.write(json.dumps(record) + '\n')
        if args.once:
            return 1 if record['event'] == 'collection_gap' else 0
        time.sleep(args.interval)


if __name__ == '__main__':
    raise SystemExit(main())
