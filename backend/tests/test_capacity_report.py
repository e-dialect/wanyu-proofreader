import json
import tempfile
import unittest
from pathlib import Path
import capacity_report as report
from capacity_resources import phase_at, trend
from capacity_burst import make_submit_burst
from test_capacity_burst import fixture as burst_fixture, successful_evidence


class CapacityReportTest(unittest.TestCase):
    def fixture(self, root):
        def write(name, value):
            (root/name).write_text(json.dumps(value))
        def records(name, values):
            (root/name).write_text(''.join(json.dumps(value)+'\n' for value in values))
        records('requests.jsonl', [{'vu': 3, 'operation': name, 'duration_ms': 10, 'phase': 'steady', 'status': 200, 'ok': True} for name in report.HTTP_P95])
        records('browser.jsonl', [{'vu': vu, 'operation': name, 'duration_ms': 100, 'phase': 'steady', 'cache_state': cache}
                for vu in (0, 1) for name, cache in [('source_visible', 'cold_browser'), ('source_visible', 'hot_browser'), ('submit_ack', ''), ('editor_ready', '')]])
        records('browser-actors.jsonl', [{'vu': vu, 'successful_ui_submissions': 1} for vu in (0, 1)])
        records('vitals.jsonl', [{'vu': 0, 'id': name, 'name': name, 'value': value} for name, value in [('LCP', 100), ('INP', 20), ('CLS', .01)]])
        write('background.json', {'csv': {'status': 'pass'}, 'slow_export': {'status': 'pass'}})
        for name in ('summary.json', 'browser-generator.json'):
            write(name, {'generator_event_loop_p95_ms': 10, 'errors': []})
        config=burst_fixture()
        config['submit_burst']=make_submit_burst(config)
        requests,events=successful_evidence(config)
        with (root/'requests.jsonl').open('a') as stream:
            for row in requests: stream.write(json.dumps({**row,'duration_ms':10,'phase':'steady'})+'\n')
        records('burst-events.jsonl',events)
        return config

    def test_failed_responses_are_not_fast_successes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);config=self.fixture(root)
            with (root/'requests.jsonl').open('a') as out:
                out.write(json.dumps({'vu':3,'operation':'submit','duration_ms':1,'phase':'steady','status':400,'ok':False})+'\n')
            result=report.summarize(root,config,{'pass':True},[0,0])
            self.assertEqual(result['status'],'fail')
            submit=next(row for row in result['http'] if row['operation']=='submit')
            self.assertEqual(submit['samples'],25)
            self.assertEqual(submit['p95_ms'],10)

    def test_slow_own_history_cannot_hide_behind_fast_primary_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);config=self.fixture(root)
            path=root/'requests.jsonl'
            rows=[json.loads(line) for line in path.read_text().splitlines()]
            for row in rows:
                if row['operation']=='own_reviewed_tasks': row['duration_ms']=600
            path.write_text(''.join(json.dumps(row)+'\n' for row in rows))
            result=report.summarize(root,config,{'pass':True},[0,0])
            self.assertEqual(result['status'],'fail')
            self.assertEqual(next(row for row in result['http'] if row['operation']=='own_reviewed_tasks')['status'],'fail')

    def test_full_run_checks_http_errors_outside_steady_phase(self):
        for filename in ('requests.jsonl', 'browser-http.jsonl'):
            for phase in ('warmup', 'ramp', 'cooldown'):
                with self.subTest(filename=filename, phase=phase), tempfile.TemporaryDirectory() as directory:
                    root=Path(directory);config=self.fixture(root)
                    with (root/filename).open('a') as out:
                        out.write(json.dumps({'vu':0,'operation':'own_reviewed_tasks','duration_ms':1,
                                              'phase':phase,'status':503,'ok':False})+'\n')
                    result=report.summarize(root,config,{'pass':True},[0,0])
                    gates={row['gate']:row for row in result['gates']}
                    self.assertEqual(result['status'],'fail')
                    self.assertEqual(gates['unexpected_http_responses']['status'],'fail')
                    self.assertEqual(gates['unexpected_5xx_timeout_rate']['status'],'fail')
                    self.assertEqual(gates['unexpected_5xx_timeout_rate']['actual'],1/result['http_error_samples'])
                    self.assertEqual(result['http_error_samples'],result['http_samples']+1)
                    self.assertEqual(result['http_error_scope'],'all phases')
                    self.assertEqual(result['latency_scope'],'steady phase only')

    def test_full_run_keeps_latency_source_and_ack_gates_steady_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);config=self.fixture(root)
            with (root/'browser-http.jsonl').open('a') as out:
                out.write(json.dumps({'vu':0,'operation':'own_reviewed_tasks','duration_ms':9999,
                                      'phase':'warmup','status':200,'ok':True})+'\n')
            with (root/'browser.jsonl').open('a') as out:
                for name,cache in [('source_visible','cold_browser'),('source_visible','hot_browser'),('submit_ack','')]:
                    out.write(json.dumps({'vu':0,'operation':name,'duration_ms':9999,
                                          'phase':'cooldown','cache_state':cache})+'\n')
            result=report.summarize(root,config,{'pass':True},[0,0])
            history=next(row for row in result['http'] if row['operation']=='own_reviewed_tasks')
            self.assertEqual(result['status'],'pass')
            self.assertEqual(history['samples'],1)
            self.assertEqual(history['p95_ms'],10)
            self.assertEqual(result['http_error_samples'],result['http_samples']+1)
            self.assertEqual(result['submit_ack']['samples'],2)
            self.assertEqual(result['submit_ack']['p95_ms'],100)
            for source in result['source_visible']:
                if source['cache_state']!='unknown':
                    self.assertEqual(source['samples'],2)
                    self.assertEqual(source['p95_ms'],100)

    def test_expected_conflicts_are_not_fast_successes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);config=self.fixture(root)
            with (root/'requests.jsonl').open('a') as out:
                for _ in range(30):
                    out.write(json.dumps({'vu':3,'operation':'arbitrate','duration_ms':1,'phase':'steady','status':409,'ok':True})+'\n')
            result=report.summarize(root,config,{'pass':True},[0,0])
            arbitration=next(row for row in result['http'] if row['operation']=='arbitrate')
            self.assertEqual(arbitration['samples'],1)
            self.assertEqual(arbitration['p95_ms'],10)
            self.assertEqual(result['expected_conflicts']['arbitrate'],30)
            self.assertEqual(result['status'],'pass')

    def test_unknown_cache_is_not_promoted_to_hot(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);config=self.fixture(root)
            path=root/'browser.jsonl';path.write_text(path.read_text().replace('hot_browser','unknown'))
            result=report.summarize(root,config,{'pass':True},[0,0])
            self.assertEqual(result['status'],'incomplete')
            self.assertEqual(next(row for row in result['source_visible'] if row['cache_state']=='hot_browser')['samples'],0)

    def test_resource_trends_preserve_missing_recovery_evidence(self):
        config={'start_epoch_ms':1000,'phases':[{'name':'steady','seconds':10},{'name':'cooldown','seconds':5}]}
        self.assertEqual(phase_at(config,12),'cooldown')
        self.assertEqual(phase_at(config,16),'recovery')
        self.assertEqual(trend([], 'rss'), {'samples':0})
        self.assertEqual(trend([{'at_ms':0,'rss':100},{'at_ms':5000,'rss':150}], 'rss')['per_second'],10)

    def test_generator_saturation_invalidates_apparent_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);config=self.fixture(root)
            (root/'browser-generator.json').write_text(json.dumps({'generator_event_loop_p95_ms':20.01}))
            self.assertEqual(report.summarize(root,config,{'pass':True},[0,0])['status'],'invalid_generator')


if __name__=='__main__':unittest.main()
