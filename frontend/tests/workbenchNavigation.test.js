import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isImmersiveRoute,
  loadRecentWork,
  navigationArea,
  recentWorkKey,
  rememberWork,
  resumeWork
} from '../src/lib/workbenchNavigation.js'

function storage() {
  const data = new Map()
  return { getItem: (key) => data.get(key) || null, setItem: (key, value) => data.set(key, value) }
}

test('stable navigation groups task, project and platform routes without a global role switch', () => {
  assert.equal(navigationArea({ path: '/admin/projects/project1/settings' }), 'projects')
  assert.equal(navigationArea({ path: '/tasks/problems' }), 'tasks')
  assert.equal(navigationArea({ path: '/admin/sources' }), 'sources')
  assert.equal(navigationArea({ path: '/admin/gate-rules' }), 'platform')
  assert.equal(isImmersiveRoute({ name: 'ProofreadEditor' }), true)
  assert.equal(isImmersiveRoute({ name: 'Arbitration' }), true)
  assert.equal(isImmersiveRoute({ name: 'TaskHall' }), false)
})

test('recent context preserves query and hash, is account-scoped and does not store material', () => {
  const memory = storage()
  rememberWork(memory, 'alice', {
    name: 'ProjectDetail',
    params: { id: 'project1' },
    fullPath: '/admin/projects/project1?section=materials#project-files'
  })
  assert.equal(
    loadRecentWork(memory, 'alice')[0].path,
    '/admin/projects/project1?section=materials#project-files'
  )
  assert.deepEqual(loadRecentWork(memory, 'bob'), [])
  assert.deepEqual(Object.keys(loadRecentWork(memory, 'alice')[0]).sort(), [
    'at',
    'path',
    'projectId',
    'taskId'
  ])
})

test('corrupt history and mismatched project identity cannot create a resume link', () => {
  const memory = storage()
  memory.setItem(
    recentWorkKey('alice'),
    JSON.stringify([
      { path: 'https://example.test', projectId: 'project1' },
      { path: '/admin/projects/project2', projectId: 'project1' },
      { path: '/admin/projects/project1/../../login', projectId: 'project1' },
      { path: '/tasks/task1/edit', taskId: 'task2' }
    ])
  )
  assert.deepEqual(loadRecentWork(memory, 'alice'), [])
  assert.doesNotThrow(() =>
    rememberWork(
      {
        setItem() {
          throw Error('denied')
        },
        getItem() {
          throw Error('denied')
        }
      },
      'alice',
      { name: 'ProjectDetail', params: { id: 'project1' }, fullPath: '/admin/projects/project1' }
    )
  )
})

test('resume requires current project access and never treats an expired task as active', () => {
  const recent = [
    { path: '/admin/projects/project1?section=work', projectId: 'project1', taskId: '' }
  ]
  assert.equal(resumeWork(recent, [], { managedProjectIds: [] }), null)
  assert.equal(resumeWork(recent, [], { managedProjectIds: ['project1'] }).path, recent[0].path)
  const queues = [
    { project: { id: 'project2' }, activeMine: 0, activePage: { id: 'task1', page_number: 2 } }
  ]
  assert.equal(
    resumeWork([{ path: '/tasks/task1/edit', taskId: 'task1', projectId: '' }], queues, {}),
    null
  )
  queues[0].activeMine = 1
  assert.equal(resumeWork([], queues, {}).path, '/tasks/task1/edit')
})

test('account security belongs to account navigation', () => {
  assert.equal(navigationArea({ path: '/account/security' }), 'profile')
})
