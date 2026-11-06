import assert from 'node:assert/strict'
import test from 'node:test'
import { createPageListLoader } from '../src/lib/pageListLoader.js'

function fixture(responses) {
  const calls = []
  return {
    calls,
    load: createPageListLoader({
      collection(name) {
        assert.equal(name, 'pages')
        return {
          async getList(...args) {
            calls.push(args)
            const result = responses.shift()
            if (result instanceof Error) throw result
            return result
          }
        }
      }
    })
  }
}
test('successful expand keeps records and requires no fallback request', async () => {
  const expected = {
    items: [{ id: 'a', expand: { project: { name: 'fixture' } } }],
    totalItems: 51
  }
  const { calls, load } = fixture([expected])
  assert.equal(await load({ page: 2, perPage: 25, expand: 'project' }), expected)
  assert.deepEqual(calls, [[2, 25, { requestKey: null, expand: 'project' }]])
})
test('denied expansion falls back with the exact same scope and pagination', async () => {
  const expected = { items: [{ id: 'b' }], totalItems: 77 }
  const { calls, load } = fixture([new Error('403 expansion'), expected])
  assert.equal(
    await load({
      page: 3,
      perPage: 20,
      filter: 'proofreader="mine"',
      sort: '-updated',
      fields: 'id,project',
      expand: 'project'
    }),
    expected
  )
  assert.deepEqual(calls[1], [
    3,
    20,
    { filter: 'proofreader="mine"', sort: '-updated', fields: 'id,project', requestKey: null }
  ])
  assert.equal(calls.length, 2)
})
test('a second failure is visible instead of returning empty success', async () => {
  const error = new Error('network unavailable')
  const { calls, load } = fixture([new Error('expand'), error])
  await assert.rejects(load({ expand: 'project' }), (failure) => failure === error)
  assert.equal(calls.length, 2)
})
test('without expansion a failure is not retried', async () => {
  const error = new Error('denied')
  const { calls, load } = fixture([error])
  await assert.rejects(load({}), (failure) => failure === error)
  assert.equal(calls.length, 1)
})
