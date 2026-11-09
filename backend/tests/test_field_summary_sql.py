"""Semantic equivalence to the frozen pre-optimization projection, in real SQLite."""
import json
import random
import re
import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def production_sql():
    source = (ROOT / 'pb_hooks/lib/field_audit.js').read_text()
    base = re.search(r'const resultsSQL = `([\s\S]*?)`', source)[1]
    page = re.search(r'const pagedSummarySQL = resultsSQL \+ `([\s\S]*?)`', source)[1]
    return re.sub(r'\{:(\w+)\}', r':\1', base + page)


def index_sql():
    migration = (ROOT / 'pb_migrations/1794204000_field_summary_judgment_index.js').read_text()
    return re.search(r'collection.indexes.push\("([^"\n]+)"\)', migration)[1]


class FieldSummarySQLTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.executescript('''
          CREATE TABLE proofreading_attempts(id TEXT PRIMARY KEY, project TEXT, page TEXT, kind TEXT, row_json TEXT);
          CREATE TABLE verification_events(id TEXT PRIMARY KEY, project TEXT, page TEXT, kind TEXT, ref TEXT, field_name TEXT, created TEXT, payload_json TEXT);
          CREATE INDEX idx_attempt_project ON proofreading_attempts(project);
        ''')
        self.db.execute(index_sql())
        self.before = (ROOT / 'tests/fixtures/field_summary_6a306ea.sql').read_text()
        self.after = production_sql()
        self.sequence = 0

    def attempt(self, id='a', row=None, project='p', page='page', kind='proofread', raw=None):
        self.db.execute('INSERT INTO proofreading_attempts VALUES(?,?,?,?,?)', (id, project, page, kind, raw if raw is not None else json.dumps(row or {'field': 'value'}, ensure_ascii=False)))

    def judgment(self, *, ref='a', field='field', state='correct', value='value', page='page', project='p', created='2026-11-08 00:00:00.000Z', revision=1, id=None, raw=None, kind='judgment'):
        self.sequence += 1
        self.db.execute('INSERT INTO verification_events VALUES(?,?,?,?,?,?,?,?)', (id or f'e{self.sequence:014d}', project, page, kind, ref, field, created, raw if raw is not None else json.dumps({'state': state, 'value': value, 'revision': revision}, ensure_ascii=False)))

    def compare(self, project='p', limit=100, offset=0):
        params = {'project': project, 'limit': limit, 'offset': offset}
        before = self.db.execute(self.before, params).fetchall()
        after = self.db.execute(self.after, params).fetchall()
        self.assertEqual(after, before)
        return after

    def test_latest_order_and_mismatching_latest_never_falls_back(self):
        self.attempt()
        self.judgment(id='a', revision=99, created='2026-11-07', state='incorrect')
        self.judgment(id='b', revision=1, state='correct')
        self.assertEqual(self.compare()[0][2:7], (1, 0, 0, 0, 0))
        self.judgment(id='c', revision=2, state='withdrawn')
        self.assertEqual(self.compare()[0][2:7], (0, 0, 0, 1, 0))
        self.judgment(id='d', revision=2, page='other-page')
        self.assertEqual(self.compare()[0][2:7], (0, 0, 0, 0, 1))
        self.judgment(id='e', revision=3, value='changed-value')
        self.assertEqual(self.compare()[0][2:7], (0, 0, 0, 0, 1))
        self.judgment(id='f', revision=4, state='future-unknown-state')
        self.assertEqual(self.compare()[0][2:7], (0, 0, 0, 0, 1))
        # Invalid JSON is excluded before latest selection, unlike an unknown state.
        self.judgment(id='g', raw='{invalid')
        self.compare()

    def test_invalid_rows_duplicate_fields_types_and_scope(self):
        for n, raw in enumerate(['null', '[]', 'true', '"text"', '{invalid']):
            self.attempt(id=f'invalid{n}', raw=raw)
        self.attempt(id='a', raw='{"field":"value","field":"other","number":1,"bool":true,"empty":null}')
        self.judgment()
        self.judgment(field='number', value=1)
        self.judgment(field='bool', value=True)
        self.judgment(field='empty', value=None)
        self.judgment(ref='orphan')
        self.judgment(ref='final')
        self.judgment(project='other', revision=999)
        self.judgment(kind='field_action', revision=999)
        rows = {row[0]: row for row in self.compare()}
        self.assertEqual(rows['field'][1:7], (2, 1, 0, 0, 0, 1))
        self.assertEqual(rows['empty'][2:7], (0, 0, 0, 0, 1))
        self.compare(limit=2, offset=99999)
        self.assertEqual(self.compare(project='empty'), [])

    def test_randomized_history_exact_equivalence(self):
        rng = random.Random(1701)
        fields = ['甲', 'a.b', 'a"b', '𢶀', 'bool', 'null', 'number', 'array']
        values = ['value', 0, 1.5, True, False, None, ['a', 'b'], {'nested': 'value'}]
        for n in range(120):
            attempt = f'a{n}'
            row = dict(zip(fields, rng.sample(values, len(values))))
            self.attempt(id=attempt, row=row, page=f'page{n}', project='other' if n % 13 == 0 else 'p')
            for field, value in row.items():
                for revision in range(rng.randrange(7)):
                    self.judgment(ref=attempt, field=field, value=value if rng.random() > .15 else 'stale-value', page=f'page{n}' if rng.random() > .1 else 'mismatch', project='other' if rng.random() < .1 else 'p', state=rng.choice(['correct', 'incorrect', 'pending', 'withdrawn', 'unknown']), revision=rng.choice([revision, 0, None, 'invalid', 2.5]), created=rng.choice(['2026-11-07', '2026-11-08', '2026-11-08']), raw='{invalid' if rng.random() < .05 else None)
        for project in ['p', 'other', 'empty']:
            for limit, offset in [(100, 0), (3, 0), (3, 3), (3, 99999)]:
                self.compare(project, limit, offset)

    def test_lookup_uses_partial_cover_index_without_history_sort(self):
        self.attempt()
        self.judgment()
        details = [row[3] for row in self.db.execute('EXPLAIN QUERY PLAN ' + self.after, {'project': 'p', 'limit': 100, 'offset': 0})]
        self.assertTrue(any('idx_verification_judgment_latest' in detail and 'ref=? AND field_name=?' in detail for detail in details), details)
        # Only the final small field-summary pagination may sort, not every judgment.
        lookup = next(i for i, detail in enumerate(details) if 'CORRELATED SCALAR SUBQUERY' in detail)
        self.assertIn('idx_verification_judgment_latest', details[lookup + 1])
        self.assertNotIn('TEMP B-TREE', details[lookup + 1])


if __name__ == '__main__':
    unittest.main()
