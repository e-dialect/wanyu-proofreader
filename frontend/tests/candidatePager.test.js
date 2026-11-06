import test from 'node:test'
import assert from 'node:assert/strict'
import { createCandidatePager } from '../src/lib/candidatePager.js'

function fixture() {
  const state = { items: [], nextCursor: '', term: '', loading: false, error: '' }
  const pending = []
  const pager = createCandidatePager(
    (project, query) =>
      new Promise((resolve, reject) => pending.push({ project, query, resolve, reject })),
    state
  )
  return { state, pending, pager }
}
test('next page appends unique options, failure preserves cursor and retries the same page', async () => {
  const f = fixture()
  let work = f.pager.search('p')
  f.pending[0].resolve({ items: [{ id: 'a' }], nextCursor: 'next' })
  await work
  work = f.pager.next()
  f.pending[1].reject(new Error('503'))
  await work
  assert.deepEqual(f.state.items, [{ id: 'a' }])
  assert.equal(f.state.nextCursor, 'next')
  assert.equal(f.state.error, '503')
  work = f.pager.retry()
  assert.deepEqual(f.pending[2].query, f.pending[1].query)
  f.pending[2].resolve({ items: [{ id: 'a' }, { id: 'b' }], nextCursor: '' })
  await work
  assert.deepEqual(f.state.items, [{ id: 'a' }, { id: 'b' }])
  assert.equal(f.state.nextCursor, '')
  assert.equal(f.state.error, '')
})
test('new exact search isolates a late previous page and its error', async () => {
  const f = fixture()
  let first = f.pager.search('p')
  f.pending[0].resolve({ items: [{ id: 'a' }], nextCursor: 'next' })
  await first
  const old = f.pager.next()
  const search = f.pager.search('p', 'known-name')
  f.pending[2].resolve({ items: [{ id: 'known' }], nextCursor: '' })
  await search
  f.pending[1].reject(new Error('late 503'))
  await old
  assert.equal(f.state.term, 'known-name')
  assert.deepEqual(f.state.items, [{ id: 'known' }])
  assert.equal(f.state.error, '')
})
test('changing project clears options immediately and ignores the old response', async () => {
  const f = fixture()
  const old = f.pager.search('old')
  const current = f.pager.search('new')
  assert.deepEqual(f.state.items, [])
  f.pending[1].resolve({ items: [{ id: 'new-user' }], nextCursor: '' })
  await current
  f.pending[0].resolve({ items: [{ id: 'old-user' }], nextCursor: 'old-cursor' })
  await old
  assert.deepEqual(f.state.items, [{ id: 'new-user' }])
  assert.equal(f.state.nextCursor, '')
  assert.equal(f.state.loading, false)
})
