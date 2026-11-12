import json
import unittest
from summarize_metrics import summarize, timestamp


class MetricsTest(unittest.TestCase):
    def test_percentiles_dedup_and_gaps(self):
        rows = [{'event': 'http_completed', 'route_template': 'GET /items/{id}', 'method': 'GET',
                 'duration_ms': n, 'status': 500 if n == 100 else 200} for n in range(1, 101)]
        for value in (1, 2):
            rows.append({'event': 'web_vital', 'sample': {'buildSha': 'sha', 'pageViewId': 'p', 'metricId': 'm',
                         'name': 'INP', 'value': value, 'entryRoute': 'TaskHall', 'viewportClass': 'desktop'}})
        report = summarize(map(json.dumps, rows))
        self.assertEqual(report['operations'][0]['p95_ms'], 95)
        self.assertEqual(report['operations'][0]['unexpected_5xx_rate'], .01)
        self.assertEqual(report['browser'][0]['samples'], 1)
        self.assertEqual(report['browser'][0]['p75'], 2)
        self.assertTrue(report['browser'][0]['small_sample'])
        self.assertEqual(summarize(['{"event":"collection_gap"}'])['status'], 'incomplete')
        self.assertEqual(summarize(['{"bad'])['malformed_lines'], 1)

    def test_window_queue_results_and_failed_audits_remain_visible(self):
        rows = [
            {'event': 'work_started', 'time': '2026-11-08T12:00:00Z', 'kind': 'csv', 'queue_wait_ms': 22},
            {'event': 'work_finished', 'time': '2026-11-08T12:00:01Z', 'kind': 'csv', 'duration_ms': 150, 'result': 'failed'},
            {'event': 'security_audit_persist_failed', 'time': '2026-11-08T12:00:02Z'},
            {'event': 'runtime_sample', 'time': '2026-11-07T12:00:00Z', 'heap_bytes': 999},
        ]
        report = summarize(map(json.dumps, rows), since=timestamp('2026-11-08T00:00:00Z'))
        self.assertEqual(report['jobs'][0]['queue_wait_p95_ms'], 22)
        self.assertEqual(report['jobs'][0]['results'], {'failed': 1})
        self.assertEqual(report['peak_heap_bytes'], 0)
        self.assertEqual(report['audit_persistence_gaps'], 1)
        self.assertEqual(report['status'], 'incomplete')
        self.assertEqual(summarize(['{"event":"work_started"}'], since=timestamp('2026-11-08T00:00:00Z'))['status'], 'incomplete')

    def test_resource_peaks_and_missing_backup_do_not_become_success(self):
        rows = [{'event': 'container_sample', 'database_bytes': 20, 'wal_bytes': 5,
                 'disk_free_bytes': 900, 'cpu_percent': '123.5%',
                 'cache_usage': {'directories': {'pdf-preview-cache-v1': {'bytes': 8}}},
                 'backup': {'status': 'not_configured', 'evidence': 'local_backup_receipt_only'}},
                {'event': 'container_sample', 'database_bytes': 21, 'wal_bytes': 2, 'disk_free_bytes': 800}]
        report = summarize(map(json.dumps, rows))
        self.assertEqual(report['peak_wal_bytes'], 5)
        self.assertEqual(report['min_disk_free_bytes'], 800)
        self.assertEqual(report['peak_cpu_percent'], 123.5)
        self.assertEqual(report['peak_cache_bytes']['pdf-preview-cache-v1'], 8)
        self.assertEqual(report['backup_evidence_gaps'], 1)
        self.assertEqual(report['status'], 'incomplete')
        rows[0]['backup']['status'] = 'current'
        current = summarize(map(json.dumps, rows))
        self.assertEqual(current['backup_evidence_gaps'], 0)
        self.assertEqual(current['status'], 'observed')

    def test_pdf_cache_hit_rate_and_latency_by_build_and_outcome(self):
        rows = [{'event': 'pdf_preview', 'build_sha': build, 'cache': outcome, 'total_ms': duration,
                 'ts': stamp, 'source_key': 'private-source', 'page_range': '6-7',
                 'user_id': 'private-user', 'asset_id': 'private-asset'}
                for build, outcome, duration, stamp in (
                    ('a', 'watermark-hit', 0, '2026-11-08T12:00:00Z'),
                    ('a', 'pages-hit', 5, '2026-11-08T12:00:01Z'),
                    ('a', 'pages-hit', 10, '2026-11-08T12:00:02Z'),
                    ('a', 'pages-unreadable-degraded', 250, '2026-11-08T12:00:03Z'),
                    ('a', 'image-hit', 2, '2026-11-08T12:00:04Z'),
                    ('b', 'miss-degraded', 100, '2026-11-08T12:00:04Z'),
                    ('b', 'pages-hit', 10, '2026-11-07T12:00:00Z'),
                    ('c', 'image-hit', 4, '2026-11-08T12:00:04Z'))]
        report = summarize(map(json.dumps, rows), since=timestamp('2026-11-08T00:00:00Z'))
        first, second, image_only = report['pdf_previews']
        self.assertEqual((first['build'], first['samples'], first['fallback_samples']), ('a', 5, 4))
        self.assertEqual(first['fallback_cache_hit_rate'], .75)
        self.assertEqual(first['outcomes']['pages-hit'], {'samples': 2, 'p50_ms': 5, 'p95_ms': 10, 'p99_ms': 10})
        self.assertEqual(first['outcomes']['watermark-hit']['p95_ms'], 0)
        self.assertEqual(first['outcomes']['image-hit']['p95_ms'], 2)
        self.assertEqual((second['build'], second['fallback_samples'], second['fallback_cache_hit_rate']), ('b', 1, 0))
        self.assertEqual(image_only['fallback_samples'], 0)
        self.assertIsNone(image_only['fallback_cache_hit_rate'])
        for private in ('private-source', 'private-user', 'private-asset', '6-7'):
            self.assertNotIn(private, json.dumps(report))
        self.assertEqual(report['status'], 'observed')

    def test_empty_window_and_invalid_preview_are_incomplete(self):
        empty = summarize(['PocketBase started', '{"event":"server_started"}'])
        self.assertTrue(empty['no_observations'])
        self.assertEqual(empty['status'], 'incomplete')
        rows = [{'event': 'pdf_preview', 'cache': 'watermark-hit', 'total_ms': 12,
                 'ts': '2026-11-08T12:00:00Z'}]
        outside_window = summarize(map(json.dumps, rows), since=timestamp('2026-11-09T00:00:00Z'))
        self.assertTrue(outside_window['no_observations'])
        self.assertEqual(outside_window['status'], 'incomplete')
        rows.append({'event': 'pdf_preview', 'cache': 'pages-hit', 'total_ms': 'missing'})
        partial = summarize(map(json.dumps, rows))
        self.assertFalse(partial['no_observations'])
        self.assertEqual(partial['invalid_pdf_preview_records'], 1)
        self.assertEqual(partial['status'], 'incomplete')


if __name__ == '__main__':
    unittest.main()
