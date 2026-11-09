import json
import tempfile
import unittest
from pathlib import Path
import capacity_report as report


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
        return {'profile': 'full'}

    def test_failed_responses_are_not_fast_successes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);config=self.fixture(root)
            with (root/'requests.jsonl').open('a') as out:
                out.write(json.dumps({'vu':3,'operation':'submit','duration_ms':1,'phase':'steady','status':400,'ok':False})+'\n')
            result=report.summarize(root,config,{'pass':True},[0,0])
            self.assertEqual(result['status'],'fail')
            submit=next(row for row in result['http'] if row['operation']=='submit')
            self.assertEqual(submit['samples'],1)
            self.assertEqual(submit['p95_ms'],10)

    def test_unknown_cache_is_not_promoted_to_hot(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);config=self.fixture(root)
            path=root/'browser.jsonl';path.write_text(path.read_text().replace('hot_browser','unknown'))
            result=report.summarize(root,config,{'pass':True},[0,0])
            self.assertEqual(result['status'],'incomplete')
            self.assertEqual(next(row for row in result['source_visible'] if row['cache_state']=='hot_browser')['samples'],0)

    def test_generator_saturation_invalidates_apparent_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);config=self.fixture(root)
            (root/'browser-generator.json').write_text(json.dumps({'generator_event_loop_p95_ms':20.01}))
            self.assertEqual(report.summarize(root,config,{'pass':True},[0,0])['status'],'invalid_generator')


if __name__=='__main__':unittest.main()
