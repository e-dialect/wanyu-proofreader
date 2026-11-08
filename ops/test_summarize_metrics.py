import json
import unittest
from summarize_metrics import summarize


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


if __name__ == '__main__':
    unittest.main()
