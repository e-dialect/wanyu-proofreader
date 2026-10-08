#!/usr/bin/env python3
"""Run the #190 conversion workflow against a disposable server, with a restart.

两件事必须由本文件而不是 run_integration.py 负责：

1. **规则目录**：#190 刻意不给 FANGJI_SCHEME_ADAPTER_DIR 任何默认值（本仓在 #193/#195
   上学过写死路径这一课）。所以这里造一个临时目录，把 #281 的合成适配器放进去，
   再把环境变量指给它。用的是合成规则，不是任何一套真实莆仙方案。
2. **重启**：验收里有一条「作业中途 kill 后重启进入确定态、无重复计数」，
   只有在真的重启过一次的实例上才有意义。两阶段与 run_bundle_import_integration.py 同一手法。
"""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

backend = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='fangji-scheme-') as temp:
    root = Path(temp)
    binary = root / 'pocketbase'
    data = root / 'data'
    adapters = root / 'adapters'
    adapters.mkdir()
    shutil.copy(backend / 'scheme/testdata/adapter_synthetic.json', adapters / 'adapter_synthetic.json')

    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    handoff = str(root / 'scheme-handoff.json')
    env = {**os.environ, 'PB_URL': f'http://127.0.0.1:{port}',
           'APP_ADMIN_EMAIL': 'scheme-admin@example.com', 'APP_ADMIN_PASSWORD': 'SchemeTest12345!',
           'PB_ADMIN_EMAIL': 'scheme-super@example.com', 'PB_ADMIN_PASSWORD': 'SchemeTest12345!',
           'PB_SUPER_EMAIL': 'scheme-super@example.com', 'PB_SUPER_PASSWORD': 'SchemeTest12345!',
           'FANGJI_SKIP_ADMIN_BOOTSTRAP': '0', 'HINGHWA_IDENTITY_BASE_URL': '',
           'FANGJI_SCHEME_ADAPTER_DIR': str(adapters),
           'SCHEME_CONVERSION_HANDOFF': handoff}
    subprocess.run(['go', 'build', '-o', str(binary), '.'], cwd=backend, check=True)
    for migration in sorted((backend / 'pb_migrations').glob('*.js'), key=lambda p: int(p.name.split('_')[0])):
        with tempfile.TemporaryDirectory(dir=root) as one:
            shutil.copy(migration, one)
            subprocess.run([str(binary), 'migrate', 'up', f'--dir={data}', f'--migrationsDir={one}'],
                           env={**env, 'FANGJI_SKIP_ADMIN_BOOTSTRAP': '1'}, check=True, stdout=subprocess.DEVNULL)

    for phase in ('--prepare-resume', '--verify-resume'):
        with (root / 'server.log').open('a') as log:
            server = subprocess.Popen([str(binary), 'serve', f'--http=127.0.0.1:{port}', f'--dir={data}',
                                       f'--hooksDir={backend / "pb_hooks"}', f'--migrationsDir={backend / "pb_migrations"}',
                                       '--hooksWatch=false'], env=env, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    try:
                        with urllib.request.urlopen(env['PB_URL'] + '/api/health', timeout=1):
                            break
                    except OSError:
                        if server.poll() is not None:
                            raise RuntimeError((root / 'server.log').read_text(encoding='utf-8', errors='replace'))
                        time.sleep(.1)
                else:
                    raise RuntimeError('Temporary server did not become ready')
                subprocess.run(['node', str(backend / 'tests/scheme_conversion_integration.mjs'), phase],
                               env=env, check=True)
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
print('PASS: scheme conversion job, review queue and restart resume')
