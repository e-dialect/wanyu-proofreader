import os
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import run_capacity_faults
from run_capacity_faults import controlled_run


@unittest.skipUnless(os.name == 'posix', 'fault process-group cleanup targets Linux/macOS')
class FaultProcessCleanupTests(unittest.TestCase):
    def test_timeout_runs_cleanup_and_stops_a_stubborn_descendant(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            command = [sys.executable, '-c', r'''
import pathlib, signal, subprocess, sys, time
root = pathlib.Path(sys.argv[1])
child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGINT, signal.SIG_IGN); time.sleep(60)'])
root.joinpath('child').write_text(str(child.pid))
try:
    time.sleep(60)
finally:
    root.joinpath('cleanup').write_text('ran')
''', str(root)]
            self.assertEqual(controlled_run(command, root, root/'gate.log', timeout=.5), 124)
            self.assertEqual((root/'cleanup').read_text(), 'ran')
            pid = int((root/'child').read_text())
            for _ in range(30):
                status = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='],
                                        capture_output=True, text=True).stdout.strip()
                if not status or status.startswith('Z'):
                    break
                time.sleep(.05)
            self.assertTrue(not status or status.startswith('Z'), 'descendant remained running')
            self.assertIn('FAULT_GATE_TIMEOUT', (root/'gate.log').read_text())

    def test_detached_descendant_is_stopped_after_timeout_or_parent_exit(self):
        for timeout, exit_code in ((.5, 124), (3, 7)):
            with self.subTest(timeout=timeout), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                command = [sys.executable, '-c', r'''
import pathlib, subprocess, sys, time
root = pathlib.Path(sys.argv[1])
child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGINT, signal.SIG_IGN); time.sleep(60)'], start_new_session=True)
root.joinpath('child').write_text(str(child.pid))
time.sleep(.8)
raise SystemExit(7)
''', str(root)]
                pid = None
                try:
                    self.assertEqual(controlled_run(command, root, root/'gate.log', timeout=timeout), exit_code)
                    pid = int((root/'child').read_text())
                    status = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True).stdout.strip()
                    self.assertTrue(not status or status.startswith('Z'), 'detached descendant remained running')
                finally:
                    # Clean the synthetic process even if this regression fails.
                    if pid is None and (root/'child').exists():
                        pid = int((root/'child').read_text())
                    if pid is not None:
                        try:
                            os.killpg(pid, 9)
                        except ProcessLookupError:
                            pass

    def test_failed_suite_remains_failed_and_credentials_are_redacted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            code = controlled_run([sys.executable, '-c',
                                   'print("password: secret-example"); raise SystemExit(3)'],
                                  root, root/'gate.log')
            self.assertEqual(code, 3)
            self.assertNotIn('secret-example', (root/'gate.log').read_text())
            self.assertEqual((root/'gate.log').stat().st_mode & 0o777, 0o600)


class FaultSourceFreezeTests(unittest.TestCase):
    def run_full(self, after, failed_suite=False):
        before = {'baseline_sha': 'a'*40, 'dirty_diff_sha256': 'b'*64,
                  'source_sha256': {'backend/main.go': 'c'*64}}
        clock = {'now': 0}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(sys, 'argv', ['faults', '--profile', 'full', '--output', str(root)]), \
                    patch.object(run_capacity_faults.capacity_fixture, 'source_manifest', side_effect=[before, after]) as snapshots, \
                    patch.object(run_capacity_faults.time, 'monotonic', side_effect=lambda: clock['now']), \
                    patch('sys.stdout', new_callable=io.StringIO):
                def run(command, cwd, log_path, timeout=1800):
                    # The first source snapshot must precede npm build, not
                    # merely the first fault suite. No child process is launched.
                    self.assertEqual(snapshots.call_count, 1)
                    if command[0] != 'npm':
                        clock['now'] += 200
                    return 3 if failed_suite and log_path.name == '1-restart.log' else 0
                with patch.object(run_capacity_faults, 'controlled_run', side_effect=run) as executions:
                    code = run_capacity_faults.main()
                self.assertEqual(executions.call_count, 6)
                self.assertEqual(snapshots.call_count, 2)
            return code, json.loads((root/'faults.json').read_text())

    def test_matching_source_allows_full_fault_result(self):
        source = {'baseline_sha': 'a'*40, 'dirty_diff_sha256': 'b'*64,
                  'source_sha256': {'backend/main.go': 'c'*64}}
        code, report = self.run_full(source)
        self.assertEqual(code, 0)
        self.assertEqual(report['source_after'], source)
        self.assertEqual(report['source_unchanged'], 'pass')
        self.assertEqual(report['gates']['source_unchanged'], 'pass')
        self.assertEqual(report['status'], 'pass')
        self.assertTrue(report['full_fault_gate'])
        self.assertEqual(report['duration_seconds'], 1000)

    def test_changed_or_missing_source_never_passes_full_fault_result(self):
        source = {'baseline_sha': 'a'*40, 'dirty_diff_sha256': 'b'*64,
                  'source_sha256': {'backend/main.go': 'c'*64}}
        cases = [{**source, 'baseline_sha': 'd'*40}, {**source, 'dirty_diff_sha256': 'd'*64},
                 {**source, 'source_sha256': {'backend/main.go': 'd'*64}}, {}, OSError('unavailable')]
        for after in cases:
            with self.subTest(after=type(after).__name__):
                code, report = self.run_full(after)
                self.assertEqual(code, 2)
                self.assertEqual(report['source_unchanged'], 'incomplete')
                self.assertEqual(report['status'], 'incomplete')
                self.assertFalse(report['full_fault_gate'])
                self.assertEqual(len(report['executions']), 5)
                self.assertTrue(all(row['status'] == 'pass' for row in report['executions']))

    def test_suite_failure_is_not_downgraded_by_missing_source(self):
        code, report = self.run_full(OSError('unavailable'), failed_suite=True)
        self.assertEqual(code, 1)
        self.assertEqual(report['status'], 'fail')
        self.assertFalse(report['full_fault_gate'])


if __name__ == '__main__':
    unittest.main()
