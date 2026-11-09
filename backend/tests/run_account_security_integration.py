#!/usr/bin/env python3
"""Exercise account APIs plus offline recovery and create-only bootstrap on restart."""
import json
import os
import sqlite3
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

import harness


def request(env, path, body, token='', method='POST', expected=200):
    req = urllib.request.Request(env['PB_URL'] + path, data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json', 'Authorization': token}, method=method)
    try:
        response = urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read()
        assert response.status == expected, f'{method} {path}: unexpected status {response.status}'
        return json.loads(raw) if raw else None


def main():
    with harness.temporary_root() as root:
        binary = harness.build_binary(root / 'pocketbase')
        with harness.server(binary, root) as env:
            subprocess.run(['node', str(harness.BACKEND / 'tests/account_security_integration.mjs')],
                           env=harness.with_research_notice_preload(env), check=True)
            admin = request(env, '/api/collections/users/auth-with-password',
                            {'identity': harness.ADMIN_EMAIL, 'password': harness.ADMIN_PASSWORD})
            admin_id = admin['record']['id']
            # An existing configured admin can intentionally be demoted. Restart
            # must not grant its old role or restore the environment password.
            request(env, f'/api/collections/users/records/{admin_id}', {'role': 'user'}, admin['token'], 'PATCH')
        with sqlite3.connect(root / 'data/data.db') as db:
            before = db.execute('SELECT COUNT(*) FROM users').fetchone()[0]
        recovery_env = {**os.environ, 'APP_ADMIN_EMAIL': 'must-not-bootstrap@example.test',
                        'APP_ADMIN_PASSWORD': 'MustNotCreatePassword123!', 'FANGJI_SKIP_ADMIN_BOOTSTRAP': '0'}
        subprocess.run([str(binary), 'recover-account', '--dir', str(root / 'data'),
                        '--hooksDir', str(harness.HOOKS), '--collection', 'users', '--id', admin_id,
                        '--operator', 'integration-test', '--password-stdin'],
                       input='RecoveredFixturePassword123!\n', text=True, env=recovery_env, check=True,
                       stdout=subprocess.DEVNULL)
        with sqlite3.connect(root / 'data/data.db') as db:
            assert db.execute('SELECT COUNT(*) FROM users').fetchone()[0] == before
            assert db.execute("SELECT COUNT(*) FROM security_events WHERE event_type='account.admin_recovered' AND source='cli'").fetchone()[0] == 1
        with harness.server(binary, root) as env:
            request(env, '/api/collections/users/auth-with-password',
                    {'identity': harness.ADMIN_EMAIL, 'password': harness.ADMIN_PASSWORD}, expected=400)
            recovered = request(env, '/api/collections/users/auth-with-password',
                                {'identity': harness.ADMIN_EMAIL, 'password': 'RecoveredFixturePassword123!'})
            assert recovered['record']['role'] == 'user', 'bootstrap restored old admin role'
            assert recovered['record']['must_change_password'] is True
            request(env, '/api/collections/users/auth-refresh', {}, admin['token'], expected=401)
    print('PASS offline recovery and create-only bootstrap restart', flush=True)


if __name__ == '__main__':
    main()
