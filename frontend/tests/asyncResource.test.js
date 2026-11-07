import test from 'node:test'
import assert from 'node:assert/strict'
import { createAsyncResource, statusPresentation } from '../src/lib/asyncResource.js'
const deferred = () => {
  let resolve, reject
  const promise = new Promise((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
test('late responses cannot replace the latest resource and reload aborts the prior signal', async () => {
  const pending = [deferred(), deferred()],
    signals = [],
    snapshots = []
  const resource = createAsyncResource(
    ({ signal }, index) => {
      signals.push(signal)
      return pending[index].promise
    },
    { onChange: (state) => snapshots.push(state), isEmpty: (value) => !value?.length }
  )
  const first = resource.reload(0),
    second = resource.reload(1)
  assert.equal(signals[0].aborted, true)
  pending[1].resolve(['B'])
  assert.equal((await second).ok, true)
  pending[0].resolve(['A'])
  assert.equal((await first).cancelled, true)
  assert.deepEqual(resource.state.data, ['B'])
  assert.equal(resource.state.pending, false)
  assert.equal(snapshots.filter((state) => state.hasValue).length, 1)
})
test('dispose cancels real signal users and no state publishes after unmount', async () => {
  let aborts = 0,
    changes = 0
  const resource = createAsyncResource(
    ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => {
          aborts++
          reject(new Error('cancelled'))
        })
      ),
    { onChange: () => changes++ }
  )
  const load = resource.reload()
  assert.equal(changes, 1)
  resource.dispose()
  resource.dispose()
  assert.equal((await load).cancelled, true)
  assert.equal(aborts, 1)
  assert.equal(changes, 1)
  assert.equal((await resource.reload()).cancelled, true)
})
test('failed reload retains prior data, reports error and can retry', async () => {
  let fail = false
  const resource = createAsyncResource(
    async () => {
      if (fail) throw new Error('offline')
      return ['saved']
    },
    { initialData: [], isEmpty: (value) => !value.length }
  )
  await resource.reload()
  fail = true
  assert.equal((await resource.reload()).ok, false)
  assert.deepEqual(resource.state.data, ['saved'])
  assert.equal(resource.state.error, 'offline')
  fail = false
  await resource.reload()
  assert.equal(resource.state.error, '')
})
test('empty reasons are explicit and computation failure never becomes a clean empty list', () => {
  assert.throws(() => statusPresentation('empty'), /requires/)
  assert.throws(() => statusPresentation('empty', 'clean'), /requires/)
  assert.match(statusPresentation('empty', 'not_computed').message, /尚未运行/)
  assert.match(statusPresentation('empty', 'not_authorized').message, /权限/)
  assert.equal(statusPresentation('error', '', 'offline').role, 'alert')
  assert.equal(statusPresentation('danger').role, 'alert')
})
