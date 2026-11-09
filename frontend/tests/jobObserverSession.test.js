import assert from 'node:assert/strict'
import test from 'node:test'
import { jobObserverScope } from './helpers/jobObserverScope.js'

test('token refresh retains a snapshot; logout/account switch cannot reseed the prior account snapshot', () => {
  const cleanup = []
  const host = jobObserverScope(cleanup)
  const job = host.ref({ id: 'job', project: 'project', status: 'validated' })
  const api = host.useJobObserver({
    projectId: 'project',
    kind: 'csv',
    job,
    read: async () => assert.fail('validated jobs do not poll')
  })
  assert.equal(api.snapshot.value.id, 'job')
  host.changeAuth('test-user')
  assert.equal(api.snapshot.value.id, 'job')
  host.changeAuth('other-user')
  assert.equal(api.snapshot.value, null)
  host.changeAuth('')
  host.changeAuth('test-user')
  assert.equal(api.snapshot.value, null)
  job.value = { id: 'new-job', project: 'project', status: 'validated' }
  assert.equal(api.snapshot.value.id, 'new-job')
  cleanup.forEach((fn) => fn())
})

test('standard observer aliases preserve legacy reads and keep connection failures outside job state', async () => {
  const cleanup = []
  const host = jobObserverScope(cleanup)
  const selected = host.ref({ id: 'job', project: 'project', status: 'validated' })
  let response = {
    id: 'job',
    project: 'project',
    status: 'processing',
    processed_count: 2,
    total_count: 10
  }
  let error
  let calls = 0
  const api = host.useJobObserver({
    projectId: 'project',
    kind: 'csv',
    job: selected,
    read: async () => {
      calls++
      if (error) throw error
      return response
    }
  })
  try {
    assert.equal(api.refresh, api.retry)
    assert.equal(api.job.value.state, 'awaiting_confirmation')
    assert.equal(api.connection.value, 'fresh')
    assert.equal(api.lastFetchedAt.value, api.observation.value.lastSuccessAt)
    assert.equal(api.job.value.updatedAt, null)
    await api.refresh()
    assert.equal(calls, 1)
    assert.equal(api.snapshot.value, response)
    assert.equal(api.job.value.state, 'processing')
    assert.equal(api.job.value.progress.percent, 20)
    const receivedAt = api.lastFetchedAt.value
    error = new Error('network')
    await api.refresh()
    assert.equal(api.connection.value, 'stale')
    assert.equal(api.job.value.state, 'processing')
    assert.equal(api.job.value.errorCode, null)
    assert.equal(api.lastFetchedAt.value, receivedAt)
    error = { status: 404 }
    await api.refresh()
    assert.equal(api.connection.value, 'unavailable')
    assert.equal(api.job.value, null)
    assert.equal(api.lastFetchedAt.value, null)
    host.changeAuth('other-user')
    assert.equal(api.connection.value, 'auth_lost')
    assert.equal(api.job.value, null)
  } finally {
    cleanup.forEach((fn) => fn())
  }
})
