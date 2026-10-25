import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('backup', Path(__file__).parents[1] / 'ops/backup.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


class BackupTest(unittest.TestCase):
    def test_restore_complete_data_and_reject_corruption(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'pb_data'
            source.mkdir()
            with sqlite3.connect(source / 'data.db') as db:
                db.execute('CREATE TABLE pages (text TEXT)')
                db.execute('INSERT INTO pages VALUES (?)', ('𢶀ɑ',))
            (source / 'storage/project').mkdir(parents=True)
            (source / 'storage/project/source.pdf').write_bytes(b'%PDF-test-fixture')
            (source / 'storage/project/input.csv').write_text('page,word\n1,𢶀\n', encoding='utf-8')
            original = ops.inventory(source)
            self.assertEqual(ops.backup(source, root / 'backup', 'fixture-v1'), 3)
            self.assertEqual(ops.restore(root / 'backup', root / 'restored'), 'fixture-v1')
            self.assertEqual(ops.inventory(root / 'restored'), original)
            with sqlite3.connect(root / 'restored/data.db') as db:
                self.assertEqual(db.execute('SELECT text FROM pages').fetchone()[0], '𢶀ɑ')
            with self.assertRaises(ValueError):
                ops.restore(root / 'backup', source)
            (root / 'backup/data/storage/project/source.pdf').write_bytes(b'corrupted')
            with self.assertRaises(ValueError):
                ops.restore(root / 'backup', root / 'corrupt-restore')
            self.assertFalse((root / 'corrupt-restore').exists())
            self.assertEqual(ops.inventory(source), original)

    def test_reject_symlinks_and_recursive_destination(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'data'
            source.mkdir()
            with self.assertRaises(ValueError):
                ops.backup(source, source / 'backup', 'v1')
            (source / 'outside').symlink_to(root / 'secret')
            with self.assertRaises(ValueError):
                ops.backup(source, root / 'backup', 'v1')


if __name__ == '__main__':
    unittest.main()
