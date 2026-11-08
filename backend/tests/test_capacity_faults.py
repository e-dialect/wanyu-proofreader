import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

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

    def test_failed_suite_remains_failed_and_credentials_are_redacted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            code = controlled_run([sys.executable, '-c',
                                   'print("password: secret-example"); raise SystemExit(3)'],
                                  root, root/'gate.log')
            self.assertEqual(code, 3)
            self.assertNotIn('secret-example', (root/'gate.log').read_text())
            self.assertEqual((root/'gate.log').stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
