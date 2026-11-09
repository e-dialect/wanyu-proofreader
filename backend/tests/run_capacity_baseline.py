#!/usr/bin/env python3
"""Disposable mixed-load protocol probe. Never accepts production URL/data-dir."""
import argparse
from contextlib import closing
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
import capacity_fixture as fixture_helpers
import capacity_report
from capacity_burst import make_submit_burst
from capacity_reconciliation import snapshot_actor_records, reconcile_submissions
from capacity_resources import ResourceSampler
from capacity_remote_contract import valid_fault_evidence


def clone_fixture(db, project, entries, pdf_file=None):
    """Clone actual workflow templates offline, preserving attempt/event references."""
    with closing(sqlite3.connect(db)) as sql, sql:
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
            if pdf_file is not None:
                record['project_file']=pdf_file
                record['pdf_page']=index % 200 + 1
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


def snapshot_counts(db, project):
    with closing(sqlite3.connect(db)) as sql:
        return {
            'proofreads': sql.execute("SELECT COUNT(*) FROM proofreading_attempts WHERE project=? AND kind='proofread'", (project,)).fetchone()[0],
            'submissions': sql.execute("SELECT COUNT(*) FROM verification_events WHERE project=? AND kind='submission'", (project,)).fetchone()[0]
        }


def prepare_fixture(binary, root, args):
    fixture_file=root/'fixture.json'; db=root/'data/data.db'
    with harness.server(binary,root,extra_env={'FIDELITY_BROWSER_FIXTURE':str(fixture_file)}) as env:
        subprocess.run(['node',str(harness.BACKEND/'tests/source_fidelity_integration.mjs')],env=harness.with_research_notice_preload(env),check=True,stdout=subprocess.DEVNULL)
        fixture=json.loads(fixture_file.read_text())
        superauth=audit.request(env['PB_URL'],'/api/collections/_superusers/auth-with-password',method='POST',body={'identity':env['PB_SUPER_EMAIL'],'password':env['PB_SUPER_PASSWORD']})
        fixture['super_token']=superauth['token']
        storage_gate,project,_=audit.rollback_probe(env,db,fixture)
        pdf_meta=fixture_helpers.synthetic_pdf(root/'synthetic-capacity.pdf')
        source=fixture_helpers.upload_pdf(env['PB_URL'], project['id'], fixture['admin']['token'], root/'synthetic-capacity.pdf')
        audit.request(env['PB_URL'],f'/api/fangji/projects/{project["id"]}/verification-policy',fixture['admin']['token'],'POST',{'instructions':'Synthetic capacity source policy', 'reading_fields':['字段1'], 'tone_equivalence':False, 'reason':'Approve the newly uploaded 200-page synthetic source'},(201,))
        secondary=audit.request(env['PB_URL'],'/api/fangji/projects',fixture['admin']['token'],'POST',{'name':'SYNTHETIC parallel import'},(201,))
        actors=[]
        for i in range(args.users):
            role='proofreader' if i<args.users-6 else 'arbitrator' if i<args.users-2 else 'manager'
            identity=f'maturity-load-{i}@example.com'; password='SyntheticMaturity123!'
            user=audit.request(env['PB_URL'],'/api/collections/users/records',superauth['token'],'POST',{'email':identity,'name':f'Maturity load {i}','password':password,'passwordConfirm':password,'role':'user'})
            auth=audit.request(env['PB_URL'],'/api/collections/users/auth-with-password',method='POST',body={'identity':identity,'password':password})
            audit.request(env['PB_URL'],f'/api/fangji/projects/{project["id"]}/members/{user["id"]}',fixture['admin']['token'],'PUT',{'role':'proofreader' if role=='proofreader' else 'manager'})
            if role=='manager':
                audit.request(env['PB_URL'],f'/api/fangji/projects/{secondary["id"]}/members/{user["id"]}',fixture['admin']['token'],'PUT',{'role':'manager'})
            audit.request(env['PB_URL'],'/api/fangji/research-notice',auth['token'],'POST',{'choice':'participate'})
            actors.append({'vu':i,'role':role,'transport':'browser' if i<2 else 'http','token':auth['token'],'record':auth['record']})
    fixture_meta=clone_fixture(db,project['id'],args.entries,source['id'])
    before=snapshot_counts(db, project['id'])
    actor_ids=tuple(actor['record']['id'] for actor in actors)
    actor_baseline=snapshot_actor_records(db, actor_ids)
    return {"fixture_meta":fixture_meta,"pdf_meta":pdf_meta,"storage_gate":storage_gate,"project":project,"secondary":secondary,"actors":actors,"before":before,"actor_ids":actor_ids,"actor_baseline":actor_baseline}


