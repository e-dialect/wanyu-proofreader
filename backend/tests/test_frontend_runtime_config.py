"""Exercise the production entrypoint without touching container/live paths."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(shutil.which('sh') and shutil.which('awk'), 'requires POSIX shell and awk')
class RuntimeConfigTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.html = self.root / 'html'
        self.html.mkdir()
        self.bundle = self.html / 'bundle.js'
        self.bundle.write_text('const immutable = "original";\n', encoding='utf-8')
        self.before = hashlib.sha256(self.bundle.read_bytes()).digest()
        snippets = self.root / 'snippets'
        snippets.mkdir()
        templates = self.root / 'templates'
        templates.mkdir()
        for mode in ['enabled', 'disabled']:
            (templates / f'pocketbase-admin-{mode}.conf').write_text(mode)
        script = (ROOT / 'frontend/docker-entrypoint.d/40-runtime-config.sh').read_text()
        script = script.replace('/etc/nginx/snippets', str(snippets))
        script = script.replace('/opt/fangji/nginx', str(templates))
        script = script.replace('/usr/share/nginx/html', str(self.html))
        self.script = self.root / 'entrypoint.sh'
        self.script.write_text(script)

    def run_config(self, value, fallback='', extra=None):
        return subprocess.run(['sh', str(self.script)], env={**os.environ,
            'VITE_BACKEND_URL': value, 'PB_URL': fallback,
            'ENABLE_POCKETBASE_ADMIN_UI': 'false', 'TRUSTED_PROXY_CIDRS': '127.0.0.1/32', **(extra or {})},
            text=True, capture_output=True, timeout=10)

    def configured_url(self):
        source = (self.html / 'runtime-config.js').read_text().splitlines()[0]
        return json.loads(source.removeprefix('globalThis.__FANGJI_BACKEND_URL__ = ').rstrip(';\n'))

    def test_restart_changes_address_and_empty_restores_origin_without_changing_bundles(self):
        for value in ['https://api.example.test/pb', 'https://new.example.test', '']:
            result = self.run_config(value)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.configured_url(), value)
            self.assertEqual(hashlib.sha256(self.bundle.read_bytes()).digest(), self.before)

    def test_fallback_and_javascript_escaping(self):
        value = 'https://api.example.test/a"b\\c&d|e'
        result = self.run_config('', fallback=value)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.configured_url(), value)
        # A real JS parser must see just a single property assignment.
        result = subprocess.run(['node', '--input-type=module', '-e',
            'import vm from "node:vm"; const context={}; vm.runInNewContext(' +
            json.dumps((self.html / 'runtime-config.js').read_text()) +
            ',context); console.log(JSON.stringify(context.__FANGJI_BACKEND_URL__));'],
            text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), value)

    def test_telemetry_flags_are_atomic_and_not_javascript_injection(self):
        result = self.run_config('', extra={'FANGJI_TELEMETRY_ENABLED': '1', 'FANGJI_BUILD_SHA': 'abc123', 'FANGJI_NATIVE_DELIVERY_ENABLED': '0'})
        self.assertEqual(result.returncode, 0, result.stderr)
        before = (self.html / 'runtime-config.js').read_text()
        result = subprocess.run(['node', '--input-type=module', '-e',
            'import vm from "node:vm"; const context={}; vm.runInNewContext(' + json.dumps(before) +
            ',context); console.log(JSON.stringify([context.__FANGJI_TELEMETRY_ENABLED__,context.__FANGJI_BUILD_SHA__,context.__FANGJI_NATIVE_DELIVERY_ENABLED__]));'],
            text=True, capture_output=True, timeout=10)
        self.assertEqual(json.loads(result.stdout), [True, 'abc123', False])
        for extra in [{'FANGJI_TELEMETRY_ENABLED': 'yes'}, {'FANGJI_BUILD_SHA': 'bad";alert(1)'}, {'FANGJI_NATIVE_DELIVERY_ENABLED': 'yes'}]:
            self.assertNotEqual(self.run_config('', extra=extra).returncode, 0)
            self.assertEqual((self.html / 'runtime-config.js').read_text(), before)

    def test_invalid_value_fails_without_publishing_partial_config(self):
        self.assertEqual(self.run_config('https://valid.example.test').returncode, 0)
        for value in ['ftp://example.test', 'https://example.test/\nnext', 'https://example.test/a b',
                      'https://example.test/\rnext', 'https://example.test/\x01']:
            with self.subTest(value=value):
                self.assertNotEqual(self.run_config(value).returncode, 0)
                self.assertEqual(self.configured_url(), 'https://valid.example.test')
                self.assertEqual(list(self.html.glob('runtime-config.js.*')), [])


if __name__ == '__main__':
    unittest.main()
