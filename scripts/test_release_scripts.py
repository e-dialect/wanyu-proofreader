"""Exercise publication authorization and immutable manifest failure boundaries."""
import datetime
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
RELEASE = yaml.safe_load((ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8'))
CI = yaml.safe_load((ROOT / '.github/workflows/ci.yml').read_text(encoding='utf-8'))
SHA = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True, encoding='utf-8').strip()
COMMIT_DATE = datetime.datetime.fromtimestamp(int(subprocess.check_output(['git', 'show', '-s', '--format=%ct', SHA], cwd=ROOT)), datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

def labels():
    return {'org.opencontainers.image.revision': SHA, 'org.opencontainers.image.source': 'https://github.com/e-dialect/wanyu-proofreader', 'org.opencontainers.image.version': 'sha-' + SHA, 'org.opencontainers.image.created': COMMIT_DATE}


def node(source, env=None):
    return subprocess.run(['node', '--input-type=module', '-e', source], cwd=ROOT,
                          env={**os.environ, **(env or {})}, capture_output=True, text=True,
                          encoding='utf-8', timeout=20)


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
        steps = {step['id']: step for step in RELEASE['jobs']['publish']['steps'] if 'id' in step}
        for service in ['backend', 'frontend']:
            self.assertEqual(steps[service]['if'], f"steps.existing.outputs.{service}_digest == ''")


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = pathlib.Path(self.temp.name)
        self.env = {'SOURCE_SHA': SHA, 'VERSION': 'sha-' + SHA, 'BUILD_DATE': COMMIT_DATE}
        for service in ['backend', 'frontend']:
            self.write_config(service, {'os': 'linux', 'architecture': 'amd64',
                'config': {'Labels': labels()}})
            self.bind_config(service)

    def tearDown(self):
        self.temp.cleanup()

    def write_manifest(self, service, value):
        raw = json.dumps(value).encode()
        (self.directory / (service + '-manifest.json')).write_bytes(raw + b'\n')
        self.env[service.upper() + '_DIGEST'] = 'sha256:' + hashlib.sha256(raw).hexdigest()

    def write_config(self, service, value):
        (self.directory / (service + '-config.json')).write_text(json.dumps(value), encoding='utf-8')

    def bind_config(self, service):
        raw = (self.directory / (service + '-config.json')).read_bytes()
        self.write_manifest(service, {'schemaVersion': 2,
            'mediaType': 'application/vnd.oci.image.manifest.v1+json',
            'config': {'digest': 'sha256:' + hashlib.sha256(raw).hexdigest(), 'size': len(raw)}})

    def create(self):
        return subprocess.run(['node', 'scripts/create-release-manifest.mjs', str(self.directory)], cwd=ROOT,
                              env={**os.environ, **self.env}, capture_output=True, text=True,
                              encoding='utf-8', timeout=20)

    def test_verified_manifest_binds_images_runtime_config_and_migrations(self):
        result = self.create()
        self.assertEqual(result.returncode, 0, result.stderr)
        release = json.loads((self.directory / 'release-manifest.json').read_text(encoding='utf-8'))
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
        go_mod = subprocess.check_output(['git', 'show', SHA + ':backend/go.mod'], cwd=ROOT, text=True, encoding='utf-8')
        version = re.search(r'github.com/pocketbase/pocketbase v([^\s]+)', go_mod).group(1)
        self.assertEqual(release['recovery']['pocketbaseVersion'], version)
        self.assertEqual(set(release['images']), {'backend', 'frontend'})

    def test_tampered_registry_bytes_do_not_produce_manifest(self):
        with (self.directory / 'backend-manifest.json').open('ab') as stream:
            stream.write(b' ')
        self.assertNotEqual(self.create().returncode, 0)
        self.assertFalse((self.directory / 'release-manifest.json').exists())

    def test_raw_config_must_match_manifest_digest(self):
        raw = (self.directory / 'backend-config.json').read_bytes()
        # Keep valid JSON and byte length so only the content hash detects this.
        tampered = raw.replace(b'linux', b'linuz', 1)
        self.assertEqual(len(raw), len(tampered))
        (self.directory / 'backend-config.json').write_bytes(tampered)
        self.assertNotEqual(self.create().returncode, 0)
        self.assertFalse((self.directory / 'release-manifest.json').exists())

    def test_wrong_platform_or_revision_is_rejected(self):
        for key, value in [('architecture', 'arm64'), ('revision', 'a' * 40)]:
            with self.subTest(key=key):
                config = {'os': 'linux', 'architecture': 'amd64', 'config': {'Labels': labels()}}
                if key == 'revision':
                    config['config']['Labels']['org.opencontainers.image.revision'] = value
                else:
                    config[key] = value
                self.write_config('backend', config)
                self.bind_config('backend')
                self.assertNotEqual(self.create().returncode, 0)
                self.assertFalse((self.directory / 'release-manifest.json').exists())


class ImmutableTagTests(unittest.TestCase):
    def check(self, responses):
        script = (ROOT / 'scripts/resolve-release-images.mjs').resolve().as_uri()
        code = '''import assert from 'node:assert/strict';
const responses=RESPONSES;let count=0;
globalThis.fetch=async(url)=>{assert.ok(url.startsWith('https://api.github.com/orgs/e-dialect/packages/container/wanyu-proofreader-'));const r=responses[count++];return {status:r.status,ok:r.status===200,json:async()=>r.body}};
await import(SCRIPT);assert.equal(count,responses.length);
'''.replace('RESPONSES', json.dumps(responses)).replace('SCRIPT', json.dumps(script))
        with tempfile.TemporaryDirectory() as temp:
            return node(code, {'SOURCE_SHA': SHA, 'GHCR_TOKEN': 'synthetic-fixture-token', 'BUILD_DATE': COMMIT_DATE, 'GITHUB_OUTPUT': str(pathlib.Path(temp) / 'github-output')})

    def test_new_packages_can_publish_but_both_packages_are_checked(self):
        self.assertEqual(self.check([{'status': 404}, {'status': 200, 'body': []}]).returncode, 0)
        existing = {'status': 200, 'body': [{'metadata': {'container': {'tags': ['sha-' + SHA]}}}]}
        self.assertNotEqual(self.check([{'status': 404}, existing]).returncode, 0)

    def test_retry_reuses_only_fully_verified_published_digest(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = pathlib.Path(temp)
            config = {'os': 'linux', 'architecture': 'amd64', 'config': {'Labels': labels()}}
            def registry_response():
                raw_config = json.dumps(config).encode()
                raw = json.dumps({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json', 'config': {'digest': 'sha256:' + hashlib.sha256(raw_config).hexdigest(), 'size': len(raw_config)}}).encode()
                digest = 'sha256:' + hashlib.sha256(raw).hexdigest()
                (directory / 'manifest').write_bytes(raw)
                return digest, raw_config
            docker = directory / 'docker'
            docker.write_text("#!/usr/bin/env python3\nimport pathlib,sys\np=pathlib.Path(__file__).parent\nassert sys.argv[1:4]==['buildx','imagetools','inspect']\nassert any('wanyu-proofreader-'+s+'@sha256:' in sys.argv[4] for s in ['backend','frontend'])\nsys.stdout.buffer.write((p/'manifest').read_bytes())\n", encoding='utf-8')
            docker.chmod(0o755)
            script = (ROOT / 'scripts/resolve-release-images.mjs').resolve().as_uri()
            def execute(redirect_host=None, both_existing=False):
                (directory / 'github-output').unlink(missing_ok=True)
                digest, raw_config = registry_response()
                existing = {'status': 200, 'body': [{'name': digest, 'metadata': {'container': {'tags': ['sha-' + SHA]}}}]}
                responses = [existing, existing if both_existing else {'status': 404}]
                code = "import assert from 'node:assert/strict';const r=" + json.dumps(responses) + ";const blob=" + json.dumps(raw_config.decode()) + ";const redirect=" + json.dumps(redirect_host) + ";let n=0;globalThis.fetch=async(url,options)=>{url=String(url);if(url.startsWith('https://ghcr.io/token?'))return new Response(JSON.stringify({token:'synthetic-pull-token'}));if(url.includes('/blobs/'))return redirect?new Response(null,{status:307,headers:{location:'https://'+redirect+'/fixture?signature=synthetic'}}):new Response(blob);if(url.startsWith('https://pkg-containers.githubusercontent.com/')){assert.equal(options.headers?.Authorization,undefined);return new Response(blob)}const v=r[n++];return {status:v.status,ok:v.status===200,json:async()=>v.body}};await import(" + json.dumps(script) + ");"

                env = {'PATH': str(directory) + os.pathsep + os.environ['PATH'], 'SOURCE_SHA': SHA, 'GHCR_TOKEN': 'synthetic-fixture-token', 'GITHUB_ACTOR': 'synthetic-actor', 'BUILD_DATE': COMMIT_DATE, 'GITHUB_OUTPUT': str(directory / 'github-output')}
                return node(code, env), digest
            for both_existing in (False, True):
                with self.subTest(both_existing=both_existing):
                    result, digest = execute(both_existing=both_existing)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual((directory / 'github-output').read_text(encoding='utf-8'), 'backend_digest=' + digest + '\nfrontend_digest=' + (digest if both_existing else '') + '\n')
            self.assertEqual(execute('pkg-containers.githubusercontent.com')[0].returncode, 0)
            untrusted = execute('untrusted.example')[0]
            self.assertNotEqual(untrusted.returncode, 0)
            self.assertIn('Untrusted registry blob redirect', untrusted.stderr)
            # Valid raw blobs with mismatched identity still must not be reused.
            for key, value in [('org.opencontainers.image.revision', 'a' * 40), ('org.opencontainers.image.source', 'https://github.com/other/repo'), ('org.opencontainers.image.version', 'unexpected-version'), ('org.opencontainers.image.created', '2020-01-01T00:00:00Z')]:
                with self.subTest(label=key):
                    config['config']['Labels'] = labels()
                    config['config']['Labels'][key] = value
                    self.assertNotEqual(execute()[0].returncode, 0)

    def test_registry_api_errors_fail_closed(self):
        for status in [401, 403, 429, 500]:
            with self.subTest(status=status):
                self.assertNotEqual(self.check([{'status': status}]).returncode, 0)


if __name__ == '__main__':
    unittest.main()
