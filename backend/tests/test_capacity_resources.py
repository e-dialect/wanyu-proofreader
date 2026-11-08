from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch

from capacity_resources import ResourceSampler, production_runtime_status


class SamplerConnectionTests(unittest.TestCase):
    def test_mode_requires_actual_false_and_never_promotes_unknown_or_true(self):
        self.assertEqual(production_runtime_status([{}, {'dev_mode': False}]), 'pass')
        for rows in ([], [{}], [{'dev_mode': 0}], [{'dev_mode': None}]):
            self.assertEqual(production_runtime_status(rows), 'incomplete')
        self.assertEqual(production_runtime_status([{'dev_mode': False}, {'dev_mode': True}]), 'fail')

    def test_repeated_samples_release_every_read_connection(self):
        opened = []
        connect = sqlite3.connect

        class ObservedConnection(sqlite3.Connection):
            closed = False

            def close(self):
                self.closed = True
                return super().close()

        def observed_connect(*args, **kwargs):
            connection = connect(*args, **kwargs, factory=ObservedConnection)
            opened.append(connection)
            return connection

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'data').mkdir()
            (root/'server.log').write_text('')
            with closing(connect(root/'data/data.db')) as db:
                for table in ('import_jobs', 'conversion_jobs', 'project_files'):
                    db.execute(f'CREATE TABLE {table}(status TEXT)')
                db.commit()
            sampler = ResourceSampler(123, root, {
                'output': str(root), 'start_epoch_ms': time.time()*1000,
                'duration': 60, 'phases': [{'name': 'steady', 'seconds': 60}]
            })
            with patch('capacity_resources.sqlite3.connect', side_effect=observed_connect), \
                 patch('capacity_resources.subprocess.check_output', return_value='1024 1.0'):
                for _ in range(12):
                    sampler.sample()
                    self.assertTrue(all(connection.closed for connection in opened))
            self.assertEqual(len(opened), 12)
            self.assertTrue(all(row['unfinished_jobs'] == 0 for row in sampler.rows))
            with self.assertRaises(sqlite3.ProgrammingError):
                opened[-1].execute('SELECT 1')


if __name__ == '__main__':
    unittest.main()
