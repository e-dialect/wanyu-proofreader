#!/usr/bin/env python3
"""Summarise redacted application JSONL. Never echo malformed/private input."""
import argparse
import datetime
import json
import math
from collections import defaultdict
from pathlib import Path


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)] if ordered else None


def timestamp(raw):
    if not isinstance(raw, str):
        return None
    try:
        value = datetime.datetime.fromisoformat(raw.replace('Z', '+00:00'))
        return value if value.tzinfo is not None else None
    except ValueError:
        return None


def timestamp_argument(raw):
    value = timestamp(raw)
    if value is None:
        raise argparse.ArgumentTypeError('a timestamp with timezone is required')
    return value


def summarize(lines, since=None, until=None):
    operations = defaultdict(list)
    failures = defaultdict(int)
    vitals = {}
    runtime = []
    malformed = 0
    gaps = 0
    audit_gaps = 0
    missing_timestamps = 0
    stamps = []
    jobs = defaultdict(lambda: {'wait': [], 'duration': [], 'results': defaultdict(int)})
    for line in lines:
        if not line.strip():
            continue
        # PocketBase also emits plain diagnostics. Only structured lines count.
        start = line.find('{')
        if start < 0:
            continue
        try:
            event = json.loads(line[start:])
            if not isinstance(event, dict):
                raise ValueError()
        except (ValueError, TypeError):
            malformed += 1
            continue
        kind = event.get('event')
        stamp = timestamp(event.get('ts', event.get('time')))
        if since or until:
            if stamp is None:
                missing_timestamps += 1
                continue
            if (since and stamp < since) or (until and stamp > until):
                continue
        if stamp:
            stamps.append(stamp)
        if kind == 'http_completed':
            key = (event.get('build_sha', 'unknown'), event.get('route_template', 'unknown'), event.get('method', ''))
            value = event.get('duration_ms')
            if isinstance(value, (int, float)) and math.isfinite(value) and value >= 0:
                operations[key].append(value)
                if event.get('status', 0) >= 500:
                    failures[key] += 1
        elif kind == 'web_vital':
            sample = event.get('sample', {})
            identity = (sample.get('buildSha'), sample.get('pageViewId'), sample.get('metricId'))
            vitals[identity] = sample
        elif kind in ('runtime_sample', 'container_sample'):
            runtime.append(event)
        elif kind == 'collection_gap':
            gaps += 1
        elif kind == 'security_audit_persist_failed':
            audit_gaps += 1
        elif kind in ('work_started', 'work_finished'):
            job = jobs[(event.get('build_sha', 'unknown'), event.get('kind', 'unknown'))]
            key, field = ('wait', 'queue_wait_ms') if kind == 'work_started' else ('duration', 'duration_ms')
            value = event.get(field)
            if isinstance(value, (int, float)) and math.isfinite(value) and value >= 0:
                job[key].append(value)
            if kind == 'work_finished':
                job['results'][event.get('result', 'unknown')] += 1
    metrics = defaultdict(list)
    for sample in vitals.values():
        value = sample.get('value')
        if isinstance(value, (int, float)) and math.isfinite(value) and value >= 0:
            metrics[(sample.get('buildSha'), sample.get('name'), sample.get('entryRoute'), sample.get('viewportClass'))].append(value)
    return {
        'status': 'incomplete' if gaps or malformed or audit_gaps or missing_timestamps else 'observed',
        'collection_gaps': gaps, 'malformed_lines': malformed,
        'audit_persistence_gaps': audit_gaps, 'missing_timestamps': missing_timestamps,
        'window': {'first': min(stamps).isoformat() if stamps else None, 'last': max(stamps).isoformat() if stamps else None},
        'operations': [{'build': k[0], 'operation': k[1], 'method': k[2], 'samples': len(v),
                        'p50_ms': percentile(v, .5), 'p95_ms': percentile(v, .95), 'p99_ms': percentile(v, .99),
                        'unexpected_5xx_rate': failures[k] / len(v)} for k, v in sorted(operations.items())],
        'browser': [{'build': k[0], 'metric': k[1], 'entry_route': k[2], 'viewport': k[3], 'samples': len(v),
                     'p75': percentile(v, .75), 'small_sample': len(v) < 200} for k, v in sorted(metrics.items())],
        'runtime_samples': len(runtime),
        'peak_heap_bytes': max((e.get('heap_bytes', 0) for e in runtime), default=0),
        'peak_container_memory_bytes': max((e.get('container_memory_bytes', 0) for e in runtime), default=0),
        'jobs': [{'build': k[0], 'kind': k[1], 'started_samples': len(v['wait']), 'finished_samples': len(v['duration']),
                  'queue_wait_p50_ms': percentile(v['wait'], .5), 'queue_wait_p95_ms': percentile(v['wait'], .95),
                  'execution_p50_ms': percentile(v['duration'], .5), 'execution_p95_ms': percentile(v['duration'], .95),
                  'results': dict(v['results'])} for k, v in sorted(jobs.items())],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--since', type=timestamp_argument)
    parser.add_argument('--until', type=timestamp_argument)
    args = parser.parse_args()
    if args.since and args.until and args.since > args.until:
        parser.error('since must be before until')
    with args.input.open() as source:
        report = summarize(source, args.since, args.until)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'operations': len(report['operations']),
                      'browser_groups': len(report['browser']), 'runtime_samples': report['runtime_samples']}))
    return 1 if report['status'] == 'incomplete' else 0


if __name__ == '__main__':
    raise SystemExit(main())
