import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { practiceNavigationQuery } from '../src/lib/practiceContext.js'
import { projectWorkspaceTarget } from '../src/lib/projectWorkspace.js'

const source = readFileSync(
  new URL('../src/components/admin/project/ProjectWorkspaceNav.vue', import.meta.url),
  'utf8'
)
const scopedQuery = source.match(/function scopedQuery\(query\) \{[\s\S]*?\n\}/)[0]
const target = source.match(/function target\(item\) \{[\s\S]*?\n\}/)[0]

test('workspace tabs preserve verified practice context and clear the todo return', () => {
  const context = { projectId: 'practiceproj001', role: 'manager', step: 'import' }
  const props = { projectId: context.projectId }
  const practiceContext = { value: context }
  const route = { query: { ...practiceNavigationQuery(context), todoFrom: 'source', q: 'sample' } }
  const navigate = new Function(
    'props',
    'practiceContext',
    'practiceNavigationQuery',
    'projectWorkspaceTarget',
    'route',
    `const practiceQueryKeys = ['practiceProject', 'practiceRole', 'practiceStep']; ${scopedQuery}; ${target}; return target`
  )(props, practiceContext, practiceNavigationQuery, projectWorkspaceTarget, route)
  const work = navigate({ key: 'work' })
  assert.equal(work.query.todoFrom, undefined)
  assert.equal(work.query.practiceProject, context.projectId)
  assert.equal(work.query.practiceRole, context.role)
  assert.equal(work.query.q, 'sample')
  assert.equal(navigate({ key: 'settings' }).query.practiceProject, context.projectId)
  practiceContext.value = null
  const unverified = navigate({ key: 'work' })
  assert.equal(unverified.query.todoFrom, undefined)
  assert.equal(unverified.query.practiceProject, undefined)
})
