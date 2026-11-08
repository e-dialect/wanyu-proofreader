"""Versioned remote-capacity evidence and budget contract; no hardware override flags."""
import hashlib
import json
import math
import os
import platform
import re
import subprocess
import queue
import time
from pathlib import Path
from capacity_resources import production_runtime_status

VERSION = 1
MAX_LINE = 16 * 1024 * 1024
ARTIFACTS = frozenset(('resources.jsonl', 'runtime.jsonl'))
SOURCE_KEYS = ('baseline_sha', 'dirty_diff_sha256', 'source_sha256')
FAILURE_PHASES = frozenset(('protocol', 'connect', 'prepare', 'source', 'build_backend', 'build_frontend',
                            'fixture', 'start', 'tunnel', 'generate', 'observation', 'finish', 'cleanup'))
FAILURE_REASONS = frozenset(('invalid_request', 'invalid_error_frame', 'source_mismatch', 'command_failed',
                             'timed_out', 'interrupted', 'protocol_failed', 'io_failed', 'operation_failed'))


class CapacityFailure(RuntimeError):
    def __init__(self, phase, reason_code):
        if not isinstance(phase, str) or not isinstance(reason_code, str) or phase not in FAILURE_PHASES or reason_code not in FAILURE_REASONS:
            phase, reason_code = 'protocol', 'invalid_error_frame'
        self.phase, self.reason_code = phase, reason_code
        super().__init__('capacity_run_failed')

    def frame(self):
        return {'error': 'target_session_failed', 'phase': self.phase, 'reason_code': self.reason_code}


def safe_failure(phase, error):
    if isinstance(error, CapacityFailure):
        return error
    if isinstance(error, (TimeoutError, subprocess.TimeoutExpired, queue.Empty)):
        reason = 'timed_out'
    elif isinstance(error, KeyboardInterrupt):
        reason = 'interrupted'
    elif isinstance(error, subprocess.CalledProcessError):
        reason = 'command_failed'
    elif isinstance(error, OSError):
        reason = 'io_failed'
    elif isinstance(error, ValueError):
        reason = 'invalid_request'
    else:
        reason = 'operation_failed'
    return CapacityFailure(phase, reason)


def failure_from_frame(frame):
    if (not isinstance(frame, dict) or set(frame) != {'error', 'phase', 'reason_code'} or
            frame.get('error') != 'target_session_failed' or not isinstance(frame.get('phase'), str) or
            not isinstance(frame.get('reason_code'), str) or frame['phase'] not in FAILURE_PHASES or
            frame['reason_code'] not in FAILURE_REASONS):
        return CapacityFailure('protocol', 'invalid_error_frame')
    return CapacityFailure(frame['phase'], frame['reason_code'])


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def strict_json_loads(value):
    def reject(_):
        raise ValueError('nonfinite_json_number')
    def number(raw):
        parsed = float(raw)
        if not math.isfinite(parsed): reject(raw)
        return parsed
    def unique(pairs):
        result = {}
        for key, item in pairs:
            if key in result: raise ValueError('duplicate_json_key')
            result[key] = item
        return result
    return json.loads(value, parse_constant=reject, parse_float=number, object_pairs_hook=unique)


def host_identity():
    identity, method = None, 'unavailable'
    try:
        if platform.system() == 'Linux':
            identity = Path('/etc/machine-id').read_text().strip()
            method = 'linux-machine-id-sha256'
        elif platform.system() == 'Darwin':
            raw = subprocess.check_output(['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice'], text=True, timeout=5)
            match = re.search(r'"IOPlatformUUID"\s*=\s*"([^"]+)"', raw)
            identity = match.group(1) if match else None
            method = 'darwin-platform-uuid-sha256'
    except (OSError, subprocess.SubprocessError):
        pass
    return {'machine_sha256': hashlib.sha256(identity.encode()).hexdigest() if identity else None,
            'method': method, 'platform': platform.system(), 'observed_epoch_ms': round(time.time()*1000)}


