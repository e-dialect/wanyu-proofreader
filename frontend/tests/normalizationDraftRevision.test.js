import { jobObserverScope } from './helpers/jobObserverScope.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computed, ref } from 'vue'
import * as drafts from '../src/lib/normalizationDraft.js'
const row = (basis = 'source-ma', source = 'ma533') => ({
  id: 'row-a',
  page_number: 1,
  expected_basis: basis,
  source_pronunciation: source,
  current_source_pronunciation: source,
  source_scheme_id: 'synthetic-source',
  canonical_scheme_id: 'synthetic-target',
  normalization_rule_version: 'v1',
  normalization_schema_version: 2,
  normalization_source_column: '读音',
  normalization_status: 'UNSUPPORTED',
  normalization_trace: [],
  candidates: []
})
function pending() {
  let resolve, reject
  const promise = new Promise((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
function fixture(request, decide = async () => {}) {
  const cleanup = []
  const source = readFileSync(
    new URL('../src/components/admin/project/ProjectSchemePanel.vue', import.meta.url),
    'utf8'
  )
    .split('<script setup>')[1]
    .split('</script>')[0]
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\n/gm, '')
  const scope = {
    ...jobObserverScope(cleanup),
    ref,
    computed,
    defineProps: () => ({ projectId: 'project' }),
    defineExpose: () => {},
    onMounted: () => {},
    onBeforeUnmount: (fn) => cleanup.push(fn),
    getPbMessage: (error) => error.message,
    listNormalizations: request,
    decideNormalization: decide,
    ...drafts
  }
  const env = new Proxy(scope, {
    has: () => true,
    get: (obj, key) =>
      key === Symbol.unscopables ? undefined : key in obj ? obj[key] : globalThis[key]
  })
  return new Function(
    'scope',
    `with(scope){${source};return {loadReviews,saveReview,restartReview,reviewDraft,reviewRows,schemeSuccess,schemeError,offPageDrafts,dispose:()=>disposed=true}}`
  )(env)
}

test('same decision context retains the exact in-progress manual values', () => {
  const draft = drafts.reconcileNormalizationDraft(null, row())
  draft.canonical = 'ge533'
  draft.basis = 'old manual basis'
  assert.equal(drafts.reconcileNormalizationDraft(draft, row()), draft)
  assert.equal(drafts.canSubmitNormalizationDraft(draft, row()), true)
})
test('source, scheme, schema or rule change archives old input and requires explicitly starting a fresh review', () => {
  for (const change of [
    { source_pronunciation: 'si533' },
    { source_scheme_id: 'new' },
    { canonical_scheme_id: 'new' },
    { normalization_rule_version: 'v2' },
    { normalization_schema_version: 3 }
  ]) {
    const old = drafts.reconcileNormalizationDraft(null, row())
    old.canonical = 'ge533'
    old.basis = 'ma evidence'
    const next = { ...row('new-context', 'si533'), ...change }
    const draft = drafts.reconcileNormalizationDraft(old, next)
    assert.equal(draft.stale, true)
    assert.equal(draft.canonical, '')
    assert.equal(draft.basis, '')
    assert.equal(draft.history[0].canonical, 'ge533')
    assert.equal(draft.history[0].context.source, 'ma533')
    assert.equal(drafts.canSubmitNormalizationDraft(draft, next), false)
    assert.equal(drafts.restartNormalizationDraft(draft, next), true)
    assert.equal(drafts.canSubmitNormalizationDraft(draft, next), false)
    draft.canonical = 'de533'
    draft.basis = 'new actual evidence'
    assert.equal(drafts.canSubmitNormalizationDraft(draft, next), true)
  }
})
test('missing basis and changed source before rerun remain blocked', () => {
  const missing = { ...row(), expected_basis: '' }
  const changed = { ...row(), source_changed: true }
  for (const current of [missing, changed]) {
    const draft = drafts.reconcileNormalizationDraft(null, current)
    draft.canonical = 'ge533'
    draft.basis = 'basis'
    assert.equal(drafts.canSubmitNormalizationDraft(draft, current), false)
    assert.equal(drafts.restartNormalizationDraft(draft, current), false)
  }
})
test('mounted controller keeps off-page and no-longer-queued drafts visible', async () => {
  let items = [row()]
  const api = fixture(async () => ({ items, page: 1 }))
  await api.loadReviews()
  Object.assign(api.reviewDraft.value['row-a'], { canonical: 'ge533', basis: 'manual ma evidence' })
  items = []
  await api.loadReviews()
  assert.equal(api.offPageDrafts.value[0].canonical, 'ge533')
  items = [row()]
  await api.loadReviews()
  assert.equal(api.reviewDraft.value['row-a'].canonical, 'ge533')
  items = [row('source-si', 'si533')]
  await api.loadReviews()
  assert.equal(api.reviewDraft.value['row-a'].stale, true)
  assert.equal(api.reviewDraft.value['row-a'].history[0].basis, 'manual ma evidence')
})
test('save sends captured basis and late success cannot publish into replacement context', async () => {
  const wait = pending()
  let items = [row()]
  const calls = []
  const api = fixture(
    async () => ({ items, page: 1 }),
    async (...args) => {
      calls.push(args)
      return wait.promise
    }
  )
  await api.loadReviews()
  Object.assign(api.reviewDraft.value['row-a'], { canonical: 'ge533', basis: 'ma evidence' })
  const saving = api.saveReview(api.reviewRows.value[0])
  assert.equal(calls[0][1].expectedBasis, 'source-ma')
  items = [row('source-si', 'si533')]
  await api.loadReviews()
  wait.resolve({})
  await saving
  assert.equal(api.schemeSuccess.value, '')
  assert.equal(api.reviewDraft.value['row-a'].stale, true)
})
test('409 retains a removed-row draft for viewing and cannot silently enable re-submission', async () => {
  let items = [row()]
  const api = fixture(
    async () => ({ items, page: 1 }),
    async () => {
      items = []
      throw { status: 409, message: 'context changed' }
    }
  )
  await api.loadReviews()
  Object.assign(api.reviewDraft.value['row-a'], { canonical: 'ge533', basis: 'ma evidence' })
  await api.saveReview(api.reviewRows.value[0])
  assert.match(api.schemeError.value, /context changed/)
  assert.equal(api.offPageDrafts.value[0].basis, 'ma evidence')
  assert.equal(api.offPageDrafts.value[0].stale, true)
})

test('409 followed by failed refresh cannot relabel an old source as current', async () => {
  let loads = 0
  const api = fixture(
    async () => {
      if (++loads > 1) throw new Error('network')
      return { items: [row()], page: 1 }
    },
    async () => {
      throw { status: 409, message: 'changed' }
    }
  )
  await api.loadReviews()
  Object.assign(api.reviewDraft.value['row-a'], { canonical: 'ge533', basis: 'ma evidence' })
  await api.saveReview(api.reviewRows.value[0])
  const draft = api.reviewDraft.value['row-a']
  assert.equal(draft.requiresReload, true)
  api.restartReview(api.reviewRows.value[0])
  assert.equal(draft.stale, true)
  assert.equal(draft.canonical, 'ge533')
  assert.equal(drafts.canSubmitNormalizationDraft(draft, row()), false)
})
