import copy
import json
from pathlib import Path
import subprocess
import unittest
from capacity_burst import make_submit_burst, burst_report
from capacity_fixture import phases


def fixture(profile='full', users=30, duration=3600):
    return {'profile': profile, 'start_epoch_ms': 1000000, 'phases': phases(duration),
            'actors': [{'vu': n, 'role': 'proofreader' if n < users - 6 else 'manager',
                        'transport': 'browser' if n < 2 else 'http'} for n in range(users)]}


def successful_evidence(config):
    plan = config['submit_burst']
    requests = [{'vu': p['vu'], 'operation': 'submit', 'status': 200, 'ok': True,
                 'burst_id': plan['id'], 'started_at_ms': plan['at_epoch_ms'] + p['vu']} for p in plan['participants']]
    events = [{'vu': p['vu'], 'transport': p['transport'], 'burst_id': plan['id'],
               'status': 'prepared', 'at_ms': plan['at_epoch_ms'] - 100} for p in plan['participants']]
    return requests, events


class SubmitBurstTest(unittest.TestCase):
    def test_full_forces_24_actors_in_steady_without_a_flag(self):
        config = fixture()
        plan = make_submit_burst(config)
        self.assertEqual(plan['at_epoch_ms'], config['start_epoch_ms'] + 900000)
        self.assertEqual(plan['prepare_window_ms'], 240000)
        self.assertEqual(len(plan['participants']), 24)
        self.assertEqual(sum(p['transport'] == 'browser' for p in plan['participants']), 2)
        with self.assertRaises(ValueError):
            make_submit_burst(fixture(users=10))

    def test_default_smoke_is_unchanged_and_explicit_small_burst_has_two_browsers(self):
        config = fixture('smoke', 10, 60)
        self.assertIsNone(make_submit_burst(config))
        plan = make_submit_burst(config, True)
        self.assertEqual(len(plan['participants']), 4)
        self.assertEqual(sum(p['transport'] == 'browser' for p in plan['participants']), 2)
        self.assertEqual(plan['at_epoch_ms'], 1030000)
        self.assertEqual(plan['prepare_window_ms'], 20000)
        self.assertEqual(burst_report(config, [], [])['status'], 'not_requested')

    def test_exact_once_acknowledged_and_synchronized_passes(self):
        config = fixture(); config['submit_burst'] = make_submit_burst(config)
        requests, events = successful_evidence(config)
        result = burst_report(config, requests, events)
        self.assertEqual(result['status'], 'pass', result)
        self.assertEqual(result['dispatch_span_ms'], 23)

    def test_missing_full_configuration_is_incomplete(self):
        self.assertEqual(burst_report(fixture(), [], [])['status'], 'incomplete')

    def test_negative_gates(self):
        original = fixture(); original['submit_burst'] = make_submit_burst(original)
        for mode in ['missing_actor', 'duplicate_post', 'late', 'early', 'no_start_time', 'failed_post',
                     'not_prepared', 'duplicate_prepare', 'missed', 'wrong_id', 'mismatched_plan', 'wrong_transport']:
            with self.subTest(mode=mode):
                config = copy.deepcopy(original)
                requests, events = successful_evidence(config)
                if mode == 'missing_actor': requests.pop()
                if mode == 'duplicate_post': requests.append(copy.deepcopy(requests[0]))
                if mode == 'late': requests[0]['started_at_ms'] += 251
                if mode == 'early': requests[0]['started_at_ms'] -= 1
                if mode == 'no_start_time': requests[0].pop('started_at_ms')
                if mode == 'failed_post': requests[0].update(status=409, ok=True)
                if mode == 'not_prepared': events.pop()
                if mode == 'duplicate_prepare': events.append(copy.deepcopy(events[0]))
                if mode == 'missed': events.append({**events[0], 'status': 'missed', 'reason': 'late_task'})
                if mode == 'wrong_id': requests[0]['burst_id'] = 'another-burst'
                if mode == 'mismatched_plan': config['submit_burst']['participants'][0]['transport'] = 'http'
                if mode == 'wrong_transport': events[0]['transport'] = 'http'
                self.assertEqual(burst_report(config, requests, events)['status'], 'fail')

    def test_shared_js_barrier_never_tags_a_second_post_or_late_actor(self):
        script = r'''
const assert = require('node:assert/strict')
const { createSubmitBurst } = require('./capacity_burst.cjs')
const actor = {vu:0, transport:'browser'}
const config = {submit_burst:{id:'one',at_epoch_ms:1000,prepare_window_ms:500,max_start_skew_ms:250,participants:[actor]}}
async function run(extra={}, oversleep=0, initial=600) {
 let time=initial, events=[]
 const burst=createSubmitBurst({...config,...extra},actor,{now:()=>time,sleep:async(ms)=>{time+=ms+oversleep},record:e=>events.push(e)})
 await burst.beforeSubmit()
 return {burst,events,time}
}
;(async()=>{
 const good=await run()
 assert.equal(good.time,1000)
 assert.equal(good.burst.claimRequest(),'one')
 assert.equal(good.burst.claimRequest(),null)
 await good.burst.beforeSubmit();good.burst.finalize()
 assert.deepEqual(good.events.map(e=>e.status),['prepared','released'])
 assert.equal((await run({},251)).burst.claimRequest(),null)
 assert.equal((await run({},0,1001)).events[0].reason,'not_prepared_before_epoch')
 const missed=await run({submit_burst_test_fault:{miss_vu:0,expected_fail:true}})
 assert.equal(missed.burst.claimRequest(),null)
 assert.equal(missed.events.at(-1).reason,'injected_missed_participant')
 const early=await run({},0,499); assert.equal(early.events.length,0)
 early.burst.finalize(); assert.equal(early.events[0].status,'missed')
})().catch(e=>{console.error(e);process.exitCode=1})
'''
        subprocess.run(['node', '-e', script], cwd=Path(__file__).parent, check=True)


if __name__ == '__main__':
    unittest.main()
