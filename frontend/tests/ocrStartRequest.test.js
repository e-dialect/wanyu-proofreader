import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearPendingOcrStart,
  ocrPendingStorageKey,
  readPendingOcrStart,
  savePendingOcrStart
} from '../src/lib/ocrStartRequest.js'
function storage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  }
}
const request = {
  projectId: 'project-a',
  requestId: 'synthetic-request-0001',
  startPage: 1,
  endPage: 200,
  language: 'chi_sim+eng',
  layout: 'single_column'
}
test('uncertain OCR starts restore the same request ID and parameters within the same user/project', () => {
  const state = storage()
  savePendingOcrStart(state, 'user-a', request)
  assert.deepEqual(readPendingOcrStart(state, 'user-a', 'project-a'), request)
  assert.equal(readPendingOcrStart(state, 'user-b', 'project-a'), null)
  assert.equal(readPendingOcrStart(state, 'user-a', 'project-b'), null)
  clearPendingOcrStart(state, 'user-a', 'project-a')
  assert.equal(readPendingOcrStart(state, 'user-a', 'project-a'), null)
})
test('invalid restored parameters cannot become a different untracked OCR request', () => {
  for (const value of [
    { ...request, requestId: 'short' },
    { ...request, projectId: 'other' },
    { ...request, endPage: 201 },
    { ...request, layout: 'guess_columns' }
  ]) {
    const state = storage()
    state.setItem(ocrPendingStorageKey('user-a', 'project-a'), JSON.stringify(value))
    assert.throws(() => readPendingOcrStart(state, 'user-a', 'project-a'))
  }
  assert.throws(() => ocrPendingStorageKey('', 'project-a'))
  assert.throws(
    () =>
      savePendingOcrStart(
        {
          setItem() {
            throw new Error('unavailable')
          }
        },
        'user-a',
        request
      ),
    /unavailable/
  )
})
