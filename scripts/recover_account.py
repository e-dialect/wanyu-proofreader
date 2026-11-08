#!/usr/bin/env python3
"""Prompt without echo and pipe a temporary password to an offline backend.

Stop the serving backend first. Uses an existing record id; never creates a
user, changes a role/email, prints a password, or passes it via argv/env.
"""
import argparse
import getpass
import os
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--dir', type=Path, required=True)
    parser.add_argument('--hooks-dir', type=Path, required=True)
    parser.add_argument('--collection', choices=['users', '_superusers'], default='users')
    parser.add_argument('--id', required=True)
    parser.add_argument('--operator', required=True)
    args = parser.parse_args()
    if not sys.stdin.isatty():
        parser.error('Run from an interactive terminal so the password prompt cannot echo.')
    password = getpass.getpass('New temporary password (12–71 characters, at most 72 UTF-8 bytes): ')
    confirmation = getpass.getpass('Confirm password: ')
    if password != confirmation:
        parser.error('Passwords do not match.')
    if not 12 <= len(password) <= 71 or len(password.encode('utf-8')) > 72 or '\n' in password or '\r' in password:
        parser.error('Password length is outside the supported range.')
    result = subprocess.run([str(args.binary.resolve()), 'recover-account', '--dir', str(args.dir.resolve()),
                             '--hooksDir', str(args.hooks_dir.resolve()), '--collection', args.collection,
                             '--id', args.id, '--operator', args.operator, '--password-stdin'],
                            input=(password + '\n').encode('utf-8'),
                            env={**os.environ, 'FANGJI_SKIP_ADMIN_BOOTSTRAP': '1'})
    password = confirmation = ''
    return result.returncode


if __name__ == '__main__':
    sys.exit(main())
