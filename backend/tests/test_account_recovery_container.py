from types import SimpleNamespace
import unittest
from unittest.mock import patch

import run_account_recovery_container as recovery


class RecoveryCreationReceiptTests(unittest.TestCase):
    def test_created_volume_with_failed_ownership_inspection_cannot_report_clean(self):
        owned = recovery.OwnedResources('sha256:' + 'a' * 64)
        with patch.object(recovery, 'docker', return_value=SimpleNamespace(stdout=owned.prefix, returncode=0)) as docker, \
                patch.object(recovery, 'inspect', side_effect=OSError('inspection unavailable')):
            with self.assertRaises(OSError):
                owned.create()
            self.assertIsNone(owned.volume)
            self.assertFalse(owned.cleanup())
            # No deletion by prefix or unverified name is permitted.
            self.assertEqual(docker.call_count, 1)
            self.assertEqual(docker.call_args.args[0][:2], ['volume', 'create'])

    def test_container_create_with_unparseable_identity_cannot_report_clean(self):
        owned = recovery.OwnedResources('sha256:' + 'a' * 64)
        with patch.object(recovery, 'docker', return_value=SimpleNamespace(stdout='unexpected-id', returncode=0)) as docker:
            with self.assertRaisesRegex(recovery.RehearsalFailure, '^invalid_container_identity$'):
                owned.container('backend', [])
            self.assertEqual(owned.containers, [])
            self.assertFalse(owned.cleanup())
            self.assertEqual(docker.call_count, 1)
            self.assertEqual(docker.call_args.args[0][0], 'create')


if __name__ == '__main__':
    unittest.main()
