#!/usr/bin/env python3
"""Separate-host capacity entrypoint. Requires an explicitly selected isolated SSH target."""
import argparse
import hashlib
import json
import os
import queue
import re
import secrets
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import harness
import capacity_fixture as fixture
import capacity_report
from capacity_remote_contract import (VERSION, MAX_LINE, ARTIFACTS, canonical_hash, clean_environment,
    host_identity, validate_budget, validate_init, evaluate_evidence, same_source, observation_seconds, strict_json_loads,
    CapacityFailure, failure_from_frame, safe_failure)
from capacity_target import stop_process


def transport_environment(ssh=False):
    env = clean_environment()
    # The local SSH client may need its agent. Never forward the agent or this
    # variable to target subprocesses; the helper applies its own allowlist.
    if ssh and 'SSH_AUTH_SOCK' in os.environ:
        env['SSH_AUTH_SOCK'] = os.environ['SSH_AUTH_SOCK']
    return env


def stop_generator_group(process):
    """Stop inherited and Playwright-detached descendants before idle sampling."""
    groups = {process.pid}
    if process.poll() is None:
        try:
            rows = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,pgid=,stat='], text=True, timeout=2).splitlines()
            records = [row.split() for row in rows if row.split()]
            descendants = {process.pid}
            while True:
                found = {int(r[0]) for r in records if int(r[1]) in descendants}
                if found <= descendants: break
                descendants.update(found)
            # Playwright's browser launcher starts a separate process group.
            # Only groups whose leader is a proven descendant can be signaled.
            groups.update(int(r[2]) for r in records if int(r[0]) in descendants and int(r[2]) in descendants)
        except (OSError, subprocess.SubprocessError, ValueError):
            try: os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            stop_process(process)
            raise RuntimeError('generator_descendants_unobservable') from None
    for group in groups:
        try: os.killpg(group, signal.SIGTERM)
        except ProcessLookupError: pass
    stop_process(process)
    for attempt in range(40):
        rows = subprocess.check_output(['ps', '-axo', 'pgid=,stat='], text=True, timeout=2).splitlines()
        live = [r.split() for r in rows if r.split() and int(r.split()[0]) in groups and not r.split()[1].startswith(('Z', 'X'))]
        if not live:
            return
        if attempt == 10:
            for group in groups:
                try: os.killpg(group, signal.SIGKILL)
                except ProcessLookupError: pass
        time.sleep(.1)
    raise RuntimeError('generator_group_cleanup_unconfirmed')


class Transport:
    def __init__(self, command, output):
        self.output = output
        self.queue = queue.Queue(maxsize=64)
        self.closed = threading.Event()
        self.sizes = {}
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, start_new_session=True, env=transport_environment(command[0] == 'ssh'))
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        try:
            while not self.closed.is_set():
                line = self.process.stdout.readline(MAX_LINE+1)
                if not line or len(line) > MAX_LINE or not line.endswith(b'\n'):
                    self.queue.put(None, timeout=1)
                    return
                self.queue.put(strict_json_loads(line), timeout=1)
        except (ValueError, queue.Full, OSError):
            try: self.queue.put(None, timeout=1)
            except queue.Full: pass

    def request(self, value, timeout=900):
        line = json.dumps(value, separators=(',', ':'), allow_nan=False).encode()+b'\n'
        if len(line) > MAX_LINE:
            raise ValueError('protocol_message_too_large')
        self.process.stdin.write(line)
        self.process.stdin.flush()
        deadline = time.monotonic()+timeout
        while True:
            response = self.queue.get(timeout=max(.01, deadline-time.monotonic()))
            if not isinstance(response, dict):
                raise CapacityFailure('protocol', 'protocol_failed')
            if 'error' in response:
                raise failure_from_frame(response)
            if 'artifact' not in response:
                return response
            name, data = response.get('artifact'), response.get('data')
            if name not in ARTIFACTS or not isinstance(data, str) or set(response) != {'artifact', 'data'}:
                raise ValueError('invalid_artifact')
            self.sizes[name] = self.sizes.get(name, 0)+len(data.encode())
            if self.sizes[name] > 128*1024*1024:
                raise ValueError('artifact_exceeds_limit')
            with (self.output/name).open('a') as out:
                out.write(data)

    def close(self):
        self.closed.set()
        try:
            self.process.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        try:
            code = self.process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            stop_process(self.process)
            code = self.process.returncode
        self.thread.join(timeout=2)
        self.process.stdout.close()
        return code


