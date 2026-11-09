#!/usr/bin/env python3
"""Read-only release gate report. Missing operator receipts stay pending."""
import argparse
import datetime
import json
import re
from pathlib import Path


def check_receipt(path, max_age_hours, now, required_build=None):
    if path is None:
        return {'status': 'pending', 'reason': 'unconfigured'}
    try:
        value = json.loads(path.read_text())
        stamp = datetime.datetime.fromisoformat(value['verified_at'].replace('Z', '+00:00'))
        if stamp.tzinfo is None or stamp > now or (now-stamp).total_seconds()>max_age_hours*3600:
            return {'status': 'failed', 'reason': 'verification_expired'}
        if value.get('status') != 'pass' or (required_build and value.get('build_sha') != required_build):
            return {'status': 'failed', 'reason': 'verification_failed_or_build_mismatch'}
        return {'status': 'pass', 'verified_at': stamp.isoformat()}
    except (OSError, ValueError, KeyError, TypeError):
        return {'status': 'failed', 'reason': 'invalid_receipt'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-sha', required=True)
    for name in ['backup', 'remote-backup', 'restore', 'smtp', 'notification', 'human', 'capacity']:
        parser.add_argument('--'+name+'-receipt', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch('[0-9a-f]{40}',args.build_sha):
        parser.error('exact build SHA required')
    now = datetime.datetime.now(datetime.timezone.utc)
    gates = {}
    for name, hours in [('backup',24),('remote_backup',24),('restore',24*90),('smtp',24*30),('notification',24*30),('human',24*30),('capacity',24*30)]:
        gates[name] = check_receipt(getattr(args,name+'_receipt'),hours,now,args.build_sha if name in ('restore','human','capacity') else None)
    report = {'schema_version':1,'build_sha':args.build_sha,'checked_at':now.isoformat(),'status':'ready' if all(g['status']=='pass' for g in gates.values()) else 'not_ready','gates':gates,
              'boundary':'Receipts are operator evidence inputs, not cryptographic attestations. This tool never creates them or sends notifications.'}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'status':report['status'],'pending_or_failed':[n for n,g in gates.items() if g['status']!='pass']}))
    return 0 if report['status']=='ready' else 1


if __name__=='__main__':
    raise SystemExit(main())
