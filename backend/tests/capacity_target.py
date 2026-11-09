#!/usr/bin/env python3
"""SSH-stdio target. Creates only a nonce-owned temporary DB, binds loopback only."""
import contextlib
import hashlib
import json
import os
import queue
import signal
import select
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import harness
import capacity_fixture as fixture
from capacity_remote_contract import (VERSION, MAX_LINE, SOURCE_KEYS, canonical_hash, clean_environment,
                                      host_identity, observation_seconds, same_source, validate_init, strict_json_loads,
                                      CapacityFailure, safe_failure)
from capacity_resources import ResourceSampler
from run_capacity_baseline import prepare_fixture, reconcile_fixture


SHUTTING_DOWN = threading.Event()
CURRENT_PHASE = 'protocol'


class Interrupted(KeyboardInterrupt):
    pass


def stop_process(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


class OwnedTarget:
    """The only filesystem lifetime owned by this protocol; no caller path input."""
    def __init__(self, nonce):
        self.temp = tempfile.TemporaryDirectory(prefix='wanyu-capacity-' + nonce + '-')
        self.root = Path(self.temp.name)
        os.chmod(self.root, 0o700)
        self.stack = contextlib.ExitStack()
        self.frontend = None
        self.sampler = None
        self.closed = False

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            if self.sampler:
                self.sampler.stop()
        finally:
            try:
                stop_process(self.frontend)
            finally:
                try:
                    self.stack.close()
                finally:
                    self.temp.cleanup()


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':'), allow_nan=False) + '\n')
    sys.stdout.flush()


def command_reader(channel):
    # Do not hold Python's buffered stdin lock in a daemon thread at interpreter
    # shutdown. Poll the raw descriptor so normal completion can join cleanly.
    pending = b''
    try:
        while not SHUTTING_DOWN.is_set():
            if not select.select([sys.stdin.fileno()], [], [], .2)[0]:
                continue
            chunk = os.read(sys.stdin.fileno(), 65536)
            if not chunk:
                if not SHUTTING_DOWN.is_set(): os.kill(os.getpid(), signal.SIGTERM)
                return
            pending += chunk
            if len(pending) > MAX_LINE:
                raise ValueError('protocol_message_too_large')
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                channel.put(strict_json_loads(line), timeout=1)
    except (ValueError, queue.Full, OSError):
        if not SHUTTING_DOWN.is_set(): os.kill(os.getpid(), signal.SIGTERM)


def source():
    return fixture.source_manifest(harness.BACKEND)


def stream_artifact(name, path):
    if not path.exists():
        return
    with path.open() as incoming:
        while chunk := incoming.read(32768):
            emit({'artifact': name, 'data': chunk})


