// Disposable runner only. No credentials or material values are written to reports.
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import assert from 'node:assert/strict'
const fixture = JSON.parse(readFileSync(process.env.CAPACITY_FIXTURE, 'utf8'))
const { base, project, actors, duration, output, seed } = fixture
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let randomState = seed >>> 0
const random = () => ((randomState = (1664525 * randomState + 1013904223) >>> 0) / 4294967296)
const samples = [], endAt = performance.now() + duration * 1000
const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable()
async function request(actor, operation, path, { method = 'GET', body, allowed = [200], binary = false } = {}) {
  const start = performance.now()
  let status = 0, ok = false
  try {
    const form = body instanceof FormData
    const response = await fetch(base + path, { method, headers: { Authorization: actor.token, ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: body ? (form ? body : JSON.stringify(body)) : undefined, signal: AbortSignal.timeout(30000) })
    status = response.status
    const value = binary ? await response.arrayBuffer() : await response.json().catch(() => null)
    if (!allowed.includes(status)) throw Error(`unexpected_status_${status}`)
    ok = true
    return value
  } finally {
    const record = { vu: actor.vu, operation, status, ok, duration_ms: performance.now() - start }
    samples.push(record); appendFileSync(output + '/requests.jsonl', JSON.stringify(record) + '\n')
  }
}
async function proofreader(actor) {
  let count = 0
  while (performance.now() < endAt) {
    try {
      const claim = await request(actor, 'claim', `/api/fangji/projects/${project}/claim`, { method: 'POST', allowed: [200, 204, 404, 409] })
      if (!claim?.id) { await sleep(1000); continue }
      const task = await request(actor, 'task', `/api/fangji/pages/${claim.id}/task`)
      await request(actor, 'pdf_descriptor', `/api/fangji/pages/${claim.id}/pdf/descriptor`)
      await request(actor, 'pdf_read', `/api/fangji/pages/${claim.id}/pdf`, { binary: true })
      const verification = await request(actor, 'verification', `/api/fangji/pages/${claim.id}/verification`)
      const row = JSON.parse(task.ocr_row_json || claim.ocr_row_json || '{}')
      const think = duration < 180 ? 100 : (random() < .2 ? 120000 + random()*60000 : 30000 + random()*30000)
      await sleep(Math.min(think, Math.max(0,endAt-performance.now())))
      if (performance.now() >= endAt) break
      if (think >= 120000) await request(actor,'renew',`/api/fangji/pages/${claim.id}/lease/renew`,{method:'POST',body:{leaseToken:claim.leaseToken}})
      await request(actor, 'submit', `/api/fangji/pages/${claim.id}/submit`, { method: 'POST', body: { rowJson: JSON.stringify(row), leaseToken: claim.leaseToken, sourceChecked: true, basis: verification.context.basis } })
      if (++count % 5 === 0) await request(actor, 'hall', '/api/fangji/proofreading-queues')
    } catch (error) { appendFileSync(output+'/failures.jsonl',JSON.stringify({vu:actor.vu,error:String(error.message).replace(/[^A-Za-z0-9_]/g,'').slice(0,80)})+'\n'); await sleep(500) }
  }
}
async function manager(actor) {
  let count = 0
  while (performance.now() < endAt) {
    try {
      const list = await request(actor,'admin_pages',`/api/fangji/projects/${project}/pages?perPage=25&page=1${actor.role==='arbitrator'?'&status=arbitration':''}`)
      if (actor.role === 'arbitrator' && list.items?.length) {
        const page = list.items[(actor.vu + count) % list.items.length]
        const item = await request(actor,'arbitration_read',`/api/fangji/pages/${page.id}/arbitration`)
        if (item.attempts?.length) {
          const first = item.attempts[0], row = JSON.parse(first.row_json)
          const view = await request(actor,'verification',`/api/fangji/pages/${page.id}/verification`)
          const selections = Object.fromEntries(Object.keys(row).map((field)=>[field,'attempt:'+first.id]))
          const judgments = Object.keys(row).flatMap((field)=>[...item.attempts.map((a)=>({attempt:a.id,field,state:JSON.parse(a.row_json)[field]===row[field]?'correct':'incorrect',reason:'Synthetic capacity fixture',location:'Synthetic source'})),{attempt:'final',field,state:'correct',reason:'Synthetic capacity fixture',location:'Synthetic source'}])
          await request(actor,'arbitrate',`/api/fangji/pages/${page.id}/arbitrate`,{method:'POST',body:{rowJson:JSON.stringify(row),selections,judgments,basis:view.context.basis},allowed:[200,409]})
        }
      } else {
        await request(actor,'field_summary',`/api/fangji/projects/${project}/field-error-summary`)
        if (++count===2 && actor.vu===actors.at(-1).vu) await request(actor,'export',`/api/fangji/projects/${project}/export?format=csv`,{binary:true})
      }
    } catch { appendFileSync(output+'/failures.jsonl',JSON.stringify({vu:actor.vu,error:'manager_operation_failed'})+'\n') }
    await sleep(Math.min(duration<180?500:actor.role==='arbitrator'?45000+random()*30000:30000,Math.max(0,endAt-performance.now())))
  }
}
await Promise.all(actors.map(async (actor,index)=>{await sleep(duration<180?index*20:index*1000); return actor.role==='proofreader'?proofreader(actor):manager(actor)}))
delay.disable()
const thresholds = { claim:800,submit:800,arbitrate:800,field_summary:1000,pdf_descriptor:500,task:500,admin_pages:500,verification:500 }
const operations = [...new Set(samples.map((s)=>s.operation))].map((operation)=>{const rows=samples.filter((s)=>s.operation===operation),v=rows.map((s)=>s.duration_ms).sort((a,b)=>a-b);const percentile=(p)=>v[Math.ceil(p*v.length)-1];return {operation,samples:v.length,p50:percentile(.5),p95:percentile(.95),p99:percentile(.99),unexpected:rows.filter((r)=>!r.ok).length,threshold_pass:!(operation in thresholds)||percentile(.95)<=thresholds[operation]}})
const generatorP95 = delay.percentile(95)/1e6
writeFileSync(output+'/summary.json',JSON.stringify({status:generatorP95>20?'invalid_generator_saturated':'observed',duration,virtual_users:actors.length,seed,operations,generator_event_loop_p95_ms:generatorP95,acceptance_profile:duration>=3600?'full':'smoke',limitations:['Browser visible timing, slow download, parallel import and fault cases require acceptance runner; HTTP smoke does not certify them.']},null,2))
