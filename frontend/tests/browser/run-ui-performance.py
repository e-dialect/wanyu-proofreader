#!/usr/bin/env python3
"""Measure an existing production build against a disposable PocketBase instance.

This opt-in benchmark does not build the frontend or join the default CI suite.
Example: NODE_PATH=/path/to/playwright/node_modules BROWSER_CHANNEL=msedge \
  python3 frontend/tests/browser/run-ui-performance.py --dist frontend/dist \
  --label after --output output/playwright/ui-performance
"""
import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'backend/tests'))
import harness  # noqa: E402

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--dist', type=Path, required=True)
parser.add_argument('--label', required=True)
parser.add_argument('--output', type=Path, default=ROOT / 'output/playwright/ui-performance')
parser.add_argument('--repetitions', type=int, default=5)
args = parser.parse_args()
if args.repetitions < 5:
    parser.error('Use at least five repetitions; timings are descriptive, not a pass threshold.')
dist = args.dist.resolve()
if not (dist / 'index.html').is_file():
    parser.error(f'No production index.html in {dist}')
with harness.temporary_root() as temporary:
    binary = harness.build_binary(temporary / 'pocketbase')
    with harness.server(binary, temporary) as env:
        env.update({
            'UI_PERFORMANCE_DIST': str(dist),
            'UI_PERFORMANCE_LABEL': args.label,
            'UI_PERFORMANCE_OUTPUT': str(args.output.resolve()),
            'UI_PERFORMANCE_REPETITIONS': str(args.repetitions),
            'FANGJI_TEST_DATA_DIR': str(temporary / 'data'),
        })
        subprocess.run(['node', str(Path(__file__).with_name('ui-performance.cjs'))],
                       env=env, check=True, timeout=240)