def ssh_command(target, repo):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]{0,200}', target) or not repo.startswith('/') or '\n' in repo:
        raise ValueError('invalid_ssh_destination')
    # SSH always invokes a remote shell: quote the complete user-supplied path.
    remote = 'cd ' + shlex.quote(repo) + ' && exec python3 backend/tests/capacity_target.py'
    return ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'ForwardAgent=no', '-o', 'SendEnv=-*',
            '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', target, remote]


def loopback_port(origin):
    match = re.fullmatch(r'http://127\.0\.0\.1:(\d+)', origin)
    if not match or not 1024 <= int(match.group(1)) <= 65535:
        raise ValueError('target_not_loopback')
    return int(match.group(1))


def clock_probe(transport):
    probes = []
    for _ in range(5):
        before = time.time()*1000
        pong = transport.request({'op': 'ping'}, timeout=10)
        after = time.time()*1000
        if pong.get('ok') != 'pong' or not before <= after:
            raise ValueError('invalid_clock_response')
        processing = pong['sent_ms']-pong['received_ms']
        roundtrip = after-before
        if not 0 <= processing <= roundtrip:
            raise ValueError('invalid_clock_sample')
        probes.append({'local_send_ms': before, 'target_receive_ms': pong['received_ms'],
                       'target_send_ms': pong['sent_ms'], 'local_receive_ms': after,
                       'offset_ms': ((pong['received_ms']-before)+(pong['sent_ms']-after))/2,
                       'uncertainty_ms': (roundtrip-processing)/2})
    best = min(probes, key=lambda item: item['uncertainty_ms'])
    return {**best, 'probes': probes, 'method': 'five stdio round trips; minimum-RTT offset bound'}


