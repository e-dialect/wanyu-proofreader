import assert from 'node:assert/strict'
import test from 'node:test'
import { createJobObserverRegistry, jobObserverKey, jobProgress } from '../src/lib/jobObserver.js'

const identity = { authEpoch: 1, userId: 'user', projectId: 'project', kind: 'csv', jobId: 'job' }
const row = (status = 'processing') => ({
  id: 'job',
  project: 'project',
  status,
  total_count: 10,
  processed_count: 2
})
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
function clock() {
  let time = 100,
    next = 0
  const timers = new Map()
  return {
    now: () => time,
    setTimer(fn, delay) {
      const id = ++next
      timers.set(id, { fn, at: time + delay })
      return id
    },
    clearTimer(id) {
      timers.delete(id)
    },
    delay() {
      return timers.size ? Math.min(...[...timers.values()].map((timer) => timer.at - time)) : null
    },
    async advance(ms) {
      time += ms
      for (const [id, timer] of [...timers])
        if (timer.at <= time) {
          timers.delete(id)
          timer.fn()
        }
      await flush()
    }
  }
}

test('two subscribers share one GET and dispose the request/timer after the last subscriber', async () => {
  const time = clock(),
    registry = createJobObserverRegistry(time)
  let calls = 0,
    latest
  const read = async () => {
    calls++
    return row()
  }
  const a = registry.subscribe(identity, { read }, (value) => {
    latest = value
  })
  const b = registry.subscribe(identity, { read }, () => {})
  await flush()
  assert.equal(calls, 1)
  assert.equal(latest.state, 'live')
  assert.equal(time.delay(), 2000)
  a.unsubscribe()
  await time.advance(2000)
  assert.equal(calls, 2)
  b.unsubscribe()
  assert.equal(registry.size, 0)
  assert.equal(time.delay(), null)
  await time.advance(30000)
  assert.equal(calls, 2)
})

test('hidden panels/documents poll at 15 seconds; becoming visible or online reads immediately', async () => {
  const time = clock(),
    registry = createJobObserverRegistry(time)
  let calls = 0
  const sub = registry.subscribe(
    identity,
    {
      read: async () => {
        calls++
        return row()
      }
    },
    () => {}
  )
  await flush()
  sub.setVisible(false)
  assert.equal(time.delay(), 15000)
  await time.advance(14999)
  assert.equal(calls, 1)
  sub.setVisible(true)
  await flush()
  assert.equal(calls, 2)
  registry.setEnvironment({ visible: false })
  assert.equal(time.delay(), 15000)
  registry.setEnvironment({ online: false })
  assert.equal(time.delay(), null)
  await time.advance(30000)
  assert.equal(calls, 2)
  registry.setEnvironment({ online: true })
  await flush()
  assert.equal(calls, 3)
  registry.setEnvironment({ visible: true })
  await flush()
  assert.equal(calls, 4)
  sub.unsubscribe()
})

test('transient failures preserve successful snapshots with bounded 2/4/8/15-second backoff', async () => {
  const time = clock(),
    registry = createJobObserverRegistry(time)
  let fail = false,
    latest
  const sub = registry.subscribe(
    identity,
    {
      read: async () => {
        if (fail) throw Error('network')
        return row()
      }
    },
    (value) => {
      latest = value
    }
  )
  await flush()
  const savedAt = latest.lastSuccessAt
  fail = true
  await sub.retry()
  assert.equal(latest.state, 'stale')
  assert.equal(latest.snapshot.processed_count, 2)
  assert.equal(latest.lastSuccessAt, savedAt)
  for (const expected of [2000, 4000, 8000, 15000, 15000]) {
    assert.equal(time.delay(), expected)
    await time.advance(expected)
  }
  fail = false
  await sub.retry()
  assert.equal(latest.state, 'live')
  assert.equal(latest.error, '')
  assert.equal(time.delay(), 2000)
  sub.unsubscribe()
})

test('401/403 erase snapshots and stop; 404 is unavailable and never switches to the newest job', async () => {
  for (const status of [401, 403, 404]) {
    const time = clock(),
      registry = createJobObserverRegistry(time)
    let latest,
      calls = 0
    const sub = registry.subscribe(
      identity,
      {
        initial: row(),
        read: async () => {
          calls++
          throw { status }
        }
      },
      (value) => {
        latest = value
      }
    )
    await sub.retry()
    assert.equal(latest.state, status === 404 ? 'unavailable' : 'unauthorized')
    assert.equal(latest.snapshot, null)
    assert.equal(latest.lastSuccessAt, null)
    assert.equal(time.delay(), null)
    await sub.retry()
    assert.equal(calls, 1)
    sub.unsubscribe()
  }
})

