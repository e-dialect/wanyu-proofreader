#!/usr/bin/env python3
"""Rehearse Docker account recovery using only runner-owned synthetic resources.

Requires a trusted, already built local backend image. No URL, existing
container, volume, network, data directory or credential input is accepted.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import secrets
import select
import signal
import subprocess
import sys
import termios
import time

ROOT = Path(__file__).resolve().parents[2]
WRAPPER = ROOT / 'scripts/recover_account.py'
LABEL = 'org.e-dialect.account-recovery-rehearsal'
IMAGE = re.compile(r'(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._:/@-]{0,254})')
GATES = ('isolation', 'running_refused', 'shared_mount_refused', 'stopped_recovered',
         'old_password_rejected', 'old_token_rejected', 'new_password_accepted',
         'identity_preserved', 'bootstrap_did_not_elevate', 'no_secret_output', 'cleanup')


class RehearsalFailure(Exception):
    """Only fixed internal reason codes may reach the report."""


def require(condition, code):
    if not condition:
        raise RehearsalFailure(code)


def docker(args, *, env=None, timeout=60, check=True, input=None):
    result = subprocess.run(['docker', *args], capture_output=True, text=True,
                            env=env, timeout=timeout, check=False, input=input)
    if check and result.returncode:
        raise RehearsalFailure('docker_command_failed')
    return result


def inspect(kind, identity, template):
    return json.loads(docker([kind, 'inspect', '--format', template, identity]).stdout)


def request(container, path, body=None, token='', method='POST', expected=200):
    # The backend has no network and no published ports. curl still exercises
    # real HTTP/native auth on its loopback; all credentials enter via stdin.
    def quoted(value):
        return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\r', '\\r') + '"'
    config = ['url = ' + quoted('http://127.0.0.1:8090' + path), 'request = ' + quoted(method),
              'header = "Content-Type: application/json"', 'header = ' + quoted('Authorization: ' + token)]
    if body is not None:
        config.append('data = ' + quoted(json.dumps(body)))
    result = docker(['exec', '-i', container, 'curl', '--config', '-', '--silent', '--show-error',
                     '--max-time', '10', '--write-out', '\n%{http_code}'],
                    input='\n'.join(config) + '\n', check=False, timeout=15)
    require(result.returncode == 0, 'http_transport_failed')
    payload, status = result.stdout.rsplit('\n', 1)
    require(status.isdigit() and int(status) == expected, 'unexpected_http_status')
    return json.loads(payload) if payload else None


def wait_ready(container):
    for _ in range(180):
        try:
            request(container, '/api/health', method='GET')
            return
        except (OSError, RehearsalFailure):
            state = inspect('container', container, '{{json .State.Running}}')
            require(state is True, 'backend_exited_before_ready')
            time.sleep(.5)
    raise RehearsalFailure('backend_ready_timeout')


def run_wrapper(container, record_id, password=None):
    # Exercise the actual operator wrapper, including isatty/getpass, without
    # placing the recovery password in argv/env. The PTY input has echo disabled.
    master, slave = pty.openpty()
    settings = termios.tcgetattr(slave)
    settings[3] &= ~termios.ECHO
    termios.tcsetattr(slave, termios.TCSANOW, settings)
    command = [sys.executable, str(WRAPPER), '--container', container, '--id', record_id,
               '--operator', 'synthetic-container-rehearsal']
    process = None
    transcript = bytearray()
    sent = 0
    try:
        process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave,
                                   start_new_session=True)
        os.close(slave)
        slave = None
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], .1)
            if readable:
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    chunk = b''
                transcript.extend(chunk)
                require(len(transcript) < 65536, 'wrapper_output_limit')
                if password is not None:
                    if sent == 0 and b'Temporary password (' in transcript:
                        os.write(master, (password + '\n').encode())
                        sent = 1
                    if sent == 1 and b'Confirm password: ' in transcript:
                        os.write(master, (password + '\n').encode())
                        sent = 2
            if process.poll() is not None and (not readable or not chunk):
                break
        require(process.poll() is not None, 'wrapper_timeout')
        require(password is None or sent == 2, 'wrapper_prompt_not_exercised')
        require(password is None or password.encode() not in transcript, 'wrapper_echoed_password')
        return process.returncode, bytes(transcript)
    finally:
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        os.close(master)
        if slave is not None:
            os.close(slave)


class OwnedResources:
    def __init__(self, image):
        self.nonce = secrets.token_hex(16)
        self.prefix = 'wanyu-recovery-test-' + self.nonce
        self.image = image
        self.containers = []
        self.volume = None

    def create(self):
        volume = docker(['volume', 'create', '--label', LABEL + '=' + self.nonce, self.prefix]).stdout.strip()
        metadata = inspect('volume', volume, '{{json .Labels}}')
        require(volume == self.prefix and metadata.get(LABEL) == self.nonce, 'volume_ownership_mismatch')
        self.volume = volume

    def container(self, name, command, env=None, peer=False):
        args = ['create', '--pull=never', '--name', self.prefix + '-' + name,
                '--label', LABEL + '=' + self.nonce, '--network=none',
                '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
                '--cpus=.1' if peer else '--cpus=.5', '--memory=32m' if peer else '--memory=512m',
                '--pids-limit=16' if peer else '--pids-limit=128',
                '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m',
                '--mount', f'type=volume,source={self.volume},target=/pb/pb_data']
        if peer:
            args += ['--entrypoint', '/bin/sleep']
        else:
            args += ['--env', 'APP_ADMIN_EMAIL', '--env', 'APP_ADMIN_PASSWORD',
                     '--env', 'PB_ADMIN_EMAIL', '--env', 'PB_ADMIN_PASSWORD',
                     '--env', 'GOMAXPROCS=2', '--env', 'GOMEMLIMIT=268435456',
                     '--env', 'ACCOUNT_EMAIL_ACTIONS_ENABLED=false']
        identity = docker([*args, self.image, *command], env=env).stdout.strip()
        require(re.fullmatch('[a-f0-9]{64}', identity) is not None, 'invalid_container_identity')
        self.containers.append(identity)
        docker(['container', 'start', identity])
        return identity

    def cleanup(self):
        ok = True
        # A timed-out wrapper may leave its deterministic one-shot container.
        # Only an exact image + this newly generated volume establishes ownership.
        if self.volume:
            name = 'wanyu-account-recovery-' + hashlib.sha256(('volume:' + self.volume).encode()).hexdigest()[:24]
            try:
                found = docker(['container', 'inspect', '--format', '{{json .Id}}', name], check=False)
                if found.returncode == 0:
                    identity = json.loads(found.stdout)
                    details = inspect('container', identity, '{"image":{{json .Image}},"mounts":{{json .Mounts}}}')
                    if details['image'] == self.image and any(m.get('Name') == self.volume and m.get('Destination') == '/pb/pb_data' for m in details['mounts']):
                        self.containers.append(identity)
                    else:
                        ok = False
            except Exception:
                ok = False
        for identity in reversed(self.containers):
            try:
                if docker(['container', 'rm', '-f', identity], check=False).returncode:
                    ok = False
            except Exception:
                ok = False
        for kind, identity in (('volume', self.volume),):
            if identity:
                try:
                    if docker([kind, 'rm', identity], check=False).returncode:
                        ok = False
                except Exception:
                    ok = False
        return ok


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, help='Trusted local backend tag or immutable image ID; never pulled')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not IMAGE.fullmatch(args.image):
        parser.error('image must be a local Docker image reference')
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        parser.error('output must be empty')
    output.mkdir(parents=True, exist_ok=True)
    report = {'status': 'running', 'synthetic': True, 'gates': {key: 'not_run' for key in GATES},
              'wrapper_sha256': hashlib.sha256(WRAPPER.read_bytes()).hexdigest(),
              'runner_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    resources = None
    phase = 'image'
    try:
        endpoint = json.loads(docker(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']).stdout)
        require(isinstance(endpoint, str) and endpoint.startswith('unix://') and
                (not os.environ.get('DOCKER_HOST') or os.environ['DOCKER_HOST'].startswith('unix://')), 'local_docker_socket_required')
        metadata = inspect('image', args.image, '{"id":{{json .Id}},"user":{{json .Config.User}},"labels":{{json .Config.Labels}}}')
        image, user = metadata['id'], metadata['user']
        require(re.fullmatch('sha256:[a-f0-9]{64}', image) is not None and bool(user) and user.split(':')[0] not in ('0', 'root'), 'untrusted_image_configuration')
        revision = (metadata['labels'] or {}).get('org.opencontainers.image.revision', '')
        report.update(image_id=image, image_revision=revision if re.fullmatch('[a-f0-9]{40}', revision) else None,
                      docker_server=docker(['version', '--format', '{{.Server.Version}}']).stdout.strip(),
                      python_version=sys.version.split()[0])
        resources = OwnedResources(image)
        phase = 'create'
        resources.create()
        original_password, super_password, recovered_password = [secrets.token_urlsafe(30) for _ in range(3)]
        email, super_email = 'recovery-' + resources.nonce + '@example.test', 'super-' + resources.nonce + '@example.test'
        env = {**os.environ, 'APP_ADMIN_EMAIL': email, 'APP_ADMIN_PASSWORD': original_password,
               'PB_ADMIN_EMAIL': super_email, 'PB_ADMIN_PASSWORD': super_password}
        backend = resources.container('backend', [], env=env)
        config = inspect('container', backend, '{"user":{{json .Config.User}},"host":{{json .HostConfig}},"networks":{{json .NetworkSettings.Networks}}}')
        require(config['user'] == user and config['host']['ReadonlyRootfs'] and config['host']['CapDrop'] == ['ALL'] and
                config['host']['Memory'] == 512 * 1024 * 1024 and config['host']['NanoCpus'] == 500000000 and
                config['host']['NetworkMode'] == 'none' and not config['host']['PortBindings'], 'isolation_mismatch')
        report['gates']['isolation'] = 'pass'
        phase = 'bootstrap'
        wait_ready(backend)
        login = request(backend, '/api/collections/users/auth-with-password', {'identity': email, 'password': original_password})
        superuser = request(backend, '/api/collections/_superusers/auth-with-password', {'identity': super_email, 'password': super_password})
        record_id = login['record']['id']
        request(backend, '/api/collections/users/records/' + record_id, {'verified': False}, superuser['token'], 'PATCH')
        request(backend, '/api/collections/users/records/' + record_id, {'role': 'user'}, login['token'], 'PATCH')
        current = request(backend, '/api/collections/users/auth-refresh', {}, login['token'])
        baseline = {key: current['record'][key] for key in ('id', 'email', 'role', 'verified')}
        count_before = request(backend, '/api/collections/users/records?perPage=1', token=superuser['token'], method='GET')['totalItems']
        require(baseline['role'] == 'user' and baseline['verified'] is False, 'synthetic_demotion_not_applied')
        phase = 'running_refusal'
        code, transcript = run_wrapper(backend, record_id)
        require(code != 0 and b'Backend is not proven stopped' in transcript and b'Temporary password (' not in transcript, 'running_backend_not_refused')
        report['gates']['running_refused'] = 'pass'
        docker(['container', 'stop', '--time', '10', backend])
        phase = 'shared_mount_refusal'
        peer = resources.container('shared-mount', ['180'], peer=True)
        code, transcript = run_wrapper(backend, record_id)
        require(code != 0 and b'Another running/restarting container uses this data mount' in transcript and b'Temporary password (' not in transcript, 'shared_mount_not_refused')
        report['gates']['shared_mount_refused'] = 'pass'
        docker(['container', 'stop', '--time', '2', peer])
        phase = 'recovery'
        code, transcript = run_wrapper(backend, record_id, recovered_password)
        require(code == 0 and b'Account recovered; existing sessions revoked.' in transcript, 'recovery_failed')
        report['gates']['stopped_recovered'] = 'pass'
        phase = 'restart'
        docker(['container', 'start', backend])
        wait_ready(backend)
        request(backend, '/api/collections/users/auth-with-password', {'identity': email, 'password': original_password}, expected=400)
        report['gates']['old_password_rejected'] = 'pass'
        request(backend, '/api/collections/users/auth-refresh', {}, current['token'], expected=401)
        report['gates']['old_token_rejected'] = 'pass'
        recovered = request(backend, '/api/collections/users/auth-with-password', {'identity': email, 'password': recovered_password})
        require(recovered['record']['must_change_password'] is True, 'initial_password_change_not_required')
        report['gates']['new_password_accepted'] = 'pass'
        require({key: recovered['record'][key] for key in baseline} == baseline, 'account_identity_changed')
        report['gates']['identity_preserved'] = 'pass'
        count_after = request(backend, '/api/collections/users/records?perPage=1', token=superuser['token'], method='GET')['totalItems']
        require(count_before == count_after and recovered['record']['role'] == 'user', 'bootstrap_changed_existing_account')
        report['gates']['bootstrap_did_not_elevate'] = 'pass'
        phase = 'privacy'
        log_result = docker(['container', 'logs', backend])
        logs = log_result.stdout + log_result.stderr
        commits = set(re.findall(r'fangji backend [^\n]* \(commit ([a-f0-9]{40}), built ', logs))
        report['binary_commit'] = next(iter(commits)) if len(commits) == 1 else None
        forbidden = [original_password, super_password, recovered_password, login['token'], current['token'], recovered['token'], superuser['token']]
        require(all(value not in logs and value.encode() not in transcript for value in forbidden), 'secret_found_in_output')
        combined = logs + transcript.decode('utf-8', errors='replace')
        require(not re.search(r'\$2[aby]\$\d\d\$[A-Za-z0-9./]{53}|\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b', combined), 'credential_material_found_in_output')
        report['gates']['no_secret_output'] = 'pass'
        report['identity_assertions'] = {'same_id': True, 'same_email': True, 'same_verified_false': True, 'same_demoted_role': True, 'same_user_count': True, 'must_change_password': True}
        report['status'] = 'pass'
    except (Exception, KeyboardInterrupt) as error:
        report.update(status='fail', error_phase=phase,
                      error_code=str(error) if isinstance(error, RehearsalFailure) else 'rehearsal_interrupted_or_failed')
    finally:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        try:
            cleaned = resources is None or resources.cleanup()
        except Exception:
            cleaned = False
        report['gates']['cleanup'] = 'pass' if cleaned else 'fail'
        if not cleaned:
            report['status'] = 'fail'
        (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        os.chmod(output / 'report.json', 0o600)
    print(json.dumps({'status': report['status'], 'report': str(output / 'report.json')}))
    return 0 if report['status'] == 'pass' else 1


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    raise SystemExit(main())
