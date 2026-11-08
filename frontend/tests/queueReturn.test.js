import test from 'node:test'
import assert from 'node:assert/strict'
import {
  queueReturnTarget,
  rememberQueueTransition,
  takeQueuePosition
} from '../src/lib/queueReturn.js'
const memory = () => {
  const data = new Map()
  return {
    getItem: (key) => data.get(key),
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key)
  }
}
const task = { name: 'ProofreadEditor', params: { id: 'task1' } }
const arbitration = { name: 'Arbitration', params: { projectId: 'project1', pageId: 'page1' } }

test('task return keeps queue filters and restores its position exactly once after data is ready', () => {
  const storage = memory(),
    queue = { name: 'TaskHall', fullPath: '/tasks?project=project1&view=active&page=2' }
  rememberQueueTransition(storage, 'alice', task, queue, { top: 640, left: 0 })
  assert.equal(queueReturnTarget(storage, 'alice', task), queue.fullPath)
  assert.equal(queueReturnTarget(storage, 'bob', task), '/tasks')
  rememberQueueTransition(storage, 'alice', queue, task)
  assert.equal(takeQueuePosition(storage, 'alice', '/tasks'), null)
  assert.deepEqual(takeQueuePosition(storage, 'alice', queue.fullPath), { top: 640, left: 0 })
  assert.equal(takeQueuePosition(storage, 'alice', queue.fullPath), null)
})

test('continuing within a queue keeps context while a different project or direct link uses a safe fallback', () => {
  const storage = memory(),
    queue = {
      name: 'SourceFidelity',
      fullPath: '/admin/projects/project1/verification?view=review'
    }
  rememberQueueTransition(storage, 'alice', arbitration, queue)
  rememberQueueTransition(
    storage,
    'alice',
    { ...arbitration, params: { ...arbitration.params, pageId: 'page2' } },
    arbitration
  )
  assert.equal(queueReturnTarget(storage, 'alice', arbitration), queue.fullPath)
  assert.equal(
    queueReturnTarget(storage, 'alice', { ...arbitration, params: { projectId: 'project2' } }),
    '/admin/projects/project2?section=work&status=arbitration'
  )
  rememberQueueTransition(storage, 'alice', task, { fullPath: '/workspace' })
  assert.equal(queueReturnTarget(storage, 'alice', task), '/tasks')
})

test('storage errors and external destinations do not interrupt navigation', () => {
  const storage = memory()
  rememberQueueTransition(storage, 'alice', task, { fullPath: 'https://example.test/tasks' })
  assert.equal(queueReturnTarget(storage, 'alice', task), '/tasks')
  const denied = {
    getItem() {
      throw Error('denied')
    },
    setItem() {
      throw Error('denied')
    },
    removeItem() {
      throw Error('denied')
    }
  }
  assert.doesNotThrow(() => rememberQueueTransition(denied, 'alice', task, { fullPath: '/tasks' }))
  assert.equal(queueReturnTarget(denied, 'alice', task), '/tasks')
})