def run(channel):
    global CURRENT_PHASE
    initial = validate_init(channel.get(timeout=30))
    CURRENT_PHASE = 'source'
    if not same_source(initial['source'], source()):
        raise CapacityFailure('source', 'source_mismatch')
    CURRENT_PHASE = 'prepare'
    owned = OwnedTarget(initial['nonce'])
    # Preparation logs may contain synthetic credentials; never place them on
    # stdout/stderr (the protocol and operator report channels).
    log = None
    try:
        log = (owned.root/'prepare.log').open('w')
        args = SimpleNamespace(**initial)
        budget = initial['budget']
        if budget:
            for key, environment_key in [('gomaxprocs', 'GOMAXPROCS'), ('gomemlimit_bytes', 'GOMEMLIMIT')]:
                if budget['runtime'][key] is not None:
                    os.environ[environment_key] = str(int(budget['runtime'][key]))
        CURRENT_PHASE = 'build_backend'
        binary = harness.build_binary(owned.root/'pocketbase', build_sha=initial['source']['baseline_sha'])
        CURRENT_PHASE = 'build_frontend'
        subprocess.run(['npm', 'run', 'build', '--', '--outDir', str(owned.root/'dist')],
                       cwd=harness.BACKEND.parent/'frontend', stdout=log, stderr=log, check=True)
        CURRENT_PHASE = 'fixture'
        with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            state = prepare_fixture(binary, owned.root, args)
        CURRENT_PHASE = 'start'
        env = owned.stack.enter_context(harness.server(binary, owned.root))
        owned.frontend = subprocess.Popen(['node', str(harness.BACKEND/'tests/capacity_target_frontend.cjs'),
            env['PB_URL'], str(owned.root/'dist')], stdout=subprocess.PIPE, stderr=log, text=True)
        # Readiness is bounded by the session alarm as well as child failure.
        ready = json.loads(owned.frontend.stdout.readline())
        owned.frontend.stdout.close()
        config = {'disposable': True, 'base': env['PB_URL'], 'browser_origin': ready['origin'],
                  'project': state['project']['id'], 'secondary_project': state['secondary']['id'],
                  'actors': state['actors'], 'duration': args.duration, 'profile': args.profile,
                  'phases': fixture.phases(args.duration), 'start_epoch_ms': time.time()*1000+86400000,
                  'output': str(owned.root), 'seed': 1701, 'parallel_import_rows': 200 if args.profile == 'smoke' else 2000,
                  'observation': 'baseline'}
        owned.sampler = ResourceSampler(env['PB_TEST_SERVER_PID'], owned.root, config, owned.frontend.pid, os.getpgrp())
        owned.sampler.start()
        baseline_started = time.monotonic()
        evidence = {'host': host_identity(), 'hardware': fixture.hardware(), 'source': source(),
                    'budget_sha256': canonical_hash(budget), 'nonce': args.nonce,
                    'workload': {'duration': args.duration, 'entries': args.entries, 'users': args.users},
                    'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
                    'frontend_dist_sha256': canonical_hash({str(p.relative_to(owned.root/'dist')): hashlib.sha256(p.read_bytes()).hexdigest()
                                                          for p in sorted((owned.root/'dist').rglob('*')) if p.is_file()}),
                    'runtime': {'frontend': 'target-side Node static host and API proxy', 'bind': 'loopback',
                                'frontend_engine': 'node-http/export_browser_host.cjs', 'production_nginx': False,
                                'resource_constraints': 'observed host/cgroup; no constraints are installed by this runner'}}
        # Secrets exist only in this response, the pipe and generator's 0600 temp
        # file. The orchestrator writes only the evidence object to its manifest.
        emit({'ok': 'ready', 'version': VERSION, 'evidence': evidence, 'config': config})
        CURRENT_PHASE = 'observation'
        armed = False
        while True:
            command = channel.get(timeout=args.duration+600)
            if not isinstance(command, dict):
                raise ValueError('invalid_command')
            op = command.get('op')
            if op == 'ping' and set(command) == {'op'}:
                received = time.time()*1000
                emit({'ok': 'pong', 'received_ms': received, 'sent_ms': time.time()*1000})
            elif op == 'arm' and set(command) == {'op'} and not armed:
                remaining = observation_seconds(budget, 'baseline_seconds') - (time.monotonic()-baseline_started)
                if remaining > 0:
                    time.sleep(remaining)
                owned.sampler.sample()
                config['start_epoch_ms'] = round(time.time()*1000)+5000
                config['observation'] = 'load'
                owned.sampler.sample()
                armed = True
                emit({'ok': 'armed', 'start_epoch_ms': config['start_epoch_ms']})
            elif op == 'finish' and set(command) == {'op', 'submissions'} and armed:
                submissions = command['submissions']
                if not isinstance(submissions, list) or len(submissions) > 100000:
                    raise ValueError('invalid_reconciliation_input')
                owned.sampler.sample()
                config['observation'] = 'postload_idle'
                # Both generators have exited before finish. No new work is
                # admitted during this independent post-load recovery window.
                owned.sampler.sample()
                time.sleep(observation_seconds(budget, 'observe_seconds'))
                resources = owned.sampler.stop()
                owned.sampler = None
                CURRENT_PHASE = 'finish'
                stop_process(owned.frontend)
                owned.stack.close()
                reconciliation = reconcile_fixture(owned.root, state, config, submissions)
                safe = []
                for line in (owned.root/'server.log').read_text().splitlines():
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    if event.get('event') in ('http_completed', 'runtime_sample', 'web_vital'):
                        safe.append(json.dumps(event))
                (owned.root/'runtime.jsonl').write_text('\n'.join(safe)+'\n')
                stream_artifact('resources.jsonl', owned.root/'resources.jsonl')
                stream_artifact('runtime.jsonl', owned.root/'runtime.jsonl')
                emit({'ok': 'finished', 'reconciliation': reconciliation, 'resources': resources,
                      'fixture': state['fixture_meta'], 'pdf': state['pdf_meta'], 'storage_rollback_gate': state['storage_gate'],
                      'source_after': source(), 'host_after': host_identity(), 'database_bytes': (owned.root/'data/data.db').stat().st_size,
                      'recovery_mode': 'generators-exited; independent postload idle observation',
                      'baseline_seconds': observation_seconds(budget, 'baseline_seconds'),
                      'recovery_seconds': observation_seconds(budget, 'observe_seconds')})
                return
            else:
                raise ValueError('invalid_protocol_state')
    except (Exception, KeyboardInterrupt) as error:
        raise safe_failure(CURRENT_PHASE, error) from None
    finally:
        CURRENT_PHASE = 'cleanup'
        SHUTTING_DOWN.set()
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        os.killpg(os.getpid(), signal.SIGTERM)
        owned.close()
        if log is not None:
            log.close()


def main():
    # An isolated session lets final cleanup reap only this helper's descendants,
    # including a build/fixture subprocess interrupted before its normal return.
    if os.getsid(0) != os.getpid():
        os.setsid()
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
        signal.signal(sig, lambda *_: (_ for _ in ()).throw(Interrupted()))
    signal.alarm(7200)
    os.umask(0o077)
    incoming = queue.Queue(maxsize=8)
    environment = clean_environment()
    os.environ.clear()
    os.environ.update(environment)
    reader = threading.Thread(target=command_reader, args=(incoming,), daemon=True)
    reader.start()
    result = 1
    try:
        run(incoming)
        result = 0
    except (Exception, KeyboardInterrupt) as error:
        # Exception messages and traceback can contain secret child environment
        # or configuration values. Fixed code only on this channel.
        try:
            emit(safe_failure(CURRENT_PHASE, error).frame())
        except (BrokenPipeError, OSError):
            pass
    finally:
        SHUTTING_DOWN.set()
        reader.join(timeout=1)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.alarm(0)
        os.killpg(os.getpid(), signal.SIGTERM)
    return result


if __name__ == '__main__':
    raise SystemExit(main())
