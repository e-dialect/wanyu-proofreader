import assert from 'node:assert/strict'
import test from 'node:test'
import { createProtectedPageScope } from '../src/lib/protectedPageScope.js'
import { protectedPageScopeFixture } from './helpers/protectedPageScopeFixture.js'

for (const status of [401, 403]) {
  test(`${status} invalidation aborts all owned requests before clearing page state`, () => {
    const seen = []
    let first, second
    const scope = createProtectedPageScope((value) => {
      assert.equal(first.signal.aborted, true)
      assert.equal(second.signal.aborted, true)
      seen.push(value)
    })
    first = scope.capture()
    second = scope.capture()
    assert.equal(scope.invalidate({ response: { status } }, first), true)
    assert.deepEqual(seen, [status])
    assert.equal(first.isCurrent(), false)
    assert.equal(second.isCurrent(), false)
    assert.equal(scope.invalidate({ status }, second), false)
    assert.deepEqual(seen, [status], 'another late request must not clear a new view')
    assert.equal(scope.capture().isCurrent(), true, 'an explicit retry can obtain a fresh ticket')
  })
}

test('404 and transient errors do not globally invalidate the protected page', () => {
  let clears = 0
  const scope = createProtectedPageScope(() => clears++)
  const request = scope.capture()
  for (const error of [{ status: 404 }, { status: 500 }, { status: 0 }, new Error('offline')]) {
    assert.equal(scope.invalidate(error, request), false)
    assert.equal(request.isCurrent(), true)
    assert.equal(request.signal.aborted, false)
  }
  assert.equal(clears, 0)
})

test('replaced reads are aborted and an old 401 cannot invalidate the current ticket', () => {
  let clears = 0
  const scope = createProtectedPageScope(() => clears++)
  const previous = scope.capture()
  previous.cancel()
  const current = scope.capture()
  assert.equal(previous.signal.aborted, true)
  assert.equal(scope.invalidate({ status: 401 }, previous), false)
  assert.equal(current.isCurrent(), true)
  assert.equal(clears, 0)
})

test('finishing releases request ownership, while cancellation and disposal fence publication', () => {
  const scope = createProtectedPageScope(() => {})
  const finished = scope.capture()
  finished.finish()
  const pending = scope.capture()
  scope.cancel()
  assert.equal(finished.signal.aborted, false, 'completed requests no longer retain controllers')
  assert.equal(finished.isCurrent(), false)
  assert.equal(pending.signal.aborted, true)
  const latest = scope.capture()
  scope.dispose()
  assert.equal(latest.signal.aborted, true)
  assert.equal(scope.capture().isCurrent(), false)
  assert.equal(scope.capture().signal.aborted, true)
})

test('the production composable preserves normal token refresh but invalidates identity and role changes', () => {
  const cleanup = []
  const fixture = protectedPageScopeFixture((callback) => cleanup.push(callback))
  const invalidations = []
  const scope = fixture.useProtectedPageScope((status) => invalidations.push(status))
  const original = scope.capture()
  fixture.changeIdentity({ id: 'account-a', role: 'user' }, 'refreshed-token')
  assert.equal(original.isCurrent(), true)
  assert.equal(scope.accessLost.value, false)
  fixture.changeIdentity({ id: 'account-b', role: 'user' })
  assert.equal(original.signal.aborted, true)
  assert.equal(scope.accessLost.value, true)
  const b = scope.capture()
  fixture.changeIdentity({ id: 'account-a', role: 'user' })
  assert.equal(b.isCurrent(), false)
  assert.equal(original.isCurrent(), false, 'A to B to A cannot revive an earlier ticket')
  fixture.changeIdentity({ id: 'account-a', role: 'platform_admin' })
  assert.deepEqual(invalidations, [401, 401, 401])
  const latest = scope.capture()
  cleanup.forEach((callback) => callback())
  assert.equal(latest.signal.aborted, true)
  assert.equal(fixture.listenerCount(), 0)
  fixture.changeIdentity(null)
  assert.deepEqual(invalidations, [401, 401, 401])
})
