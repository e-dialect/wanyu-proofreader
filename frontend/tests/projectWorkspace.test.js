import test from 'node:test'
import assert from 'node:assert/strict'
import {
  projectWorkspaceLocation,
  projectWorkspaceSubviews,
  projectWorkspaceTarget
} from '../src/lib/projectWorkspace.js'

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