def clean_environment(source=None):
    source = os.environ if source is None else source
    # No APP_*, PB_*, SMTP, proxy, NODE_OPTIONS or provider configuration can
    # reach a disposable target. Runtime budgets are supplied separately.
    return {key: source[key] for key in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT', 'GOCACHE', 'GOPATH') if key in source}


def validate_init(value):
    required = {'op', 'version', 'nonce', 'profile', 'entries', 'users', 'duration', 'source', 'budget'}
    if not isinstance(value, dict) or set(value) != required or value['op'] != 'init' or type(value['version']) is not int or value['version'] != VERSION:
        raise ValueError('invalid_init_schema')
    if not isinstance(value['nonce'], str) or not re.fullmatch('[a-f0-9]{32}', value['nonce']):
        raise ValueError('invalid_nonce')
    for name, low, high in [('entries', 20, 20000), ('users', 8, 30), ('duration', 12, 3600)]:
        if type(value[name]) is not int or not low <= value[name] <= high:
            raise ValueError('invalid_' + name)
    if value['profile'] not in ('smoke', 'full'):
        raise ValueError('invalid_profile')
    if value['profile'] == 'full' and (value['entries'], value['users'], value['duration']) != (20000, 30, 3600):
        raise ValueError('invalid_full_profile')
    if not isinstance(value['source'], dict) or any(key not in value['source'] for key in SOURCE_KEYS):
        raise ValueError('missing_source_evidence')
    validate_budget(value['budget'])
    return value


def validate_budget(budget):
    if budget is None:
        return
    expected = {'version', 'name', 'target', 'ceilings', 'recovery', 'clock', 'runtime', 'reference_profile'}
    if not isinstance(budget, dict) or set(budget) != expected or type(budget['version']) is not int or budget['version'] != VERSION or not isinstance(budget['name'], str) or not re.fullmatch('[a-z0-9_-]{1,64}', budget['name']):
        raise ValueError('invalid_budget_schema')
    if budget['reference_profile'] not in ('production_shared', '8g_comparison'):
        raise ValueError('invalid_reference_profile')
    fields = {
        'target': ('cpu_cores', 'memory_min_bytes', 'memory_max_bytes'),
        'ceilings': ('combined_rss_bytes', 'wal_bytes', 'data_growth_bytes', 'disk_free_min_bytes'),
        'recovery': ('baseline_seconds', 'observe_seconds', 'dwell_seconds', 'rss_growth_bytes', 'heap_growth_bytes'),
        'clock': ('max_uncertainty_ms',),
        'runtime': ('gomaxprocs', 'gomemlimit_bytes'),
    }
    for section, names in fields.items():
        if not isinstance(budget[section], dict) or set(budget[section]) != set(names):
            raise ValueError('invalid_budget_' + section)
        for name in names:
            number = budget[section][name]
            if number is not None and (type(number) not in (int, float) or not math.isfinite(number) or number <= 0):
                raise ValueError('invalid_budget_number')
    if any(value is not None and type(value) is not int for value in budget['runtime'].values()):
        raise ValueError('invalid_runtime_budget_integer')
    r = budget['recovery']
    for name in ('baseline_seconds', 'observe_seconds', 'dwell_seconds'):
        if r[name] is not None and not 10 <= r[name] <= 600:
            raise ValueError('invalid_observation_duration')
    if all(r[k] is not None for k in ('observe_seconds', 'dwell_seconds')) and r['observe_seconds'] < r['dwell_seconds']:
        raise ValueError('recovery_shorter_than_dwell')


def observation_seconds(budget, key):
    return budget['recovery'][key] if budget and budget['recovery'][key] is not None else 15


def same_source(a, b):
    return all(a.get(key) == b.get(key) and a.get(key) is not None for key in SOURCE_KEYS)


def valid_fault_evidence(report, source):
    if not isinstance(report, dict) or not isinstance(report.get('source_after'), dict):
        return False
    duration = report.get('duration_seconds')
    gates = report.get('gates', {})
    return bool(report.get('status') == 'pass' and report.get('full_fault_gate') is True and
        type(duration) in (int, float) and math.isfinite(duration) and duration >= 900 and
        isinstance(gates, dict) and all(gates.get(name) == 'pass' for name in
        ('offline', 'response_loss', 'restart', 'revocation', 'storage', 'source_unchanged')) and
        same_source(source, report) and same_source(source, report['source_after']))


def evaluate_evidence(rows, budget, target, generator, clock, transport):
    """All inputs are observed receipts, never caller assertions of CPU/SSD/separation."""
    gates = dict.fromkeys(('separate_generator_host', 'reference_hardware', 'clock_alignment',
                          'resource_sampling', 'resource_budget', 'cooldown_recovery', 'formal_reference_profile', 'runtime_budgets'), 'incomplete')
    gates['production_runtime'] = production_runtime_status(rows)
    a, b = target['host'].get('machine_sha256'), generator.get('machine_sha256')
    if a and b:
        gates['separate_generator_host'] = 'pass' if transport == 'ssh' and a != b else 'fail'
    if not budget:
        return gates
    if budget['reference_profile'] == 'production_shared':
        envelope = budget['target']
        if all(v is not None for v in envelope.values()) and envelope['cpu_cores'] == 4 and envelope['memory_min_bytes'] <= 3674*1024**2 <= envelope['memory_max_bytes'] and envelope['memory_max_bytes'] - envelope['memory_min_bytes'] <= 512*1024**2:
            gates['formal_reference_profile'] = 'pass'
    c = budget['clock']['max_uncertainty_ms']
    if clock and c is not None:
        gates['clock_alignment'] = 'pass' if max(clock['uncertainty_ms'], clock.get('drift_bound_ms', float('inf'))) <= c else 'fail'
    hardware, envelope = target['hardware'], budget['target']
    cpu, memory = hardware.get('effective_cpu_cores'), hardware.get('effective_memory_bytes')
    known_cpu = type(cpu) in (int, float) and math.isfinite(cpu) and cpu > 0 and envelope['cpu_cores'] is not None
    known_memory = (type(memory) in (int, float) and math.isfinite(memory) and memory > 0 and
                    envelope['memory_min_bytes'] is not None and envelope['memory_max_bytes'] is not None)
    if ((known_cpu and cpu != envelope['cpu_cores']) or
            (known_memory and not envelope['memory_min_bytes'] <= memory <= envelope['memory_max_bytes'])):
        gates['reference_hardware'] = 'fail'
    elif known_cpu and known_memory and hardware.get('storage_medium_verified') is True:
        gates['reference_hardware'] = 'pass'
    runtime = budget['runtime']
    runtime_rows = [r for r in rows if type(r.get('gomaxprocs')) is int and type(r.get('go_memory_limit_bytes')) is int]
    if runtime_rows and all(value is not None for value in runtime.values()):
        gates['runtime_budgets'] = 'pass' if all(r['gomaxprocs'] == runtime['gomaxprocs'] and r['go_memory_limit_bytes'] == runtime['gomemlimit_bytes'] for r in runtime_rows) else 'fail'
    required = ('server_rss_bytes', 'frontend_rss_bytes', 'target_group_rss_bytes', 'wal_bytes', 'data_directory_bytes', 'disk_free_bytes', 'unfinished_jobs')
    complete = [r for r in rows if all(type(r.get(k)) in (float, int) for k in required)]
    gaps = [b['at_ms'] - a['at_ms'] for a, b in zip(rows, rows[1:])]
    load = [r for r in rows if r.get('observation') == 'load']
    duration = target.get('workload', {}).get('duration')
    load_covered = duration is not None and len(load) >= 2 and load[-1]['at_ms'] - load[0]['at_ms'] >= duration*1000
    if rows and len(complete) == len(rows) and gaps and max(gaps) <= 12000 and load_covered:
        gates['resource_sampling'] = 'pass'
    ceilings = budget['ceilings']
    if complete and all(v is not None for v in ceilings.values()):
        first_data = complete[0]['data_directory_bytes']
        exceeded = any(r['target_group_rss_bytes'] > ceilings['combined_rss_bytes'] or
            r['wal_bytes'] > ceilings['wal_bytes'] or r['data_directory_bytes'] - first_data > ceilings['data_growth_bytes'] or
            r['disk_free_bytes'] < ceilings['disk_free_min_bytes'] for r in complete)
        gates['resource_budget'] = 'fail' if exceeded else 'pass' if gates['resource_sampling'] == 'pass' else 'incomplete'
    recovery = budget['recovery']
    baseline = [r for r in complete if r.get('observation') == 'baseline']
    idle = [r for r in complete if r.get('observation') == 'postload_idle']
    def span(group): return (group[-1]['at_ms'] - group[0]['at_ms'])/1000 if group else 0
    if all(v is not None for v in recovery.values()) and span(baseline) >= recovery['baseline_seconds'] and span(idle) >= recovery['observe_seconds']:
        cutoff = idle[-1]['at_ms'] - recovery['dwell_seconds']*1000
        boundary = [r for r in idle if r['at_ms'] <= cutoff]
        tail = ([boundary[-1]] if boundary else []) + [r for r in idle if r['at_ms'] > cutoff]
        fresh_heap = lambda r: type(r.get('heap_bytes')) in (int,float) and r.get('runtime_sample_age_seconds', 999) <= 35
        heap_baseline = [r for r in baseline if fresh_heap(r)]
        if span(tail) >= recovery['dwell_seconds'] and len(heap_baseline) >= 2 and all(fresh_heap(r) and all(type(r.get(key)) is int for key in ('queue_length', 'ocr_queue_length', 'image_queue_length')) for r in tail):
            rss = max(r['target_group_rss_bytes'] for r in baseline)
            heap = max(r['heap_bytes'] for r in heap_baseline)
            recovered = all(r['target_group_rss_bytes'] <= rss+recovery['rss_growth_bytes'] and
                r['heap_bytes'] <= heap+recovery['heap_growth_bytes'] and r['unfinished_jobs'] == 0 and
                all(r.get(key) == 0 for key in ('queue_length', 'ocr_queue_length', 'image_queue_length')) for r in tail)
            gates['cooldown_recovery'] = 'pass' if recovered else 'fail'
    return gates
