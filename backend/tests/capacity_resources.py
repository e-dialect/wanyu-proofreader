"""Read-only server resource sampling; missing budgets are never invented."""
from contextlib import closing
import json
import math
import shutil
import sqlite3
import subprocess
import threading
import time
from pathlib import Path


def phase_at(config, now):
    elapsed = now - config['start_epoch_ms'] / 1000
    if elapsed < 0: return 'waiting'
    for phase in config['phases']:
        if elapsed < phase['seconds']: return phase['name']
        elapsed -= phase['seconds']
    return 'recovery'


def trend(rows, key):
    points = [(r['at_ms'] / 1000, r[key]) for r in rows if isinstance(r.get(key), (int, float))]
    if not points: return {'samples': 0}
    duration = points[-1][0] - points[0][0]
    return {'samples': len(points), 'first': points[0][1], 'last': points[-1][1],
            'peak': max(v for _, v in points), 'delta': points[-1][1] - points[0][1],
            'per_second': (points[-1][1] - points[0][1]) / duration if duration > 0 else None}


def production_runtime_status(rows):
    modes = [row['dev_mode'] for row in rows if row.get('dev_mode') is not None]
    if any(mode is True for mode in modes):
        return 'fail'
    if not modes or any(type(mode) is not bool for mode in modes):
        return 'incomplete'
    return 'pass'


