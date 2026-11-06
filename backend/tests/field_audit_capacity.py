#!/usr/bin/env python3
"""Opt-in #185 probe: disposable real schema, audit rollback and indexed capacity.

No production URL or data-dir argument is accepted. Bulk rows are synthetic and
inserted only while this script's temporary server is stopped. They measure
storage/query scale, not the cost or correctness of 1.6m HTTP submissions.
"""
import argparse
import json
import math
import os
import platform
import sqlite3
import statistics
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from contextlib import closing

import harness


def request(base, route, token='', method='GET', body=None, allowed=(200,)):
    headers = {'Authorization': token} if token else {}
    payload = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        payload = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(base + route, data=payload, headers=headers, method=method)
    try:
        response = urllib.request.urlopen(req, timeout=60)
    except urllib.error.HTTPError as error:
        response = error
    status = response.code
    value = json.loads(response.read() or b'null')
    assert status in allowed, (method, route, status, value)
    return value


def timed_reads(base, token, page, samples, project):
    result = {}
    routes = {'arbitration': f'/api/fangji/pages/{page}/arbitration',
              'verification': f'/api/fangji/pages/{page}/verification',
              'field-error-summary': f'/api/fangji/projects/{project}/field-error-summary'}
    for route, endpoint in routes.items():
        values = []
        size = 0
        for index in range(samples + 3):
            start = time.perf_counter()
            data = request(base, endpoint, token)
            elapsed = (time.perf_counter() - start) * 1000
            if index >= 3:
                values.append(elapsed)
            size = len(json.dumps(data, ensure_ascii=False).encode())
        values.sort()
        result[route] = {'samples': samples, 'p50_ms': round(statistics.median(values), 3),
                         'p95_ms': round(values[math.ceil(samples * .95) - 1], 3),
                         'response_bytes': size}
    return result


def upload_source(base, root, token):
    stream = 'BT /F1 20 Tf 50 720 Td (SYNTHETIC EIGHT FIELD AUDIT SOURCE) Tj ET\n'
    objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
               f'<< /Length {len(stream)} >>\nstream\n{stream}endstream',
               '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    pdf, offsets = '%PDF-1.4\n', [0]
    for index, value in enumerate(objects, 1):
        offsets.append(len(pdf)); pdf += f'{index} 0 obj\n{value}\nendobj\n'
    start = len(pdf)
    pdf += f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n'
    pdf += ''.join(f'{value:010d} 00000 n \n' for value in offsets[1:])
    pdf += f'trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n'
    boundary = 'audit-' + uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audit-source.pdf"\r\n'
            'Content-Type: application/pdf\r\n\r\n').encode() + pdf.encode() + f'\r\n--{boundary}--\r\n'.encode()
    req = urllib.request.Request(base + root + '/files/pdf', data=body, method='POST',
                                 headers={'Authorization': token, 'Content-Type': f'multipart/form-data; boundary={boundary}'})
    with urllib.request.urlopen(req) as response:
        assert response.code == 202
        file = json.load(response)
    for _ in range(100):
        record = request(base, f'/api/collections/project_files/records/{file["id"]}', token)
        if record['status'] == 'ready':
            return record
        time.sleep(.05)
    raise AssertionError('synthetic PDF did not become ready')


def browser_read(env, root, fixture, phase, output):
    script = os.environ.get('FIELD_AUDIT_BROWSER_SCRIPT')
    if not script:
        return {'status': 'not_run', 'reason': 'FIELD_AUDIT_BROWSER_SCRIPT is not set'}
    manifest = root / f'browser-{phase}.json'
    manifest.write_text(json.dumps({**fixture, 'base': env['PB_URL']}, ensure_ascii=False))
    result = root / f'browser-{phase}-result.json'
    screenshot = output.parent.resolve() / f'arbitration-{phase}.png'
    screenshot.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['node', script], check=True, env={**env,
                   'FIELD_AUDIT_BROWSER_FIXTURE': str(manifest),
                   'FIELD_AUDIT_BROWSER_RESULT': str(result),
                   'FIELD_AUDIT_BROWSER_SCREENSHOT': str(screenshot)})
    return json.loads(result.read_text())