def reconcile_fixture(root, state, config, http):
    db=root/"data/data.db"
    project,secondary,before,actor_ids,actor_baseline=(state[key] for key in ("project","secondary","before","actor_ids","actor_baseline"))
    after=snapshot_counts(db, project['id'])
    acknowledged=sum(r['operation']=='submit' and r.get('status')==200 and r.get('ok') for r in http)
    with closing(sqlite3.connect(db)) as sql:
        reconciliation={'integrity':sql.execute('PRAGMA integrity_check').fetchone()[0],
            'duplicate_attempts':sql.execute("SELECT COUNT(*) FROM (SELECT page,proofreader,pass_no,kind,COUNT(*) n FROM proofreading_attempts WHERE project=? GROUP BY page,proofreader,pass_no,kind HAVING n>1)",(project['id'],)).fetchone()[0],
            'before':before,'after':after,'acknowledged_submissions':acknowledged,
            'expected_parallel_rows':config['parallel_import_rows'],
            'actual_parallel_rows':sql.execute('SELECT COUNT(*) FROM pages WHERE project=?',(secondary['id'],)).fetchone()[0]}
    reconciliation['submission_evidence']=reconcile_submissions(db, project['id'], actor_ids, actor_baseline, http)
    reconciliation['pass']=(reconciliation['submission_evidence']['pass'] and reconciliation['integrity']=='ok' and reconciliation['duplicate_attempts']==0 and
        after['proofreads']-before['proofreads']==acknowledged==after['submissions']-before['submissions'] and
        reconciliation['actual_parallel_rows']==reconciliation['expected_parallel_rows'])
    return reconciliation


