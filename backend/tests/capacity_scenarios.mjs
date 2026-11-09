// Disposable runner only. No credentials or material values are written to reports.
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import assert from 'node:assert/strict'
import { phaseAt, randomFor, sleep } from './capacity_profile.mjs'
import { createHash } from 'node:crypto'
import submissionHelpers from './capacity_submission.cjs'
const { submissionEvidence } = submissionHelpers
import burstHelpers from './capacity_burst.cjs'
const { createSubmitBurst } = burstHelpers
const fixture = JSON.parse(readFileSync(process.env.CAPACITY_FIXTURE, 'utf8'))
const { base, project, actors, duration, output, seed } = fixture
assert.equal(fixture.disposable, true)
assert.equal(actors.filter((actor) => actor.transport === 'browser').length, 2)
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/)
const samples = []
const bursts = new Map(
  actors
    .filter((actor) => actor.role === 'proofreader' && actor.transport === 'http')
    .map((actor) => [
      actor.vu,
      createSubmitBurst(fixture, actor, {
        record: (event) =>
          appendFileSync(output + '/burst-events.jsonl', JSON.stringify(event) + '\n')
      })
    ])
)
const endAt = fixture.start_epoch_ms + duration * 1000
const startedCpu = process.cpuUsage(),
  generatorStarted = performance.now()