def rollback_probe(env, db, fixture):
    base, admin, superuser = env['PB_URL'], fixture['admin']['token'], fixture['super_token']
    project = request(base, '/api/fangji/projects', admin, 'POST',
                      {'name': 'SYNTHETIC audit rollback', 'requiredProofreads': 2}, (201,))
    user = fixture['users'][0]
    root = f'/api/fangji/projects/{project["id"]}'
    request(base, f'{root}/members/{user["id"]}', admin, 'PUT', {'role': 'proofreader'})
    source = upload_source(base, root, admin)
    request(base, root + '/column-roles', admin, 'PUT', {'roles': {'字段0': 'headword', '字段1': 'reading'}})
    request(base, root + '/verification-policy', admin, 'POST',
            {'instructions': '合成八字段功能验收，非真人语言学判断', 'reading_fields': ['字段1'],
             'tone_equivalence': False, 'reason': '明确标记的合成来源与核验约定'}, (201,))
    row = {f'字段{i}': f'合成原值{i}' for i in range(8)}
    page = request(base, '/api/collections/pages/records', superuser, 'POST',
                   {'project': project['id'], 'project_file': source['id'], 'pdf_page': 1, 'page_number': 1, 'status': 'pending',
                    'ocr_row_json': json.dumps(row, ensure_ascii=False),
                    'row_headers_json': json.dumps(list(row), ensure_ascii=False)})
    claimed = request(base, f'{root}/claim', user['token'], 'POST', {})
    assert claimed['id'] == page['id']
    basis = request(base, f'/api/fangji/pages/{page["id"]}/verification', user['token'])['context']['basis']
    with closing(sqlite3.connect(db)) as sql, sql:
        before = sql.execute('SELECT status, proofread_count, proofread_row_json FROM pages WHERE id=?', (page['id'],)).fetchone()
        sql.execute(f'''CREATE TRIGGER synthetic_reject_submission_event BEFORE INSERT ON verification_events
          WHEN NEW.project = '{project['id']}' AND NEW.kind = 'submission'
          BEGIN SELECT RAISE(ABORT, 'synthetic-event-write-failure'); END''')
    changed = {field: value + '已改' for field, value in row.items()}
    request(base, f'/api/fangji/pages/{page["id"]}/submit', user['token'], 'POST',
            {'leaseToken': claimed['leaseToken'], 'rowJson': json.dumps(changed, ensure_ascii=False), 'sourceChecked': True, 'basis': basis},
            (400, 500))
    with closing(sqlite3.connect(db)) as sql, sql:
        after = sql.execute('SELECT status, proofread_count, proofread_row_json FROM pages WHERE id=?', (page['id'],)).fetchone()
        assert after == before, (before, after)
        assert sql.execute('SELECT COUNT(*) FROM proofreading_attempts WHERE page=?', (page['id'],)).fetchone()[0] == 0
        assert sql.execute('SELECT COUNT(*) FROM verification_events WHERE page=?', (page['id'],)).fetchone()[0] == 0
        sql.execute('DROP TRIGGER synthetic_reject_submission_event')
    request(base, f'/api/fangji/pages/{page["id"]}/submit', user['token'], 'POST',
            {'leaseToken': claimed['leaseToken'], 'rowJson': json.dumps(changed, ensure_ascii=False), 'sourceChecked': True, 'basis': basis})
    history = request(base, f'/api/fangji/pages/{page["id"]}/verification', admin)['history']
    actions = [event for event in history if event['kind'] == 'field_action']
    assert len(actions) == 8 and all(event['actor'] == user['id'] for event in actions)
    assert {event['field'] for event in actions} == set(row)
    submission = next(event for event in history if event['kind'] == 'submission')
    assert submission['payload']['row'] == changed
    assert submission['context']['input'] == row
    own = request(base, f'/api/fangji/pages/{page["id"]}/verification', user['token'])
    assert 'history' not in own and 'judgments' not in own
    request(base, f'/api/fangji/pages/{page["id"]}/verification', fixture['users'][1]['token'], allowed=(403,))
    assert not any(event['kind'] == 'final_adoption' for event in history), 'one submission must not invent a final decision'
    second = fixture['users'][1]
    request(base, f'{root}/members/{second["id"]}', admin, 'PUT', {'role': 'proofreader'})
    lease = request(base, f'{root}/claim', second['token'], 'POST', {})
    second_row = {field: value + '第二份' for field, value in row.items()}
    request(base, f'/api/fangji/pages/{page["id"]}/submit', second['token'], 'POST',
            {'leaseToken': lease['leaseToken'], 'rowJson': json.dumps(second_row, ensure_ascii=False), 'sourceChecked': True, 'basis': basis})
    case = request(base, f'/api/fangji/pages/{page["id"]}/arbitration', admin)
    attempts = {item['proofreader']: item for item in case['attempts']}
    final = {**changed, '字段1': second_row['字段1'], '字段2': '合成管理员自拟'}
    selections = {field: 'attempt:' + attempts[user['id']]['id'] for field in row}
    selections.update({'字段1': 'attempt:' + attempts[second['id']]['id'], '字段2': 'custom'})
    judgments = []
    for field in row:
        for actor, values in ((user, changed), (second, second_row)):
            judgments.append({'attempt': attempts[actor['id']]['id'], 'field': field,
                              'state': 'correct' if values[field] == final[field] else 'incorrect',
                              'reason': '合成字段决定测试，非真人语言学判断', 'location': '物理第1页合成行'})
        judgments.append({'attempt': 'final', 'field': field, 'state': 'correct',
                          'reason': '合成最终值测试', 'location': '物理第1页合成行'})
    request(base, f'/api/fangji/pages/{page["id"]}/arbitrate', admin, 'POST',
            {'rowJson': json.dumps(final, ensure_ascii=False), 'selections': selections, 'basis': basis, 'judgments': judgments})
    history = request(base, f'/api/fangji/pages/{page["id"]}/verification', admin)['history']
    adopted = next(event for event in reversed(history) if event['kind'] == 'final_adoption')
    assert adopted['actor'] == fixture['admin']['record']['id']
    assert adopted['payload']['row'] == final
    assert adopted['payload']['by_field']['字段0'] == attempts[user['id']]['id']
    assert adopted['payload']['by_field']['字段1'] == attempts[second['id']]['id']
    assert adopted['payload']['by_field']['字段2'] is None
    submissions = [event for event in history if event['kind'] == 'submission']
    assert {event['actor'] for event in submissions} == {user['id'], second['id']}
    assert all(set(event['payload']['fields']) == set(row) for event in submissions)
    assert len([event for event in history if event['kind'] == 'field_action']) == 16
    own = request(base, f'/api/fangji/pages/{page["id"]}/verification', user['token'])
    own_text = json.dumps(own, ensure_ascii=False)
    assert '第二份' not in own_text and '合成管理员自拟' not in own_text
    with closing(sqlite3.connect(db)) as sql, sql:
        assert json.loads(sql.execute('SELECT row_json FROM proofreading_attempts WHERE id=?',
                                      (attempts[user['id']]['id'],)).fetchone()[0]) == changed
        assert json.loads(sql.execute('SELECT row_json FROM proofreading_attempts WHERE id=?',
                                      (attempts[second['id']]['id'],)).fetchone()[0]) == second_row
    checks = {'event_failure_rolls_back_attempt_events_and_page': True,
            'retry_after_removing_failure_succeeds_once': True,
            'eight_fields_trace_original_and_submitted_values': True,
            'ordinary_response_hides_manager_event_history': True,
            'nonmember_denied': True,
            'two_actors_all_eight_fields_recorded': True,
            'arbitration_attempt_A_attempt_B_and_custom_trace': True,
            'arbitration_preserves_original_submissions': True,
            'ordinary_response_hides_other_submission_and_final_values': True}
    # A separate real, unresolved eight-field case measures the normal arbitration
    # read path. The already-arbitrated trace above remains available for assertions.
    benchmark = request(base, '/api/collections/pages/records', superuser, 'POST',
                        {'project': project['id'], 'project_file': source['id'], 'pdf_page': 1, 'page_number': 2, 'status': 'pending',
                         'ocr_row_json': json.dumps(row, ensure_ascii=False),
                         'row_headers_json': json.dumps(list(row), ensure_ascii=False)})
    for actor, values in ((user, changed), (second, second_row)):
        lease = request(base, f'{root}/claim', actor['token'], 'POST', {})
        assert lease['id'] == benchmark['id']
        basis = request(base, f'/api/fangji/pages/{benchmark["id"]}/verification', actor['token'])['context']['basis']
        request(base, f'/api/fangji/pages/{benchmark["id"]}/submit', actor['token'], 'POST',
                {'leaseToken': lease['leaseToken'], 'rowJson': json.dumps(values, ensure_ascii=False), 'sourceChecked': True, 'basis': basis})
    assert request(base, f'/api/fangji/pages/{benchmark["id"]}/arbitration', admin)['mode'] == 'arbitration'
    return checks, project, benchmark


