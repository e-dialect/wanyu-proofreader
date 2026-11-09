"""Each real trigger mutation must match the frozen historical SQL exactly."""
import json
import random
import re
import subprocess
from functools import lru_cache

import test_field_summary_sql as reference

ROOT = reference.ROOT
production_sql = reference.production_sql


@lru_cache(maxsize=1)
def migration_statements():
    # Execute the actual migration's SQL generator, not a test implementation.
    script = """const fs=require('node:fs'),vm=require('node:vm');const statements={up:[],down:[]};
const app=key=>({db:()=>({newQuery:sql=>({execute:()=>statements[key].push(sql)})})});
vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),{migrate:(up,down)=>{up(app('up'));down(app('down'))}});
process.stdout.write(JSON.stringify(statements));"""
    return json.loads(subprocess.check_output(['node', '-e', script, str(ROOT / 'pb_migrations/1794204100_field_summary_projection.js')], text=True))


def projection_sql():
    source = (ROOT / 'pb_hooks/lib/field_audit.js').read_text()
    base = re.search(r'const projectionSQL = `([\s\S]*?)`', source)[1]
    page = re.search(r'const pagedSummarySQL = resultsSQL \+ `([\s\S]*?)`', source)[1]
    return re.sub(r'\{:(\w+)\}', r':\1', base + page)