def run_once(args, output, source, budget):
    nonce = secrets.token_hex(16)
    command = ([sys.executable, str(harness.BACKEND/'tests/capacity_target.py')]
               if args.transport == 'local' else ssh_command(args.ssh_target, args.target_repo))
    try:
        transport = Transport(command, output)
    except (Exception, KeyboardInterrupt) as error:
        raise safe_failure('connect', error) from None
    tunnel, processes = None, []
    result = None
    phase = 'prepare'
    try:
        ready = transport.request({'op': 'init', 'version': VERSION, 'nonce': nonce,
            'profile': args.profile, 'entries': args.entries, 'users': args.users, 'duration': args.duration,
            'source': source, 'budget': budget})
        if ready.get('ok') != 'ready' or ready.get('version') != VERSION:
            raise ValueError('invalid_ready')
        evidence = ready['evidence']
        if evidence.get('nonce') != nonce or evidence.get('budget_sha256') != canonical_hash(budget) or not same_source(source, evidence['source']):
            raise ValueError('target_evidence_mismatch')
        config = ready['config']
        backend_port, frontend_port = loopback_port(config['base']), loopback_port(config['browser_origin'])
        if args.transport == 'ssh':
            phase = 'tunnel'
            local_backend, local_frontend = harness.free_port(), harness.free_port()
            tunnel = subprocess.Popen(['ssh', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                '-o', 'ForwardAgent=no', '-o', 'SendEnv=-*',
                '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
                '-L', f'127.0.0.1:{local_backend}:127.0.0.1:{backend_port}',
                '-L', f'127.0.0.1:{local_frontend}:127.0.0.1:{frontend_port}', args.ssh_target],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, env=transport_environment(True))
            config['base'] = f'http://127.0.0.1:{local_backend}'
            config['browser_origin'] = f'http://127.0.0.1:{local_frontend}'
            import urllib.request
            for _ in range(100):
                if tunnel.poll() is not None: raise RuntimeError('tunnel_exited')
                try:
                    with urllib.request.urlopen(config['base']+'/api/health', timeout=1): break
                except OSError: time.sleep(.1)
            else: raise RuntimeError('tunnel_not_ready')
        phase = 'observation'
        clock = clock_probe(transport)
        armed = transport.request({'op': 'arm'}, timeout=700)
        if armed.get('ok') != 'armed': raise ValueError('invalid_arm')
        config.update(start_epoch_ms=armed['start_epoch_ms']-clock['offset_ms'], output=str(output))
        config.pop('observation', None)
        phase = 'generate'
        # mkstemp starts 0600; credentials are never written into output or argv.
        with tempfile.TemporaryDirectory(prefix='wanyu-capacity-generator-') as temporary:
            path = Path(temporary)/'load.json'
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'w') as file: json.dump(config, file)
            env = {**clean_environment(), 'CAPACITY_FIXTURE': str(path)}
            for key in ('NODE_PATH', 'BROWSER_CHANNEL', 'PLAYWRIGHT_BROWSERS_PATH'):
                if key in os.environ: env[key] = os.environ[key]
            for script in ('capacity_scenarios.mjs', 'capacity_browser.cjs'):
                processes.append(subprocess.Popen(['node', str(harness.BACKEND/'tests'/script)], env=env,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True))
            codes = []
            deadline = time.monotonic()+args.duration+120
            for process in processes:
                try: codes.append(process.wait(timeout=max(1, deadline-time.monotonic())))
                except subprocess.TimeoutExpired:
                    stop_generator_group(process)
                    codes.append(124)
            for process in processes:
                stop_generator_group(process)
        http = capacity_report.lines(output/'requests.jsonl')+capacity_report.lines(output/'browser-http.jsonl')
        submissions = [row for row in http if row.get('operation') == 'submit' and row.get('status') == 200 and row.get('ok')]
        phase = 'observation'
        after_clock = clock_probe(transport)
        clock['after_load'] = after_clock
        clock['drift_bound_ms'] = abs(after_clock['offset_ms']-clock['offset_ms'])+after_clock['uncertainty_ms']+clock['uncertainty_ms']
        phase = 'observation'
        finished = transport.request({'op': 'finish', 'submissions': submissions}, timeout=observation_seconds(budget, 'observe_seconds')+120)
        if finished.get('ok') != 'finished': raise ValueError('invalid_finish')
        phase = 'finish'
        rows = [strict_json_loads(line) for line in (output/'resources.jsonl').read_text().splitlines() if line]
        generator = host_identity()
        gates = evaluate_evidence(rows, budget, evidence, generator, clock, args.transport)
        runtime = capacity_report.lines(output/'runtime.jsonl')
        gates['binary_build_identity'] = ('pass' if all(row.get('build_sha') == source['baseline_sha'] for row in runtime) else 'fail') if runtime else 'incomplete'
        gates['source_unchanged'] = 'pass' if same_source(source, finished['source_after']) and same_source(source, fixture.source_manifest(harness.BACKEND)) else 'incomplete'
        gates['target_identity_unchanged'] = 'pass' if evidence['host'].get('machine_sha256') and evidence['host']['machine_sha256'] == finished['host_after'].get('machine_sha256') else 'incomplete'
        report = capacity_report.summarize(output, config, finished['reconciliation'], codes)
        report.update({key: finished[key] for key in ('fixture', 'pdf', 'storage_rollback_gate', 'database_bytes', 'recovery_mode', 'baseline_seconds', 'recovery_seconds')})
        report['remote_gates'] = gates
        resource_report = finished['resources']
        resource_report.update(resource_budget_status=gates['resource_budget'], cooldown_recovery_status=gates['cooldown_recovery'],
                               separate_generator_host=gates['separate_generator_host'] == 'pass', separate_generator_status=gates['separate_generator_host'])
        resource_report['limitations'] = ['Resource budget uses the owned target process group RSS, including backend, Node frontend, helper and inherited renderer processes; backend/frontend RSS are also reported separately.',
            'Directory size is sampled every 60s, other OS/DB fields every 5s, runtime heap every 30s; short spikes between samples are not certified.',
            'Actual SSH, device identity and co-tenant contention must be observed on the intended isolated target; localhost transport never establishes separation.']
        for name, value in [('reconciliation.json', finished['reconciliation']), ('resources-summary.json', resource_report),
                            ('target-evidence.json', evidence), ('generator-evidence.json', generator), ('clock.json', clock)]:
            (output/name).write_text(json.dumps(value, indent=2))
        result = report
        return report
    except (Exception, KeyboardInterrupt) as error:
        raise safe_failure(phase, error) from None
    finally:
        try:
            try:
                for process in processes:
                    stop_generator_group(process)
            finally:
                stop_process(tunnel)
                code = transport.close()
        except (Exception, KeyboardInterrupt) as error:
            raise safe_failure('cleanup', error) from None
        if result is not None:
            result['target_exit_code'] = code
            result['remote_gates']['target_cleanup'] = 'pass' if code == 0 else 'incomplete'
            (output/'acceptance.json').write_text(json.dumps(result, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--transport', choices=('ssh', 'local'), default='ssh')
    parser.add_argument('--ssh-target')
    parser.add_argument('--target-repo')
    parser.add_argument('--budget', type=Path)
    parser.add_argument('--profile', choices=('smoke', 'full'), default='smoke')
    parser.add_argument('--entries', type=int, default=20000)
    parser.add_argument('--users', type=int, default=30)
    parser.add_argument('--duration', type=int)
    parser.add_argument('--repeats', type=int)
    parser.add_argument('--fault-report', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.duration = args.duration or (3600 if args.profile == 'full' else 180)
    args.repeats = args.repeats or (3 if args.profile == 'full' else 1)
    if args.transport == 'ssh' and (not args.ssh_target or not args.target_repo): parser.error('SSH requires an explicitly selected isolated target and checkout')
    if not 1 <= args.repeats <= 3: parser.error('repeats must be 1..3')
    if args.profile == 'full' and args.repeats != 3: parser.error('full requires three repeats')
    args.output = args.output.resolve()
    if args.output.exists() and any(args.output.iterdir()): parser.error('output must be empty')
    args.output.mkdir(parents=True, exist_ok=True)
    budget_bytes = args.budget.read_bytes() if args.budget else None
    budget = strict_json_loads(budget_bytes) if budget_bytes else None
    validate_budget(budget)
    source = fixture.source_manifest(harness.BACKEND)
    validate_init({'op':'init','version':VERSION,'nonce':'0'*32,'profile':args.profile,'entries':args.entries,'users':args.users,'duration':args.duration,'source':source,'budget':budget})
    manifest = {**source, 'profile': args.profile, 'synthetic': True, 'transport': args.transport,
                'acceptance_scope': 'isolated_protocol_reference_load',
                'release_gates': {'production_stack': 'incomplete', 'colocated_contention': 'incomplete', 'container_hard_limits': 'incomplete'},
                'release_ready': False,
                'entries': args.entries, 'users': args.users, 'duration': args.duration, 'repeats': args.repeats,
                'budget': budget, 'budget_sha256': canonical_hash(budget), 'budget_file_sha256': hashlib.sha256(budget_bytes).hexdigest() if budget_bytes else None, 'status': 'running', 'full_acceptance': False}
    (args.output/'manifest.json').write_text(json.dumps(manifest, indent=2))
    results = []
    try:
        for repeat in range(args.repeats):
            output = args.output/f'run-{repeat+1}'
            output.mkdir()
            results.append(run_once(args, output, source, budget))
        gates = {key: 'fail' if any(r['remote_gates'][key] == 'fail' for r in results) else 'pass' if all(r['remote_gates'][key] == 'pass' for r in results) else 'incomplete'
                 for key in results[0]['remote_gates']}
        gates['mixed_runs'] = 'pass' if all(r['status'] == 'pass' for r in results) else 'fail' if any(r['status'] == 'fail' for r in results) else 'incomplete'
        gates['three_full_repeats'] = 'pass' if args.profile == 'full' else 'incomplete'
        faults = strict_json_loads(args.fault_report.read_text()) if args.fault_report else None
        valid_faults = bool(faults and faults.get('status') == 'pass' and faults.get('full_fault_gate') is True and faults.get('duration_seconds', 0) >= 900
            and same_source(source, faults) and all(faults.get('gates', {}).get(name) == 'pass' for name in ('offline','response_loss','restart','revocation','storage')))
        gates['fifteen_minute_faults'] = 'pass' if valid_faults else 'incomplete'
        gates['budget_unchanged'] = 'pass' if budget_bytes is not None and args.budget.read_bytes() == budget_bytes else 'incomplete'
        full = all(value == 'pass' for value in gates.values())
        status = 'fail' if 'fail' in gates.values() else 'pass' if full else 'incomplete'
        if any(r['status'] == 'invalid_generator' for r in results): status = 'invalid_generator'
        manifest.update(status=status, gates=gates, full_acceptance=full)
    except (Exception, KeyboardInterrupt) as error:
        failure = safe_failure('protocol', error)
        manifest.update(status='incomplete', error_code=failure.reason_code, error_phase=failure.phase, full_acceptance=False)
    finally:
        (args.output/'manifest.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps({'status': manifest['status'], 'full_acceptance': manifest['full_acceptance']}))
    return {'pass':0, 'fail':1, 'incomplete':2, 'invalid_generator':3}[manifest['status']]


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    raise SystemExit(main())
