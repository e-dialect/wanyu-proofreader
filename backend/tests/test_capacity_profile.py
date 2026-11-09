from pathlib import Path
import subprocess
import unittest


class SourcePayloadPathTest(unittest.TestCase):
    def test_real_pdf_and_image_routes_count_but_descriptors_do_not(self):
        subprocess.run(['node', '--input-type=module', '-e', r'''
import assert from 'node:assert/strict'
import { isSourcePayloadRequest } from './capacity_profile.mjs'
for (const url of [
 'http://127.0.0.1:8090/api/fangji/pages/page123/pdf',
 'http://127.0.0.1:8090/api/fangji/pages/page123/pdf?download=1',
 '/api/fangji/pages/page123/images/12/asset',
 new URL('http://127.0.0.1:8090/api/fangji/pages/page123/images/12/asset?synthetic=1')
]) assert.equal(isSourcePayloadRequest(url), true, String(url))
for (const url of [
 '/api/fangji/pages/page123/pdf/descriptor',
 '/api/fangji/pages/page123/pdf/descriptor?url=/api/fangji/pages/page123/pdf',
 '/api/fangji/pages/page123/images/12/descriptor',
 '/api/fangji/pages/page123/pdf/images/12/asset',
 '/api/fangji/pages/page123/task',
 'http://['
]) assert.equal(isSourcePayloadRequest(url), false, String(url))
'''], cwd=Path(__file__).parent, check=True)


if __name__ == '__main__':
    unittest.main()
