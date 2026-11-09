import test from 'node:test'
import assert from 'node:assert/strict'
import { createTelemetryQueue } from '../src/lib/telemetry.js'

test('telemetry projects allowed values, deduplicates and remains bounded', async () => {
  let sent
  const q = createTelemetryQueue({
    enabled: true,
    pageViewId: 'page',
    send: (x) => {
      sent = x
    }
  })
  for (let i = 0; i < 25; i++)
    q.record({
      id: String(i),
      name: 'INP',
      value: i,
      entries: ['private'],
      navigationURL: '/secret'
    })
  q.record({ id: '24', name: 'INP', value: 99 })
  assert.equal(q.size(), 20)
  await q.flush()
  assert.equal(sent.metrics.length, 20)
  assert.equal(sent.metrics.at(-1).value, 99)
  assert.ok(sent.metrics.every((m) => !('entries' in m) && !('navigationURL' in m)))
  assert.equal(q.size(), 0)
})

test('telemetry never retries failed sends and ignores disabled or disposed sessions', async () => {
  let calls = 0
  const q = createTelemetryQueue({
    enabled: true,
    pageViewId: 'p',
    send: () => {
      calls++
      throw Error('offline')
    }
  })
  q.record({ id: 'one', name: 'CLS', value: 0 })
  await q.flush()
  await q.flush()
  assert.equal(calls, 1)
  q.dispose()
  q.record({ id: 'two', name: 'LCP', value: 5 })
  assert.equal(q.size(), 0)
  const disabled = createTelemetryQueue({ send: () => assert.fail('disabled') })
  disabled.record({ id: 'id', name: 'CLS', value: 1 })
  await disabled.flush()
})
