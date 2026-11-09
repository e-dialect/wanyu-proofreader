import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest import mock

import collect_runtime as runtime


class RuntimeCollectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.now = 1800000000
        self.receipt = self.root / 'receipt.json'

    def write_receipt(self, **changes):
        value = {'format': 1, 'status': 'pass', 'version': 'sha256:synthetic', 'files': 3,
                 'created_at': runtime.timestamp(self.now - 120), 'verified_at': runtime.timestamp(self.now - 60)}
        value.update(changes)
        self.receipt.write_text(json.dumps(value))

    def test_cache_metadata_only_and_missing_directories(self):
        cache = self.root / 'pdf-preview-cache-v1'
        (cache / 'pages').mkdir(parents=True)
        (cache / 'pages/a.pdf').write_bytes(b'private-body')
        (self.root / 'storage').mkdir()
        (self.root / 'storage/private.pdf').write_bytes(b'unrelated' * 1000)
        with mock.patch.object(Path, 'open', side_effect=AssertionError('must not read file bodies')):
            values = runtime.cache_sizes(self.root)
        self.assertEqual(values['pdf-preview-cache-v1'], {'status': 'ok', 'bytes': 12, 'files': 1})
        self.assertEqual(values['pdf-upload-staging-v1']['status'], 'absent')

    @unittest.skipIf(os.name == 'nt', 'symlink privileges are platform-specific')
    def test_cache_links_do_not_follow_external_content(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'secret').write_bytes(b'x' * 10000)
        cache = self.root / 'pdf-preview-cache-v1'
        cache.mkdir()
        (cache / 'outside').symlink_to(outside, target_is_directory=True)
        (cache / 'secret').symlink_to(outside / 'secret')
        (self.root / 'pdf-upload-staging-v1').symlink_to(outside, target_is_directory=True)
        values = runtime.cache_sizes(self.root)
        self.assertEqual(values['pdf-preview-cache-v1']['bytes'], 0)
        self.assertEqual(values['pdf-upload-staging-v1'], {'status': 'gap', 'error_type': 'Symlink'})

    def test_cache_permissions_are_explicit_gap_not_zero(self):
        cache = self.root / 'pdf-preview-cache-v1'
        cache.mkdir()
        with mock.patch('audit_storage.os.scandir', side_effect=PermissionError('private path must not leak')):
            value = runtime.cache_sizes(self.root)['pdf-preview-cache-v1']
        self.assertEqual(value['status'], 'gap')
        self.assertNotIn('bytes', value)
        self.assertNotIn('private path', json.dumps(value))

    def test_cache_scan_is_low_frequency_and_data_dir_scoped(self):
        sampler = runtime.CacheSampler(300)
        with mock.patch.object(runtime, 'cache_sizes', return_value={}) as scan:
            first = sampler.get(self.root, now=self.now, tick=10)
            cached = sampler.get(self.root, now=self.now + 5, tick=15)
            self.assertEqual(scan.call_count, 1)
            self.assertEqual(first['sampled_at'], cached['sampled_at'])
            self.assertEqual(cached['age_seconds'], 5)
            sampler.get(self.root, now=self.now + 300, tick=310)
            self.assertEqual(scan.call_count, 2)
            sampler.get(self.root / 'different', now=self.now + 301, tick=311)
            self.assertEqual(scan.call_count, 3)

    def test_receipt_reports_fixed_fields_and_limits_claims(self):
        self.write_receipt(private_body='never output me')
        result = runtime.backup_receipt(self.receipt, now=self.now)
        self.assertEqual(result['status'], 'current')
        self.assertEqual(result['age_seconds'], 60)
        self.assertEqual(result['files'], 3)
        self.assertNotIn('private_body', result)
        self.assertFalse(result['restore_verified'])
        self.assertFalse(result['offsite_verified'])
        self.assertFalse(result['integrity_rechecked'])

    def test_unconfigured_missing_and_expired_are_distinct(self):
        self.assertEqual(runtime.backup_receipt(None)['status'], 'not_configured')
        self.assertEqual(runtime.backup_receipt(self.receipt)['status'], 'missing')
        self.write_receipt()
        value = runtime.backup_receipt(self.receipt, now=self.now, max_age=59)
        self.assertEqual(value['status'], 'expired')
        self.assertEqual(value['verified_at'], runtime.timestamp(self.now - 60))

    def test_corruption_large_file_and_untrusted_schema(self):
        for raw in ['{invalid', '[]', '"private"', 'x' * 8192, '[' * 2000 + ']' * 2000, '{"status":"fail","status":"pass"}', '{"private":"' + 'x' * 9000 + '"}']:
            self.receipt.write_text(raw)
            with self.subTest(raw_length=len(raw)):
                self.assertEqual(runtime.backup_receipt(self.receipt, now=self.now)['status'], 'invalid')
        for changes in [{'status': 'fail'}, {'format': 2}, {'format': True}, {'files': True}, {'files': -1}, {'version': 'bad\nvalue'}, {'version': 'x' * 513}, {'verified_at': '2026-01-01'}, {'verified_at': runtime.timestamp(self.now + 301)}, {'created_at': runtime.timestamp(self.now)}]:
            self.write_receipt(**changes)
            with self.subTest(changes=changes):
                self.assertEqual(runtime.backup_receipt(self.receipt, now=self.now)['status'], 'invalid')

    @unittest.skipIf(os.name == 'nt', 'symlink privileges are platform-specific')
    def test_receipt_symlink_is_not_opened(self):
        external = self.root / 'outside.json'
        external.write_text('{"private":"secret"}')
        self.receipt.symlink_to(external)
        with mock.patch.object(runtime.os, 'open', side_effect=AssertionError('must not open symlink')):
            result = runtime.backup_receipt(self.receipt)
        self.assertEqual(result['error_type'], 'Symlink')

    def test_receipt_read_permission_failure_is_gap(self):
        self.write_receipt()
        with mock.patch.object(runtime.os, 'open', side_effect=PermissionError('secret path')):
            result = runtime.backup_receipt(self.receipt, now=self.now)
        self.assertEqual(result['status'], 'gap')
        self.assertEqual(result['error_type'], 'PermissionError')
        self.assertNotIn('secret', json.dumps(result))

    def test_cli_keeps_valid_metrics_and_emits_separate_gap(self):
        (self.root / 'data.db').write_bytes(b'123')
        output = self.root / 'runtime.jsonl'
        result = subprocess.run([sys.executable, str(Path(runtime.__file__)), '--data-dir', str(self.root), '--output', str(output), '--backup-receipt', str(self.receipt), '--once'], capture_output=True)
        self.assertEqual(result.returncode, 1)
        records = [json.loads(line) for line in output.read_text().splitlines()]
        self.assertEqual([record['event'] for record in records], ['container_sample', 'collection_gap'])
        self.assertEqual(records[0]['database_bytes'], 3)
        self.assertEqual(records[1]['scopes'], ['backup_receipt'])

    def test_partial_samples_keep_metrics_and_mark_collection_gap(self):
        (self.root / 'data.db').write_bytes(b'123')
        result = runtime.sample(self.root, caches={'directories': {'pdf-preview-cache-v1': {'status': 'gap'}}}, receipt_path=self.receipt)
        self.assertEqual(result['event'], 'container_sample')
        self.assertEqual(result['database_bytes'], 3)
        self.assertEqual(result['collection_gaps'], ['cache:pdf-preview-cache-v1', 'backup_receipt'])


if __name__ == '__main__':
    unittest.main()
