import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const serviceSource = readFileSync(
  new URL('../src/services/pagesService.js', import.meta.url),
  'utf8'
)
const serviceBody = serviceSource
  .match(/export async function listProjectQueueSummaries\([\s\S]*?\n\}/)?.[0]
  .replace(/^export /, '')
assert.ok(serviceBody, 'the production queue service must be exercised')
const hallSource = readFileSync(
  new URL('../src/views/proofreader/TaskHallView.vue', import.meta.url),
  'utf8'
)
const loader = hallSource.match(
  /const queueResource = useAsyncResource\(\s*(async \(\{ signal \}\) => \{[\s\S]*?\n {2}\})/
)?.[1]
assert.ok(loader, 'the mounted task hall must keep a queue resource loader')

test('queue service preserves the old default and forwards only supplied filter/project options', async () => {
  const calls = []
  const service = new Function('pb', `return (${serviceBody})`)({
    send: (...args) => {
      calls.push(args)
      return { items: [] }
    }
  })
  await service()
  assert.deepEqual(calls[0], [
    '/api/fangji/proofreading-queues',
    { query: { page: 1, perPage: 12 }, signal: undefined, requestKey: null }
  ])
  const signal = new AbortController().signal
  await service(2, 12, { signal, filter: 'reviewed', project: 'selected-project' })
  assert.deepEqual(calls[1], [
    '/api/fangji/proofreading-queues',
    {
      query: { page: 2, perPage: 12, filter: 'reviewed', project: 'selected-project' },
      signal,
      requestKey: null
    }
  ])
})

for (const filter of ['active', 'available', 'reviewed']) {
  test(`the ${filter} hall requests exactly its filtered page and selected project without scanning`, async () => {
    const calls = []
    const signal = new AbortController().signal
    const expected = {
      items: [],
      totalItems: 14,
      totalPages: 2,
      page: 2,
      summary: { totalItems: 10013 }
    }
    const bindings = {
      currentUserId: () => 'reader',
      auth: { user: { id: 'reader' } },
      currentPage: { value: 2 },
      selectedProject: { value: 'selected-project' },
      taskView: { value: filter },
      listProjectQueueSummaries: (...args) => {
        calls.push(args)
        return Promise.resolve(expected)
      }
    }
    const load = new Function(...Object.keys(bindings), `return (${loader})`)(
      ...Object.values(bindings)
    )
    assert.equal(await load({ signal }), expected)
    assert.deepEqual(calls, [[2, 12, { signal, filter, project: 'selected-project' }]])
  })
}

test('the task hall defaults to active even when the current project page has only available work', () => {
  const expression = hallSource.match(/const taskView = computed\(\s*(\(\) =>[\s\S]*?)\n\)/)?.[1]
  assert.ok(expression)
  const read = new Function('route', `return (${expression})`)({ query: {} })
  assert.equal(read(), 'active')
})