test('logout, offline and unmount abort outstanding GETs and discard even abort-ignoring responses', async () => {
  for (const action of ['logout', 'offline', 'unmount']) {
    const registry = createJobObserverRegistry(clock())
    let resolve, signal, latest
    const sub = registry.subscribe(
      identity,
      {
        read: (options) => {
          signal = options.signal
          return new Promise((done) => {
            resolve = done
          })
        }
      },
      (value) => {
        latest = value
      }
    )
    await flush()
    if (action === 'logout') registry.invalidate()
    if (action === 'offline') registry.setEnvironment({ online: false })
    if (action === 'unmount') sub.unsubscribe()
    assert.equal(signal.aborted, true)
    resolve(row('completed'))
    await flush()
    assert.equal(latest.snapshot, null)
    if (action === 'logout') assert.equal(latest.state, 'unauthorized')
    if (action === 'offline') assert.equal(latest.state, 'offline')
    sub.unsubscribe()
  }
})

test('CSV validated waits for confirmation; accepted commit restarts observation without replaying the POST', async () => {
  const time = clock(),
    registry = createJobObserverRegistry(time)
  let calls = 0,
    latest
  const sub = registry.subscribe(
    identity,
    {
      initial: row('validated'),
      read: async () => {
        calls++
        return row('completed')
      }
    },
    (value) => {
      latest = value
    }
  )
  await flush()
  assert.equal(calls, 0)
  assert.equal(time.delay(), null)
  sub.seed(row('queued'))
  assert.equal(time.delay(), 2000)
  await time.advance(2000)
  assert.equal(calls, 1)
  assert.equal(latest.snapshot.status, 'completed')
  assert.equal(time.delay(), null)
  sub.unsubscribe()
})

test('identity keys separate sessions, accounts, projects, kinds and exact jobs; wrong responses are rejected', async () => {
  const key = jobObserverKey(identity)
  for (const name of ['authEpoch', 'userId', 'projectId', 'kind', 'jobId'])
    assert.notEqual(jobObserverKey({ ...identity, [name]: 'different' }), key)
  const registry = createJobObserverRegistry(clock())
  let latest
  const sub = registry.subscribe(
    identity,
    { read: async () => ({ ...row(), id: 'newest-job' }) },
    (value) => {
      latest = value
    }
  )
  await flush()
  assert.equal(latest.state, 'stale')
  assert.equal(latest.snapshot, null)
  sub.unsubscribe()
})

test('conversion processed count is never a percentage denominator', () => {
  assert.deepEqual(jobProgress('conversion', { total_count: 90 }), {
    processed: 90,
    total: null,
    percent: null,
    unit: '条'
  })
  assert.deepEqual(jobProgress('ocr', { total_count: 200, processed_count: 50 }), {
    processed: 50,
    total: 200,
    percent: 25,
    unit: '页'
  })
  assert.equal(jobProgress('csv', { total_count: 0 }).percent, null)
})

test('10-second read deadline escapes an abort-ignoring transport and retries without job failure', async () => {
  const time = clock(),
    registry = createJobObserverRegistry(time)
  let finishOld,
    signal,
    latest,
    reads = 0
  const sub = registry.subscribe(
    identity,
    {
      initial: row(),
      read: (options) => {
        reads++
        if (reads > 1) return Promise.resolve({ ...row(), processed_count: 4 })
        signal = options.signal
        return new Promise((resolve) => {
          finishOld = resolve
        })
      }
    },
    (value) => {
      latest = value
    }
  )
  const reading = sub.retry()
  await flush()
  assert.equal(latest.refreshing, true)
  await time.advance(9999)
  assert.equal(signal.aborted, false)
  await time.advance(1)
  await reading
  assert.equal(signal.aborted, true)
  assert.equal(latest.refreshing, false)
  assert.equal(latest.state, 'stale')
  assert.equal(latest.snapshot.status, 'processing')
  assert.equal(latest.snapshot.processed_count, 2)
  assert.equal(time.delay(), 2000)
  await time.advance(2000)
  assert.equal(reads, 2)
  assert.equal(latest.state, 'live')
  assert.equal(latest.snapshot.processed_count, 4)
  finishOld(row('failed'))
  await flush()
  assert.equal(latest.snapshot.status, 'processing')
  assert.equal(latest.snapshot.processed_count, 4)
  sub.unsubscribe()
  assert.equal(time.delay(), null)
})
