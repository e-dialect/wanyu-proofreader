#!/usr/bin/env python3
"""Reproduce dense field-summary SQL before/after on a disposable real workflow.

No production URL or existing data directory is accepted. Offline cloning is
fixture setup, never reported as HTTP write throughput. This is a single-reader
query benchmark; mixed-load/hardware acceptance remains a separate gate.
"""
import argparse
import hashlib
import json
import math
import platform
import sqlite3
import statistics
import subprocess
import time
from pathlib import Path

import harness
import field_audit_capacity as audit
from run_capacity_baseline import clone_fixture
from test_field_summary_sql import production_sql, index_sql
from field_summary_projection_benchmark import baseline_migrations


def timed_sql(db, query, params, samples):
    timings = []
    rows = None
    for _ in range(samples):
        start = time.perf_counter()
        current = db.execute(query, params).fetchall()
        timings.append((time.perf_counter() - start) * 1000)
        if rows is not None:
            assert current == rows, 'read-only repeated SQL changed results'
        rows = current
    ordered = sorted(timings)
    return rows, {'samples': samples, 'samples_ms': timings,
                  'p50_ms': statistics.median(timings),
                  'p95_ms': ordered[math.ceil(samples * .95) - 1]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--entries', type=int, default=20000)
    parser.add_argument('--samples', type=int, default=15)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not 20 <= args.entries <= 20000 or args.samples < 5:
        parser.error('entries must be 20..20000; samples must be >=5')
    report = {'synthetic': True, 'entries': args.entries, 'host': platform.platform(),
              'sqlite_version': sqlite3.sqlite_version, 'mixed_load_acceptance': False,
              'reference_hardware_verified': False, 'cache': 'no application cache; OS cache uncontrolled',
              'method': 'real two-person submission/arbitration templates, stopped-server offline clone, identical DB SQL comparison, current HTTP after restart',
              'source_sha256': hashlib.sha256((harness.HOOKS / 'lib/field_audit.js').read_bytes()).hexdigest()}
    with harness.temporary_root() as root:
        binary = harness.build_binary(root / 'pocketbase')
        fixture_path = root / 'fixture.json'
        db_path = root / 'data/data.db'
        migrations = baseline_migrations(root)  # isolate SQL; do not maintain the later read model without its index
        with harness.server(binary, root, migrations=migrations, extra_env={'FIDELITY_BROWSER_FIXTURE': str(fixture_path)}) as env:
            subprocess.run(['node', str(harness.BACKEND / 'tests/source_fidelity_integration.mjs')], env=harness.with_research_notice_preload(env), check=True, stdout=subprocess.DEVNULL)
            fixture = json.loads(fixture_path.read_text())
            fixture['super_token'] = audit.request(env['PB_URL'], '/api/collections/_superusers/auth-with-password', method='POST', body={'identity': env['PB_SUPER_EMAIL'], 'password': env['PB_SUPER_PASSWORD']})['token']
            _, project, _ = audit.rollback_probe(env, db_path, fixture)
        # Remove only the new derived index on this script-owned, stopped DB so
        # the frozen baseline sees its original query plan. Metadata is restored
        # by the migration and the index is recreated before serving again.
        with sqlite3.connect(db_path) as db:
            db.execute('DROP INDEX idx_verification_judgment_latest')
        start = time.perf_counter()
        report['fixture'] = clone_fixture(db_path, project['id'], args.entries)
        report['seed_seconds'] = time.perf_counter() - start
        print('fixture ready', flush=True)
        params = {'project': project['id'], 'limit': 100, 'offset': 0}
        before = (harness.BACKEND / 'tests/fixtures/field_summary_6a306ea.sql').read_text()
        after = production_sql()
        with sqlite3.connect(db_path) as db:
            db.execute('ANALYZE')
            report['database_bytes_before_index'] = db_path.stat().st_size
            report['fixture']['judgments'] = db.execute("SELECT COUNT(*) FROM verification_events WHERE project=? AND kind='judgment'", (project['id'],)).fetchone()[0]
            report['before_plan'] = [row[3] for row in db.execute('EXPLAIN QUERY PLAN ' + before, params)]
            expected, report['before_sql'] = timed_sql(db, before, params, args.samples)
            print('baseline SQL measured', flush=True)
            start = time.perf_counter()
            db.execute(index_sql())
            db.commit()
            report['index_build_ms'] = (time.perf_counter() - start) * 1000
            report['index_bytes'] = db.execute("SELECT SUM(pgsize) FROM dbstat WHERE name='idx_verification_judgment_latest'").fetchone()[0]
            report['after_plan'] = [row[3] for row in db.execute('EXPLAIN QUERY PLAN ' + after, params)]
            actual, report['after_sql'] = timed_sql(db, after, params, args.samples)
            assert actual == expected
            for limit, offset in [(3, 0), (3, 3), (3, 99999)]:
                request = {**params, 'limit': limit, 'offset': offset}
                assert db.execute(before, request).fetchall() == db.execute(after, request).fetchall()
            report['exact_results_and_pagination_equal'] = True
            report['result_sha256'] = hashlib.sha256(json.dumps(actual, ensure_ascii=False).encode()).hexdigest()
            legacy = "SELECT COUNT(*) FROM pages p WHERE p.project=:project AND p.status='approved' AND NOT EXISTS(SELECT 1 FROM proofreading_attempts a WHERE a.page=p.id AND a.kind='proofread')"
            report['legacy_plan'] = [row[3] for row in db.execute('EXPLAIN QUERY PLAN ' + legacy, params)]
            _, report['legacy_sql'] = timed_sql(db, legacy, params, args.samples)
        print('optimized SQL measured; checking actual HTTP', flush=True)
        with harness.server(binary, root, migrations=migrations) as env:
            timings = []
            for _ in range(args.samples):
                start = time.perf_counter()
                value = audit.request(env['PB_URL'], f'/api/fangji/projects/{project["id"]}/field-error-summary?perPage=100', fixture['admin']['token'])
                timings.append((time.perf_counter() - start) * 1000)
                counts = [(item['field'], item['submittedFields'], item['correctCount'], item['incorrectCount'], item['pendingCount'], item['withdrawnCount'], item['unrecordedCount']) for item in value['items']]
                assert counts == [row[:7] for row in actual]
            report['after_http'] = {'samples': args.samples, 'samples_ms': timings, 'first_request_after_restart_ms': timings[0], 'p50_ms': statistics.median(timings), 'p95_ms': sorted(timings)[math.ceil(args.samples * .95) - 1], 'response_bytes': len(json.dumps(value, ensure_ascii=False).encode())}
            report['observed_http_p95_under_1000ms'] = report['after_http']['p95_ms'] <= 1000
        report['integrity'] = 'ok'
        with sqlite3.connect(db_path) as db:
            assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'output': str(args.output), 'after_http': report['after_http'], 'mixed_load_acceptance': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
