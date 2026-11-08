#!/usr/bin/env python3
"""Disposable mixed-load protocol probe. Never accepts production URL/data-dir."""
import argparse
import hashlib
import json
import os
import platform
import sqlite3
import subprocess
import time
from pathlib import Path
import harness
import field_audit_capacity as audit


def clone_fixture(db, project, entries):
    """Clone actual workflow templates offline, preserving attempt/event references."""
    with sqlite3.connect(db) as sql:
        sql.row_factory = sqlite3.Row
        pages = [dict(r) for r in sql.execute('SELECT * FROM pages WHERE project=? ORDER BY page_number', (project,))]
        complete = next(p for p in pages if p['status'] in ('approved','proofread'))
        arbitration = next(p for p in pages if p['status']=='arbitration')
        templates = {}
        for kind, page in [('complete',complete),('arbitration',arbitration)]:
            attempts = [dict(r) for r in sql.execute('SELECT * FROM proofreading_attempts WHERE page=?',(page['id'],))]
            events = [dict(r) for r in sql.execute('SELECT * FROM verification_events WHERE page=?',(page['id'],))]
            templates[kind]=(page,attempts,events)
        def insert(table,row):
            sql.execute(f'INSERT INTO {table} ({",".join(row)}) VALUES ({",".join("?" for _ in row)})',tuple(row.values()))
        entries_to_add = max(0, entries - len(pages))
        for index in range(entries_to_add):
            kind='complete' if index<entries*.5 else 'arbitration' if index<entries*.7 else 'single' if index<entries*.85 else 'pending'
            page,attempts,events=templates['complete' if kind=='complete' else 'arbitration']
            pageid=f'mat{index:012d}';mapping={page['id']:pageid}
            chosen=attempts if kind in ('complete','arbitration') else [a for a in attempts if a['kind']=='proofread'][:1] if kind=='single' else []
            for n,a in enumerate(chosen): mapping[a['id']]=f'maa{index*4+n:012d}'
            for n,e in enumerate(events): mapping[e['id']]=f'mae{index*100+n:012d}'
            def mapped(record):
                result={}
                for key,value in record.items():
                    if isinstance(value,str):
                        for old,new in mapping.items():value=value.replace(old,new)
                    result[key]=value
                return result
            record=mapped(page);record['page_number']=1000+index
            if kind in ('single','pending'):
                record.update(status='proofreading' if kind=='single' else 'pending',proofread_count=len(chosen),proofread_row_json='',proofreader='',lease_token_hash='',lease_expires_at='')
            # Unknown optional schema keys must not be invented during fixture creation.
            record={k:v for k,v in record.items() if k in page}
            insert('pages',record)
            for attempt in chosen:insert('proofreading_attempts',mapped(attempt))
            chosen_ids={a['id'] for a in chosen}
            for event in events:
                if kind in ('complete','arbitration') or (event['kind'] in ('field_action','submission') and event['ref'] in chosen_ids):
                    insert('verification_events',mapped(event))
        integrity=sql.execute('PRAGMA integrity_check').fetchone()[0]
        assert integrity=='ok'
        return {'entries_added':entries_to_add,'integrity':integrity,'counts':dict(sql.execute('SELECT status,COUNT(*) FROM pages WHERE project=? GROUP BY status',(project,)).fetchall()),'method':'offline cloning of real HTTP workflow templates; bulk setup is not submission throughput'}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--entries',type=int,default=20000)
    parser.add_argument('--duration',type=int,default=3600)
    parser.add_argument('--users',type=int,default=30)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if not 20<=args.entries<=20000 or not 3<=args.users<=30 or args.duration<5:parser.error('entries 20..20000, users 3..30, duration >=5')
    args.output=args.output.resolve();args.output.mkdir(parents=True,exist_ok=True)
    manifest={'source_sha256': {name: hashlib.sha256((harness.BACKEND/'tests'/name).read_bytes()).hexdigest() for name in ['run_capacity_baseline.py','capacity_scenarios.mjs']}, 'baseline_sha':subprocess.check_output(['git','rev-parse','HEAD'],cwd=harness.BACKEND,text=True).strip(),'host':platform.platform(),'entries':args.entries,'users':args.users,'duration':args.duration,'seed':1701,'synthetic':True,'reference_hardware_verified':False,'full_acceptance':False}
    with harness.temporary_root() as root:
        binary=harness.build_binary(root/'pocketbase'); fixture_file=root/'fixture.json';db=root/'data/data.db'
        with harness.server(binary,root,extra_env={'FIDELITY_BROWSER_FIXTURE':str(fixture_file)}) as env:
            subprocess.run(['node',str(harness.BACKEND/'tests/source_fidelity_integration.mjs')],env=harness.with_research_notice_preload(env),check=True,stdout=subprocess.DEVNULL)
            fixture=json.loads(fixture_file.read_text())
            superauth=audit.request(env['PB_URL'],'/api/collections/_superusers/auth-with-password',method='POST',body={'identity':env['PB_SUPER_EMAIL'],'password':env['PB_SUPER_PASSWORD']})
            fixture['super_token']=superauth['token']
            _,project,_=audit.rollback_probe(env,db,fixture)
            actors=[]
            for i in range(args.users):
                role='proofreader' if i<max(1,args.users-6) else 'arbitrator' if i<args.users-2 else 'manager'
                identity=f'maturity-load-{i}@example.com';password='SyntheticMaturity123!'
                user=audit.request(env['PB_URL'],'/api/collections/users/records',superauth['token'],'POST',{'email':identity,'name':f'Maturity load {i}','password':password,'passwordConfirm':password,'role':'user'})
                auth=audit.request(env['PB_URL'],'/api/collections/users/auth-with-password',method='POST',body={'identity':identity,'password':password})
                audit.request(env['PB_URL'],f'/api/fangji/projects/{project["id"]}/members/{user["id"]}',fixture['admin']['token'],'PUT',{'role':'proofreader' if role=='proofreader' else 'manager'})
                audit.request(env['PB_URL'],'/api/fangji/research-notice',auth['token'],'POST',{'choice':'participate'})
                actors.append({'vu':i,'role':role,'token':auth['token']})
        manifest['fixture']=clone_fixture(db,project['id'],args.entries)
        manifest['database_bytes']=db.stat().st_size
        with harness.server(binary,root) as env:
            config={'base':env['PB_URL'],'project':project['id'],'actors':actors,'duration':args.duration,'output':str(args.output),'seed':1701}
            config_path=root/'load.json';config_path.write_text(json.dumps(config));os.chmod(config_path,0o600)
            start=time.monotonic()
            subprocess.run(['node',str(harness.BACKEND/'tests/capacity_scenarios.mjs')],env={**env,'CAPACITY_FIXTURE':str(config_path)},check=True)
            manifest['elapsed_seconds']=time.monotonic()-start
        # Retain redacted server metrics, never the secret temporary fixture.
        safe=[]
        for line in (root/'server.log').read_text().splitlines():
            if line.startswith('{'):
                try:event=json.loads(line)
                except ValueError:continue
                if event.get('event') in ('http_completed','runtime_sample','web_vital'):safe.append(json.dumps(event))
        (args.output/'runtime.jsonl').write_text('\n'.join(safe)+'\n')
        with sqlite3.connect(db) as sql:
            reconciliation={'integrity':sql.execute('PRAGMA integrity_check').fetchone()[0], 'attempts':sql.execute('SELECT COUNT(*) FROM proofreading_attempts WHERE project=?',(project['id'],)).fetchone()[0], 'duplicate_attempts':sql.execute("SELECT COUNT(*) FROM (SELECT page,proofreader,pass_no,kind,COUNT(*) n FROM proofreading_attempts WHERE project=? GROUP BY page,proofreader,pass_no,kind HAVING n>1)",(project['id'],)).fetchone()[0]}
        (args.output/'reconciliation.json').write_text(json.dumps(reconciliation,indent=2))
    manifest['fixture_sha256']=hashlib.sha256(json.dumps(manifest['fixture'],sort_keys=True).encode()).hexdigest()
    (args.output/'manifest.json').write_text(json.dumps(manifest,indent=2))
    (args.output/'report.txt').write_text('HTTP mixed-load probe complete. See summary.json for measured values. Full release acceptance remains pending browser, faults, actual hardware, large PDF, parallel import and slow download gates.\n')
    print(json.dumps({'status':'observed','output':str(args.output),'full_acceptance':False}))


if __name__=='__main__':main()
