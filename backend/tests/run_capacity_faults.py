#!/usr/bin/env python3
"""Independent disposable fault gate. No URL, token or data-dir inputs are accepted.

Full mode repeats the five real fault gates across a >=15 minute orchestration
window. This is separate from the steady-load capacity run, not a claim that
each fault occurred throughout every second of that window.
"""
import argparse
import json
import os
import re
import secrets
import tempfile
import subprocess
import sys
import time
from pathlib import Path
import harness
import capacity_fixture
from capacity_remote_contract import same_source
from capacity_process_ownership import ProcessRegistry


class FaultCleanupUnconfirmed(RuntimeError):
    def __init__(self, exit_code):
        super().__init__('fault_process_cleanup_unconfirmed')
        self.exit_code = exit_code


def controlled_run(command, cwd, log_path, timeout=1800):
    # Test suites can print fixture passwords/tokens. Keep diagnostic output but
    # redact credentials before copying it out of the temporary capture file.
    # Only this fixed fault-suite subtree receives the Node preload. The real
    # backend Popen/PB_TEST_SERVER_PID inside each suite remain untouched.
    with tempfile.TemporaryDirectory(prefix='wanyu-fault-ownership-') as temporary, \
            tempfile.TemporaryFile(mode='w+', encoding='utf-8') as capture:
        registry = ProcessRegistry(Path(temporary).resolve()/'processes', create=True)
        ticket = secrets.token_hex(16)
        pending = registry.root/(ticket+'.pending')
        fd = os.open(pending, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as out:
            out.write(registry.nonce)
        preload = harness.BACKEND/'tests/capacity_owned_spawn.cjs'
        guardian = harness.BACKEND/'tests/capacity_process_ownership.py'
        env = {**os.environ, 'CAPACITY_PROCESS_REGISTRY':str(registry.root),
               'CAPACITY_GUARDIAN_PYTHON':sys.executable,
               'NODE_OPTIONS':(os.environ.get('NODE_OPTIONS','')+' --require='+json.dumps(str(preload))).strip()}
        process = None
        code, cleanup_failed = None, False
        try:
            try:
                process = subprocess.Popen([sys.executable,str(guardian),str(registry.root),ticket,
                    '--interrupt','--',*command], cwd=cwd, env=env, stdout=capture, stderr=subprocess.STDOUT,
                    start_new_session=True)
            except (OSError, ValueError):
                pending.unlink()
                raise
            try:
                code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                code = 124
        finally:
            # Request stop while the registry still exists. Only a live guardian
            # signals its own PG; no saved PID/PGID is used as signal authority.
            try:
                registry.stop(wait_seconds=7)
            except (Exception, KeyboardInterrupt):
                cleanup_failed = True
            if process is not None:
                try: process.wait(timeout=2)
                except subprocess.TimeoutExpired: cleanup_failed = True
        if code == 124:
            capture.write('\nFAULT_GATE_TIMEOUT\n')
        if cleanup_failed:
            capture.write('\nFAULT_PROCESS_CLEANUP_UNCONFIRMED\n')
        capture.seek(0)
        text = capture.read()
    text = re.sub(r'\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b', '[REDACTED_TEST_TOKEN]', text)
    text = re.sub(r'(?im)^([^\n]*(?:password|authorization|access_token|refresh_token)[^:=\n]*[:=]).*$', r'\1 [REDACTED_TEST_CREDENTIAL]', text)
    for secret in (harness.ADMIN_PASSWORD, harness.SUPER_PASSWORD, 'Demo12345678!', 'SyntheticMaturity123!'):
        text = text.replace(secret, '[REDACTED_TEST_PASSWORD]')
    log_path.write_text(text)
    os.chmod(log_path, 0o600)
    if cleanup_failed:
        raise FaultCleanupUnconfirmed(code)
    return code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=['smoke', 'full'], default='smoke')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()): parser.error('output must be empty')
    output.mkdir(parents=True, exist_ok=True)
    root = harness.BACKEND.parent
    # Freeze before compiling either frontend or backend code. A later snapshot
    # must not label earlier suite executions with a different checkout.
    source = capacity_fixture.source_manifest(harness.BACKEND)
    try:
        build_code = controlled_run(['npm', 'run', 'build'], root/'frontend', output/'frontend-build.log')
    except FaultCleanupUnconfirmed as error:
        failed = error.exit_code not in (None, 0)
        (output/'faults.json').write_text(json.dumps({**source, 'status':'fail' if failed else 'incomplete',
            'full_fault_gate':False,'reason':'process_cleanup_unconfirmed','log':'frontend-build.log'}))
        return 1 if failed else 2
    if build_code != 0:
        (output/'faults.json').write_text(json.dumps({**source, 'status':'fail','full_fault_gate':False,'reason':'frontend_build_failed','log':'frontend-build.log'}))
        return 1
    commands = [
        ('offline', ['run_frontend_quality_browser.py', '--only', 'components'],
         'real browser offline -> pause -> online re-read; stale snapshots and auth isolation'),
        ('response_loss', ['run_ocr_browser.py'],
         'server accepted POST then browser loses response; retry/reload reuses original intent'),
        ('restart', ['run_scheme_conversion_integration.py'],
         'real server restart resumes conversion cursor without duplicate counting'),
        ('revocation', ['run_all.py', 'pdf_access', 'project_access'],
         'real project/member revocation rejects protected material and project operations'),
        ('storage', ['field_audit_capacity.py', '--entries', '20', '--samples', '5'],
         'SQLite trigger rejects event persistence; attempt/events/page rollback, then one successful retry')
    ]
    started = time.monotonic()
    manifest = {**source, 'profile': args.profile,
                'synthetic': True, 'gates': {name: 'not_run' for name, _, _ in commands}, 'executions': []}
    cycle = 0
    while True:
        cycle += 1
        for name, command, coverage in commands:
            current = [sys.executable, str(harness.BACKEND/'tests'/command[0]), *command[1:]]
            if name == 'storage': current += ['--output', str(output/f'storage-{cycle}')]
            step = time.monotonic()
            log_path=output/f'{cycle}-{name}.log'
            try:
                code=controlled_run(current,root,log_path)
                status = 'pass' if code == 0 else 'fail'
            except FaultCleanupUnconfirmed as error:
                code = error.exit_code
                status = 'fail' if code not in (None, 0) else 'incomplete'
                manifest['gates']['process_cleanup'] = 'incomplete'
            if manifest['gates'][name] != 'fail': manifest['gates'][name] = status
            manifest['executions'].append({'gate': name, 'cycle': cycle, 'status': status,
                'duration_seconds': time.monotonic()-step, 'exit_code': code, 'coverage': coverage, 'log':log_path.name,
                'command': [Path(current[0]).name, *[str(part).replace(str(root)+'/', '') for part in current[1:]]]})
            (output/'faults.json').write_text(json.dumps(manifest, indent=2))
            if manifest['gates'].get('process_cleanup') == 'incomplete': break
        if args.profile == 'smoke' or time.monotonic()-started >= 900 or any(value in ('fail','incomplete') for value in manifest['gates'].values()): break
    manifest['duration_seconds'] = time.monotonic()-started
    try:
        source_after = capacity_fixture.source_manifest(harness.BACKEND)
    except (OSError, subprocess.SubprocessError):
        source_after = None
    manifest['source_after'] = source_after
    manifest['source_unchanged'] = 'pass' if source_after is not None and same_source(source, source_after) else 'incomplete'
    manifest['gates']['source_unchanged'] = manifest['source_unchanged']
    manifest['status'] = ('fail' if 'fail' in manifest['gates'].values() else
                          'pass' if all(value == 'pass' for value in manifest['gates'].values()) else 'incomplete')
    manifest['full_fault_gate'] = manifest['status'] == 'pass' and args.profile == 'full' and manifest['duration_seconds'] >= 900
    manifest['limitation'] = ('Independent fault suites, not simultaneous faults injected into all 30 active users. '
        'A missing or failed child never counts as passed. Process cleanup covers the suite group and registered '
        'Node detached children; it does not certify Docker resources or other out-of-process systems.')
    (output/'faults.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps({'status': manifest['status'], 'full_fault_gate': manifest['full_fault_gate'], 'output': str(output)}))
    return {'pass': 0, 'fail': 1, 'incomplete': 2}[manifest['status']]


if __name__ == '__main__': raise SystemExit(main())
