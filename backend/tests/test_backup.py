import importlib.util
import json
import datetime
from unittest import mock
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
            receipt = json.loads((root / 'backup/receipt.json').read_text())
            manifest = json.loads((root / 'backup/manifest.json').read_text())
            self.assertEqual(receipt['status'], 'pass')
            self.assertEqual(receipt['files'], 3)
            self.assertEqual(receipt['version'], 'fixture-v1')
            self.assertEqual(receipt['created_at'], manifest['created_at'])
            self.assertLessEqual(datetime.datetime.fromisoformat(receipt['created_at']), datetime.datetime.fromisoformat(receipt['verified_at']))
            self.assertLess((root / 'backup/receipt.json').stat().st_size, 8192)
            self.assertEqual(manifest['format'], 1)
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

    def test_old_format_one_without_receipt_or_timestamps_still_restores(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'data'
            source.mkdir()
            with sqlite3.connect(source / 'data.db') as db:
                db.execute('CREATE TABLE original (value TEXT)')
            ops.backup(source, root / 'backup', 'old-version')
            manifest_path = root / 'backup/manifest.json'
            manifest = json.loads(manifest_path.read_text())
            del manifest['created_at']
            manifest_path.write_text(json.dumps(manifest))
            (root / 'backup/receipt.json').unlink()
            self.assertEqual(ops.restore(root / 'backup', root / 'restored'), 'old-version')
            self.assertEqual(ops.inventory(source), ops.inventory(root / 'restored'))

    def test_receipt_is_not_restore_authority(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'data'
            source.mkdir()
            with sqlite3.connect(source / 'data.db') as db:
                db.execute('CREATE TABLE original (value TEXT)')
            ops.backup(source, root / 'backup', 'manifest-version')
            (root / 'backup/receipt.json').write_text('broken observability receipt')
            self.assertEqual(ops.restore(root / 'backup', root / 'restored'), 'manifest-version')
            self.assertEqual(ops.inventory(source), ops.inventory(root / 'restored'))

    def test_failed_validation_publishes_no_success_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'data'
            source.mkdir()
            (source / 'data.db').write_bytes(b'invalid')
            with mock.patch.object(ops, 'check_databases', side_effect=ValueError('synthetic validation failure')):
                with self.assertRaises(ValueError):
                    ops.backup(source, root / 'backup', 'v1')
            self.assertFalse((root / 'backup').exists())
            self.assertEqual(list(root.glob('.backup-*')), [])

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
