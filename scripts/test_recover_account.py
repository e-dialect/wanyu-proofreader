import copy
import contextlib
import io
from types import SimpleNamespace
from unittest.mock import patch
import unittest

from recover_account import main, recovery_command, validate_target


def target():
    return {'Id': 'backend-fixture', 'Image': 'sha256:' + 'a' * 64, 'User': '10001:10001',
            'State': {'Status': 'exited', 'Running': False, 'Restarting': False, 'Paused': False, 'Pid': 0},
            'Mounts': [{'Destination': '/pb/pb_data', 'Type': 'bind', 'Source': '/srv/wanyu/pb_data', 'RW': True}]}


class RecoveryGuardTests(unittest.TestCase):
    def test_actual_stop_state_is_required(self):
        for key, value in [('Status', 'running'), ('Running', True), ('Restarting', True), ('Paused', True), ('Pid', 123)]:
            record = target()
            record['State'][key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                validate_target(record, [])

    def test_other_containers_cannot_use_mount(self):
        record = target()
        peer = copy.deepcopy(record)
        peer['Id'] = 'another-backend'
        peer['State'].update(Running=True, Pid=123, Status='running')
        with self.assertRaisesRegex(RuntimeError, 'Another'):
            validate_target(record, [peer])
        peer['Mounts'][0]['Source'] = '/srv/wanyu'
        with self.assertRaisesRegex(RuntimeError, 'Another'):
            validate_target(record, [peer])
        peer['Mounts'][0]['Source'] = '/srv/unrelated'
        self.assertEqual(validate_target(record, [peer])['source'], '/srv/wanyu/pb_data')

    def test_named_volume_identity_and_unknown_mounts(self):
        record = target()
        record['Mounts'][0].update(Type='volume', Name='wanyu-data')
        self.assertEqual(validate_target(record, [])['source'], 'wanyu-data')
        record['Mounts'][0]['Destination'] = '/unknown/data'
        with self.assertRaises(RuntimeError):
            validate_target(record, [])

    def test_mutable_image_root_or_ambiguous_path_are_refused(self):
        for key, value in [('Image', 'wanyu:latest'), ('User', 'root'), ('User', '')]:
            record = target()
            record[key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                validate_target(record, [])
        record = target()
        record['Mounts'][0]['Source'] = '/srv/data,readonly'
        with self.assertRaises(RuntimeError):
            validate_target(record, [])

    def test_recovery_has_no_network_or_password_argument(self):
        command = recovery_command(validate_target(target(), []), 'users', 'record123', 'operator')
        self.assertIn('--network=none', command)
        self.assertIn('--read-only', command)
        self.assertIn('--pull=never', command)
        self.assertIn('--cap-drop=ALL', command)
        self.assertIn('--password-stdin', command)
        self.assertIn('FANGJI_SKIP_ADMIN_BOOTSTRAP=1', command)
        self.assertIn('type=bind,source=/srv/wanyu/pb_data,target=/pb/pb_data', command)
        self.assertNotIn('--privileged', command)
        self.assertNotIn('--env-file', command)
        self.assertEqual(command.count('-i'), 1)
        self.assertEqual(command, recovery_command(validate_target(target(), []), 'users', 'record123', 'operator'))


    def test_restart_during_password_prompt_is_rechecked_before_mount(self):
        plan = validate_target(target(), [])
        with patch('recover_account.sys.argv', ['recover_account.py', '--container', 'backend', '--id', 'record123', '--operator', 'test']), \
             patch('recover_account.sys.stdin.isatty', return_value=True), \
             patch('recover_account.checked_plan', side_effect=[plan, RuntimeError('restarted')]) as checks, \
             patch('recover_account.getpass.getpass', return_value='SyntheticRecovery123!'), \
             patch('recover_account.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='--password-stdin')) as run, \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(main(), 1)
            self.assertEqual(checks.call_count, 2)
            self.assertEqual(run.call_count, 1)
            self.assertNotIn('--mount', run.call_args.args[0])

    def test_verified_recovery_uses_stdin_and_exact_inspected_image(self):
        plan = validate_target(target(), [])
        password = 'SyntheticRecovery123!'
        with patch('recover_account.sys.argv', ['recover_account.py', '--container', 'backend', '--id', 'record123', '--operator', 'test']), \
             patch('recover_account.sys.stdin.isatty', return_value=True), \
             patch('recover_account.checked_plan', return_value=plan) as checks, \
             patch('recover_account.getpass.getpass', return_value=password), \
             patch('recover_account.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='--password-stdin')) as run:
            self.assertEqual(main(), 0)
            self.assertEqual(checks.call_count, 2)
            self.assertEqual(run.call_count, 2)
            argv = run.call_args.args[0]
            self.assertIn(plan['image'], argv)
            self.assertNotIn(password, repr(argv))
            self.assertEqual(run.call_args.kwargs['input'], (password + '\n').encode())


if __name__ == '__main__':
    unittest.main()
