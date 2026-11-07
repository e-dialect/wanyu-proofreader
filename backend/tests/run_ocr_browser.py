#!/usr/bin/env python3
"""Real local OCR image + disposable migrated server + production SPA browser.

Requires built frontend/dist, Docker, Go, Node and Playwright/Chromium. An explicit
OCR_BROWSER_IMAGE uses the caller's freshly built image; otherwise build from this
checkout. All material and identities are generated synthetic fixtures.
"""
import os
from pathlib import Path
import secrets
import subprocess
import time
import urllib.request
import uuid

import harness


def main():
    image = os.environ.get('OCR_BROWSER_IMAGE')
    if not image:
        image = 'wanyu-ocr-browser:local'
        subprocess.run(['docker', 'build', '-f', 'ocr-worker.Dockerfile', '-t', image, '.'],
                       cwd=harness.BACKEND, check=True)
    name = 'wanyu-ocr-browser-' + uuid.uuid4().hex[:12]
    token = secrets.token_hex(24)
    subprocess.run([
        'docker', 'run', '--rm', '-d', '--name', name, '--read-only',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m,mode=1777',
        '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
        '--cpus=1', '--memory=768m', '--pids-limit=64',
        '-p', '127.0.0.1::8091', '-e', 'OCR_WORKER_TOKEN=' + token,
        '-e', 'OMP_THREAD_LIMIT=1', image
    ], check=True, stdout=subprocess.DEVNULL)
    try:
        binding = subprocess.check_output(['docker', 'port', name, '8091/tcp'], text=True).strip()
        worker = 'http://127.0.0.1:' + binding.rsplit(':', 1)[1]
        for attempt in range(100):
            try:
                with urllib.request.urlopen(worker + '/healthz', timeout=1):
                    break
            except OSError:
                if attempt == 99:
                    raise RuntimeError('temporary OCR worker did not become healthy')
                time.sleep(.1)
        with harness.temporary_root() as root:
            binary = harness.build_binary(Path(root) / 'pocketbase')
            extra = {'OCR_ENGINE_ENABLED': 'true', 'OCR_WORKER_URL': worker, 'OCR_WORKER_TOKEN': token}
            with harness.server(binary, root, extra_env=extra) as env:
                harness.run_suite('ocr_browser.cjs', env)
    finally:
        subprocess.run(['docker', 'rm', '-f', name], check=False, stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
