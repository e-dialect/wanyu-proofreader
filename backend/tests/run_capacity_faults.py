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
import signal
import tempfile
import subprocess
import sys
import time
from pathlib import Path
import harness
import capacity_fixture
from capacity_remote_contract import same_source


def owned_process_groups(process, known):
    """Retain live groups observed in this suite's tree, including detached browsers."""
    rows = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,pgid=,stat='], text=True, timeout=2)
    records = [row.split() for row in rows.splitlines() if row.split()]
    live_groups = {int(row[2]) for row in records if not row[3].startswith(('Z', 'X'))}
    descendants = {process.pid}
    while True:
        found = {int(row[0]) for row in records if int(row[1]) in descendants}
        if found <= descendants:
            break
        descendants.update(found)
    # Only group leaders proven to be descendants may be added. Keep a known
    # live group after its parent exits; forget vanished groups to avoid PID reuse.
    return (known & live_groups) | {process.pid} | {
        int(row[2]) for row in records if int(row[0]) in descendants and int(row[2]) in descendants
    }


def stop_owned_process(process, groups=None):
    groups = groups or {process.pid}
    if os.name == 'posix':
        # SIGINT permits Python finally blocks to remove temporary containers.
        # Playwright launches a separate group, so signal all proven descendants.
        for group in groups:
            try:
                os.killpg(group, signal.SIGINT)
            except ProcessLookupError:
                pass
    elif process.poll() is None:
        process.terminate()
    if process.poll() is None:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
    if os.name == 'posix':
        for group in groups:
            try:
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                pass
    elif process.poll() is None:
        process.kill()
    process.wait()
    if os.name == 'posix':
        for _ in range(40):
            rows = subprocess.check_output(['ps', '-axo', 'pgid=,stat='], text=True, timeout=2)
            live = [row.split() for row in rows.splitlines() if row.split()]
            if not any(int(row[0]) in groups and not row[1].startswith(('Z', 'X')) for row in live):
                return
            time.sleep(.05)
        raise RuntimeError('fault_descendant_cleanup_unconfirmed')


def controlled_run(command, cwd, log_path, timeout=1800):
    # Test suites can print fixture passwords/tokens. Keep diagnostic output but
    # redact credentials before copying it out of the temporary capture file.
    with tempfile.TemporaryFile(mode='w+', encoding='utf-8') as capture:
        process = subprocess.Popen(command, cwd=cwd, stdout=capture, stderr=subprocess.STDOUT,
                                   start_new_session=os.name == 'posix')
        groups = {process.pid}
        deadline = time.monotonic() + timeout
        try:
            while True:
                if os.name == 'posix':
                    groups = owned_process_groups(process, groups)
                try:
                    code = process.wait(timeout=max(0, min(.5, deadline-time.monotonic())))
                    break
                except subprocess.TimeoutExpired:
                    if time.monotonic() >= deadline:
                        code = 124
                        break
        finally:
            # Retain detached groups while the suite is alive, including a Node
            # child that times out before its Python supervisor exits.
            try:
                if os.name == 'posix':
                    groups = owned_process_groups(process, groups)
            finally:
                stop_owned_process(process, groups)
        if code == 124:
            capture.write('\nFAULT_GATE_TIMEOUT\n')
        capture.seek(0)
        text = capture.read()
    text = re.sub(r'\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b', '[REDACTED_TEST_TOKEN]', text)
    text = re.sub(r'(?im)^([^\n]*(?:password|authorization|access_token|refresh_token)[^:=\n]*[:=]).*$', r'\1 [REDACTED_TEST_CREDENTIAL]', text)
    for secret in (harness.ADMIN_PASSWORD, harness.SUPER_PASSWORD, 'Demo12345678!', 'SyntheticMaturity123!'):
        text = text.replace(secret, '[REDACTED_TEST_PASSWORD]')
    log_path.write_text(text)
    os.chmod(log_path, 0o600)
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
    if controlled_run(['npm', 'run', 'build'], root/'frontend', output/'frontend-build.log') != 0:
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
            code=controlled_run(current,root,log_path)
            status = 'pass' if code == 0 else 'fail'
            if manifest['gates'][name] != 'fail': manifest['gates'][name] = status
            manifest['executions'].append({'gate': name, 'cycle': cycle, 'status': status,
                'duration_seconds': time.monotonic()-step, 'exit_code': code, 'coverage': coverage, 'log':log_path.name,
                'command': [Path(current[0]).name, *[str(part).replace(str(root)+'/', '') for part in current[1:]]]})
            (output/'faults.json').write_text(json.dumps(manifest, indent=2))
        if args.profile == 'smoke' or time.monotonic()-started >= 900 or 'fail' in manifest['gates'].values(): break
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
    manifest['limitation'] = 'Independent fault suites, not simultaneous faults injected into all 30 active users. A missing or failed child never counts as passed.'
    (output/'faults.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps({'status': manifest['status'], 'full_fault_gate': manifest['full_fault_gate'], 'output': str(output)}))
    return {'pass': 0, 'fail': 1, 'incomplete': 2}[manifest['status']]


if __name__ == '__main__': raise SystemExit(main())
