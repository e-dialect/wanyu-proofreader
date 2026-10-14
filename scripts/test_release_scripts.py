"""Exercise publication authorization and immutable manifest failure boundaries."""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
RELEASE = yaml.safe_load((ROOT / '.github/workflows/release.yml').read_text())
CI = yaml.safe_load((ROOT / '.github/workflows/ci.yml').read_text())
SHA = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()


def node(source, env=None):
    return subprocess.run(['node', '--input-type=module', '-e', source], cwd=ROOT,
                          env={**os.environ, **(env or {})}, capture_output=True, text=True, timeout=20)


class AuthorizationTests(unittest.TestCase):
    def authorize(self, mutation=None):
        script = RELEASE['jobs']['authorize']['steps'][0]['with']['script']
        state = {'sha': SHA, 'main': SHA, 'event': 'push', 'repository': 'e-dialect/wanyu-proofreader',
                 'latest': 100, 'conclusion': 'success', 'gate': 'success'}
        state.update(mutation or {})
        harness = '''const s=STATE;
const run={id:100,run_number:10,head_sha:s.sha,head_branch:'main',
 head_repository:{full_name:s.repository},repository:{full_name:s.repository},
 workflow_id:42,event:s.event,status:'completed',conclusion:s.conclusion};
const github={rest:{repos:{getBranch:async()=>({data:{commit:{sha:s.main}}})},actions:{
 getWorkflow:async()=>({data:{id:42}}),getWorkflowRun:async()=>({data:run}),
 listWorkflowRuns:async()=>({data:{workflow_runs:[run,{...run,id:s.latest,run_number:11}]}}),
 listJobsForWorkflowRun:()=>{}}},paginate:async()=>s.gate===null?[]:[{name:'CI gate',status:'completed',conclusion:s.gate}]};
const context={repo:{owner:'e-dialect',repo:'wanyu-proofreader'},payload:{workflow_run:{id:100,head_sha:s.sha}}};
const outputs={};const core={setOutput:(k,v)=>outputs[k]=v};
const execute=new (Object.getPrototypeOf(async()=>{}).constructor)('github','context','core',SCRIPT);
try{await execute(github,context,core);console.log(JSON.stringify(outputs))}catch(e){process.exitCode=1}
'''.replace('STATE', json.dumps(state)).replace('SCRIPT', json.dumps(script))
        return node(harness)

    def test_trusted_current_main_latest_ci_passes(self):
        result = self.authorize()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['source_sha'], SHA)

    def test_untrusted_stale_failed_or_missing_gate_cannot_authorize(self):
        for mutation in [{'event': 'pull_request'}, {'repository': 'fork/wanyu-proofreader'},
                         {'main': 'a' * 40}, {'latest': 101}, {'conclusion': 'failure'},
                         {'gate': 'failure'}, {'gate': None}]:
            with self.subTest(mutation=mutation):
                self.assertNotEqual(self.authorize(mutation).returncode, 0)

    def test_all_ci_jobs_feed_gate_and_only_authorized_job_has_package_write(self):
        jobs = CI['jobs']
        self.assertEqual(set(jobs['ci-gate']['needs']), set(jobs) - {'ci-gate'})
        self.assertEqual(jobs['ci-gate']['if'], 'always()')
        events = RELEASE.get('on', RELEASE.get(True))
        self.assertEqual(set(events), {'workflow_run', 'workflow_dispatch'})
        self.assertEqual(RELEASE['permissions'], {'contents': 'read'})
        self.assertNotIn('packages', RELEASE['jobs']['authorize']['permissions'])
        self.assertFalse(any('checkout' in step.get('uses', '') for step in RELEASE['jobs']['authorize']['steps']))
        self.assertEqual(RELEASE['jobs']['publish']['needs'], 'authorize')
        self.assertEqual(RELEASE['jobs']['publish']['permissions']['packages'], 'write')


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = pathlib.Path(self.temp.name)
        self.env = {'SOURCE_SHA': SHA, 'VERSION': 'sha-' + SHA, 'BUILD_DATE': '2026-10-14T00:00:00Z'}
        for service in ['backend', 'frontend']:
            self.write_manifest(service, {'schemaVersion': 2,
                'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                'config': {'digest': 'sha256:' + 'c' * 64}})
            self.write_config(service, {'os': 'linux', 'architecture': 'amd64',
                'config': {'Labels': {'org.opencontainers.image.revision': SHA}}})

    def tearDown(self):
        self.temp.cleanup()

    def write_manifest(self, service, value):
        raw = json.dumps(value).encode()
        (self.directory / (service + '-manifest.json')).write_bytes(raw + b'\n')
        self.env[service.upper() + '_DIGEST'] = 'sha256:' + hashlib.sha256(raw).hexdigest()

    def write_config(self, service, value):
        (self.directory / (service + '-config.json')).write_text(json.dumps(value))

    def create(self):
        return subprocess.run(['node', 'scripts/create-release-manifest.mjs', str(self.directory)], cwd=ROOT,
                              env={**os.environ, **self.env}, capture_output=True, text=True, timeout=20)

    def test_verified_manifest_binds_images_runtime_config_and_migrations(self):
        result = self.create()
        self.assertEqual(result.returncode, 0, result.stderr)
        release = json.loads((self.directory / 'release-manifest.json').read_text())
        self.assertEqual(release['build']['frontend'], {'VITE_BACKEND_URL': ''})
        self.assertEqual(release['recovery']['compatibility'], 'server-local-attestation-required')
        self.assertFalse(release['recovery']['rollbackSafe'])
        entries = []
        tree = subprocess.check_output(['git', 'ls-tree', '-rz', '--full-tree', SHA, '--', 'backend/pb_migrations'], cwd=ROOT)
        for record in tree.decode().split('\0'):
            if not record:
                continue
            metadata, path = record.split('\t')
            content = subprocess.check_output(['git', 'cat-file', 'blob', metadata.split()[2]], cwd=ROOT)
            entries.append({'path': path, 'sha256': hashlib.sha256(content).hexdigest()})
        canonical = json.dumps(sorted(entries, key=lambda e: e['path']), separators=(',', ':'), ensure_ascii=False).encode()
        self.assertEqual(release['recovery']['migrationDigest'], 'sha256:' + hashlib.sha256(canonical).hexdigest())
        go_mod = subprocess.check_output(['git', 'show', SHA + ':backend/go.mod'], cwd=ROOT, text=True)
        version = re.search(r'github.com/pocketbase/pocketbase v([^\s]+)', go_mod).group(1)
        self.assertEqual(release['recovery']['pocketbaseVersion'], version)
        self.assertEqual(set(release['images']), {'backend', 'frontend'})

    def test_tampered_registry_bytes_do_not_produce_manifest(self):
        with (self.directory / 'backend-manifest.json').open('ab') as stream:
            stream.write(b' ')
        self.assertNotEqual(self.create().returncode, 0)
        self.assertFalse((self.directory / 'release-manifest.json').exists())

    def test_wrong_platform_or_revision_is_rejected(self):
        for key, value in [('architecture', 'arm64'), ('revision', 'a' * 40)]:
            with self.subTest(key=key):
                config = {'os': 'linux', 'architecture': 'amd64', 'config': {'Labels': {'org.opencontainers.image.revision': SHA}}}
                if key == 'revision':
                    config['config']['Labels']['org.opencontainers.image.revision'] = value
                else:
                    config[key] = value
                self.write_config('backend', config)
                self.assertNotEqual(self.create().returncode, 0)
                self.assertFalse((self.directory / 'release-manifest.json').exists())


class ImmutableTagTests(unittest.TestCase):
    def check(self, responses):
        script = (ROOT / 'scripts/assert-release-tags-absent.mjs').resolve().as_uri()
        code = '''import assert from 'node:assert/strict';
const responses=RESPONSES;let count=0;
globalThis.fetch=async(url)=>{assert.ok(url.startsWith('https://api.github.com/orgs/e-dialect/packages/container/wanyu-proofreader-'));const r=responses[count++];return {status:r.status,ok:r.status===200,json:async()=>r.body}};
await import(SCRIPT);assert.equal(count,responses.length);
'''.replace('RESPONSES', json.dumps(responses)).replace('SCRIPT', json.dumps(script))
        return node(code, {'SOURCE_SHA': SHA, 'GHCR_TOKEN': 'synthetic-fixture-token'})

    def test_new_packages_can_publish_but_both_packages_are_checked(self):
        self.assertEqual(self.check([{'status': 404}, {'status': 200, 'body': []}]).returncode, 0)
        existing = {'status': 200, 'body': [{'metadata': {'container': {'tags': ['sha-' + SHA]}}}]}
        self.assertNotEqual(self.check([{'status': 404}, existing]).returncode, 0)

    def test_registry_api_errors_fail_closed(self):
        for status in [401, 403, 429, 500]:
            with self.subTest(status=status):
                self.assertNotEqual(self.check([{'status': status}]).returncode, 0)


if __name__ == '__main__':
    unittest.main()
