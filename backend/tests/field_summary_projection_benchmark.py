#!/usr/bin/env python3
"""Disposable 20k real-workflow benchmark of transactional field summaries.

The CLI accepts no existing data directory or remote server. Setup cloning is
not write throughput. HTTP writes use the actual source-judgment business API.
"""
import argparse
import hashlib
import json
import math
import platform
import shutil
import sqlite3
import statistics
import subprocess
import time
from pathlib import Path

import harness
import field_audit_capacity as audit
from check_migrations import migrate, applied
from run_capacity_baseline import clone_fixture
from test_field_summary_sql import production_sql
from test_field_summary_projection import projection_sql

MIGRATION = '1794204100_field_summary_projection.js'


def sample_summary(values):
    return {'samples': len(values), 'samples_ms': values, 'p50_ms': statistics.median(values), 'p95_ms': sorted(values)[math.ceil(len(values) * .95) - 1]}


def baseline_migrations(root):
    directory = root / 'before-projection-migrations'
    directory.mkdir(exist_ok=True)
    for path in harness.MIGRATIONS.glob('*.js'):
        if path.name != MIGRATION:
            shutil.copy(path, directory / path.name)
    return directory


def reconcile(db, project):
    for limit, offset in [(100, 0), (3, 0), (3, 3), (3, 99999)]:
        params = {'project': project, 'limit': limit, 'offset': offset}
        assert db.execute(production_sql(), params).fetchall() == db.execute(projection_sql(), params).fetchall()