def run_once(binary, root, args, output, repeat):
    state=prepare_fixture(binary,root,args)
    db=root/"data/data.db"
    project,secondary,actors=(state[key] for key in ("project","secondary","actors"))
    fixture_meta,pdf_meta,storage_gate=(state[key] for key in ("fixture_meta","pdf_meta","storage_gate"))
    with harness.server(binary,root) as env:
        config={'disposable':True,'base':env['PB_URL'],'project':project['id'],'secondary_project':secondary['id'],
                'actors':actors,'duration':args.duration,'profile':args.profile,'phases':fixture_helpers.phases(args.duration),
                'start_epoch_ms':int(time.time()*1000)+3000,'output':str(output),'seed':1701,
                'parallel_import_rows':200 if args.profile=='smoke' else 2000}
        config['submit_burst']=make_submit_burst(config, args.submit_burst)
        if args.burst_miss_vu is not None:
            config['submit_burst_test_fault']={'miss_vu':args.burst_miss_vu,'expected_fail':True}
        config_path=root/'load.json';config_path.write_text(json.dumps(config));os.chmod(config_path,0o600)
        sampler=ResourceSampler(env['PB_TEST_SERVER_PID'],root,config)
        sampler.start()
        resources=None
        processes=[]
        for script in ('capacity_scenarios.mjs','capacity_browser.cjs'):
            processes.append(subprocess.Popen(['node',str(harness.BACKEND/'tests'/script)],env={**env,'CAPACITY_FIXTURE':str(config_path)},stdout=subprocess.DEVNULL))
        codes=[]
        try:
            for process in processes:
                try: codes.append(process.wait(timeout=args.duration+120))
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(); codes.append(124)
        finally:
            for process in processes:
                if process.poll() is None: process.terminate(); process.wait(timeout=10)
            resources=sampler.stop()
    http=capacity_report.lines(output/'requests.jsonl')+capacity_report.lines(output/'browser-http.jsonl')
    reconciliation=reconcile_fixture(root,state,config,http)
    (output/'reconciliation.json').write_text(json.dumps(reconciliation,indent=2))
    safe=[]
    for line in (root/'server.log').read_text().splitlines():
        if line.startswith('{'):
            try: event=json.loads(line)
            except ValueError: continue
            if event.get('event') in ('http_completed','runtime_sample','web_vital'): safe.append(json.dumps(event))
    (output/'runtime.jsonl').write_text('\n'.join(safe)+'\n')
    report=capacity_report.summarize(output, config, reconciliation, codes)
    report.update({'resources':resources,'fixture':fixture_meta,'pdf':pdf_meta,'storage_rollback_gate':storage_gate,
                   'database_bytes':db.stat().st_size,'repeat':repeat,'duration':args.duration,
                   'users':args.users,'browser_users':2,'phases':config['phases'],
                   'submit_burst_plan':config['submit_burst'],'submit_burst_test_fault':config.get('submit_burst_test_fault')})
    (output/'acceptance.json').write_text(json.dumps(report,indent=2))
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile',choices=['smoke','full'],default='smoke')
    parser.add_argument('--entries',type=int)
    parser.add_argument('--duration',type=int)
    parser.add_argument('--users',type=int,default=30)
    parser.add_argument('--repeats',type=int)
    parser.add_argument('--fault-report',type=Path)
    parser.add_argument('--submit-burst',action='store_true',help='one synchronized submit per proofreader (mandatory for full)')
    parser.add_argument('--burst-miss-vu',type=int,help='smoke-only missed-participant fault; expected fail, never a product pass')
    parser.add_argument('--reference-profile',choices=['production_shared','8g_comparison'],default='production_shared')
    parser.add_argument('--target-cpus',type=int,default=4)
    parser.add_argument('--target-memory-gib',type=float)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    args.target_memory_gib=args.target_memory_gib or (3.7 if args.reference_profile=='production_shared' else 8.0)
    if args.target_cpus<1 or args.target_memory_gib<=0: parser.error('target hardware values must be positive')
    args.entries=args.entries or (20000 if args.profile=='full' else 2000)
    args.duration=args.duration or (3600 if args.profile=='full' else 45)
    args.repeats=args.repeats or (3 if args.profile=='full' else 1)
    if not 20<=args.entries<=20000 or not 8<=args.users<=30 or args.duration<12 or not 1<=args.repeats<=3:
        parser.error('entries 20..20000, users 8..30, duration >=12, repeats 1..3')
    if args.profile=='full' and (args.duration!=3600 or args.users!=30 or args.entries!=20000 or args.repeats!=3):
        parser.error('full profile is frozen at 20,000 entries / 30 actors / 3 x 3,600 seconds')
    if args.burst_miss_vu is not None and (args.profile!='smoke' or not args.submit_burst or not 0<=args.burst_miss_vu<args.users-6):
        parser.error('--burst-miss-vu requires smoke --submit-burst and a proofreader VU')
    args.output=args.output.resolve()
    if args.output.exists() and any(args.output.iterdir()): parser.error('output must be empty; never append a repeat to previous evidence')
    args.output.mkdir(parents=True,exist_ok=True)
    subprocess.run(['npm','run','build'],cwd=harness.BACKEND.parent/'frontend',check=True,stdout=subprocess.DEVNULL)
    manifest={**fixture_helpers.source_manifest(harness.BACKEND),'hardware':fixture_helpers.hardware(),
              'profile':args.profile,'synthetic':True,'seed':1701,'entries':args.entries,'users':args.users,
              'browser_users':2,'duration':args.duration,'repeats':args.repeats,'phases':fixture_helpers.phases(args.duration)}
    manifest['submit_burst_enabled']=args.profile=='full' or args.submit_burst
    manifest['submit_burst_test_fault']={'miss_vu':args.burst_miss_vu,'expected_fail':True} if args.burst_miss_vu is not None else None
    manifest['target_hardware']={'reference_profile':args.reference_profile,'cpu_cores':args.target_cpus,'memory_gib':args.target_memory_gib,'production_is_shared':args.reference_profile=='production_shared'}
    manifest['runtime_environment']={
        'GOMAXPROCS':os.environ.get('GOMAXPROCS'),
        'GOMEMLIMIT':os.environ.get('GOMEMLIMIT'),
        'constraint_type':'Go runtime soft budgets only; this local runner does not install container CPU or memory limits'
    }
    manifest['workload_timing_assumptions']={'measured_human_timing':False,'full':{'proofreader_seconds':[30,60],'long_think_probability':.2,'long_think_seconds':[120,180],'manager_refresh_seconds':30,'arbitrator_seconds':[45,75]},'smoke':{'http_proofreader_think_ms':3000,'browser_think_ms':150,'manager_arbitrator_refresh_ms':500},'note':'Synthetic pacing assumptions; smoke intentionally accelerates interaction and refresh frequency. Neither is a measured real-user rhythm.'}
    manifest['actual_target_envelope_match']=(manifest['hardware']['effective_cpu_cores']==args.target_cpus and abs(manifest['hardware']['effective_memory_bytes']/1024**3-args.target_memory_gib)<.15)
    dist=harness.BACKEND.parent/'frontend/dist'
    manifest['frontend_dist_sha256']=hashlib.sha256(b''.join(str(p.relative_to(dist)).encode()+hashlib.sha256(p.read_bytes()).digest() for p in sorted(dist.rglob('*')) if p.is_file())).hexdigest()
    manifest['status']='running'
    (args.output/'manifest.json').write_text(json.dumps(manifest,indent=2))
    results=[]
    with harness.temporary_root() as build:
        binary=harness.build_binary(build/'pocketbase', build_sha=manifest['baseline_sha'])
        manifest['binary_sha256']=hashlib.sha256(binary.read_bytes()).hexdigest()
        for repeat in range(args.repeats):
            output=args.output/f'run-{repeat+1}';output.mkdir()
            with harness.temporary_root() as root:
                results.append(run_once(binary,root,args,output,repeat+1))
    faults=json.loads(args.fault_report.read_text()) if args.fault_report else None
    faults_valid=valid_fault_evidence(faults, manifest)
    gates={'mixed_runs': 'pass' if all(r['status']=='pass' for r in results) else
           'invalid_generator' if any(r['status']=='invalid_generator' for r in results) else
           'fail' if any(r['status']=='fail' for r in results) else 'incomplete',
           'three_full_repeats': 'pass' if args.profile=='full' else 'incomplete',
           'reference_hardware': 'pass' if manifest['actual_target_envelope_match'] and manifest['hardware']['storage_medium_verified'] else 'incomplete',
           'formal_reference_profile': 'pass' if args.reference_profile=='production_shared' and args.target_cpus==4 and args.target_memory_gib==3.7 else 'incomplete',
           'fifteen_minute_faults': 'pass' if faults_valid else 'incomplete'}
    gates.update({
        'production_runtime': 'fail' if any(r['resources']['production_runtime_status']=='fail' for r in results) else 'pass' if all(r['resources']['production_runtime_status']=='pass' for r in results) else 'incomplete',
        'resource_sampling':'pass' if all(r['resources']['sampling_status']=='pass' for r in results) else 'incomplete',
        'resource_budget':'incomplete', 'cooldown_recovery':'incomplete', 'separate_generator_host':'incomplete'})
    manifest['separate_generator_host']=False
    manifest['formal_capacity_limitation']='Local engineering rehearsal: server and generators share a host; resource/recovery budgets and separate-host execution evidence remain required.'
    finished_source=fixture_helpers.source_manifest(harness.BACKEND)
    source_unchanged=all(finished_source[key]==manifest[key] for key in ('baseline_sha','dirty_diff_sha256','source_sha256'))
    gates['source_unchanged']='pass' if source_unchanged else 'incomplete'
    full_pass=all(value=='pass' for value in gates.values())
    status=gates['mixed_runs']
    if status=='pass' and ((args.profile=='full' and not full_pass) or not source_unchanged): status='incomplete'
    manifest.update({'status':status,'full_acceptance':full_pass,'gates':gates,
                     'full_run_pending':not full_pass,'fault_report_supplied':bool(faults)})
    (args.output/'manifest.json').write_text(json.dumps(manifest,indent=2))
    (args.output/'report.txt').write_text(f"{args.profile} status: {status}; full acceptance: {full_pass}. See per-run acceptance.json for observed thresholds and missing gates.\n")
    print(json.dumps({'status':status,'output':str(args.output),'full_acceptance':full_pass}))
    return {'pass':0,'fail':1,'incomplete':2,'invalid_generator':3}[status]


if __name__=='__main__':raise SystemExit(main())