def bulk_seed(db, fixture, entries, events_per_entry):
    start = time.perf_counter()
    with closing(sqlite3.connect(db)) as sql, sql:
        sql.row_factory = sqlite3.Row
        template = dict(sql.execute('SELECT * FROM pages WHERE id=?', (fixture['pages'][1]['id'],)).fetchone())
        event = dict(sql.execute("SELECT * FROM verification_events WHERE page=? AND kind='field_action' LIMIT 1", (fixture['pages'][1]['id'],)).fetchone())
        assert event, 'the real integration must have produced a field action'
        # Journal-off bulk loading is limited to the script-owned disposable DB.
        # Server is stopped here, and no URL or existing data-dir is accepted.
        sql.execute('PRAGMA journal_mode=OFF')
        sql.execute('PRAGMA synchronous=OFF')
        page_columns = list(template)
        event_columns = list(event)
        insert_page = f'INSERT INTO pages ({",".join(page_columns)}) VALUES ({",".join("?" for _ in page_columns)})'
        insert_event = f'INSERT INTO verification_events ({",".join(event_columns)}) VALUES ({",".join("?" for _ in event_columns)})'
        sample_bytes = len(event['context_json'].encode()) + len(event['payload_json'].encode())
        for batch in range(0, entries, 1000):
            pages, events = [], []
            for index in range(batch, min(batch + 1000, entries)):
                page_id = f'cap{index:012d}'
                row = {**template, 'id': page_id, 'page_number': 1000 + index}
                pages.append(tuple(row[column] for column in page_columns))
                context = json.loads(event['context_json'])
                context['page'] = page_id
                context_json = json.dumps(context, ensure_ascii=False, separators=(',', ':'))
                for offset in range(events_per_entry):
                    number = index * events_per_entry + offset
                    item = {**event, 'id': f'cev{number:012d}', 'page': page_id,
                            'field_name': f'合成字段{offset % 8}', 'context_json': context_json}
                    events.append(tuple(item[column] for column in event_columns))
            sql.executemany(insert_page, pages)
            sql.executemany(insert_event, events)
            sql.commit()
            if batch % 10000 == 0:
                print(f'bulk fixture: {min(batch + 1000, entries)}/{entries} entries', flush=True)
        sql.execute('PRAGMA journal_mode=WAL')
        sql.execute('ANALYZE')
        plans = {}
        target = fixture['pages'][1]['id']
        for name, query, parameters in (
            ('page_history', 'SELECT * FROM verification_events WHERE page=? ORDER BY created,id LIMIT 500', (target,)),
            ('page_kind', 'SELECT * FROM verification_events WHERE page=? AND kind=? ORDER BY created,id LIMIT 500', (target, 'final_adoption')),
            ('project_kind', 'SELECT * FROM verification_events WHERE project=? AND kind=? ORDER BY created,id LIMIT 500', (fixture['project']['id'], 'submission')),
        ):
            details = [row[3] for row in sql.execute('EXPLAIN QUERY PLAN ' + query, parameters)]
            assert any('USING INDEX idx_verification_events_' in value for value in details), (name, details)
            assert not any('SCAN verification_events' in value for value in details), (name, details)
            plans[name] = details
        count = sql.execute('SELECT COUNT(*) FROM verification_events').fetchone()[0]
        pages = sql.execute('SELECT COUNT(*) FROM pages').fetchone()[0]
        kinds = dict(sql.execute('SELECT kind,COUNT(*) FROM verification_events WHERE project=? GROUP BY kind', (fixture['project']['id'],)))
        sizes = {row[0]: row[1] for row in sql.execute('SELECT name,SUM(pgsize) FROM dbstat GROUP BY name')}
    return {'seed_seconds': round(time.perf_counter() - start, 3),
            'added_entries': entries, 'added_events': entries * events_per_entry,
            'total_entries': pages, 'total_events': count,
            'project_event_kinds': kinds,
            'copied_real_context_and_payload_bytes': sample_bytes,
            'database_bytes': db.stat().st_size,
            'verification_events_table_bytes': sizes['verification_events'],
            'verification_events_index_bytes': {key: value for key, value in sizes.items() if key.startswith('idx_verification_events_')},
            'query_plans': plans}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--entries', type=int, default=100000)
    parser.add_argument('--events-per-entry', type=int, default=16)
    parser.add_argument('--samples', type=int, default=15)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.entries < 1 or args.events_per_entry < 1 or args.samples < 5:
        parser.error('entries/events must be positive; at least five timing samples are required')
    report = {'synthetic': True, 'host': platform.platform(),
              'method': 'Temporary full-migration PocketBase; bulk storage fixture, not HTTP import throughput or human latency.'}
    with tempfile.TemporaryDirectory(prefix='wanyu-field-audit-') as directory:
        root = Path(directory)
        binary = harness.build_binary(root / 'pocketbase')
        fixture_file = root / 'fixture.json'
        db = root / 'data' / 'data.db'
        with harness.server(binary, root, extra_env={'FIDELITY_BROWSER_FIXTURE': str(fixture_file)}) as env:
            subprocess.run(['node', str(harness.BACKEND / 'tests/source_fidelity_integration.mjs')], env=harness.with_research_notice_preload(env), check=True)
            fixture = json.loads(fixture_file.read_text())
            superauth = request(env['PB_URL'], '/api/collections/_superusers/auth-with-password', method='POST', body={'identity': env['PB_SUPER_EMAIL'], 'password': env['PB_SUPER_PASSWORD']})
            fixture['super_token'] = superauth['token']
            report['correctness'], fixture['project'], fixture['pages'][1] = rollback_probe(env, db, fixture)
            report['before'] = timed_reads(env['PB_URL'], fixture['admin']['token'], fixture['pages'][1]['id'], args.samples, fixture['project']['id'])
            report['browser_before'] = browser_read(env, root, fixture, 'before', args.output)
        report['capacity'] = bulk_seed(db, fixture, args.entries, args.events_per_entry)
        with harness.server(binary, root) as env:
            # Tokens survive a process restart but never leave this temporary fixture.
            report['after'] = timed_reads(env['PB_URL'], fixture['admin']['token'], fixture['pages'][1]['id'], args.samples, fixture['project']['id'])
            report['browser_after'] = browser_read(env, root, fixture, 'after', args.output)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
