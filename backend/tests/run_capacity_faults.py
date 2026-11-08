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
import tempfile
import subprocess
import sys
import time
from pathlib import Path
import harness
import capacity_fixture


def controlled_run(command, cwd, log_path, timeout=1800):
    # Test suites can print fixture passwords/tokens. Keep diagnostic output but
    # redact credentials before copying it out of the temporary capture file.
    with tempfile.TemporaryFile(mode='w+', encoding='utf-8') as capture:
        try:
            code = subprocess.run(command, cwd=cwd, stdout=capture, stderr=subprocess.STDOUT, timeout=timeout).returncode
        except subprocess.TimeoutExpired:
            code = 124
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
    if controlled_run(['npm', 'run', 'build'], root/'frontend', output/'frontend-build.log') != 0:
        (output/'faults.json').write_text(json.dumps({'status':'fail','full_fault_gate':False,'reason':'frontend_build_failed','log':'frontend-build.log'}))
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
    manifest = {**capacity_fixture.source_manifest(harness.BACKEND), 'profile': args.profile,
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
    manifest['status'] = 'pass' if all(value == 'pass' for value in manifest['gates'].values()) else 'fail'
    manifest['full_fault_gate'] = manifest['status'] == 'pass' and args.profile == 'full' and manifest['duration_seconds'] >= 900
    manifest['limitation'] = 'Independent fault suites, not simultaneous faults injected into all 30 active users. A missing or failed child never counts as passed.'
    (output/'faults.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps({'status': manifest['status'], 'full_fault_gate': manifest['full_fault_gate'], 'output': str(output)}))
    return 0 if manifest['status'] == 'pass' else 1


if __name__ == '__main__': raise SystemExit(main())