class ResourceSampler:
    interval_seconds = 5

    def __init__(self, pid, root, config, frontend_pid=None, target_group=None):
        self.pid, self.root, self.config = int(pid), Path(root), config
        self.output = Path(config['output'])
        self.rows, self.last_runtime = [], None
        self.frontend_pid = frontend_pid
        self.target_group = target_group
        self.directory_sample = None
        self.sample_lock = threading.Lock()
        self.log_offset = (self.root/'server.log').stat().st_size
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.sample()
        self.thread.start()

    def _run(self):
        next_sample = time.monotonic() + self.interval_seconds
        while not self.stopped.wait(max(0, next_sample - time.monotonic())):
            self.sample()
            next_sample += self.interval_seconds

    def sample(self):
        with self.sample_lock:
            self._sample()

    def _sample(self):
        now = time.time()
        row = {'at_ms': round(now * 1000), 'phase': phase_at(self.config, now), 'errors': {}}
        if 'observation' in self.config:
            row['observation'] = self.config['observation']
        try:
            values = subprocess.check_output(['ps', '-p', str(self.pid), '-o', 'rss=', '-o', 'pcpu='], text=True, timeout=2).split()
            row['server_rss_bytes'] = int(values[0]) * 1024
            row['server_cpu_percent'] = float(values[1])
        except (OSError, subprocess.SubprocessError, ValueError, IndexError) as error:
            row['errors']['server_process'] = type(error).__name__
        if self.frontend_pid is not None:
            try:
                values = subprocess.check_output(['ps', '-p', str(self.frontend_pid), '-o', 'rss=', '-o', 'pcpu='], text=True, timeout=2).split()
                row['frontend_rss_bytes'] = int(values[0]) * 1024
                row['frontend_cpu_percent'] = float(values[1])
            except (OSError, subprocess.SubprocessError, ValueError, IndexError) as error:
                row['errors']['frontend_process'] = type(error).__name__
        if self.target_group is not None:
            try:
                processes = subprocess.check_output(['ps', '-axo', 'pgid=,rss=,pcpu='], text=True, timeout=2).splitlines()
                owned = [line.split() for line in processes if line.split() and int(line.split()[0]) == self.target_group]
                row['target_group_rss_bytes'] = sum(int(parts[1])*1024 for parts in owned)
                row['target_group_cpu_percent'] = sum(float(parts[2]) for parts in owned)
            except (OSError, subprocess.SubprocessError, ValueError, IndexError) as error:
                row['errors']['target_process_group'] = type(error).__name__
        data = self.root/'data'; db = data/'data.db'
        try:
            row['database_bytes'] = db.stat().st_size
            wal = data/'data.db-wal'
            row['wal_bytes'] = wal.stat().st_size if wal.exists() else 0
            if self.directory_sample is None or now - self.directory_sample[0] >= 60:
                self.directory_sample = (now, sum(p.stat().st_size for p in data.rglob('*') if p.is_file()))
            row['data_directory_bytes'] = self.directory_sample[1]
            row['data_directory_sample_age_seconds'] = now - self.directory_sample[0]
            disk = shutil.disk_usage(data)
            row['disk_free_bytes'], row['disk_total_bytes'] = disk.free, disk.total
        except OSError as error:
            row['errors']['storage'] = type(error).__name__
        try:
            with closing(sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=.5)) as sql:
                row['unfinished_jobs'] = sum(sql.execute(f"SELECT COUNT(*) FROM {table} WHERE status IN ({statuses})").fetchone()[0]
                    for table, statuses in [('import_jobs', "'queued','processing','inspecting'"), ('conversion_jobs', "'queued','processing'"), ('project_files', "'processing'")])
        except sqlite3.Error as error:
            row['errors']['job_backlog'] = type(error).__name__
        try:
            with (self.root/'server.log').open() as log:
                log.seek(self.log_offset)
                for line in log.readlines():
                    try: item = json.loads(line)
                    except ValueError: continue
                    if item.get('event') == 'runtime_sample': self.last_runtime = (now, item)
                self.log_offset = log.tell()
            if self.last_runtime:
                at, runtime = self.last_runtime
                row['runtime_sample_age_seconds'] = now - at
                for key in ['heap_bytes', 'goroutines', 'queue_length', 'ocr_queue_length', 'image_queue_length', 'gomaxprocs', 'go_memory_limit_bytes', 'dev_mode']:
                    row[key] = runtime.get(key)
        except OSError as error:
            row['errors']['runtime_log'] = type(error).__name__
        self.rows.append(row)
        with (self.output/'resources.jsonl').open('a') as output: output.write(json.dumps(row)+'\n')

    def stop(self):
        self.stopped.set()
        self.thread.join(timeout=10)
        self.directory_sample = None
        self.sample()
        expected = max(1, math.floor(self.config['duration'] / self.interval_seconds))
        required = ('server_rss_bytes', 'wal_bytes', 'data_directory_bytes', 'disk_free_bytes', 'unfinished_jobs')
        complete = [r for r in self.rows if all(key in r for key in required)]
        measured = len(complete) >= expected and not self.thread.is_alive()
        phases = {}
        for phase in ('warmup', 'ramp', 'steady', 'cooldown', 'recovery'):
            rows = [r for r in self.rows if r['phase'] == phase]
            phases[phase] = {key: trend(rows, key) for key in (*required, 'heap_bytes', 'queue_length', 'ocr_queue_length', 'image_queue_length')}
        report = {'sample_interval_seconds': self.interval_seconds, 'samples': len(self.rows),
            'complete_samples': len(complete), 'sampling_status': 'pass' if measured else 'incomplete',
            'production_runtime_status': production_runtime_status(self.rows),
            'resource_budget_status': 'incomplete', 'cooldown_recovery_status': 'incomplete',
            'separate_generator_host': False, 'separate_generator_status': 'incomplete',
            'phases': phases,
            'limitations': ['RSS/WAL/disk/job counts sampled every 5 s; runtime heap and in-memory queue fields come from existing 30 s server samples.',
                'Resource ceilings and recovery tolerance/dwell time have not been frozen, so measured trends do not manufacture a pass.',
                'Server, HTTP generator and browser are on the same host. A separate-host remote harness is still required for formal capacity acceptance.',
                'server_cpu_percent is ps process CPU; it is diagnostic and has no invented acceptance ceiling.']}
        (self.output/'resources-summary.json').write_text(json.dumps(report, indent=2))
        return report