def measure(binary, root, fixture, project, samples=20):
    """Caller owns this disposable root; used by the CLI after fixture creation."""
    db_path = root / 'data/data.db'
    before_migrations = baseline_migrations(root)
    if MIGRATION in applied(root / 'data'):
        migrate(binary, root / 'data', 'down', 1)
    with sqlite3.connect(db_path) as db:
        target = db.execute("SELECT id,page,row_json FROM proofreading_attempts WHERE project=? AND kind='proofread' ORDER BY id LIMIT 1", (project,)).fetchone()
        fields = list(json.loads(target[2]))
        initial_counts = {'attempts': db.execute('SELECT COUNT(*) FROM proofreading_attempts WHERE project=?', (project,)).fetchone()[0], 'judgments': db.execute("SELECT COUNT(*) FROM verification_events WHERE project=? AND kind='judgment'", (project,)).fetchone()[0]}
    report = {'synthetic': True, 'host': platform.platform(), 'fixture': initial_counts,
              'mixed_load_acceptance': False, 'reference_hardware_verified': False,
              'cache': 'no application cache; OS disk cache uncontrolled',
              'method': 'same stopped-server cloned real workflow; real Go HTTP eight-field reads and eight-judgment writes before/after; restore benchmark page/events offline between phases for identical history; transaction migration roundtrip and rollback fault',
              'source_sha256': hashlib.sha256((harness.HOOKS / 'lib/field_audit.js').read_bytes()).hexdigest()}
    token = fixture['admin']['token']

    def http_phase(migrations):
        # Source-judgment latency grows with page history. Restore only this
        # script's new events and saved page fields after each phase so that
        # before/after start at exactly the same history length and page state.
        with sqlite3.connect(db_path) as db:
            event_ids = {row[0] for row in db.execute('SELECT id FROM verification_events WHERE page=?', (target[1],))}
            page_columns = [row[1] for row in db.execute('PRAGMA table_info(pages)')]
            page_values = db.execute('SELECT * FROM pages WHERE id=?', (target[1],)).fetchone()
        with harness.server(binary, root, migrations=migrations) as env:
            reads = []
            for _ in range(samples):
                start = time.perf_counter()
                value = audit.request(env['PB_URL'], f'/api/fangji/projects/{project}/field-error-summary?perPage=100', token)
                reads.append((time.perf_counter() - start) * 1000)
            with sqlite3.connect(db_path) as db:
                expected = db.execute(production_sql(), {'project': project, 'limit': 100, 'offset': 0}).fetchall()
            assert [(v['field'], v['submittedFields'], v['correctCount'], v['incorrectCount'], v['pendingCount'], v['withdrawnCount'], v['unrecordedCount']) for v in value['items']] == [row[:7] for row in expected]
            basis = audit.request(env['PB_URL'], f'/api/fangji/pages/{target[1]}/verification', token)['context']['basis']
            writes = []
            for n in range(samples):
                judgments = [{'attempt': target[0], 'field': field, 'state': 'correct' if n % 2 else 'withdrawn', 'reason': '合成读模型写入开销测试', 'location': '合成物理第1页'} for field in fields]
                start = time.perf_counter()
                audit.request(env['PB_URL'], f'/api/fangji/pages/{target[1]}/source-judgments', token, 'POST', {'basis': basis, 'judgments': judgments})
                writes.append((time.perf_counter() - start) * 1000)
            result = {'summary_http': sample_summary(reads), 'eight_judgments_http': sample_summary(writes), 'response_bytes': len(json.dumps(value, ensure_ascii=False).encode()), 'all_fields_exact': True}
        with sqlite3.connect(db_path) as db:
            added = [row[0] for row in db.execute('SELECT id FROM verification_events WHERE page=?', (target[1],)) if row[0] not in event_ids]
            db.executemany('DELETE FROM verification_events WHERE id=?', [(id,) for id in added])
            db.execute('UPDATE pages SET ' + ','.join('"' + name + '"=?' for name in page_columns) + ' WHERE id=?', (*page_values, target[1]))
        return result

    report['before'] = http_phase(before_migrations)
    start = time.perf_counter()
    migrate(binary, root / 'data', 'up')
    report['backfill_seconds'] = time.perf_counter() - start
    with sqlite3.connect(db_path) as db:
        reconcile(db, project)
        report['derived_bytes'] = {row[0]: row[1] for row in db.execute("SELECT name,SUM(pgsize) FROM dbstat WHERE name LIKE '_field_audit_%' GROUP BY name")}
        report['database_bytes'] = db_path.stat().st_size
        report['contribution_rows'] = db.execute('SELECT COUNT(*) FROM _field_audit_contributions').fetchone()[0]
        report['totals_rows'] = db.execute('SELECT COUNT(*) FROM _field_audit_totals').fetchone()[0]
    report['after'] = http_phase(harness.MIGRATIONS)
    with sqlite3.connect(db_path) as db:
        reconcile(db, project)
        expected = db.execute(production_sql(), {'project': project, 'limit': 100, 'offset': 0}).fetchall()
        db.execute('UPDATE _field_audit_projection_meta SET enabled=0')
    # The fallback is an operational switch, not a stale cache. Source triggers
    # remain installed while disabled; compare full HTTP responses both ways.
    with harness.server(binary, root) as env:
        fallback = audit.request(env['PB_URL'], f'/api/fangji/projects/{project}/field-error-summary?perPage=100', token)
        with sqlite3.connect(db_path) as db:
            db.execute('UPDATE _field_audit_projection_meta SET enabled=1')
        projected = audit.request(env['PB_URL'], f'/api/fangji/projects/{project}/field-error-summary?perPage=100', token)
        assert fallback == projected
    report['fallback_http_exact'] = True
    # Inject a failure after the migration creates its first two tables. Its
    # transaction must remove those partial tables and its migration marker.
    migrate(binary, root / 'data', 'down', 1)
    with sqlite3.connect(db_path) as db:
        db.execute('CREATE TABLE _field_audit_projection_meta (synthetic_failure INTEGER)')
    migrate(binary, root / 'data', 'up', expect_success=False)
    with sqlite3.connect(db_path) as db:
        assert not db.execute("SELECT name FROM sqlite_master WHERE name IN ('_field_audit_contributions','_field_audit_totals')").fetchall()
        assert MIGRATION not in applied(root / 'data')
        assert db.execute(production_sql(), {'project': project, 'limit': 100, 'offset': 0}).fetchall() == expected
        db.execute('DROP TABLE _field_audit_projection_meta')
    migrate(binary, root / 'data', 'up')
    with sqlite3.connect(db_path) as db:
        reconcile(db, project)
        assert db.execute(projection_sql(), {'project': project, 'limit': 100, 'offset': 0}).fetchall() == expected
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    report['nonempty_up_down_up_and_fault_rollback'] = True
    report['observed_http_p95_under_1000ms'] = report['after']['summary_http']['p95_ms'] <= 1000
    report['write_p50_overhead_ms'] = report['after']['eight_judgments_http']['p50_ms'] - report['before']['eight_judgments_http']['p50_ms']
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--entries', type=int, default=20000)
    parser.add_argument('--samples', type=int, default=20)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not 20 <= args.entries <= 20000 or args.samples < 5:
        parser.error('entries must be 20..20000; samples must be >=5')
    with harness.temporary_root() as root:
        binary = harness.build_binary(root / 'pocketbase')
        fixture_path = root / 'fixture.json'
        with harness.server(binary, root, migrations=baseline_migrations(root), extra_env={'FIDELITY_BROWSER_FIXTURE': str(fixture_path)}) as env:
            subprocess.run(['node', str(harness.BACKEND / 'tests/source_fidelity_integration.mjs')], env=harness.with_research_notice_preload(env), check=True, stdout=subprocess.DEVNULL)
            fixture = json.loads(fixture_path.read_text())
            fixture['super_token'] = audit.request(env['PB_URL'], '/api/collections/_superusers/auth-with-password', method='POST', body={'identity': env['PB_SUPER_EMAIL'], 'password': env['PB_SUPER_PASSWORD']})['token']
            _, project, _ = audit.rollback_probe(env, root / 'data/data.db', fixture)
        clone_fixture(root / 'data/data.db', project['id'], args.entries)
        report = measure(binary, root, fixture, project['id'], args.samples)
        report['entries'] = args.entries
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'output': str(args.output), 'after': report['after'], 'mixed_load_acceptance': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
