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


if __name__ == '__main__':
    unittest.main()
