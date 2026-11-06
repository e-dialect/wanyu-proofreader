#!/usr/bin/env python3
"""Verify the opt-in OCR overlay composes with all supported entry points."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import yaml

ROOT = Path(__file__).resolve().parents[1]

def check_document(document):
    worker = document['services']['ocr-worker']
    assert not worker.get('ports'), 'OCR worker publishes a host port'
    assert worker.get('read_only') is True, 'OCR worker root is writable'
    assert worker.get('user') == '10001:10001', 'OCR worker is not non-root'
    assert worker.get('cap_drop') == ['ALL'], 'OCR worker has capabilities'
    assert 'no-new-privileges:true' in worker.get('security_opt', []), 'OCR worker can gain privileges'
    assert not worker.get('volumes'), 'models or material are mounted writable'
    assert str(worker.get('mem_limit')) in ('768m', '805306368'), 'OCR memory budget drift'
    assert float(worker.get('cpus', 0)) == 1, 'OCR CPU budget drift'
    assert worker.get('pids_limit') == 64, 'OCR pid budget drift'
    assert set(worker.get('networks', {})) == {'ocr_internal'}, 'OCR worker has external network access'
    assert document['networks']['ocr_internal'].get('internal') is True, 'OCR network is not isolated'
    tmpfs = worker.get('tmpfs', [])
    assert any('/tmp:' in item and ('size=256m' in item or 'size=268435456' in item) and 'noexec' in item for item in tmpfs), 'OCR scratch budget drift'
    return True

def main():
    with (ROOT / 'docker-compose.ocr.yml').open() as stream:
        check_document(yaml.safe_load(stream))
    docker = shutil.which('docker')
    if not docker:
        print('SKIP: docker compose rendering unavailable; OCR structural invariants passed')
        return 0
    # No real secret or material is used or printed; this only renders configs.
    env = {**os.environ, 'OCR_WORKER_TOKEN': 'synthetic-validation-token-at-least-32', 'TRAEFIK_HOST': 'synthetic.example.com', 'OCR_ENGINE_ENABLED': 'false'}
    count = 0
    for entry in ('docker-compose.yml', 'docker-compose.traefik.yml', 'docker-compose.dev.yml'):
        for named in (False, True):
            args = [docker, 'compose', '-f', entry]
            if named:
                args += ['-f', 'docker-compose.named-volume.yml']
            args += ['-f', 'docker-compose.ocr.yml', 'config', '--format', 'json']
            result = subprocess.run(args, cwd=ROOT, env=env, check=True, capture_output=True, text=True)
            document = json.loads(result.stdout)
            check_document(document)
            backend = document['services']['backend']
            assert 'ocr_internal' in backend['networks']
            assert ('app' if 'traefik' in entry else 'default') in backend['networks'], 'OCR overlay disconnected backend from frontend'
            assert backend['environment']['OCR_ENGINE_ENABLED'] == 'false'
            if entry != 'docker-compose.dev.yml':
                assert backend['read_only'] is True and not backend.get('ports')
            count += 1
    print(f'PASS: OCR isolated worker overlay and {count} entry point / named-volume combinations')
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except (AssertionError, subprocess.CalledProcessError) as error:
        print(f'OCR compose guard: {error}', file=sys.stderr)
        sys.exit(1)
