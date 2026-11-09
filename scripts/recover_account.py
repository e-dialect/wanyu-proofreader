#!/usr/bin/env python3
"""Recover an existing account in a stopped Docker backend, without secret argv.

Only Docker-managed deployments with the exact /pb/pb_data mount are supported.
The backend must already be stopped; this tool verifies state and shared mounts,
then uses its immutable image in an isolated one-shot recovery container.
"""
import argparse
import getpass
import hashlib
import json
import posixpath
import re
import subprocess
import sys

DATA_TARGET = '/pb/pb_data'
INSPECT_FORMAT = ('{"Id":{{json .Id}},"Image":{{json .Image}},"State":{{json .State}},'
                  '"User":{{json .Config.User}},"Mounts":{{json .Mounts}}}')


def docker_output(args):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError('Docker inspection/preflight failed; recovery has not started.')
    return result.stdout


def inspect_container(name):
    return json.loads(docker_output(['container', 'inspect', '--format', INSPECT_FORMAT, name]))


def mount_identity(mount):
    # Use Docker daemon-reported sources, not caller paths or a claimed stop flag.
    if mount.get('Type') == 'volume':
        return ('volume', mount.get('Name', ''))
    return (mount.get('Type'), mount.get('Source', ''))


def mounts_overlap(first, second):
    if mount_identity(first) == mount_identity(second):
        return True
    # Bind mounts of a parent directory or the backing directory of a named
    # volume can reach the same DB even though their Docker identities differ.
    a, b = first.get('Source', ''), second.get('Source', '')
    if not a.startswith('/') or not b.startswith('/'):
        return False
    a, b = posixpath.normpath(a), posixpath.normpath(b)
    return posixpath.commonpath([a, b]) in (a, b)


def validate_target(target, peers):
    state = target.get('State', {})
    if (state.get('Status') != 'exited' or state.get('Running') or state.get('Restarting')
            or state.get('Paused') or state.get('Pid') != 0):
        raise RuntimeError('Backend is not proven stopped (must be exited, not running/restarting/paused, PID 0).')
    mounts = [m for m in target.get('Mounts', []) if m.get('Destination') == DATA_TARGET]
    if len(mounts) != 1 or not mounts[0].get('RW') or mounts[0].get('Type') not in ('bind', 'volume'):
        raise RuntimeError('Expected one writable bind/volume mount at /pb/pb_data; unknown layouts are refused.')
    mount = mounts[0]
    mount_type, source = mount_identity(mount)
    if not source or any(char in source for char in ',\r\n') or (mount_type == 'bind' and not source.startswith('/')):
        raise RuntimeError('The data mount cannot be safely represented by Docker --mount.')
    for peer in peers:
        if peer.get('Id') == target.get('Id'):
            continue
        other = peer.get('State', {})
        active = other.get('Running') or other.get('Restarting') or other.get('Paused') or other.get('Pid', 0) != 0
        if active and any(mounts_overlap(mount, m) for m in peer.get('Mounts', [])):
            raise RuntimeError('Another running/restarting container uses this data mount; stop all database users first.')
    image, user = target.get('Image', ''), target.get('User', '')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
        raise RuntimeError('An immutable local image id is required.')
    if not user or user.split(':')[0] in ('0', 'root'):
        raise RuntimeError('The backend must declare a non-root container user.')
    return {'container': target['Id'], 'image': image, 'user': user, 'mount_type': mount_type, 'source': source}


def checked_plan(container):
    peers = [inspect_container(cid) for cid in docker_output(['container', 'ls', '-aq']).splitlines()]
    target = inspect_container(container)
    return validate_target(target, peers)


def isolated_command(plan):
    return ['docker', 'run', '--rm', '--pull=never', '--network=none', '--read-only',
            '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', plan['user'],
            '--cpus=1', '--memory=512m', '--pids-limit=64',
            '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m', '--entrypoint', '/pb/pocketbase']


def recovery_command(plan, collection, record_id, operator):
    # An atomic Docker name also prevents two wrappers from simultaneously
    # recovering the same mount after both pass their read-only inspections.
    key = hashlib.sha256((plan['mount_type'] + ':' + plan['source']).encode()).hexdigest()[:24]
    return [*isolated_command(plan), '--name', 'wanyu-account-recovery-' + key, '-i',
            '--mount', f"type={plan['mount_type']},source={plan['source']},target={DATA_TARGET}",
            '--env', 'FANGJI_SKIP_ADMIN_BOOTSTRAP=1', plan['image'], 'recover-account',
            '--dir', DATA_TARGET, '--hooksDir', '/pb/pb_hooks', '--automigrate=false',
            '--collection', collection, '--id', record_id, '--operator', operator, '--password-stdin']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container', required=True, help='Exact stopped backend container name or id')
    parser.add_argument('--collection', choices=['users', '_superusers'], default='users')
    parser.add_argument('--id', required=True, help='Exact existing record id')
    parser.add_argument('--operator', required=True, help='Non-secret operator label')
    args = parser.parse_args()
    if not sys.stdin.isatty():
        parser.error('Run from an interactive terminal so the password prompt cannot echo.')
    try:
        plan = checked_plan(args.container)
        # Probe the command WITHOUT the data mount. An old image must fail
        # before touching an existing database, even if it opens DBs by default.
        probe = subprocess.run([*isolated_command(plan), plan['image'], 'recover-account', '--help'],
                               capture_output=True, text=True, check=False)
        if probe.returncode or '--password-stdin' not in probe.stdout:
            raise RuntimeError('The stopped backend image does not support safe recovery; no data was mounted.')
        password = getpass.getpass('Temporary password (12–71 characters, max 72 UTF-8 bytes): ')
        confirmation = getpass.getpass('Confirm password: ')
        if password != confirmation or not 12 <= len(password) <= 71 or len(password.encode('utf-8')) > 72 or '\n' in password or '\r' in password:
            raise RuntimeError('Passwords mismatch or exceed the supported range.')
        # Recheck after the prompt, before Docker opens/mounts the data path.
        if checked_plan(args.container) != plan:
            raise RuntimeError('Container identity/image/data changed during confirmation; refusing recovery.')
        result = subprocess.run(recovery_command(plan, args.collection, args.id, args.operator),
                                input=(password + '\n').encode('utf-8'), check=False)
        password = confirmation = ''
        return result.returncode
    except (RuntimeError, OSError, json.JSONDecodeError) as error:
        print(f'Recovery refused: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
