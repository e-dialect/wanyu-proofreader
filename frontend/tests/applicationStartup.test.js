import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplicationStartup } from '../src/lib/applicationStartup.js'

function deferred() {
  let resolve
  const promise = new Promise((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

test('startup shows pending before refresh, deduplicates retries and mounts once', async () => {
  const refresh = deferred()
  const states = []
  let mounts = 0
  const startup = createApplicationStartup({
    refresh: () => {
      assert.deepEqual(states, ['pending'])
      return refresh.promise
    },
    mount: () => mounts++,
    onState: ({ state }) => states.push(state)
  })
  const first = startup.start()
  assert.equal(startup.start(), first)
  await Promise.resolve()
  assert.equal(mounts, 0)
  refresh.resolve()
  assert.equal(await first, true)
  assert.equal(await startup.start(), true)
  assert.equal(mounts, 1)
  assert.deepEqual(states, ['pending', 'ready'])
})

test('startup failures retain a retry and do not mount protected views', async () => {
  const states = []
  let requests = 0
  let mounts = 0
  const startup = createApplicationStartup({
    refresh: () => {
      if (++requests === 1) throw new TypeError('synthetic connection failure')
    },
    mount: () => mounts++,
    onState: ({ state }) => states.push(state)
  })
  assert.equal(await startup.start(), false)
  assert.equal(mounts, 0)
  assert.equal(await startup.start(), true)
  assert.equal(mounts, 1)
  assert.deepEqual(states, ['pending', 'error', 'pending', 'ready'])
})

test('timeout aborts a stalled refresh and its late result cannot mount over a retry', async () => {
  const stalled = deferred()
  const states = []
  let requests = 0
  let mounts = 0
  let firstSignal
  const startup = createApplicationStartup({
    timeoutMs: 5,
    refresh: ({ signal }) => {
      if (++requests === 1) {
        firstSignal = signal
        return stalled.promise
      }
    },
    mount: () => mounts++,
    onState: ({ state, error }) => states.push([state, error?.name])
  })
  assert.equal(await startup.start(), false)
  assert.equal(firstSignal.aborted, true)
  assert.equal(firstSignal.reason.name, 'TimeoutError')
  assert.equal(mounts, 0)
  assert.equal(await startup.start(), true)
  stalled.resolve()
  await Promise.resolve()
  assert.equal(mounts, 1)
  assert.deepEqual(
    states.map(([state]) => state),
    ['pending', 'error', 'pending', 'ready']
  )
})

test('leaving during refresh cancels it without publishing an error or a late view', async () => {
  const stalled = deferred()
  const states = []
  let mounts = 0
  const startup = createApplicationStartup({
    refresh: () => stalled.promise,
    mount: () => mounts++,
    onState: ({ state }) => states.push(state)
  })
  const running = startup.start()
  await Promise.resolve()
  startup.dispose()
  assert.equal(await running, false)
  stalled.resolve()
  assert.equal(await startup.start(), false)
  assert.equal(mounts, 0)
  assert.deepEqual(states, ['pending'])
})

test('disposed startup never starts a request', async () => {
  const startup = createApplicationStartup({
    refresh: () => assert.fail('disposed refresh ran'),
    mount: () => assert.fail('disposed mount ran')
  })
  startup.dispose()
  assert.equal(await startup.start(), false)
})
