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

    def test_detached_node_descendant_stops_after_timeout_or_fast_parent_exit(self):
        # This is the real fault-suite shape: Python -> Node -> detached browser.
        for timeout, wait, exit_code in ((3, 10, 124), (5, 0, 7), (5, 0, -9)):
            with self.subTest(timeout=timeout), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                node = root/'browser.cjs'
                node.write_text("""
const fs=require('node:fs');const {spawn}=require('node:child_process');
const child=spawn(process.env.CAPACITY_GUARDIAN_PYTHON,['-c',
 'import os,time;print(os.getpid(),flush=True);time.sleep(60)'],
 {detached:true,stdio:['ignore','pipe','ignore']});
child.stdout.once('data',data=>{fs.writeFileSync(process.argv[2],data);process.exit(7)});
""")
                finish = 'import os;os.kill(os.getpid(),9)' if exit_code == -9 else 'raise SystemExit(7)'
                command = [sys.executable,'-c',
                    'import subprocess,sys,time;subprocess.run(["node",sys.argv[1],sys.argv[2]]);time.sleep(float(sys.argv[3]));'+finish,
                    str(node),str(root/'child'),str(wait)]
                self.assertEqual(controlled_run(command,root,root/'gate.log',timeout=timeout),exit_code)
                pid=int((root/'child').read_text())
                from capacity_process_ownership import birth_identity
                self.assertIsNone(birth_identity(pid),'detached child survived')

    def test_interrupt_cleans_the_owned_suite_before_propagating(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            command=[sys.executable,'-c',
                'import os,pathlib,time;pathlib.Path("pid").write_text(str(os.getpid()));time.sleep(60)']
            real_wait=subprocess.Popen.wait
            interrupted={'done':False}
            def wait(process, *args, **kwargs):
                if kwargs.get('timeout') == 30 and not interrupted['done']:
                    deadline=time.monotonic()+3
                    while not (root/'pid').exists() and time.monotonic()<deadline: time.sleep(.01)
                    interrupted['done']=True
                    raise KeyboardInterrupt()
                return real_wait(process,*args,**kwargs)
            with patch.object(subprocess.Popen,'wait',wait):
                with self.assertRaises(KeyboardInterrupt):
                    controlled_run(command,root,root/'gate.log',timeout=30)
            from capacity_process_ownership import birth_identity
            self.assertIsNone(birth_identity(int((root/'pid').read_text())))

    def test_failed_suite_remains_failed_and_credentials_are_redacted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            code = controlled_run([sys.executable, '-c',
                                   'print("password: secret-example"); raise SystemExit(3)'],
                                  root, root/'gate.log')
            self.assertEqual(code, 3)
            self.assertNotIn('secret-example', (root/'gate.log').read_text())
            self.assertEqual((root/'gate.log').stat().st_mode & 0o777, 0o600)

    def test_normal_suite_exit_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            program = '''
import os,subprocess,sys
for method,expected in [('terminate',-15),('kill',-9)]:
    child=subprocess.Popen([sys.executable,'-u','-c','import os,time;print(os.getpid());time.sleep(60)'],stdout=subprocess.PIPE,text=True)
    assert int(child.stdout.readline())==child.pid
    assert child.pid!=os.getpid()
    getattr(child,method)()
    assert child.wait(timeout=5)==expected
    child.stdout.close()
print('normal: direct child PID and deliberate restart signals preserved')
'''
            with patch('run_capacity_faults.os.killpg') as signal_saved_group:
                self.assertEqual(controlled_run([sys.executable,'-c',program],root,root/'gate.log'),0)
                signal_saved_group.assert_not_called()
            self.assertIn('normal',(root/'gate.log').read_text())


class FaultSourceFreezeTests(unittest.TestCase):
    def test_cleanup_uncertainty_is_not_a_full_pass(self):
        source={'baseline_sha':'a'*40,'dirty_diff_sha256':'b'*64,'source_sha256':{'backend/main.go':'c'*64}}
        for code, expected in ((0,'incomplete'),(7,'fail')):
            with self.subTest(code=code),tempfile.TemporaryDirectory() as directory:
                root=Path(directory)
                with patch.object(sys,'argv',['faults','--profile','smoke','--output',str(root)]), \
                     patch.object(run_capacity_faults.capacity_fixture,'source_manifest',return_value=source), \
                     patch.object(run_capacity_faults,'controlled_run',side_effect=[0,run_capacity_faults.FaultCleanupUnconfirmed(code)]), \
                     patch('sys.stdout',new_callable=io.StringIO):
                    result=run_capacity_faults.main()
                report=json.loads((root/'faults.json').read_text())
                self.assertEqual(report['status'],expected)
                self.assertFalse(report['full_fault_gate'])
                self.assertEqual(report['gates']['process_cleanup'],'incomplete')
                self.assertEqual(result,2 if code==0 else 1)

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