class FieldSummaryProjectionTests(reference.FieldSummarySQLTests):
    def setUp(self):
        super().setUp()
        for statement in migration_statements()['up']:
            self.db.execute(statement)

    def compare(self, project='p', limit=100, offset=0):
        expected = super().compare(project, limit, offset)
        params = {'project': project, 'limit': limit, 'offset': offset}
        self.assertEqual(self.db.execute(projection_sql(), params).fetchall(), expected)
        return expected

    def reconcile(self):
        for project in ['p', 'other', 'third', 'empty']:
            for limit, offset in [(100, 0), (2, 2), (2, 99999)]:
                self.compare(project, limit, offset)
        rows = self.db.execute('SELECT project,field_name,SUM(submitted_fields),SUM(correct_count),SUM(incorrect_count),SUM(pending_count),SUM(withdrawn_count),SUM(unrecorded_count) FROM _field_audit_contributions GROUP BY project,field_name ORDER BY project,field_name').fetchall()
        self.assertEqual(rows, self.db.execute('SELECT * FROM _field_audit_totals ORDER BY project,field_name').fetchall())

    def test_deleting_latest_restores_prior_and_reinserting_attempt_rebuilds(self):
        self.attempt()
        self.judgment(id='older', state='correct', revision=1)
        self.judgment(id='newer', state='withdrawn', revision=2)
        self.assertEqual(self.compare()[0][2:7], (0, 0, 0, 1, 0))
        self.db.execute("DELETE FROM verification_events WHERE id='newer'")
        self.assertEqual(self.compare()[0][2:7], (1, 0, 0, 0, 0))
        self.db.execute("DELETE FROM proofreading_attempts WHERE id='a'")
        self.reconcile()
        self.attempt()
        self.assertEqual(self.compare()[0][2:7], (1, 0, 0, 0, 0))

    def test_mutations_move_delete_and_rollback(self):
        self.db.execute('ALTER TABLE verification_events ADD COLUMN actor TEXT')
        self.db.execute('ALTER TABLE proofreading_attempts ADD COLUMN actor TEXT')
        # Use explicit columns because the baseline helper uses positional INSERTs.
        self.db.execute("INSERT INTO proofreading_attempts(id,project,page,kind,row_json) VALUES('a','p','page','proofread','{\"field\":\"value\",\"dup\":1,\"dup\":2}')")
        self.db.execute("INSERT INTO verification_events(id,project,page,kind,ref,field_name,created,payload_json) VALUES('e','p','page','judgment','a','field','2026-01-01','{\"value\":\"value\",\"state\":\"correct\",\"revision\":1}')")
        self.reconcile()
        changes = [
            "UPDATE verification_events SET actor='another' WHERE id='e'",
            "UPDATE proofreading_attempts SET actor='another' WHERE id='a'",
            "UPDATE verification_events SET project='other' WHERE id='e'",
            "UPDATE proofreading_attempts SET project='other' WHERE id='a'",
            "UPDATE proofreading_attempts SET page='moved' WHERE id='a'",
            "UPDATE verification_events SET page='moved' WHERE id='e'",
            "UPDATE verification_events SET field_name='dup',payload_json='{\"value\":1,\"state\":\"incorrect\"}' WHERE id='e'",
            "UPDATE verification_events SET payload_json='{invalid' WHERE id='e'",
            "UPDATE verification_events SET payload_json='{\"value\":2,\"state\":\"withdrawn\"}' WHERE id='e'",
            "UPDATE verification_events SET kind='field_action' WHERE id='e'",
            "UPDATE verification_events SET kind='judgment',ref='orphan' WHERE id='e'",
            "UPDATE proofreading_attempts SET id='orphan' WHERE id='a'",
            "UPDATE proofreading_attempts SET kind='arbitrate' WHERE id='orphan'",
            "UPDATE proofreading_attempts SET kind='proofread',row_json='[]' WHERE id='orphan'",
            "UPDATE proofreading_attempts SET row_json='{\"dup\":2}' WHERE id='orphan'",
            "UPDATE verification_events SET id='changed',created='2027-01-01' WHERE id='e'",
            "DELETE FROM verification_events WHERE id='changed'",
            "DELETE FROM proofreading_attempts WHERE id='orphan'",
        ]
        for statement in changes:
            with self.subTest(statement=statement):
                self.db.execute('SAVEPOINT mutation')
                self.db.execute(statement)
                self.reconcile()
                self.db.execute('ROLLBACK TO mutation')
                self.reconcile()
                self.db.execute('RELEASE mutation')
                self.db.execute(statement)
                self.reconcile()
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM _field_audit_contributions').fetchone()[0], 0)

    def test_backfill_down_up_on_existing_history(self):
        for statement in migration_statements()['down']:
            self.db.execute(statement)
        self.seed_reference_history()
        before = {p: self.db.execute(production_sql(), {'project': p, 'limit': 100, 'offset': 0}).fetchall() for p in ['p', 'other']}
        for _ in range(2):
            for statement in migration_statements()['up']:
                self.db.execute(statement)
            self.reconcile()
            for project, expected in before.items():
                self.assertEqual(self.compare(project), expected)
            for statement in migration_statements()['down']:
                self.db.execute(statement)
        for statement in migration_statements()['up']:
            self.db.execute(statement)
        self.reconcile()

    def seed_reference_history(self):
        # Seed a separate baseline object's real SQLite rows, then insert them
        # into this DB. This works with or without installed trigger tables.
        baseline = reference.FieldSummarySQLTests()
        baseline.setUp()
        try:
            baseline.test_randomized_history_exact_equivalence()
            for table in ['proofreading_attempts', 'verification_events']:
                rows = baseline.db.execute(f'SELECT * FROM {table}').fetchall()
                self.db.executemany(f'INSERT INTO {table} VALUES({",".join("?" for _ in rows[0])})', rows)
        finally:
            baseline.doCleanups()

    def test_randomized_mutation_sequence_reconciles_every_step(self):
        rng = random.Random(61519)
        fields = ['field', 'a.b', 'a"b', '𢶀']
        for n in range(12):
            self.attempt(id=f'a{n}', project=rng.choice(['p', 'other']), page=f'page{n}', row={key: rng.choice(['v', 1, None, True]) for key in fields})
        for n in range(180):
            operation = rng.choice(['insert', 'insert', 'event_update', 'event_delete', 'attempt_update', 'attempt_delete'])
            if operation == 'insert':
                self.judgment(id=f'r{n}', ref=f'a{rng.randrange(12)}', project=rng.choice(['p', 'other']), page=f'page{rng.randrange(12)}', field=rng.choice(fields), value=rng.choice(['v', 1, None, True]), state=rng.choice(['correct', 'incorrect', 'pending', 'withdrawn', 'unknown']), created=rng.choice(['2026-01-01', '2026-01-02']), revision=rng.choice([0, 1, 2, 'invalid']), raw='{bad' if rng.randrange(10) == 0 else None)
            elif operation == 'event_update':
                row = self.db.execute('SELECT id FROM verification_events ORDER BY id LIMIT 1 OFFSET ?', (rng.randrange(max(1, self.db.execute('SELECT COUNT(*) FROM verification_events').fetchone()[0])),)).fetchone()
                if row:
                    self.db.execute('UPDATE verification_events SET project=?,ref=?,field_name=?,created=?,payload_json=? WHERE id=?', (rng.choice(['p', 'other']), f'a{rng.randrange(12)}', rng.choice(fields), rng.choice(['2026-01-01', '2026-02-01']), json.dumps({'state': rng.choice(['correct', 'withdrawn']), 'value': rng.choice(['v', 1]), 'revision': rng.randrange(3)}), row[0]))
            elif operation == 'event_delete':
                self.db.execute('DELETE FROM verification_events WHERE id=(SELECT id FROM verification_events ORDER BY id LIMIT 1)')
            elif operation == 'attempt_update':
                self.db.execute('UPDATE proofreading_attempts SET project=?,page=?,kind=?,row_json=? WHERE id=?', (rng.choice(['p', 'other', 'third']), f'page{rng.randrange(12)}', rng.choice(['proofread', 'arbitrate']), json.dumps({key: rng.choice(['v', 1, None]) for key in fields}), f'a{rng.randrange(12)}'))
            else:
                self.db.execute('DELETE FROM proofreading_attempts WHERE id=?', (f'a{rng.randrange(12)}',))
            self.reconcile()
