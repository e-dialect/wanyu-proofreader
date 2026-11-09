#!/usr/bin/env python3
"""Exercise account APIs plus offline recovery and permanent bootstrap identity on restart."""
import json
import hashlib
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
            superuser = request(env, '/api/collections/_superusers/auth-with-password',
                                {'identity': harness.SUPER_EMAIL, 'password': harness.SUPER_PASSWORD})
            super_id = superuser['record']['id']
            bindings = request(env, '/api/collections/bootstrap_bindings/records', {}, superuser['token'], 'GET')
            assert len(bindings['items']) == 2
            expected_ids = {'users': admin_id, '_superusers': super_id}
            for binding in bindings['items']:
                assert binding['record_id'] == expected_ids[binding['auth_collection']]
                request(env, '/api/collections/bootstrap_bindings/records/' + binding['id'],
                        {'record_id': 'cannotchange123'}, superuser['token'], 'PATCH', expected=403)
                request(env, '/api/collections/bootstrap_bindings/records/' + binding['id'],
                        {}, superuser['token'], 'DELETE', expected=403)
            request(env, '/api/collections/bootstrap_bindings/records',
                    {'auth_collection': 'users', 'email_sha256': hashlib.sha256(b'synthetic@example.test').hexdigest(),
                     'record_id': admin_id}, superuser['token'], expected=403)
            request(env, '/api/collections/bootstrap_bindings/records', {}, admin['token'], 'GET', expected=403)
            # An existing configured admin can intentionally be demoted. Restart
            # must not grant its old role or restore the environment password.
            request(env, f'/api/collections/users/records/{admin_id}', {'role': 'user'}, admin['token'], 'PATCH')
            renamed_email = 'renamed-bootstrap@example.test'
            # This is the normal authenticated superuser management API, not a
            # minted email token, mock SMTP result, or test-only bypass route.
            # Free the old username too: uniqueness must not accidentally be the
            # thing preventing the original ENV identity from coming back.
            request(env, f'/api/collections/users/records/{admin_id}',
                    {'email': renamed_email, 'verified': False, 'username': 'renamed_bootstrap_account'},
                    superuser['token'], 'PATCH')
            renamed_super_email = 'renamed-super-bootstrap@example.test'
            rotated_super_password = 'RotatedSuperBootstrap123!'
            request(env, f'/api/collections/_superusers/records/{super_id}',
                    {'email': renamed_super_email, 'oldPassword': harness.SUPER_PASSWORD,
                     'password': rotated_super_password, 'passwordConfirm': rotated_super_password},
                    superuser['token'], 'PATCH')
            renamed_super = request(env, '/api/collections/_superusers/auth-with-password',
                                    {'identity': renamed_super_email, 'password': rotated_super_password})
            assert renamed_super['record']['id'] == super_id
        with sqlite3.connect(root / 'data/data.db') as db:
            before = db.execute('SELECT COUNT(*) FROM users').fetchone()[0]
            super_before = db.execute('SELECT COUNT(*) FROM _superusers').fetchone()[0]
            marker_before = db.execute('SELECT auth_collection,email_sha256,record_id FROM bootstrap_bindings ORDER BY auth_collection').fetchall()
        recovery_env = {**os.environ, 'APP_ADMIN_EMAIL': 'must-not-bootstrap@example.test',
                        'APP_ADMIN_PASSWORD': 'MustNotCreatePassword123!', 'FANGJI_SKIP_ADMIN_BOOTSTRAP': '0'}
        subprocess.run([str(binary), 'recover-account', '--dir', str(root / 'data'),
                        '--hooksDir', str(harness.HOOKS), '--collection', 'users', '--id', admin_id,
                        '--operator', 'integration-test', '--password-stdin'],
                       input='RecoveredFixturePassword123!\n', text=True, env=recovery_env, check=True,
                       stdout=subprocess.DEVNULL)
        with sqlite3.connect(root / 'data/data.db') as db:
            assert db.execute('SELECT COUNT(*) FROM users').fetchone()[0] == before
            assert db.execute('SELECT COUNT(*) FROM _superusers').fetchone()[0] == super_before
            assert db.execute("SELECT COUNT(*) FROM security_events WHERE event_type='account.admin_recovered' AND source='cli'").fetchone()[0] == 1
        with harness.server(binary, root) as env:
            request(env, '/api/collections/users/auth-with-password',
                    {'identity': harness.ADMIN_EMAIL, 'password': harness.ADMIN_PASSWORD}, expected=400)
            recovered = request(env, '/api/collections/users/auth-with-password',
                                {'identity': renamed_email, 'password': 'RecoveredFixturePassword123!'})
            assert recovered['record']['id'] == admin_id
            assert recovered['record']['email'] == renamed_email
            assert recovered['record']['verified'] is False
            assert recovered['record']['role'] == 'user', 'bootstrap restored old admin role'
            assert recovered['record']['must_change_password'] is True
            request(env, '/api/collections/users/auth-refresh', {}, admin['token'], expected=401)
            request(env, '/api/collections/_superusers/auth-with-password',
                    {'identity': harness.SUPER_EMAIL, 'password': harness.SUPER_PASSWORD}, expected=400)
            request(env, '/api/collections/_superusers/auth-with-password',
                    {'identity': renamed_super_email, 'password': harness.SUPER_PASSWORD}, expected=400)
            kept_super = request(env, '/api/collections/_superusers/auth-with-password',
                                 {'identity': renamed_super_email, 'password': rotated_super_password})
            assert kept_super['record']['id'] == super_id
            request(env, '/api/collections/_superusers/auth-refresh', {}, superuser['token'], expected=401)
        with sqlite3.connect(root / 'data/data.db') as db:
            assert db.execute('SELECT COUNT(*) FROM users').fetchone()[0] == before
            assert db.execute('SELECT COUNT(*) FROM _superusers').fetchone()[0] == super_before
            assert db.execute('SELECT auth_collection,email_sha256,record_id FROM bootstrap_bindings ORDER BY auth_collection').fetchall() == marker_before
    print('PASS offline recovery, permanent bootstrap identities, native email/password changes and restart', flush=True)


if __name__ == '__main__':
    main()
