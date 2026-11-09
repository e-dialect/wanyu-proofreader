import copy
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import capacity_fixture
import harness
import run_capacity_remote
from capacity_remote_contract import (canonical_hash, clean_environment, evaluate_evidence, host_identity,
                                      validate_budget, validate_init, strict_json_loads, CapacityFailure,
                                      safe_failure, failure_from_frame, valid_fault_evidence)
from capacity_target import OwnedTarget
from run_capacity_remote import Transport, loopback_port, ssh_command, transport_environment, stop_generator_group


def budget():
    return {'version': 1, 'name': 'synthetic_test', 'reference_profile': 'production_shared',
        'target': {'cpu_cores': 4, 'memory_min_bytes': 3700000000, 'memory_max_bytes': 4000000000},
        'runtime': {'gomaxprocs': 2, 'gomemlimit_bytes': 805306368},
        'ceilings': {'combined_rss_bytes': 1000, 'wal_bytes': 1000, 'data_growth_bytes': 1000, 'disk_free_min_bytes': 1000},
        'recovery': {'baseline_seconds': 10, 'observe_seconds': 10, 'dwell_seconds': 10, 'rss_growth_bytes': 100, 'heap_growth_bytes': 100},
        'clock': {'max_uncertainty_ms': 50}}


def init():
    return {'op': 'init', 'version': 1, 'nonce': 'e'*32, 'profile': 'smoke', 'entries': 20, 'users': 8, 'duration': 12,
            'source': capacity_fixture.source_manifest(harness.BACKEND), 'budget': budget()}


