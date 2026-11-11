import test from 'node:test'
import assert from 'node:assert/strict'
import {
  projectWorkspaceLocation,
  projectWorkspaceSubviews,
  projectWorkspaceTarget
} from '../src/lib/projectWorkspace.js'
import {
  workflowCount,
  projectWorkflowNext,
  projectWorkflowTarget
} from '../src/lib/projectWorkflow.js'

test('legacy anchors keep each project capability reachable', () => {
  for (const [hash, section, view] of [
    ['#project-entries', 'work', 'entries'],
    ['#project-files', 'materials', 'import'],
    ['#project-ledger', 'materials', 'batches'],
    ['#project-export', 'delivery', 'exports'],
    ['#project-assist', 'work', 'checks'],
    ['#project-scheme', 'work', 'normalization']
  ])
    assert.deepEqual(projectWorkspaceLocation({ section: 'overview' }, hash), { section, view })
})

test('explicit sections ignore stale view names and ordinary filters stay in the entries workspace', () => {
  assert.deepEqual(projectWorkspaceLocation({ status: 'arbitration', page: '3' }), {
    section: 'work',
    view: 'entries'
  })
  assert.deepEqual(projectWorkspaceLocation({ section: 'materials', view: 'entries' }), {
    section: 'materials',
    view: 'import'
  })
  assert.deepEqual(projectWorkspaceLocation({ section: 'overview' }), {
    section: 'overview',
    view: 'summary'
  })
  assert.deepEqual(projectWorkspaceLocation({ section: 'unknown', view: 'queue' }), {
    section: 'work',
    view: 'queue'
  })
})

test('workspace navigation preserves exact list context and clears legacy anchors', () => {
  const context = { q: 'a̤̍ 𠮷', qualityState: 'unresolved', page: '3', view: 'entries' }
  const target = projectWorkspaceTarget('project1', 'materials', 'batches', context)
  assert.deepEqual(target, {
    path: '/admin/projects/project1',
    query: { ...context, section: 'materials', view: 'batches' },
    hash: ''
  })
  assert.deepEqual(context, { q: 'a̤̍ 𠮷', qualityState: 'unresolved', page: '3', view: 'entries' })
  assert.equal(projectWorkspaceTarget('p', 'work', undefined, target.query).query.view, undefined)
})

test('delivery navigation keeps work files, provenance, selection and package receipts distinct', () => {
  const items = projectWorkspaceSubviews('project1', 'delivery')
  assert.deepEqual(
    items.map((item) => item.key),
    ['exports', 'process', 'adoption', 'deliveries']
  )
  assert.equal(
    items.find((item) => item.key === 'adoption').to,
    '/admin/projects/project1/adoption'
  )
  assert.equal(
    items.find((item) => item.key === 'deliveries').to,
    '/admin/projects/project1/deliveries'
  )
  assert.deepEqual(projectWorkspaceSubviews('project1', 'overview'), [])
})

test('workflow guidance distinguishes an unread count from an empty project', () => {
  for (const value of [undefined, null, '', '0', -1, NaN, Infinity, 1.5]) {
    assert.equal(workflowCount(value), null)
  }
  assert.equal(workflowCount(0), 0)
  assert.equal(workflowCount(20000), 20000)
  assert.equal(projectWorkflowNext(null).action, 'entries')
  assert.equal(projectWorkflowNext({}).step, '')
  assert.equal(projectWorkflowNext({ total: 0 }).action, 'materials')
})

test('workflow guidance prioritizes arbitration and never labels reviewed data ready to deliver', () => {
  assert.equal(
    projectWorkflowNext({ total: 20, approved: 4, arbitration: 3 }).action,
    'arbitration'
  )
  assert.equal(projectWorkflowNext({ total: 20, approved: 4, arbitration: 0 }).action, 'entries')
  assert.equal(projectWorkflowNext({ total: 20, arbitration: 0 }).action, 'entries')
  const complete = projectWorkflowNext({ total: 20, approved: 20, arbitration: 0 })
  assert.equal(complete.action, 'delivery')
  assert.match(complete.title, /核对交付范围/)
  assert.match(complete.detail, /检查来源、用途/)
})

test('workflow links retain exact list filters and reset only the arbitration page', () => {
  const query = { q: 'a̤̍ 𠮷', qualityState: 'unresolved', status: 'pending', page: '3' }
  const arbitration = projectWorkflowTarget('project1', 'arbitration', query)
  assert.deepEqual(arbitration.query, {
    ...query,
    section: 'work',
    view: 'entries',
    status: 'arbitration',
    page: undefined
  })
  const normalization = projectWorkflowTarget('project1', 'normalization', query)
  assert.deepEqual(normalization.query, {
    ...query,
    section: 'work',
    view: 'normalization',
    schemeView: 'review'
  })
  assert.equal(query.status, 'pending')
  assert.equal(query.page, '3')
  for (const action of ['materials', 'entries', 'queue', 'delivery']) {
    assert.equal(projectWorkflowTarget('project1', action, query).query.q, query.q)
  }
  assert.deepEqual(projectWorkflowTarget('project1', 'problems', query), {
    path: '/admin/projects/project1/verification',
    query: { view: 'problems' }
  })
  assert.deepEqual(projectWorkflowTarget('project1', 'review', query), {
    path: '/admin/projects/project1/verification',
    query: { view: 'review' }
  })
  for (const action of ['members', 'rules']) {
    assert.deepEqual(projectWorkflowTarget('project1', action, query), {
      path: '/admin/projects/project1/settings',
      query: { view: action }
    })
  }
})
