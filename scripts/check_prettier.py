#!/usr/bin/env python3
"""Format gate for touched frontend source/tests; no unrelated repository sweep."""
import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SUFFIXES = {'.vue', '.js', '.cjs', '.mjs', '.css'}

def changed_files(base):
    commands = [
        ['git', 'diff', '--name-only', '-z', '--diff-filter=ACMR', base, 'HEAD'],
        ['git', 'diff', '--name-only', '-z', '--diff-filter=ACMR'],
        ['git', 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'],
        ['git', 'ls-files', '--others', '--exclude-standard', '-z'],
    ]
    paths = set()
    for command in commands:
        paths.update(subprocess.check_output(command, cwd=ROOT).decode().split('\0'))
    return sorted(path for path in paths if path.startswith('frontend/')
                  and Path(path).suffix in SUFFIXES and (ROOT / path).is_file())

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='origin/main')
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    paths = changed_files(args.base)
    if not paths:
        print('Prettier: no touched frontend source files')
        return 0
    executable = ROOT / 'frontend/node_modules/.bin/prettier'
    if not executable.exists():
        sys.exit('Prettier is required: npm --prefix frontend ci')
    return subprocess.call([str(executable), '--write' if args.write else '--check', '--', *paths], cwd=ROOT)

if __name__ == '__main__':
    sys.exit(main())
