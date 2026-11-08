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
