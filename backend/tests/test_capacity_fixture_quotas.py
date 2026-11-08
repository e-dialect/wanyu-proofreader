import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from run_capacity_baseline import clone_fixture, fixture_quota_plan


class QuotaPlanTests(unittest.TestCase):
    def test_exact_full_distribution_and_seed_deductions(self):
        targets, remaining = fixture_quota_plan(20000, {'complete': 1, 'arbitration': 1})
        self.assertEqual(targets, {'complete': 10000, 'arbitration': 4000, 'single': 3000, 'pending': 3000})
        self.assertEqual(remaining, {'complete': 9999, 'arbitration': 3999, 'single': 3000, 'pending': 3000})
        _, remaining = fixture_quota_plan(20, {'complete': 3, 'arbitration': 2, 'single': 1, 'pending': 2})
        self.assertEqual(remaining, {'complete': 7, 'arbitration': 2, 'single': 2, 'pending': 1})

    def test_odd_sizes_keep_old_cumulative_less_than_rounding(self):
        for entries, counts in [(20, (10, 4, 3, 3)), (21, (11, 4, 3, 3)),
                                (23, (12, 5, 3, 3)), (101, (51, 20, 15, 15))]:
            with self.subTest(entries=entries):
                targets, _ = fixture_quota_plan(entries, {})
                self.assertEqual(tuple(targets.values()), counts)
        for entries in range(20, 20001):
            targets, remaining = fixture_quota_plan(entries, {'complete': 1, 'arbitration': 1})
            self.assertEqual(sum(targets.values()), entries)
            self.assertEqual(sum(remaining.values()), entries-2)
            self.assertTrue(all(n >= 0 for n in remaining.values()))

    def test_invalid_or_excessive_seed_budget_is_rejected(self):
        for entries, counts in [(19, {}), (20001, {}), (20.0, {}), (True, {}),
                                (20, {'complete': 11}), (20, {'single': 4}),
                                (20, {'pending': -1}), (20, {'arbitration': 1.5}),
                                (20, {'unknown': 0})]:
            with self.subTest(entries=entries, counts=counts), self.assertRaises(ValueError):
                fixture_quota_plan(entries, counts)


class SQLiteFixtureQuotaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'fixture.db'
        self.db = sqlite3.connect(self.path)
        self.addCleanup(self.db.close)
        self.db.executescript('''
          PRAGMA foreign_keys=ON;
          CREATE TABLE pages(id TEXT PRIMARY KEY, project TEXT, page_number INTEGER,
            status TEXT, proofread_round INTEGER, proofread_count INTEGER,
            proofread_row_json TEXT, proofreader TEXT, lease_token_hash TEXT,
            lease_expires_at TEXT, project_file TEXT, pdf_page INTEGER,
            UNIQUE(project,page_number));
          CREATE TABLE proofreading_attempts(id TEXT PRIMARY KEY,
            page TEXT REFERENCES pages(id), project TEXT, kind TEXT, round INTEGER,
            pass_no INTEGER, row_json TEXT);
          CREATE INDEX idx_fixture_attempts_page_kind_round
            ON proofreading_attempts(page,kind,round);
          CREATE TABLE verification_events(id TEXT PRIMARY KEY,
            page TEXT REFERENCES pages(id), project TEXT, kind TEXT,
            ref TEXT REFERENCES proofreading_attempts(id), payload_json TEXT, context_json TEXT);
          CREATE TABLE task_leases(id TEXT PRIMARY KEY, page TEXT UNIQUE REFERENCES pages(id),
            project TEXT, holder TEXT, expires_at TEXT);
        ''')
        self.seed_number = 0
        self.add_seed('approved')
        self.add_seed('arbitration')

    def add_seed(self, status, count=None, project='main', number=None, round_=1):
        self.seed_number += 1
        n = self.seed_number
        page = f'seedpg{n:09d}'
        count = count if count is not None else {'approved': 2, 'proofread': 2, 'arbitration': 2, 'proofreading': 1}.get(status, 0)
        self.db.execute('INSERT INTO pages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                        (page, project, number or n, status, round_, count, '', '', '', '', 'seed_pdf', 1))
        kinds = ['proofread']*count + (['arbitrate'] if status=='approved' else [])
        for i, kind in enumerate(kinds):
            attempt = f'seeda{n:06d}{i:04d}'
            self.db.execute('INSERT INTO proofreading_attempts VALUES(?,?,?,?,?,?,?)',
                            (attempt, page, project, kind, round_ or 1, i+1,
                             json.dumps({'page_id': page, 'attempt_id': attempt, 'field': 'fictional'})))
            event_kinds = ['field_action', 'submission', 'judgment'] if kind=='proofread' else ['final_adoption']
            for j, event_kind in enumerate(event_kinds):
                event = f'seede{n:06d}{i*3+j:04d}'
                payload = json.dumps({'page_id': page, 'attempt_id': attempt, 'event_id': event})
                self.db.execute('INSERT INTO verification_events VALUES(?,?,?,?,?,?,?)',
                                (event, page, project, event_kind, attempt, payload, payload))
        self.db.commit()
        return page

    def snapshot(self):
        return {table: self.db.execute(f'SELECT * FROM {table} ORDER BY id').fetchall()
                for table in ('pages', 'proofreading_attempts', 'verification_events', 'task_leases')}

    def assert_relations_and_seed_preservation(self, before):
        for table, rows in before.items():
            for row in rows:
                self.assertEqual(self.db.execute(f'SELECT * FROM {table} WHERE id=?', (row[0],)).fetchone(), row)
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.assertEqual(self.db.execute('''SELECT COUNT(*) FROM proofreading_attempts a JOIN pages p ON p.id=a.page
          WHERE a.project!=p.project OR json_extract(a.row_json,'$.page_id')!=a.page
          OR json_extract(a.row_json,'$.attempt_id')!=a.id''').fetchone()[0], 0)
        self.assertEqual(self.db.execute('''SELECT COUNT(*) FROM verification_events e
          JOIN proofreading_attempts a ON a.id=e.ref JOIN pages p ON p.id=e.page
          WHERE e.page!=a.page OR e.project!=a.project OR e.project!=p.project
          OR json_extract(e.payload_json,'$.page_id')!=e.page
          OR json_extract(e.payload_json,'$.attempt_id')!=e.ref
          OR json_extract(e.context_json,'$.event_id')!=e.id''').fetchone()[0], 0)
        self.assertEqual(self.db.execute('''SELECT COUNT(*) FROM pages p WHERE p.project='main'
          AND p.proofread_count!=(SELECT COUNT(*) FROM proofreading_attempts a
             WHERE a.page=p.id AND a.kind='proofread' AND a.round=COALESCE(NULLIF(p.proofread_round,0),1))''').fetchone()[0], 0)

    def test_real_sqlite_20k_targets_and_complete_attempt_event_relations(self):
        self.add_seed('approved', project='other')
        before = self.snapshot()
        result = clone_fixture(self.path, 'main', 20000, 'new_pdf')
        self.assertEqual(result['counts'], {'approved': 10000, 'arbitration': 4000, 'proofreading': 3000, 'pending': 3000})
        self.assertEqual(result['entries_added'], 19998)
        self.assertEqual(result['groups'], result['target_groups'])
        self.assertEqual(result['integrity'], 'ok')
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM pages WHERE id LIKE 'mat%' AND (project_file!='new_pdf' OR pdf_page NOT BETWEEN 1 AND 200)").fetchone()[0], 0)
        self.assert_relations_and_seed_preservation(before)

    def test_multiple_seed_states_are_deducted_without_rewriting(self):
        self.add_seed('proofread')
        self.add_seed('proofreading', number=5000, round_=0)
        self.add_seed('pending')
        self.add_seed('arbitration')
        before = self.snapshot()
        result = clone_fixture(self.path, 'main', 23)
        self.assertEqual(result['seed_groups'], {'complete': 2, 'arbitration': 2, 'single': 1, 'pending': 1})
        self.assertEqual(result['groups'], {'complete': 12, 'arbitration': 5, 'single': 3, 'pending': 3})
        self.assertEqual(result['counts']['proofread'], 1)
        self.assertEqual(self.db.execute("SELECT MIN(page_number) FROM pages WHERE id LIKE 'mat%'").fetchone()[0], 5001)
        self.assert_relations_and_seed_preservation(before)

    def test_proofread_complete_template_and_current_round_single(self):
        self.db.execute("UPDATE pages SET status='proofread' WHERE status='approved'")
        arb = self.db.execute("SELECT id FROM pages WHERE status='arbitration'").fetchone()[0]
        self.db.execute('UPDATE pages SET proofread_round=2 WHERE id=?', (arb,))
        self.db.execute('UPDATE proofreading_attempts SET round=2 WHERE page=?', (arb,))
        self.db.execute("INSERT INTO proofreading_attempts VALUES('oldround0000001',?,'main','proofread',1,1,?)",
                        (arb, json.dumps({'page_id': arb, 'attempt_id': 'oldround0000001'})))
        self.db.commit()
        before = self.snapshot()
        result = clone_fixture(self.path, 'main', 21)
        self.assertEqual(result['counts'], {'proofread': 11, 'arbitration': 4, 'proofreading': 3, 'pending': 3})
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM proofreading_attempts a JOIN pages p ON p.id=a.page WHERE p.status='proofreading' AND a.round!=2").fetchone()[0], 0)
        self.assert_relations_and_seed_preservation(before)

    def assert_rejected_before_writes(self, entries=20):
        before = self.snapshot()
        commands = []
        connect = sqlite3.connect
        def observed(*args, **kwargs):
            connection = connect(*args, **kwargs)
            connection.set_trace_callback(commands.append)
            return connection
        with patch('run_capacity_baseline.sqlite3.connect', side_effect=observed), self.assertRaises(ValueError):
            clone_fixture(self.path, 'main', entries)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(any(q.lstrip().split()[0].upper() in ('INSERT', 'UPDATE', 'DELETE', 'REPLACE') for q in commands))

    def test_unsupported_status_is_rejected_before_writes(self):
        self.add_seed('claimed')
        self.assert_rejected_before_writes()

    def test_seed_bucket_over_budget_is_rejected_before_writes(self):
        for _ in range(10):
            self.add_seed('approved')
        self.assert_rejected_before_writes()

    def test_single_state_requires_one_actual_current_round_proofread(self):
        for count in (0, 2):
            with self.subTest(count=count):
                page = self.add_seed('proofreading', count=count)
                self.assert_rejected_before_writes()
                self.db.execute("UPDATE pages SET status='approved' WHERE id=?", (page,));self.db.commit()
        page = self.add_seed('proofreading')
        self.db.execute('UPDATE proofreading_attempts SET round=2 WHERE page=?', (page,));self.db.commit()
        self.assert_rejected_before_writes()

    def test_pending_with_submissions_or_lease_is_rejected_before_writes(self):
        page = self.add_seed('pending', count=1)
        self.assert_rejected_before_writes()
        self.db.execute("UPDATE pages SET status='approved' WHERE id=?", (page,));self.db.commit()
        page = self.add_seed('pending')
        self.db.execute("INSERT INTO task_leases VALUES('seedlease000001',?,'main','reader','2030-01-01')", (page,));self.db.commit()
        self.assert_rejected_before_writes()
        self.db.execute('DELETE FROM task_leases');self.db.execute("UPDATE pages SET proofreader='reader' WHERE id=?", (page,));self.db.commit()
        self.assert_rejected_before_writes()

    def test_missing_template_and_reserved_id_stride_overflow_are_explicit(self):
        self.db.execute("UPDATE pages SET status='proofread' WHERE status='arbitration'");self.db.commit()
        self.assert_rejected_before_writes()
        self.db.execute("UPDATE pages SET status='arbitration' WHERE page_number=2");self.db.commit()
        self.add_seed('approved', count=5, number=0)
        # Make the oversized real template sort first, without deleting seeds.
        self.db.execute("UPDATE pages SET page_number=-1 WHERE proofread_count=5");self.db.commit()
        self.assert_rejected_before_writes()

    def test_generated_distribution_mismatch_rolls_back_all_clone_rows(self):
        before = self.snapshot()
        self.db.execute("""CREATE TRIGGER corrupt_generated_state AFTER INSERT ON pages
          WHEN NEW.id LIKE 'mat%' BEGIN UPDATE pages SET status='approved' WHERE id=NEW.id; END""")
        self.db.commit()
        with self.assertRaisesRegex(ValueError, 'target distribution'):
            clone_fixture(self.path, 'main', 20)
        self.assertEqual(self.snapshot(), before)


if __name__ == '__main__':
    unittest.main()
