import datetime
import json
from pathlib import Path
import tempfile
import unittest
from release_preflight import check_receipt


class PreflightTest(unittest.TestCase):
    def test_missing_stale_or_wrong_build_never_pass(self):
        now=datetime.datetime.now(datetime.timezone.utc)
        self.assertEqual(check_receipt(None,24,now)['status'],'pending')
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'receipt.json'
            for value, expected in [
                ({'status':'pass','verified_at':now.isoformat(),'build_sha':'one'},'pass'),
                ({'status':'pass','verified_at':(now-datetime.timedelta(days=2)).isoformat(),'build_sha':'one'},'failed'),
                ({'status':'pass','verified_at':now.isoformat(),'build_sha':'two'},'failed')]:
                path.write_text(json.dumps(value))
                self.assertEqual(check_receipt(path,24,now,'one')['status'],expected)
            path.write_text('not json')
            self.assertEqual(check_receipt(path,24,now)['status'],'failed')


if __name__=='__main__':unittest.main()