class CapacityRemoteTest(unittest.TestCase):
    def test_fault_evidence_requires_frozen_source_and_complete_real_window(self):
        source = {'baseline_sha': 'a'*40, 'dirty_diff_sha256': 'b'*64,
                  'source_sha256': {'synthetic.go': 'c'*64}}
        report = {**copy.deepcopy(source), 'source_after': copy.deepcopy(source),
                  'status': 'pass', 'full_fault_gate': True, 'duration_seconds': 901,
                  'gates': dict.fromkeys(('offline', 'response_loss', 'restart', 'revocation',
                                          'storage', 'source_unchanged'), 'pass')}
        self.assertTrue(valid_fault_evidence(report, source))
        for duration in (899, float('inf'), float('nan'), True):
            self.assertFalse(valid_fault_evidence({**report, 'duration_seconds': duration}, source))
        for field in ('source_after', 'full_fault_gate'):
            old = copy.deepcopy(report); del old[field]
            self.assertFalse(valid_fault_evidence(old, source))
        for field in source:
            changed = copy.deepcopy(report); changed['source_after'][field] = 'changed'
            self.assertFalse(valid_fault_evidence(changed, source))
        changed = copy.deepcopy(report); del changed['gates']['source_unchanged']
        self.assertFalse(valid_fault_evidence(changed, source))

    def test_known_hardware_mismatch_fails_even_when_ssd_unknown(self):
        target = {'workload': {'duration':10}, 'host':{'machine_sha256':'target'},
                  'hardware':{'effective_cpu_cores':4, 'effective_memory_bytes':3800000000, 'storage_medium_verified':False}}
        def status():
            return evaluate_evidence(self.rows(), budget(), target, {'machine_sha256':'generator'}, None, 'ssh')['reference_hardware']
        self.assertEqual(status(), 'incomplete')
        target['hardware']['effective_cpu_cores'] = 8
        self.assertEqual(status(), 'fail')
        target['hardware']['effective_cpu_cores'] = None
        target['hardware']['effective_memory_bytes'] = 8000000000
        self.assertEqual(status(), 'fail')
        target['hardware']['effective_memory_bytes'] = None
        self.assertEqual(status(), 'incomplete')

    def test_safe_failure_metadata_drops_messages_and_rejects_malicious_frames(self):
        error = subprocess.CalledProcessError(1, ['secret-command'], stderr='secret-token-and-environment')
        frame = safe_failure('build_backend', error).frame()
        self.assertEqual(frame, {'error':'target_session_failed', 'phase':'build_backend', 'reason_code':'command_failed'})
        for phase in ('secret-token', ['build_backend'], {'token':'secret-token'}, None):
            rejected = failure_from_frame({**frame, 'phase':phase})
            self.assertEqual(rejected.frame(), {'error':'target_session_failed','phase':'protocol','reason_code':'invalid_error_frame'})
        for malformed in ({**frame,'message':'secret-token'}, {**frame,'reason_code':'secret-token'}, {**frame,'error':'secret-token'}):
            self.assertEqual(failure_from_frame(malformed).reason_code, 'invalid_error_frame')
        self.assertNotIn('secret', json.dumps(frame))

    def test_safe_failure_phase_is_persisted_in_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)/'result'
            args = ['remote', '--transport','local','--entries','20','--users','8','--duration','12','--output',str(output)]
            with patch.object(sys, 'argv', args), patch.object(run_capacity_remote, 'run_once', side_effect=CapacityFailure('fixture','command_failed')), patch('sys.stdout', new_callable=io.StringIO):
                self.assertEqual(run_capacity_remote.main(), 2)
            manifest = json.loads((output/'manifest.json').read_text())
            self.assertEqual((manifest['error_phase'],manifest['error_code']), ('fixture','command_failed'))

    def test_target_error_phase_survives_cleanup_without_secret_output(self):
        program = ('import subprocess,capacity_target as t;'
                   't.CURRENT_PHASE="build_frontend";'
                   't.run=lambda channel:(_ for _ in ()).throw(subprocess.CalledProcessError(1,["secret-token"],stderr="secret-environment"));'
                   'raise SystemExit(t.main())')
        process = subprocess.Popen([sys.executable,'-c',program], cwd=harness.BACKEND/'tests',
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            self.assertEqual(process.wait(timeout=5), 1)
            self.assertEqual(json.loads(process.stdout.readline()), {'error':'target_session_failed','phase':'build_frontend','reason_code':'command_failed'})
            self.assertEqual(process.stderr.read(), b'')
        finally:
            if process.poll() is None:
                os.killpg(process.pid,signal.SIGKILL);process.wait()
            process.stdin.close();process.stdout.close();process.stderr.close()
    def test_protocol_rejects_nonfinite_and_ambiguous_json(self):
        for raw in ('{"value":NaN}', '{"value":Infinity}', '{"value":-Infinity}', '{"value":1e309}', '{"version":1,"version":2}'):
            with self.assertRaises(ValueError): strict_json_loads(raw)
        for value in (float('nan'), float('inf'), float('-inf'), True, '10'):
            item = budget(); item['ceilings']['wal_bytes'] = value
            with self.assertRaises(ValueError): validate_budget(item)
        item = budget(); item['version'] = True
        with self.assertRaises(ValueError): validate_budget(item)

    def test_build_commit_is_validated_and_passed_as_one_argument(self):
        with patch.object(harness.subprocess, 'run') as run:
            harness.build_binary(Path('/tmp/synthetic-binary'), build_sha='a'*40)
            self.assertIn('-ldflags=-X main.commit='+'a'*40, run.call_args.args[0])
            for invalid in ('unknown', 'a'*40+';echo nope', True):
                with self.assertRaises(ValueError): harness.build_binary(Path('/tmp/synthetic-binary'), build_sha=invalid)
            self.assertEqual(run.call_count, 1)

    def test_environment_is_allowlist_not_secret_denylist(self):
        result = clean_environment({'PATH':'/bin', 'HOME':'/tmp/test', 'APP_ADMIN_PASSWORD':'secret', 'PB_URL':'https://production.invalid',
            'HTTPS_PROXY':'secret', 'HINGHWA_IDENTITY_BASE_URL':'https://production.invalid', 'NODE_OPTIONS':'--require evil',
            'GOMAXPROCS':'100', 'GOMEMLIMIT':'secret', 'NEW_PROVIDER_TOKEN':'secret'})
        self.assertEqual(result, {'PATH':'/bin', 'HOME':'/tmp/test'})

    def test_protocol_rejects_paths_urls_unknown_keys_and_bad_workload(self):
        valid = init()
        validate_init(valid)
        for key, value in [('data_dir','/existing'), ('url','https://production.invalid'), ('nonce','../escape'), ('duration',False), ('users',31), ('profile','full')]:
            item = {**valid, key:value}
            with self.assertRaises(ValueError): validate_init(item)
        for value in ['https://example.com', 'http://localhost:1234', 'http://127.0.0.1:22', 'http://127.0.0.1:1234/path']:
            with self.assertRaises(ValueError): loopback_port(value)
        self.assertEqual(loopback_port('http://127.0.0.1:1234'), 1234)

    def test_budget_missing_values_cannot_become_pass(self):
        data = budget(); validate_budget(data)
        data['ceilings']['wal_bytes'] = None; validate_budget(data)
        target = {'workload': {'duration': 10}, 'host':{'machine_sha256':'target'}, 'hardware':{'effective_cpu_cores':4,'effective_memory_bytes':3800000000,'storage_medium_verified':True}}
        rows = self.rows()
        gates = evaluate_evidence(rows, data, target, {'machine_sha256':'generator'}, {'uncertainty_ms':1,'drift_bound_ms':2}, 'ssh')
        self.assertEqual(gates['resource_budget'], 'incomplete')
        data['ceilings']['wal_bytes'] = float('nan')
        with self.assertRaises(ValueError): validate_budget(data)
        data = budget(); data['recovery']['observe_seconds'] = 9
        with self.assertRaises(ValueError): validate_budget(data)

    def rows(self):
        return [{'at_ms': i*5000, 'observation':'baseline' if i < 3 else 'load' if i < 6 else 'postload_idle',
            'server_rss_bytes':100, 'frontend_rss_bytes':50, 'target_group_rss_bytes':160,'wal_bytes':500,'data_directory_bytes':500,
            'disk_free_bytes':2000,'unfinished_jobs':0,'heap_bytes':50,'runtime_sample_age_seconds':0,
            'gomaxprocs':2,'go_memory_limit_bytes':805306368,'dev_mode':False,'queue_length':0,'ocr_queue_length':0,'image_queue_length':0} for i in range(9)]

    def test_observed_limits_recovery_and_separation(self):
        target = {'workload': {'duration': 10}, 'host':{'machine_sha256':'target'}, 'hardware':{'effective_cpu_cores':4,'effective_memory_bytes':3800000000,'storage_medium_verified':True}}
        rows = self.rows()
        args = (budget(), target, {'machine_sha256':'generator'}, {'uncertainty_ms':1,'drift_bound_ms':2}, 'ssh')
        gates = evaluate_evidence(rows, *args)
        for key in ('resource_budget','resource_sampling','cooldown_recovery','reference_hardware','separate_generator_host'):
            self.assertEqual(gates[key], 'pass', key)
        rows[-1]['target_group_rss_bytes'] = 1200
        gates = evaluate_evidence(rows, *args)
        self.assertEqual(gates['resource_budget'], 'fail')
        self.assertEqual(gates['cooldown_recovery'], 'fail')
        target['hardware']['storage_medium_verified'] = False
        self.assertEqual(evaluate_evidence(self.rows(), *args)['reference_hardware'], 'incomplete')
        args = (budget(), target, {'machine_sha256':'target'}, {'uncertainty_ms':100}, 'local')
        gates = evaluate_evidence(self.rows(), *args)
        self.assertEqual(gates['separate_generator_host'], 'fail')
        self.assertEqual(gates['clock_alignment'], 'fail')
        rows = self.rows(); rows[-1].pop('frontend_rss_bytes')
        self.assertEqual(evaluate_evidence(rows, *args)['resource_sampling'], 'incomplete')
        self.assertEqual(evaluate_evidence(self.rows()[:3], *args)['cooldown_recovery'], 'incomplete')
        short_idle = self.rows()[:6]+self.rows()[7:]
        self.assertEqual(evaluate_evidence(short_idle, *args)['cooldown_recovery'], 'incomplete')

    def test_ssh_quoting_and_strict_host_keys(self):
        command = ssh_command('capacity-box', "/tmp/test repo'; touch /tmp/no")
        self.assertIn('StrictHostKeyChecking=yes', command)
        self.assertIn('ForwardAgent=no', command)
        with patch.dict(os.environ, {'SSH_AUTH_SOCK':'/tmp/synthetic-agent'}):
            self.assertEqual(transport_environment(True)['SSH_AUTH_SOCK'], '/tmp/synthetic-agent')
            self.assertNotIn('SSH_AUTH_SOCK', transport_environment(False))
        self.assertIn("'\"'\"'", command[-1])
        for target in ['-oProxyCommand=evil', 'host;evil', 'host\nother']:
            with self.assertRaises(ValueError): ssh_command(target, '/tmp/repo')

    def test_owned_root_cleanup_only_its_process_and_directory(self):
        with tempfile.TemporaryDirectory() as unrelated:
            marker = Path(unrelated)/'preserve'; marker.write_text('keep')
            owned = OwnedTarget('f'*32); root = owned.root
            owned.frontend = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'])
            process = owned.frontend
            owned.close(); owned.close()
            self.assertIsNotNone(process.poll())
            self.assertFalse(root.exists())
            self.assertEqual(marker.read_text(), 'keep')

    @unittest.skipUnless(os.name == 'posix', 'POSIX SSH process-group contract')
    def test_eof_during_preparation_kills_child_and_removes_nonce_directory(self):
        # A fake go executable blocks without building or touching the network.
        # The real target protocol must clean up when its controller disappears.
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            executable = root/'go'
            executable.write_text('#!/bin/sh\nexec /bin/sleep 60\n'); executable.chmod(0o700)
            config = init(); config['nonce'] = 'a'*32
            env = {**os.environ, 'PATH':str(root)+os.pathsep+os.environ['PATH']}
            process = subprocess.Popen([sys.executable, str(harness.BACKEND/'tests/capacity_target.py')],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, start_new_session=True)
            try:
                process.stdin.write((json.dumps(config)+'\n').encode()); process.stdin.flush()
                found = []
                for _ in range(100):
                    found = list(Path(tempfile.gettempdir()).glob('wanyu-capacity-'+config['nonce']+'-*'))
                    if found: break
                    time.sleep(.05)
                self.assertTrue(found, 'target did not create its owned temporary root')
                process.stdin.close()
                self.assertNotEqual(process.wait(timeout=15), 0)
                self.assertFalse(any(path.exists() for path in found))
                output = process.stdout.read().decode()
                self.assertNotIn('actors', output)
                self.assertNotIn('password', output)
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL); process.wait()
                process.stdout.close(); process.stderr.close()

    def test_transport_refuses_artifact_path_traversal(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            program = 'import sys,json;sys.stdin.readline();print(json.dumps({"artifact":"../escape","data":"no"}),flush=True)'
            transport = Transport([sys.executable, '-c', program], root)
            try:
                with self.assertRaises(ValueError): transport.request({'op':'test'}, timeout=3)
                self.assertFalse((root.parent/'escape').exists())
            finally:
                transport.close()

    def test_malformed_secret_frame_is_not_echoed_in_error(self):
        with tempfile.TemporaryDirectory() as root:
            program = ('import sys;sys.stdin.readline();'
                       'print(\'{"ok":"ready","config":{"actors":[{"token":"synthetic-secret-sentinel"}]},"value":NaN}\',flush=True)')
            transport = Transport([sys.executable, '-c', program], Path(root))
            try:
                with self.assertRaisesRegex(RuntimeError, '^capacity_run_failed$'):
                    transport.request({'op':'test'}, timeout=3)
                self.assertEqual(list(Path(root).iterdir()), [])
            finally:
                transport.close()

    @unittest.skipUnless(os.name == 'posix', 'POSIX process groups')
    def test_missing_generator_registry_never_signals_a_live_or_exited_process(self):
        process = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'], start_new_session=True)
        try:
            with patch('run_capacity_remote.os.killpg') as signal_group:
                with self.assertRaisesRegex(RuntimeError, '^generator_registry_required$'):
                    stop_generator_group(process)
                signal_group.assert_not_called()
            self.assertIsNone(process.poll())
        finally:
            # This direct child retains its Popen identity; it is not a saved
            # group discovered by walking the process tree.
            process.terminate(); process.wait(timeout=5)
        with patch('run_capacity_remote.os.killpg') as signal_group:
            with self.assertRaisesRegex(RuntimeError, '^generator_registry_required$'):
                stop_generator_group(process)
            signal_group.assert_not_called()

    @unittest.skipUnless(os.name == 'posix', 'POSIX SSH process-group contract')
    def test_normal_target_exit_does_not_wait_for_controller_eof(self):
        # The controller may keep stdin open while waiting for a successful
        # cleanup receipt. The reader must not hold Python's buffered-stdin lock
        # during shutdown or force the controller to terminate the helper.
        program = ('import capacity_target as t;'
                   't.run=lambda channel:t.emit({"ok":"finished"});'
                   'raise SystemExit(t.main())')
        process = subprocess.Popen([sys.executable, '-c', program], cwd=harness.BACKEND/'tests',
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            self.assertEqual(process.wait(timeout=5), 0)
            self.assertEqual(json.loads(process.stdout.readline()), {'ok':'finished'})
            self.assertEqual(process.stderr.read(), b'')
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL); process.wait()
            process.stdin.close(); process.stdout.close(); process.stderr.close()


if __name__ == '__main__': unittest.main()
