import copy
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

from capacity_reconciliation import reconcile_submissions, row_sha256, snapshot_actor_records


class SubmissionReconciliationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / 'data.db'
        self.row = {'字段乙': ' ŋã\r\n𠮷 / ', '字段甲': 'tʰa\u0301'}
        with closing(sqlite3.connect(self.db)) as sql, sql:
            sql.executescript('''
                CREATE TABLE pages (id TEXT PRIMARY KEY, project TEXT);
                CREATE TABLE proofreading_attempts (id TEXT PRIMARY KEY, project TEXT, page TEXT,
                    proofreader TEXT, kind TEXT, row_json TEXT);
                CREATE TABLE verification_events (id TEXT PRIMARY KEY, project TEXT, page TEXT,
                    actor TEXT, kind TEXT, ref TEXT, payload_json TEXT);
                INSERT INTO pages VALUES ('page', 'project'), ('elsewhere', 'other');
            ''')
        # Existing actor records must not be mistaken for new load submissions.
        self.insert('old', 'old-event')
        self.baseline = snapshot_actor_records(self.db, ('actor', 'actor2'))
        self.insert('attempt', 'event')
        self.requests = [{'operation': 'submit', 'status': 200, 'ok': True,
                          'submission': {'actor_id': 'actor', 'page_id': 'page',
                                         'row_sha256': row_sha256(self.row)}}]

    def insert(self, attempt_id, event_id, project='project', page='page'):
        with closing(sqlite3.connect(self.db)) as sql, sql:
            sql.execute('INSERT INTO proofreading_attempts VALUES (?,?,?,?,?,?)',
                        (attempt_id, project, page, 'actor', 'proofread', json.dumps(self.row, ensure_ascii=False)))
            sql.execute('INSERT INTO verification_events VALUES (?,?,?,?,?,?,?)',
                        (event_id, project, page, 'actor', 'submission', attempt_id,
                         json.dumps({'row': self.row}, ensure_ascii=False)))

    def run_gate(self):
        return reconcile_submissions(self.db, 'project', ('actor', 'actor2'), self.baseline, self.requests)

    def reject(self, code):
        report = self.run_gate()
        self.assertFalse(report['pass'])
        self.assertIn(code, {item['code'] for item in report['errors']})
        # Reconciliation diagnostics never copy body/material/credentials.
        self.assertNotIn(self.row['字段甲'], json.dumps(report, ensure_ascii=False))

    def test_exact_unicode_and_field_order_pass(self):
        report = self.run_gate()
        self.assertTrue(report['pass'], report)
        self.assertEqual(report['new_actor_attempts_all_projects'], 1)
        self.assertEqual(report['matched_request_digests'], 1)

    def test_digest_matches_js_parse_stringify_utf8(self):
        rows = [self.row, {'2': 'two', '1': 'one', '01': 'zero one', '4294967295': 'large',
                          '0': '\ud800', 'tail': '\u2028\u2029😀\x00\t\\"'}, {'a': 'á', 'b': 'a\u0301'}]
        script = '''const {submissionEvidence}=require('./capacity_submission.cjs');
          let raw='';process.stdin.on('data',s=>raw+=s);process.stdin.on('end',()=>{
            console.log(JSON.stringify(JSON.parse(raw).map(row=>submissionEvidence(
              '/api/fangji/pages/page/submit','actor',{rowJson:JSON.stringify(row),leaseToken:'secret'}))))});'''
        result = subprocess.run(['node', '-e', script], input=json.dumps(rows), text=True,
                                capture_output=True, check=True, cwd=Path(__file__).parent)
        evidence = json.loads(result.stdout)
        self.assertEqual([row_sha256(row) for row in rows], [item['row_sha256'] for item in evidence])
        self.assertTrue(all(set(item) == {'actor_id', 'page_id', 'row_sha256'} for item in evidence))

    def test_request_hash_mismatch_fails(self):
        self.requests[0]['submission']['row_sha256'] = '0' * 64
        self.reject('attempt_without_matching_request_digest')

    def test_attempt_character_rewrite_fails_even_if_event_is_also_rewritten(self):
        changed = {**self.row, '字段甲': 'tʰá'}  # composed spelling must not replace decomposed text
        with closing(sqlite3.connect(self.db)) as sql, sql:
            sql.execute("UPDATE proofreading_attempts SET row_json=? WHERE id='attempt'", (json.dumps(changed),))
            sql.execute("UPDATE verification_events SET payload_json=? WHERE id='event'", (json.dumps({'row': changed}),))
        self.reject('attempt_without_matching_request_digest')

    def test_event_field_order_change_fails(self):
        changed = dict(reversed(list(self.row.items())))
        with closing(sqlite3.connect(self.db)) as sql, sql:
            sql.execute("UPDATE verification_events SET payload_json=? WHERE id='event'", (json.dumps({'row': changed}),))
        self.reject('submission_event_row_digest')

    def test_new_cross_project_attempt_is_not_filtered_out(self):
        self.insert('cross-project', 'cross-event', project='other', page='elsewhere')
        self.reject('unexpected_attempt_project')
        self.assertEqual(self.run_gate()['new_actor_attempts_all_projects'], 2)

    def test_wrong_attempt_project_fails_even_when_ack_matches(self):
        with closing(sqlite3.connect(self.db)) as sql, sql:
            sql.execute("UPDATE proofreading_attempts SET project='other' WHERE id='attempt'")
        self.reject('unexpected_attempt_project')

    def test_missing_event_fails(self):
        with closing(sqlite3.connect(self.db)) as sql, sql:
            sql.execute("DELETE FROM verification_events WHERE id='event'")
        self.reject('submission_event_count')

    def test_duplicate_event_fails(self):
        with closing(sqlite3.connect(self.db)) as sql, sql:
            sql.execute("INSERT INTO verification_events SELECT 'duplicate',project,page,actor,kind,ref,payload_json FROM verification_events WHERE id='event'")
        self.reject('submission_event_count')

    def test_event_identity_fields_and_reference_must_match(self):
        for column in ('project', 'page', 'actor', 'ref'):
            with self.subTest(column=column):
                with closing(sqlite3.connect(self.db)) as sql, sql:
                    original = sql.execute(f"SELECT {column} FROM verification_events WHERE id='event'").fetchone()[0]
                    sql.execute(f"UPDATE verification_events SET {column}='wrong' WHERE id='event'")
                self.reject('submission_event_count' if column == 'ref' else 'submission_event_identity')
                with closing(sqlite3.connect(self.db)) as sql, sql:
                    sql.execute(f"UPDATE verification_events SET {column}=? WHERE id='event'", (original,))

    def test_missing_request_evidence_fails(self):
        self.requests[0].pop('submission')
        self.reject('missing_or_invalid_request_evidence')

    def test_duplicate_ack_cannot_reuse_one_attempt(self):
        self.requests.append(copy.deepcopy(self.requests[0]))
        self.reject('acknowledgement_without_matching_attempt')

    def test_unacknowledged_attempt_and_orphan_event_fail(self):
        self.requests.clear()
        with closing(sqlite3.connect(self.db)) as sql, sql:
            sql.execute("UPDATE verification_events SET ref='old' WHERE id='event'")
        self.reject('attempt_without_matching_request_digest')
        self.reject('submission_event_without_new_attempt')


if __name__ == '__main__':
    unittest.main()
