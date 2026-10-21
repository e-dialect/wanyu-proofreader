import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldFocusMainLandmark } from '../src/lib/routeFocus.js'

test('page changes move focus to the landmark', () => {
  assert.equal(shouldFocusMainLandmark({ path: '/admin' }, { path: '/login' }), true)
  assert.equal(shouldFocusMainLandmark({ path: '/admin/projects/1' }, { path: '/admin/projects/2' }), true)
})

test('query-only and hash-only updates keep the active control focused', () => {
  assert.equal(shouldFocusMainLandmark({ path: '/admin/projects/1', query: { status: 'pending' } }, { path: '/admin/projects/1' }), false)
  assert.equal(shouldFocusMainLandmark({ path: '/admin/projects/1', hash: '#files' }, { path: '/admin/projects/1' }), false)
})

test('incomplete locations do not focus', () => {
  assert.equal(shouldFocusMainLandmark(undefined, { path: '/' }), false)
  assert.equal(shouldFocusMainLandmark({ path: '/' }, undefined), false)
})
