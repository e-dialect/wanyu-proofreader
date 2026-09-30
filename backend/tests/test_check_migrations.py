#!/usr/bin/env python3
"""Tests for check_migrations.py's SPECS↔disk reconciliation.

These run without booting a server, so the mutation cases the reviewer asked for
("hide one migration that SPECS covers and the verifier must fail") are cheap to
keep. The round trip itself is verified by running check_migrations.py.
"""
import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    'migration_guard', Path(__file__).resolve().parent / 'check_migrations.py')
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


def copy_migrations(exclude=(), extra=()):
    """A disposable migrations directory that looks like the real one minus `exclude`."""
    target = Path(tempfile.mkdtemp(prefix='fangji-migrations-'))
    for source in sorted(guard.harness.MIGRATIONS.glob('*.js')):
        if source.name not in exclude:
            shutil.copy(source, target)
    for name, text in extra:
        (target / name).write_text(text, encoding='utf-8')
    return target


class SpecCoverage(unittest.TestCase):
    def setUp(self):
        self.temp = copy_migrations()
        self.addCleanup(shutil.rmtree, self.temp, ignore_errors=True)

    def test_real_tree_is_fully_covered(self):
        on_disk, problems = guard.spec_coverage(self.temp)
        self.assertEqual(problems, [])
        self.assertIn(guard.FIRST, on_disk)
        self.assertGreaterEqual(len(on_disk), 4)
        # Every index migration the two deleted one-off scripts pinned is still pinned.
        for name in ('1788941000_pagination_indexes.js',
                     '1788942000_join_attempt_retention.js',
                     '1789027200_pdf_task_affinity.js'):
            self.assertIn(name, on_disk)
            self.assertIn(name, guard.SPECS)

    def test_hidden_migration_fails(self):
        for name in sorted(guard.SPECS):
            without = copy_migrations(exclude=[name])
            self.addCleanup(shutil.rmtree, without, ignore_errors=True)
            _, problems = guard.spec_coverage(without)
            self.assertTrue(any(name in problem for problem in problems),
                            f'removing {name} must fail, got {problems}')

    def test_unasserted_new_migration_fails(self):
        with_extra = copy_migrations(
            extra=[('1790000000_brand_new_index.js', 'migrate((app) => {}, () => {})\n')])
        self.addCleanup(shutil.rmtree, with_extra, ignore_errors=True)
        _, problems = guard.spec_coverage(with_extra)
        self.assertTrue(any('no assertions in SPECS' in problem for problem in problems), problems)

    def test_empty_directory_fails(self):
        empty = Path(tempfile.mkdtemp(prefix='fangji-migrations-'))
        self.addCleanup(shutil.rmtree, empty, ignore_errors=True)
        on_disk, problems = guard.spec_coverage(empty)
        self.assertEqual(on_disk, [])
        self.assertTrue(any(guard.FIRST in problem for problem in problems), problems)

    def test_missing_initial_schema_fails_even_with_other_files(self):
        without_first = copy_migrations(exclude=[guard.FIRST])
        self.addCleanup(shutil.rmtree, without_first, ignore_errors=True)
        _, problems = guard.spec_coverage(without_first)
        self.assertTrue(any('vacuously' in problem for problem in problems), problems)


class FieldAssertions(unittest.TestCase):
    """_assert_fields 的两向行为。往集合上追加字段的迁移只有这一个断言可写，
    而回滚方向上集合可能已被更早的迁移整个删掉——那必须判成通过。"""

    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix='fangji-fields-'))
        self.addCleanup(shutil.rmtree, self.temp, ignore_errors=True)

    def database(self, collections):
        """collections: {name: [field dicts]} -> a data.db shaped like PocketBase's."""
        import sqlite3
        path = self.temp / 'data.db'
        with sqlite3.connect(path) as db:
            # 一个用例里可能连建两次库（正反两个方向各一份数据），所以先清掉旧表。
            db.execute('DROP TABLE IF EXISTS _collections')
            db.execute('CREATE TABLE _collections (name TEXT PRIMARY KEY, fields TEXT)')
            for name, fields in collections.items():
                db.execute('INSERT INTO _collections VALUES (?, ?)', (name, json.dumps(fields)))
        return self.temp

    def test_absent_collection_passes_only_when_rolled_back(self):
        data = self.database({})
        spec = ('assist_rule_gates', {'approved_by': {'required': False}})
        applied, rolled = [], []
        guard._assert_fields(data, 'm.js', spec, applied, expect=True)
        guard._assert_fields(data, 'm.js', spec, rolled, expect=False)
        self.assertEqual([p for p in applied if 'collection assist_rule_gates missing' in p], [
            'm.js: collection assist_rule_gates missing'])
        self.assertEqual(rolled, [], f'回滚后集合不存在就是期望结果，实得 {rolled}')

    def test_absent_field_passes_only_when_rolled_back(self):
        data = self.database({'assist_rule_gates': [{'name': 'gate', 'required': True}]})
        spec = ('assist_rule_gates', {'approved_by': {'required': False}})
        applied, rolled = [], []
        guard._assert_fields(data, 'm.js', spec, applied, expect=True)
        guard._assert_fields(data, 'm.js', spec, rolled, expect=False)
        self.assertTrue(any('field assist_rule_gates.approved_by missing' in p for p in applied), applied)
        self.assertEqual(rolled, [], f'字段被 down 删掉应判通过，实得 {rolled}')

    def test_required_flag_still_enforced_both_directions(self):
        # 字段在、required 也确实是 False：应用方向应通过，回滚方向必须报——
        # 报的就是「down 没真的把它改回去」。少了这一条，expect=False 分支就是恒真断言。
        data = self.database({'assist_rule_gates': [{'name': 'approved_by', 'required': False}]})
        spec = ('assist_rule_gates', {'approved_by': {'required': False}})
        problems = []
        guard._assert_fields(data, 'm.js', spec, problems, expect=True)
        self.assertEqual(problems, [], f'应用后 required=False 正是期望，实得 {problems}')
        problems = []
        guard._assert_fields(data, 'm.js', spec, problems, expect=False)
        self.assertTrue(any('required should be False when rolled back' in p for p in problems), problems)
        # 反方向：应用后仍是 required=True（迁移没生效）也必须报。
        stuck = self.database({'assist_rule_gates': [{'name': 'approved_by', 'required': True}]})
        problems = []
        guard._assert_fields(stuck, 'm.js', spec, problems, expect=True)
        self.assertTrue(any('required should be False when applied' in p for p in problems), problems)


if __name__ == '__main__':
    unittest.main()
