"""Real HTTP must fall back when read-model maintenance is disabled or missing."""
from contextlib import closing
import json
import sqlite3
import subprocess
import unittest

import harness
import field_audit_capacity as audit
from test_field_summary_sql import production_sql
from test_field_summary_projection import projection_sql


class FieldSummaryProjectionHTTPTests(unittest.TestCase):
    def test_disabled_and_missing_trigger_fallback_with_real_mutations(self):
        with harness.temporary_root() as root:
            fixture_path = root / 'fixture.json'
            with harness.server(None, root, extra_env={'FIDELITY_BROWSER_FIXTURE': str(fixture_path)}) as env:
                subprocess.run(['node', str(harness.BACKEND / 'tests/source_fidelity_integration.mjs')], env=harness.with_research_notice_preload(env), check=True, stdout=subprocess.DEVNULL)
                fixture = json.loads(fixture_path.read_text())
                token, project = fixture['admin']['token'], fixture['project']['id']
                path = f'/api/fangji/projects/{project}/field-error-summary?perPage=100'
                with closing(sqlite3.connect(root / 'data/data.db')) as db, db:
                    params = {'project': project, 'limit': 100, 'offset': 0}
                    columns = [row[1] for row in db.execute('PRAGMA table_info(verification_events)')]
                    template = dict(zip(columns, db.execute("SELECT * FROM verification_events WHERE project=? AND kind='judgment' AND ref!='final' ORDER BY created DESC LIMIT 1", (project,)).fetchone()))

                    def assert_http_matches_authoritative():
                        expected = db.execute(production_sql(), params).fetchall()
                        value = audit.request(env['PB_URL'], path, token)
                        actual = [(v['field'], v['submittedFields'], v['correctCount'], v['incorrectCount'], v['pendingCount'], v['withdrawnCount'], v['unrecordedCount']) for v in value['items']]
                        self.assertEqual(actual, [row[:7] for row in expected])

                    def insert(id, state):
                        record = dict(template)
                        record['id'], record['created'] = id, '2099-01-01 00:00:00.000Z'
                        payload = json.loads(record['payload_json'])
                        payload.update(state=state, revision=999)
                        record['payload_json'] = json.dumps(payload)
                        db.execute('INSERT INTO verification_events (' + ','.join('"' + name + '"' for name in columns) + ') VALUES (' + ','.join('?' for _ in columns) + ')', [record[name] for name in columns])
                        db.commit()

                    db.execute('UPDATE _field_audit_projection_meta SET enabled=0')
                    db.commit()
                    insert('syntheticmodel1', 'withdrawn')
                    self.assertEqual(db.execute(production_sql(), params).fetchall(), db.execute(projection_sql(), params).fetchall(), 'disabled reads must not disable transactional maintenance')
                    assert_http_matches_authoritative()
                    db.execute('UPDATE _field_audit_projection_meta SET enabled=1')
                    db.execute('DROP TRIGGER _field_audit_event_insert')
                    db.commit()
                    insert('syntheticmodel2', 'correct')
                    self.assertNotEqual(db.execute(production_sql(), params).fetchall(), db.execute(projection_sql(), params).fetchall(), 'fault must actually leave stale counters')
                    assert_http_matches_authoritative()
                audit.request(env['PB_URL'], '/api/collections/_field_audit_totals/records', token, allowed=(404,))