const active = (actor) => actor.vu < phaseAt(fixture).active
const remaining = () => Math.max(0, endAt - Date.now())
const delay = monitorEventLoopDelay({ resolution: 10 })
delay.enable()
async function request(
  actor,
  operation,
  path,
  { method = 'GET', body, allowed = [200], binary = false } = {}
) {
  const start = performance.now()
  let status = 0,
    ok = false
  const form = body instanceof FormData
  const wireBody = body ? (form ? body : JSON.stringify(body)) : undefined
  const startedAt = Date.now()
  const burstId = operation === 'submit' ? bursts.get(actor.vu)?.claimRequest() : null
  try {
    const response = await fetch(base + path, {
      method,
      headers: {
        Authorization: actor.token,
        ...(body && !form ? { 'Content-Type': 'application/json' } : {})
      },
      body: wireBody,
      signal: AbortSignal.timeout(30000)
    })
    status = response.status
    let value
    if (binary) {
      let bytes = 0
      for await (const chunk of response.body) bytes += chunk.length
      value = { bytes }
    } else value = await response.json().catch(() => null)
    if (!allowed.includes(status)) {
      appendFileSync(
        output + '/http-errors-controlled.jsonl',
        JSON.stringify({
          operation,
          status,
          code: value?.code ?? null,
          message: value?.message ?? null,
          note: 'local synthetic error diagnosis only; no request body or authorization retained'
        }) + '\n'
      )
      console.error('capacity_operation_refused', operation, status)
      throw Error(`unexpected_status_${status}`)
    }
    ok = true
    return status === 409 ? null : value
  } finally {
    const record = {
      vu: actor.vu,
      operation,
      ...(fixture.submit_burst ? { started_at_ms: startedAt } : {}),
      ...(burstId ? { burst_id: burstId } : {}),
      phase: phaseAt(fixture).name,
      at_ms: Date.now(),
      status,
      ok,
      duration_ms: performance.now() - start
    }
    if (operation === 'submit' && ok && status >= 200 && status < 300) {
      try {
        record.submission = submissionEvidence(path, actor.record.id, JSON.parse(wireBody))
      } catch {
        // A missing digest fails reconciliation; never retain the body to diagnose it.
        record.submission_evidence_error = 'invalid_submission_evidence'
      }
    }
    samples.push(record)
    appendFileSync(output + '/requests.jsonl', JSON.stringify(record) + '\n')
  }
}
async function proofreader(actor) {
  let count = 0
  const random = randomFor(seed, actor.vu)
  while (remaining() > 0) {
    if (!active(actor)) {
      await sleep(100)
      continue
    }
    try {
      const claim = await request(actor, 'claim', `/api/fangji/projects/${project}/claim`, {
        method: 'POST',
        allowed: [200, 204, 404, 409]
      })
      if (!claim?.id) {
        await sleep(1000)
        continue
      }
      const task = await request(actor, 'task', `/api/fangji/pages/${claim.id}/task`)
      await request(actor, 'pdf_descriptor', `/api/fangji/pages/${claim.id}/pdf/descriptor`)
      await request(actor, 'pdf_read', `/api/fangji/pages/${claim.id}/pdf`, { binary: true })
      const verification = await request(
        actor,
        'verification',
        `/api/fangji/pages/${claim.id}/verification`
      )
      const row = JSON.parse(task.ocr_row_json || claim.ocr_row_json || '{}')
      const think =
        fixture.profile === 'smoke'
          ? 3000
          : random() < 0.2
            ? 120000 + random() * 60000
            : 30000 + random() * 30000
      await sleep(Math.min(think, remaining()))
      if (!remaining()) break
      if (think >= 120000)
        await request(actor, 'renew', `/api/fangji/pages/${claim.id}/lease/renew`, {
          method: 'POST',
          body: { leaseToken: claim.leaseToken }
        })
      if (fixture.submit_burst) await bursts.get(actor.vu).beforeSubmit()
      await request(actor, 'submit', `/api/fangji/pages/${claim.id}/submit`, {
        method: 'POST',
        body: {
          rowJson: JSON.stringify(row),
          leaseToken: claim.leaseToken,
          sourceChecked: true,
          basis: verification.context.basis
        }
      })
      if (++count % 5 === 0) await request(actor, 'hall', '/api/fangji/proofreading-queues')
    } catch (error) {
      appendFileSync(
        output + '/failures.jsonl',
        JSON.stringify({
          vu: actor.vu,
          error: String(error.message)
            .replace(/[^A-Za-z0-9_]/g, '')
            .slice(0, 80)
        }) + '\n'
      )
      await sleep(500)
    }
  }
  bursts.get(actor.vu).finalize()
}
async function manager(actor) {
  let count = 0
  const random = randomFor(seed, actor.vu)
  while (remaining() > 0) {
    if (!active(actor)) {
      await sleep(100)
      continue
    }
    try {
      const list = await request(
        actor,
        'admin_pages',
        `/api/fangji/projects/${project}/pages?perPage=25&page=1${actor.role === 'arbitrator' ? '&status=arbitration' : ''}`
      )
      if (actor.role === 'arbitrator' && list.items?.length) {
        const page = list.items[(actor.vu + count) % list.items.length]
        const item = await request(
          actor,
          'arbitration_read',
          `/api/fangji/pages/${page.id}/arbitration`,
          { allowed: [200, 409] }
        )
        if (item?.attempts?.length) {
          const first = item.attempts[0],
            row = JSON.parse(first.row_json)
          const view = await request(
            actor,
            'verification',
            `/api/fangji/pages/${page.id}/verification`
          )
          const selections = Object.fromEntries(
            Object.keys(row).map((field) => [field, 'attempt:' + first.id])
          )
          const judgments = Object.keys(row).flatMap((field) => [
            ...item.attempts.map((a) => ({
              attempt: a.id,
              field,
              state: JSON.parse(a.row_json)[field] === row[field] ? 'correct' : 'incorrect',
              reason: 'Synthetic capacity fixture',
              location: 'Synthetic source'
            })),
            {
              attempt: 'final',
              field,
              state: 'correct',
              reason: 'Synthetic capacity fixture',
              location: 'Synthetic source'
            }
          ])
          await request(actor, 'arbitrate', `/api/fangji/pages/${page.id}/arbitrate`, {
            method: 'POST',
            body: {
              rowJson: JSON.stringify(row),
              sourceChecked: true,
              selections,
              judgments,
              basis: view.context.basis
            },
            allowed: [200, 409]
          })
        }
      } else {
        await request(actor, 'field_summary', `/api/fangji/projects/${project}/field-error-summary`)
        count++
      }
    } catch {
      appendFileSync(
        output + '/failures.jsonl',
        JSON.stringify({ vu: actor.vu, error: 'manager_operation_failed' }) + '\n'
      )
    }
    await sleep(
      Math.min(
        fixture.profile === 'smoke'
          ? 500
          : actor.role === 'arbitrator'
            ? 45000 + random() * 30000
            : 30000,
        remaining()
      )
    )
  }
}
async function background() {
  const actor = actors.at(-1)
  while (remaining() && phaseAt(fixture).name !== 'steady') await sleep(50)
  if (!remaining()) return
  const result = { csv: { status: 'not_run' }, slow_export: { status: 'not_run' } }
  await Promise.all([
    (async () => {
      try {
        const body = new FormData()
        const rows = [
          'PDF页码,词条,记音',
          ...Array.from(
            { length: fixture.parallel_import_rows },
            (_, i) => `1,虚构并发条目${i},ia̤̍h`
          )
        ]
        body.set(
          'file',
          new Blob([rows.join('\n')], { type: 'text/csv' }),
          'synthetic-parallel.csv'
        )
        const job = await request(
          actor,
          'parallel_import',
          `/api/fangji/projects/${fixture.secondary_project}/imports/csv`,
          { method: 'POST', body, allowed: [202] }
        )
        const deadline = Date.now() + Math.max(30000, remaining())
        let current
        do {
          current = await request(
            actor,
            'parallel_import_status',
            `/api/collections/import_jobs/records/${job.id}`
          )
          if (['completed', 'completed_with_errors', 'failed'].includes(current.status)) break
          await sleep(500)
        } while (Date.now() < deadline)
        result.csv = {
          status:
            current.status === 'completed' && current.success_count === fixture.parallel_import_rows
              ? 'pass'
              : 'fail',
          expected: fixture.parallel_import_rows,
          imported: current.success_count,
          failed: current.failed_count
        }
      } catch {
        result.csv = { status: 'fail', reason: 'parallel_import_failed' }
      }
    })(),
    (async () => {
      const started = performance.now()
      let bytes = 0
      try {
        const response = await fetch(base + `/api/fangji/projects/${project}/export?format=csv`, {
          headers: { Authorization: actor.token },
          signal: AbortSignal.timeout(Math.max(120000, duration * 1000))
        })
        assert.equal(response.status, 200)
        const digest = createHash('sha256'),
          reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          digest.update(value)
          await sleep((bytes / (1024 * 1024)) * 1000 - (performance.now() - started))
        }
        const elapsed = performance.now() - started
        result.slow_export = {
          status: bytes > 0 && (bytes / elapsed) * 1000 <= 1024 * 1024 * 1.03 ? 'pass' : 'fail',
          bytes,
          elapsed_ms: elapsed,
          bytes_per_second: (bytes / elapsed) * 1000,
          limit_bytes_per_second: 1024 * 1024,
          sha256: digest.digest('hex'),
          method: 'stream reader paced at 1 MiB/s; no material retained'
        }
      } catch {
        result.slow_export = { status: 'fail', bytes, reason: 'slow_export_failed' }
      }
    })()
  ])
  writeFileSync(output + '/background.json', JSON.stringify(result, null, 2))
}
await sleep(fixture.start_epoch_ms - Date.now())
await Promise.all([
  ...actors
    .filter((actor) => actor.transport !== 'browser')
    .map((actor) => (actor.role === 'proofreader' ? proofreader(actor) : manager(actor))),
  background()
])
delay.disable()
const thresholds = {
  claim: 800,
  submit: 800,
  arbitrate: 800,
  field_summary: 1000,
  pdf_descriptor: 500,
  task: 500,
  admin_pages: 500,
  verification: 500
}
const operations = [...new Set(samples.map((s) => s.operation))].map((operation) => {
  const rows = samples.filter((s) => s.operation === operation),
    v = rows
      .filter((s) => s.ok && s.status >= 200 && s.status < 300)
      .map((s) => s.duration_ms)
      .sort((a, b) => a - b)
  const percentile = (p) => v[Math.ceil(p * v.length) - 1]
  return {
    operation,
    samples: v.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    unexpected: rows.filter((r) => !r.ok).length,
    expected_conflicts: rows.filter((r) => r.ok && r.status === 409).length,
    threshold_pass: !(operation in thresholds) || percentile(0.95) <= thresholds[operation]
  }
})
const generatorP95 = delay.percentile(95) / 1e6
writeFileSync(
  output + '/summary.json',
  JSON.stringify(
    {
      status: generatorP95 > 20 ? 'invalid_generator_saturated' : 'observed',
      duration,
      virtual_users: actors.length,
      seed,
      operations,
      generator_event_loop_p95_ms: generatorP95,
      generator_cpu_percent_one_core:
        (process.cpuUsage(startedCpu).user + process.cpuUsage(startedCpu).system) /
        ((performance.now() - generatorStarted) * 10),
      acceptance_profile: duration >= 3600 ? 'full' : 'smoke',
      limitations: [
        'Fixture setup is not measured import throughput; browser and aggregate acceptance are reported separately.'
      ]
    },
    null,
    2
  )
)
