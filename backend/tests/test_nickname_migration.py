"""Data repair, collision ordering and repeatability against the actual migration."""
import json
from contextlib import closing
import sqlite3
import unittest

import harness
from check_migrations import migrate


class NicknameMigrationTest(unittest.TestCase):
    def test_legacy_names_roundtrip(self):
        with harness.temporary_root() as root:
            binary = harness.build_binary(root / 'pocketbase')
            data = root / 'data'
            migrate(binary, data, 'up')
            migrate(binary, data, 'down', 1)
            fixtures = [
                ('000000000000001', 'Alice'), ('000000000000002', 'alice'),
                ('000000000000003', 'Alice-2'), ('000000000000004', ''),
                ('000000000000005', ' \t\u3000'), ('000000000000006', 'Ａlice'),
                ('000000000000007', 'u000000000000001'),
                ('000000000000008', '𢶀' * 256),
            ]
            with closing(sqlite3.connect(data / 'data.db')) as db:
                for i, (record_id, name) in enumerate(fixtures):
                    db.execute('INSERT INTO users(id,username,name,created,verified,tokenKey) VALUES(?,?,?,?,1,?)',
                               (record_id, 'u' + record_id, name, f'2026-01-01 00:00:{i:02}.000Z', record_id))
                db.commit()
            migrate(binary, data, 'up')
            with closing(sqlite3.connect(data / 'data.db')) as db:
                names = dict(db.execute('SELECT id,name FROM users'))
                self.assertEqual([names[key] for key, _ in fixtures[:7]],
                                 ['Alice', 'alice-3', 'Alice-2', '用户000004', '用户000005', 'Ａlice', 'u000000000000001-2'])
                self.assertEqual(len(names[fixtures[-1][0]]), 255)
                self.assertEqual(db.execute('SELECT count(*) FROM users WHERE verified=1').fetchone()[0], 8)
                indexes = db.execute("SELECT indexes FROM _collections WHERE name='users'").fetchone()[0]
                self.assertIn('idx_users_nickname', indexes)
                options = json.loads(db.execute("SELECT options FROM _collections WHERE name='users'").fetchone()[0])
                self.assertEqual(options['passwordAuth']['identityFields'], ['email', 'username', 'name'])
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute('UPDATE users SET name=? WHERE id=?', ('ALICE', fixtures[1][0]))
            migrate(binary, data, 'down', 1)
            with closing(sqlite3.connect(data / 'data.db')) as db:
                options = json.loads(db.execute("SELECT options FROM _collections WHERE name='users'").fetchone()[0])
                self.assertEqual(options['passwordAuth']['identityFields'], ['email', 'username'])
                self.assertEqual(dict(db.execute('SELECT id,name FROM users')), names)
            migrate(binary, data, 'up')
            migrate(binary, data, 'up')
            with closing(sqlite3.connect(data / 'data.db')) as db:
                self.assertEqual(dict(db.execute('SELECT id,name FROM users')), names)


if __name__ == '__main__':
    unittest.main()
