import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
import { normalizeAdminPageQuery } from '../src/lib/adminPageList.js'
import { createAsyncResource } from '../src/lib/asyncResource.js'
import { getPbMessage, getPbStatus } from '../src/utils/pbErrors.js'

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

test('whole-project arbitration links clear every entry range filter and start on page one', () => {
  const query = {
    q: 'a̤̍ 𠮷',
    qualityState: 'unresolved',
    minPage: '12',
    maxPage: '14',
    status: 'pending',
    page: '3',
    perPage: '50',
    method: 'csv'
  }
  const original = { ...query }
  const arbitration = projectWorkflowTarget('project1', 'arbitration', query)
  assert.deepEqual(arbitration.query, {
    perPage: '50',
    method: 'csv',
    section: 'work',
    view: 'entries',
    status: 'arbitration'
  })
  assert.deepEqual(
    normalizeAdminPageQuery(arbitration.query, {
      statuses: ['pending', 'arbitration'],
      qualityStates: ['unresolved'],
      pageSizes: [25, 50, 100]
    }),
    {
      q: '',
      status: 'arbitration',
      qualityState: '',
      minPage: '',
      maxPage: '',
      page: 1,
      perPage: 50
    }
  )
  assert.deepEqual(query, original)
  const entries = projectWorkflowTarget('project1', 'entries', query)
  assert.deepEqual(entries.query, { ...original, section: 'work', view: 'entries' })
})

test('other workflow links preserve list context and keep specialized destinations', () => {
  const query = { q: 'a̤̍ 𠮷', qualityState: 'unresolved', status: 'pending', page: '3' }
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

const queueSource = readFileSync(
  new URL('../src/components/admin/project/ProjectWorkQueue.vue', import.meta.url),
  'utf8'
)
function queueFixture(readStats, readNormalizations) {
  const ref = (value) => ({ value })
  const useAsyncResource = (loader, options) => {
    const refs = { data: ref(null), pending: ref(false), error: ref('') }
    const resource = createAsyncResource(loader, {
      ...options,
      onChange: (state) => {
        for (const key of Object.keys(refs)) refs[key].value = state[key]
      }
    })
    return { ...refs, reload: resource.reload, cancel: resource.cancel }
  }
  // Run the production setup and resource lifecycle; only Vue mounting and API reads are stubbed.
  const setup = queueSource
    .match(/<script setup>([\s\S]*?)<\/script>/)[1]
    .replace(/^import .*\n/gm, '')
  return new Function(
    'ref',
    'computed',
    'onMounted',
    'defineProps',
    'defineExpose',
    'useAsyncResource',
    'getAdminProjectPageStats',
    'listNormalizations',
    'getPbMessage',
    'getPbStatus',
    'projectWorkflowTarget',
    'workflowCount',
    `${setup}\nreturn { stats, normalizations, accessError, statsError, normalizationError, loadStats, loadNormalizations, reload }`
  )(
    ref,
    (get) => ({
      get value() {
        return get()
      }
    }),
    () => {},
    () => ({ projectId: 'project1', query: {} }),
    () => {},
    useAsyncResource,
    readStats,
    readNormalizations,
    getPbMessage,
    getPbStatus,
    projectWorkflowTarget,
    workflowCount
  )
}

for (const status of [401, 403, 404]) {
  test(`queue ${status} clears both counts and rejects a late peer response`, async () => {
    for (const failingSide of ['stats', 'normalizations']) {
      let fail = false,
        finishPeer
      const peer = new Promise((resolve) => {
        finishPeer = resolve
      })
      const read = (side, initial) => () =>
        !fail ? initial : side === failingSide ? Promise.reject({ status }) : peer
      const queue = queueFixture(
        read('stats', { arbitration: 3 }),
        read('normalizations', { totalItems: 4 })
      )
      await queue.reload()
      assert.equal(queue.stats.value.arbitration, 3)
      assert.equal(queue.normalizations.value.totalItems, 4)
      fail = true
      const pendingPeer = failingSide === 'stats' ? queue.loadNormalizations() : queue.loadStats()
      await (failingSide === 'stats' ? queue.loadStats() : queue.loadNormalizations())
      assert.ok(queue.accessError.value)
      assert.equal(queue.stats.value, null)
      assert.equal(queue.normalizations.value, null)
      finishPeer({ arbitration: 99, totalItems: 99 })
      await pendingPeer
      await queue.reload()
      assert.equal(queue.stats.value, null)
      assert.equal(queue.normalizations.value, null)
    }
    assert.match(
      queueSource,
      /<template v-if="accessError">[\s\S]*?<template v-else>[\s\S]*?class="project-todo__list"/
    )
    assert.match(queueSource, /<AppButton\s+v-if="!accessError"/)
  })
}

test('temporary queue read failures preserve prior counts and allow retry', async () => {
  let fail = false
  const queue = queueFixture(
    () => (fail ? Promise.reject({ status: 0, message: 'offline' }) : { arbitration: 3 }),
    () => (fail ? Promise.reject({ status: 503, message: 'unavailable' }) : { totalItems: 4 })
  )
  await queue.reload()
  fail = true
  await queue.reload()
  assert.equal(queue.accessError.value, '')
  assert.equal(queue.stats.value.arbitration, 3)
  assert.equal(queue.normalizations.value.totalItems, 4)
  assert.equal(queue.statsError.value, 'offline')
  assert.equal(queue.normalizationError.value, 'unavailable')
  fail = false
  await queue.reload()
  assert.equal(queue.statsError.value, '')
  assert.equal(queue.normalizationError.value, '')
})
