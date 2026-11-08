"""Synthetic archives exercise the installer without network or real tools."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class SecurityInstallerTests(unittest.TestCase):
    def run_installer(self, mode):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        binary = b'#!/bin/sh\nprintf "synthetic gitleaks\\n"\n'
        archive = root / 'fixture.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            entry = tarfile.TarInfo('gitleaks')
            entry.size = len(binary)
            entry.mode = 0o755
            output.addfile(entry, io.BytesIO(binary))
        # Only the disposable copy uses a synthetic archive pin. Production pins
        # remain unchanged and the real checksum/extraction/install path runs.
        script = (ROOT / 'scripts/install_security_tool.sh').read_text()
        fixture_digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        script, count = re.subn(r'digest=[0-9a-f]{64}', 'digest=' + fixture_digest, script)
        self.assertEqual(count, 4)
        installer = root / 'installer.sh'
        installer.write_text(script)
        stubs = root / 'bin'
        stubs.mkdir()
        state = root / 'state.json'
        state.write_text('[]')
        sleep_log = root / 'sleeps.txt'
        (stubs / 'uname').write_text('#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n')
        (stubs / 'sleep').write_text('#!/bin/sh\nprintf "%s\\n" "$1" >> "$WANYU_TEST_SLEEPS"\n')
        (stubs / 'curl').write_text(f'#!{sys.executable}\n' + '''import json, os, pathlib, sys
args = sys.argv[1:]
dest = pathlib.Path(args[args.index('-o') + 1])
url = next(arg for arg in args if arg.startswith('https://'))
state = pathlib.Path(os.environ['WANYU_TEST_STATE'])
calls = json.loads(state.read_text())
calls.append({'url': url, 'args': args, 'offset': dest.stat().st_size if dest.exists() else 0})
state.write_text(json.dumps(calls))
mode = os.environ['WANYU_TEST_MODE']
raw = pathlib.Path(os.environ['WANYU_TEST_ARCHIVE']).read_bytes()
if mode == 'failed' or (mode in ('fallback', 'corrupt') and len(calls) == 1) or (mode == 'late' and len(calls) <= 5):
    sys.exit(22)
if mode == 'resume' and len(calls) == 1:
    dest.write_bytes(raw[:20])
    sys.exit(28)
if mode == 'resume_late' and len(calls) <= 5:
    offset = dest.stat().st_size if dest.exists() else 0
    with dest.open('ab') as output:
        output.write(raw[offset:offset + max(1, len(raw) // 8)])
    sys.exit(28)
if mode == 'corrupt':
    dest.write_bytes(b'not the reviewed archive')
else:
    offset = dest.stat().st_size if dest.exists() else 0
    with dest.open('ab') as output:
        output.write(raw[offset:])
''')
        for executable in stubs.iterdir():
            executable.chmod(0o755)
        environment = {**os.environ, 'PATH': str(stubs) + os.pathsep + os.environ['PATH'],
                       'WANYU_TEST_MODE': mode, 'WANYU_TEST_ARCHIVE': str(archive),
                       'WANYU_TEST_STATE': str(state), 'WANYU_TEST_SLEEPS': str(sleep_log)}
        destination = root / 'installed'
        result = subprocess.run(['sh', str(installer), 'gitleaks', str(destination)],
                                env=environment, text=True, capture_output=True, timeout=10)
        calls = json.loads(state.read_text())
        sleeps = sleep_log.read_text().splitlines() if sleep_log.exists() else []
        return result, calls, sleeps, destination

    def test_direct_success_keeps_primary_endpoint(self):
        result, calls, sleeps, destination = self.run_installer('direct')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 1)
        self.assertIn('/releases/download/v8.30.1/', calls[0]['url'])
        self.assertEqual(sleeps, [])
        self.assertTrue((destination / 'gitleaks').is_file())

    def test_official_api_fallback_and_backoff(self):
        result, calls, sleeps, _ = self.run_installer('fallback')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1]['url'], 'https://api.github.com/repos/gitleaks/gitleaks/releases/assets/378332058')
        self.assertIn('Accept: application/octet-stream', calls[1]['args'])
        self.assertEqual(sleeps, ['2'])

    def test_both_front_doors_retry_three_times_before_late_recovery(self):
        result, calls, sleeps, destination = self.run_installer('late')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 6)
        self.assertEqual([call['url'] for call in calls], [calls[0]['url'], calls[1]['url']] * 3)
        self.assertIn('/releases/download/v8.30.1/', calls[0]['url'])
        self.assertEqual(calls[1]['url'], 'https://api.github.com/repos/gitleaks/gitleaks/releases/assets/378332058')
        self.assertEqual(sleeps, ['2', '4', '8', '16', '32'])
        self.assertTrue((destination / 'gitleaks').is_file())

    def test_resumed_download_recomputes_offset(self):
        result, calls, sleeps, _ = self.run_installer('resume')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls[1]['offset'], 20)
        self.assertIn('--continue-at', calls[1]['args'])
        self.assertEqual(sleeps, ['2'])

    def test_partial_download_survives_every_backoff_and_endpoint_switch(self):
        result, calls, sleeps, destination = self.run_installer('resume_late')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 6)
        offsets = [call['offset'] for call in calls]
        self.assertEqual(offsets[0], 0)
        self.assertTrue(all(left < right for left, right in zip(offsets, offsets[1:])), offsets)
        for call in calls:
            self.assertEqual(call['args'][call['args'].index('--continue-at') + 1], '-')
        self.assertEqual(sleeps, ['2', '4', '8', '16', '32'])
        self.assertTrue((destination / 'gitleaks').is_file())

    def test_all_endpoints_fail_clearly_without_installing(self):
        result, calls, sleeps, destination = self.run_installer('failed')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(calls), 6)
        self.assertEqual(sleeps, ['2', '4', '8', '16', '32'])
        self.assertIn('Unable to download pinned gitleaks 8.30.1', result.stderr)
        self.assertNotIn('Traceback', result.stderr)
        self.assertFalse((destination / 'gitleaks').exists())

    def test_fallback_must_still_match_reviewed_digest(self):
        result, _, _, destination = self.run_installer('corrupt')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('SHA-256 does not match', result.stderr)
        self.assertFalse((destination / 'gitleaks').exists())


if __name__ == '__main__':
    unittest.main()
