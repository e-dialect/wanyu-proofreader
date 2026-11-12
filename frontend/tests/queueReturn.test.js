import test from 'node:test'
import assert from 'node:assert/strict'
import {
  queueReturnTarget,
  rememberQueueTransition,
  takeQueuePosition
} from '../src/lib/queueReturn.js'
import {
  readOwnSubmissionContext,
  ownSubmissionNavigationQuery,
  ownSubmissionReturnTarget
} from '../src/lib/ownSubmissionContext.js'
import {
  readProblemFollowupContext,
  problemFollowupNavigationQuery,
  problemFollowupHallTarget
} from '../src/lib/problemFollowupContext.js'
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

test('problem follow-up returns to its filtered list and original task hall without storage', () => {
  const context = readProblemFollowupContext({
    view: 'reports',
    project: 'b12345678901234',
    taskView: 'available',
    taskPage: '2',
    taskProject: 'a12345678901234',
    taskQ: '乡音 %_&',
    returnTo: 'https://example.test/unrelated'
  })
  const query = { mode: 'review', ...problemFollowupNavigationQuery(context) }
  const back = new URL(
    queueReturnTarget(null, 'alice', { ...task, query }),
    'https://queue.invalid'
  )
  assert.equal(back.pathname, '/tasks/problems')
  assert.equal(back.searchParams.get('view'), 'reports')
  assert.equal(back.searchParams.get('project'), 'b12345678901234')
  assert.equal(back.searchParams.has('returnTo'), false)
  assert.deepEqual(
    problemFollowupHallTarget(readProblemFollowupContext(Object.fromEntries(back.searchParams))),
    {
      path: '/tasks',
      query: { view: 'available', page: '2', project: 'a12345678901234', q: '乡音 %_&' }
    }
  )
})

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

test('a searched task returns to its exact queue, including after reload without storage', () => {
  const storage = memory()
  const queue = { fullPath: '/tasks?q=%E4%B9%A1%E9%9F%B3%20%25_%26&view=available&page=2' }
  const editor = {
    ...task,
    query: { taskView: 'available', taskPage: '2', taskQ: '乡音 %_&' }
  }
  rememberQueueTransition(storage, 'alice', editor, queue, { top: 360 })
  assert.equal(queueReturnTarget(storage, 'alice', editor), queue.fullPath)
  rememberQueueTransition(storage, 'alice', queue, editor)
  assert.deepEqual(takeQueuePosition(storage, 'alice', queue.fullPath), { top: 360, left: 0 })
  const fresh = new URL(queueReturnTarget(null, 'alice', editor), 'https://queue.invalid')
  assert.equal(fresh.pathname, '/tasks')
  assert.equal(fresh.searchParams.get('q'), '乡音 %_&')
  assert.equal(fresh.searchParams.get('view'), 'available')
  assert.equal(fresh.searchParams.get('page'), '2')
  const other = { ...editor, query: { ...editor.query, taskQ: '新项目' } }
  assert.equal(
    new URL(queueReturnTarget(storage, 'alice', other), 'https://queue.invalid').searchParams.get(
      'q'
    ),
    '新项目'
  )
})

test('submission filtering and the task project search survive the read-only return independently', () => {
  const projectId = 'project00000001'
  const context = readOwnSubmissionContext(
    {
      reviewProject: projectId,
      reviewPage: '2',
      reviewNumber: '7',
      reviewSort: 'number',
      taskView: 'reviewed',
      taskPage: '3',
      taskQ: '乡音 %_&',
      taskProject: projectId
    },
    projectId
  )
  const query = { mode: 'review', ...ownSubmissionNavigationQuery(context) }
  const target = ownSubmissionReturnTarget(context)
  assert.equal(target.query.number, '7')
  assert.equal(target.query.page, '2')
  assert.equal(target.query.taskPage, '3')
  assert.equal(target.query.taskQ, '乡音 %_&')
  const path = new URL(
    queueReturnTarget(null, 'alice', { ...task, query }),
    'https://queue.invalid'
  )
  assert.equal(path.pathname, `/tasks/projects/${projectId}/submissions`)
  assert.equal(path.searchParams.get('number'), '7')
  assert.equal(path.searchParams.get('taskQ'), '乡音 %_&')
})

test('own submission review returns to its filtered practice list regardless of stored queue', () => {
  const storage = memory()
  rememberQueueTransition(storage, 'alice', task, { fullPath: '/tasks?view=active' })
  const projectId = 'practiceproj001'
  const target = queueReturnTarget(storage, 'alice', {
    ...task,
    query: {
      mode: 'review',
      reviewProject: projectId,
      reviewPage: '3',
      reviewNumber: '25',
      reviewSort: 'number',
      practiceProject: projectId,
      practiceRole: 'proofreader',
      practiceStep: 'reviewed'
    }
  })
  const url = new URL(target, 'https://queue.invalid')
  assert.equal(url.pathname, `/tasks/projects/${projectId}/submissions`)
  assert.equal(url.searchParams.get('page'), '3')
  assert.equal(url.searchParams.get('number'), '25')
  assert.equal(url.searchParams.get('practiceProject'), projectId)
  assert.equal(url.searchParams.get('practiceStep'), 'reviewed')
})

test('arbitration return keeps only the current batch and rejects invalid batch links', () => {
  const storage = memory()
  const importJob = 'batch0000000000'
  const batchRoute = { ...arbitration, query: { importJob } }
  const batchQueue = {
    fullPath: `/admin/projects/project1?section=work&status=arbitration&importJob=${importJob}&page=2`
  }
  rememberQueueTransition(storage, 'alice', batchRoute, batchQueue)
  assert.equal(queueReturnTarget(storage, 'alice', batchRoute), batchQueue.fullPath)
  assert.equal(
    queueReturnTarget(storage, 'alice', { ...arbitration, query: { importJob: 'bad' } }),
    '/admin/projects/project1?section=materials&view=batches#project-ledger'
  )
  assert.equal(
    queueReturnTarget(storage, 'alice', arbitration),
    '/admin/projects/project1?section=work&status=arbitration'
  )
})
