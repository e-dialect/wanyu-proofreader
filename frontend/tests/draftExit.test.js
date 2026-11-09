import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { ref, nextTick } from 'vue'
import { createDraftExitRegistry } from '../src/lib/draftExit.js'
import { useProofreadDrafts } from '../src/composables/proofread/useProofreadDrafts.js'

function storage() {
  const values = new Map()
  return {
    get length() {
      return values.size
    },
    key: (index) => [...values.keys()][index],
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  }
}
const draftKey = (account) => `fangji:task-draft:v1:${account}:page`

test('explicit exit flushes only the current account before counting current and historical drafts', () => {
  const data = storage(),
    registry = createDraftExitRegistry()
  data.setItem(draftKey('b'), 'other account unique copy')
  data.setItem(`${draftKey('a')}:history:old`, 'malformed but retained history')
  let flushed = 0
  const release = registry.register({
    userId: 'a',
    flush() {
      flushed++
      data.setItem(
        draftKey('a'),
        JSON.stringify({ userId: 'a', pageId: 'page', row: { 字: '𠮷 a̤̍' } })
      )
      return { ok: true }
    }
  })
  registry.register({ userId: 'b', flush: () => assert.fail('must not flush another account') })
  assert.deepEqual(registry.prepare('a', data), { ok: true, total: 2, history: 1 })
  assert.equal(data.getItem(draftKey('b')), 'other account unique copy')
  assert.equal(data.getItem(`${draftKey('a')}:history:old`), 'malformed but retained history')
  release()
  registry.prepare('a', data)
  assert.equal(flushed, 1)
})

test('save failure or unavailable storage blocks the explicit exit without deleting any copy', () => {
  const data = storage(),
    registry = createDraftExitRegistry()
  data.setItem(draftKey('a'), 'only existing copy')
  registry.register({ userId: 'a', flush: () => ({ ok: false }) })
  assert.equal(registry.prepare('a', data).ok, false)
  assert.equal(data.getItem(draftKey('a')), 'only existing copy')
  registry.clear()
  assert.equal(registry.prepare('a', null).ok, false)
  assert.equal(
    registry.prepare('a', {
      get length() {
        throw Error('denied')
      }
    }).ok,
    false
  )
})

test('editor flush reports persistence failure and remains bound to its mounting account', () => {
  const oldWindow = globalThis.window
  const data = storage()
  globalThis.window = {
    localStorage: data,
    clearTimeout() {},
    setTimeout() {
      return 1
    }
  }
  const user = ref('a')
  const state = {
    draftReady: ref(true),
    draftStatus: ref(''),
    ownReview: ref(false),
    page: ref({ id: 'page' }),
    currentUserId: user,
    initialRowJson: ref('{"字":"旧"}'),
    hasUnsavedChanges: ref(true),
    stringifyEditedRow: () => '{"字":"最后500毫秒𠮷"}',
    verificationContext: ref({ basis: 'basis' }),
    restoredLocalDraft: ref(null),
    staleLocalDrafts: ref([]),
    replaceEditedRow() {},
    originalRow: ref({ 字: '旧' })
  }
  try {
    const editor = useProofreadDrafts(state)
    user.value = 'b'
    data.setItem(draftKey('b'), 'b original')
    assert.deepEqual(editor.flushDraft(), { ok: true, saved: true })
    assert.equal(JSON.parse(data.getItem(draftKey('a'))).row.字, '最后500毫秒𠮷')
    assert.equal(data.getItem(draftKey('b')), 'b original')
    state.hasUnsavedChanges.value = false
    const preserved = data.getItem(draftKey('a'))
    assert.deepEqual(editor.flushDraft({ preserveExisting: true }), { ok: true, saved: false })
    assert.equal(data.getItem(draftKey('a')), preserved)
    state.hasUnsavedChanges.value = true
    data.setItem = () => {
      throw Error('quota')
    }
    assert.deepEqual(editor.flushDraft(), { ok: false, saved: false })
    assert.match(state.draftStatus.value, /保存失败/)
  } finally {
    globalThis.window = oldWindow
  }
})

function logoutHost() {
  const data = storage(),
    cleanup = [],
    routes = []
  let listener,
    registry,
    clears = 0
  const authStore = {
    isValid: true,
    model: { id: 'a' },
    onChange(fn) {
      listener = fn
      return () => {}
    }
  }
  const bindings = {
    ref,
    nextTick,
    inject() {},
    provide: (_key, value) => {
      registry = value
    },
    onBeforeUnmount: (fn) => cleanup.push(fn),
    pb: { authStore },
    browserLocalStorage: () => data,
    createDraftExitRegistry
  }
  const source = readFileSync(
    new URL('../src/composables/useDraftLogout.js', import.meta.url),
    'utf8'
  )
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\n/gm, '')
    .replace(/^export /gm, '')
  const useDraftLogout = new Function(...Object.keys(bindings), `${source};return useDraftLogout`)(
    ...Object.values(bindings)
  )
  const api = useDraftLogout({
    auth: {
      logout() {
        clears++
        authStore.isValid = false
        listener()
      }
    },
    router: {
      async push(route) {
        routes.push(route)
      }
    }
  })
  return {
    api,
    registry,
    data,
    routes,
    clears: () => clears,
    switchAccount(id) {
      authStore.isValid = Boolean(id)
      authStore.model = id ? { id } : null
      listener()
    },
    dispose() {
      cleanup.forEach((fn) => fn())
    }
  }
}

test('an open logout decision cannot survive A to B to A, and confirmation rechecks persistence', async () => {
  const host = logoutHost()
  let saveWorks = true,
    flushes = 0
  host.registry.register({
    userId: 'a',
    flush() {
      flushes++
      return { ok: saveWorks }
    }
  })
  host.data.setItem(draftKey('a'), 'a retained draft')
  try {
    await host.api.requestLogout()
    assert.equal(host.api.open.value, true)
    host.switchAccount('b')
    host.switchAccount('a')
    await host.api.confirmLogout()
    assert.equal(host.clears(), 0)
    assert.equal(host.api.open.value, false)
    await host.api.requestLogout()
    saveWorks = false
    await host.api.confirmLogout()
    assert.equal(host.clears(), 0)
    assert.equal(host.api.open.value, true)
    assert.match(host.api.error.value, /尚未保存/)
    saveWorks = true
    await host.api.confirmLogout()
    assert.equal(host.clears(), 1)
    assert.deepEqual(host.routes, ['/login'])
    assert.equal(host.data.getItem(draftKey('a')), 'a retained draft')
    assert.equal(flushes, 4)
  } finally {
    host.dispose()
  }
})

test('explicit logout without current-account drafts exits directly after a successful flush', async () => {
  const host = logoutHost()
  host.registry.register({ userId: 'a', flush: () => ({ ok: true }) })
  host.data.setItem(draftKey('b'), 'other account copy')
  try {
    await host.api.requestLogout()
    assert.equal(host.clears(), 1)
    assert.equal(host.api.open.value, false)
    assert.deepEqual(host.routes, ['/login'])
    assert.equal(host.data.getItem(draftKey('b')), 'other account copy')
  } finally {
    host.dispose()
  }
})
