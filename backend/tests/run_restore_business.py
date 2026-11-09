#!/usr/bin/env python3
"""Restore a disposable real workflow and verify business writes after recovery.

Only harness-created synthetic data is accepted: no production URL, existing
input directory or caller-supplied credentials. This local exercise does not
certify offsite encryption, a 24-hour RPO, or production hardware/RTO.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.parse
import urllib.request

import harness
from field_audit_capacity import request

SPEC = importlib.util.spec_from_file_location('business_restore_backup', harness.BACKEND / 'ops/backup.py')
backup_ops = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup_ops)
SUITES = ['core_logic_integration.mjs', 'pdf_access_integration.mjs',
          'arbitration_queue_integration.mjs', 'project_export_integration.mjs']
PAGE_FIELDS = ['id', 'project', 'project_file', 'pdf_page', 'status', 'proofread_round',
               'proofread_count', 'ocr_row_json', 'proofread_row_json']
ISOLATED_ENV = {'FANGJI_RESEARCH_MODE': '0', 'FIDELITY_BROWSER_SCRIPT': '',
                'PDF_BROWSER_SCRIPT': '', 'PDF_BROWSER_FIXTURE': '',
                'RUN_EXPORT_BROWSER': '0', 'REQUIRE_PAGE_IMAGES': '0', 'PYTHON': sys.executable}


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def login(base, identity, password):
    return request(base, '/api/collections/users/auth-with-password', method='POST',
                   body={'identity': identity, 'password': password})


def source_pdf(base, token, file):
    grant = request(base, '/api/files/token', token, 'POST', {})['token']
    path = '/api/files/' + '/'.join(urllib.parse.quote(file[key], safe='') for key in ['collectionId', 'id', 'file'])
    req = urllib.request.Request(base + path + '?' + urllib.parse.urlencode({'token': grant}), headers={'Authorization': token})
    with urllib.request.urlopen(req, timeout=30) as response:
        assert response.status == 200 and response.headers.get_content_type() == 'application/pdf'
        data = response.read()
    assert data.startswith(b'%PDF-')
    return hashlib.sha256(data).hexdigest(), len(data)


def snapshot_pages(base, token, pages):
    result = []
    for page in pages:
        value = request(base, f'/api/collections/pages/records/{page["id"]}', token)
        result.append({key: value.get(key) for key in PAGE_FIELDS})
    return result


def verify_stopped(pid):
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return
    raise AssertionError('Disposable source server is still running; refusing backup')


def run(report):
    source_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=harness.BACKEND, text=True).strip()
    with harness.temporary_root() as root:
        started = time.perf_counter()
        binary = harness.build_binary(root / 'pocketbase')
        report.update(source_commit=source_commit, binary_sha256=sha256(binary), build_seconds=time.perf_counter() - started)
        fixture_path = root / 'fixture.json'
        report['phase'] = 'generate_real_synthetic_workflow'
        started = time.perf_counter()
        with harness.server(binary, root, extra_env={**ISOLATED_ENV, 'FIDELITY_BROWSER_FIXTURE': str(fixture_path)}) as env:
            harness.run_suite('source_fidelity_integration.mjs', env)
            fixture = json.loads(fixture_path.read_text())
            expected_pages = snapshot_pages(env['PB_URL'], fixture['admin']['token'], fixture['pages'])
            expected_pdf_sha, expected_pdf_bytes = source_pdf(env['PB_URL'], fixture['admin']['token'], fixture['file'])
            old_pid = env['PB_TEST_SERVER_PID']
        verify_stopped(old_pid)
        report['source_stopped_before_backup'] = True
        report['seed_and_shutdown_seconds'] = time.perf_counter() - started
        offline_started = time.perf_counter()
        print('Source stopped; backing up and restoring the complete synthetic data directory.', flush=True)
        report['phase'] = 'backup'
        started = time.perf_counter()
        backed_up_files = backup_ops.backup(root / 'data', root / 'backup', source_commit)
        report['backup_seconds'] = time.perf_counter() - started
        manifest = json.loads((root / 'backup/manifest.json').read_text())
        report['backup_version'] = manifest['version']
        report['backup_created_at'] = manifest['created_at']
        report['manifest_files'] = backed_up_files
        report['backup_data_bytes'] = sum(path.stat().st_size for path in (root / 'backup/data').rglob('*') if path.is_file())
        report['phase'] = 'restore'
        restore_started = time.perf_counter()
        restored = root / 'restored-data'
        assert backup_ops.restore(root / 'backup', restored) == source_commit
        report['restore_seconds'] = time.perf_counter() - restore_started
        # restore() checks every manifest hash before its SQLite integrity check.
        # Recheck every attachment after that check and before any server starts.
        attachments = {name: digest for name, digest in manifest['files'].items() if name.startswith('storage/')}
        assert attachments, 'The recovery fixture must include actual uploaded attachments'
        restored_attachments = {name: digest for name, digest in backup_ops.inventory(restored).items() if name.startswith('storage/')}
        assert restored_attachments == attachments
        pdf_path = f'storage/{fixture["file"]["collectionId"]}/{fixture["file"]["id"]}/{fixture["file"]["file"]}'
        assert attachments[pdf_path] == expected_pdf_sha
        report.update(manifest_hashes_verified_by_restore=True, attachment_count=len(attachments), all_attachment_sha256_match=True)
        report['phase'] = 'restart_and_verify_original_records'
        startup_started = time.perf_counter()
        # Bootstrap disabled: success must come from the restored accounts,
        # never silently recreated administrator records or reset credentials.
        with harness.server(binary, root, data=restored, extra_env={**ISOLATED_ENV, 'FANGJI_SKIP_ADMIN_BOOTSTRAP': '1'}) as env:
            report['restored_startup_seconds'] = time.perf_counter() - startup_started
            base = env['PB_URL']
            admin = login(base, harness.ADMIN_EMAIL, harness.ADMIN_PASSWORD)
            assert admin['record']['id'] == fixture['admin']['record']['id']
            for index, user in enumerate(fixture['users']):
                auth = login(base, f'source-fidelity-{index}@example.com', 'SourceFidelity123!')
                assert auth['record']['id'] == user['id']
            project = request(base, f'/api/collections/projects/records/{fixture["project"]["id"]}', admin['token'])
            assert project['id'] == fixture['project']['id']
            assert project['admin'] == fixture['project']['owner']  # collection field vs project-view alias
            assert snapshot_pages(base, admin['token'], fixture['pages']) == expected_pages
            recovered_sha, recovered_bytes = source_pdf(base, admin['token'], fixture['file'])
            assert (recovered_sha, recovered_bytes) == (expected_pdf_sha, expected_pdf_bytes)
            report.update(fresh_logins_preserve_account_ids=1 + len(fixture['users']), project_id_and_owner_preserved=True,
                          original_page_records_preserved=len(expected_pages), original_pdf_http_sha256_match=True,
                          original_pdf_bytes=expected_pdf_bytes, local_restore_to_original_business_readable_seconds=time.perf_counter() - restore_started)
            report['phase'] = 'post_restore_business_workflows'
            report['business_suites'] = []
            for suite in SUITES:
                print('Restored instance: ' + suite, flush=True)
                started = time.perf_counter()
                harness.run_suite(suite, env)
                report['business_suites'].append({'suite': suite, 'status': 'pass', 'seconds': time.perf_counter() - started})
            # Existing-suite cleanup must not remove the recovered evidence.
            assert snapshot_pages(base, admin['token'], fixture['pages']) == expected_pages
            assert source_pdf(base, admin['token'], fixture['file'])[0] == expected_pdf_sha
            report['local_restore_to_business_verified_seconds'] = time.perf_counter() - restore_started
            report['local_offline_to_business_verified_seconds'] = time.perf_counter() - offline_started
            restored_pid = env['PB_TEST_SERVER_PID']
        verify_stopped(restored_pid)
        report['temporary_servers_stopped'] = True
    report.update(status='pass', phase='complete', temporary_data_removed=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='optional redacted JSON summary; never writes fixture credentials')
    args = parser.parse_args(argv)
    report = {'status': 'running', 'synthetic_only': True, 'started_at': utc_now(),
              'production_rto_verified': False, 'rpo_24h_verified': False,
              'offsite_encryption_verified': False, 'production_hardware_verified': False}
    try:
        run(report)
    except Exception as error:
        report.update(status='fail', error_type=type(error).__name__)
        raise
    finally:
        report['finished_at'] = utc_now()
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
