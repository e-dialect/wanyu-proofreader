#!/usr/bin/env python3
"""Independent disposable fault gate. No URL, token or data-dir inputs are accepted.

Full mode repeats the five real fault gates across a >=15 minute orchestration
window. This is separate from the steady-load capacity run, not a claim that
each fault occurred throughout every second of that window.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
import harness
import capacity_fixture


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=['smoke', 'full'], default='smoke')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()): parser.error('output must be empty')
    output.mkdir(parents=True, exist_ok=True)
    root = harness.BACKEND.parent
    subprocess.run(['npm', 'run', 'build'], cwd=root/'frontend', check=True, stdout=subprocess.DEVNULL)
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
            try:
                # Child suites use their own temporary server, data and local workers.
                completed = subprocess.run(current, cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1800)
                code = completed.returncode
            except subprocess.TimeoutExpired:
                code = 124
            status = 'pass' if code == 0 else 'fail'
            if manifest['gates'][name] != 'fail': manifest['gates'][name] = status
            manifest['executions'].append({'gate': name, 'cycle': cycle, 'status': status,
                'duration_seconds': time.monotonic()-step, 'exit_code': code, 'coverage': coverage,
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
