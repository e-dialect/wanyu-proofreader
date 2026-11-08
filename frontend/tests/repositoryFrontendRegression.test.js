import { jobObserverScope } from './helpers/jobObserverScope.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computed, reactive, ref } from 'vue'
import { adminRouteKey } from '../src/lib/adminRouteKey.js'
import * as taskDraft from '../src/lib/taskDraft.js'
import * as normalizationDraft from '../src/lib/normalizationDraft.js'

const regression = (name, run) => test(name, { timeout: 5000 }, run)

const stripImports = (source) => source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\n/gm, '')
function evaluate(path, names, overrides = {}) {
  const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
  const script = source.includes('<script setup>')
    ? source.split('<script setup>')[1].split('</script>')[0]
    : source
  const cleanup = []
  const scope = {
    ...jobObserverScope(cleanup),
    ref,
    reactive,
    computed,
    watch: () => {},
    onMounted: () => {},
    onBeforeUnmount: (callback) => cleanup.push(callback),
    getPbMessage: (error) => error.message,
    ...normalizationDraft,
    ...overrides
  }
  const environment = new Proxy(scope, {
    has: () => true,
    get: (target, name) =>
      name === Symbol.unscopables ? undefined : name in target ? target[name] : globalThis[name]
  })
  const body = stripImports(script).replace(/^export /gm, '')
  const value = new Function(
    'environment',
    `with (environment) { ${body}\nreturn { ${names.join(',')} } }`
  )(environment)
  return { ...value, dispose: () => cleanup.forEach((callback) => callback()) }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function memoryStorage() {
  const data = new Map()
  return {
    get length() {
      return data.size
    },
    key: (index) => [...data.keys()][index],
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key)
  }
}

regression(
  'project workspaces remount on identity changes and keep query-only pagination mounted',
  () => {
    const a = { name: 'SourceFidelity', params: { id: 'a' }, query: { page: '1' } }
    assert.notEqual(adminRouteKey(a), adminRouteKey({ ...a, params: { id: 'b' } }))
    assert.equal(adminRouteKey(a), adminRouteKey({ ...a, query: { page: '2' } }))
    assert.notEqual(
      adminRouteKey({ name: 'Arbitration', params: { projectId: 'p', pageId: 'a' } }),
      adminRouteKey({ name: 'Arbitration', params: { projectId: 'p', pageId: 'b' } })
    )
    const layout = readFileSync(
      new URL('../src/views/admin/AdminLayout.vue', import.meta.url),
      'utf8'
    )
    assert.match(layout, /<RouterView :key="adminRouteKey\(route\)"/)
  }
)

regression(
  'auth getters react to logout and cross-tab identity changes invalidate capability cache and pending requests',
  async () => {
    let listener
    const pending = deferred()
    let calls = 0
    const pb = {
      authStore: {
        model: { id: 'a' },
        token: 'a-token',
        isValid: true,
        onChange: (fn) => {
          listener = fn
        }
      }
    }
    const { useAuthStore } = evaluate('stores/auth.js', ['useAuthStore'], {
      pb,
      defineStore: (_name, setup) => setup,
      getAccessContext: () => {
        calls++
        return calls === 1 ? pending.promise : Promise.resolve({ managedProjectIds: ['b-project'] })
      },
      platformAdmin: () => false,
      projectRoles: () => ({})
    })
    const store = useAuthStore()
    assert.equal(store.isLoggedIn.value, true)
    const oldRequest = store.loadAccessContext()
    pb.authStore.model = { id: 'b' }
    pb.authStore.token = 'b-token'
    listener('b-token', { id: 'b' })
    const newRequest = store.loadAccessContext()
    assert.equal(calls, 2)
    await newRequest
    pending.resolve({ managedProjectIds: ['a-project'] })
    await oldRequest
    assert.deepEqual(store.accessContext.value, { managedProjectIds: ['b-project'] })
    pb.authStore.isValid = false
    pb.authStore.token = ''
    pb.authStore.model = null
    listener('', null)
    assert.equal(store.isLoggedIn.value, false)
    assert.equal(store.accessContext.value, null)
  }
)

function settingsFixture(updateProject) {
  const route = reactive({ params: { id: 'a' } })
  const calls = { memberLoads: [], navigations: [] }
  const api = evaluate(
    'views/admin/ProjectSettingsView.vue',
    [
      'saveDetails',
      'saveSettings',
      'addMember',
      'project',
      'details',
      'detailsDirty',
      'newMember',
      'success',
      'error'
    ],
    {
      useRoute: () => route,
      useRouter: () => ({ push: (path) => calls.navigations.push(path) }),
      useAuthStore: () => ({ loadAccessContext: async () => {} }),
      createCandidatePager: () => ({ search: async () => {} }),
      updateProject,
      setProjectMember: updateProject,
      listProjectMembers: async (id) => {
        calls.memberLoads.push(id)
        return []
      }
    }
  )
  api.project.value = { id: 'a', name: 'Old', description: '' }
  api.details.name = 'Edited'
  return { api, route, calls }
}

regression(
  'settings late saves cannot overwrite a different project or reload its member list',
  async () => {
    const waiting = deferred()
    const { api, route } = settingsFixture(() => waiting.promise)
    const operation = api.saveDetails()
    route.params.id = 'b'
    api.project.value = { id: 'b', name: 'B' }
    api.details.name = 'B local'
    waiting.resolve({ id: 'a', name: 'Edited' })
    await operation
    assert.equal(api.project.value.id, 'b')
    assert.equal(api.details.name, 'B local')
    const memberWaiting = deferred()
    const second = settingsFixture(() => memberWaiting.promise)
    const adding = second.api.addMember()
    second.api.dispose()
    second.route.params.id = 'b'
    memberWaiting.resolve({})
    await adding
    assert.deepEqual(second.calls.memberLoads, [])
  }
)

function verificationFixture(overrides = {}) {
  const props = reactive({
    page: { id: 'a' },
    row: { 词: '新' },
    leaseToken: 'lease-a',
    active: true,
    hints: []
  })
  const calls = { drafts: [], reports: [] }
  const api = evaluate(
    'components/editor/TaskVerificationPanel.vue',
    ['load', 'persistDraft', 'sendReport', 'data', 'saveError', 'message', 'saving', 'report'],
    {
      defineProps: () => props,
      defineEmits: () => () => {},
      defineExpose: () => {},
      nextTick: async () => {},
      getVerification: async (id) => ({ context: { basis: id, input: { 词: '新' } }, reports: [] }),
      saveVerificationDraft: async (...args) => {
        calls.drafts.push(args)
      },
      reportProblem: async (...args) => {
        calls.reports.push(args)
        return { id: 'report' }
      },
      ...overrides
    }
  )
  return { api, props, calls }
}

regression(
  'verification report from a previous task cannot attach to the new task and old draft failure cannot replace its error',
  async () => {
    const waiting = deferred()
    const f = verificationFixture({ reportProblem: () => waiting.promise })
    await f.api.load()
    f.api.report.description = 'Original report'
    const sending = f.api.sendReport()
    f.props.page = { id: 'b' }
    await f.api.load()
    waiting.resolve({ id: 'old-report' })
    await sending
    assert.deepEqual(f.api.data.value.reports, [])
    assert.equal(f.api.message.value, '')
    const failing = deferred()
    const started = deferred()
    const g = verificationFixture({
      saveVerificationDraft: () => {
        started.resolve()
        return failing.promise
      }
    })
    await g.api.load()
    const draft = g.api.persistDraft()
    await started.promise
    g.props.page = { id: 'b' }
    await g.api.load()
    g.api.saveError.value = 'new task error'
    failing.reject(new Error('old failure'))
    await assert.rejects(draft, /old failure/)
    assert.equal(g.api.saveError.value, 'new task error')
  }
)

regression(
  'unmount invalidates a verification request and prevents queued old drafts being sent',
  async () => {
    const waiting = deferred()
    const f = verificationFixture({ getVerification: () => waiting.promise })
    const loading = f.api.load()
    f.api.dispose()
    waiting.resolve({ context: { input: { 词: '旧' } }, reports: [] })
    await loading
    assert.equal(f.api.data.value, null)
    const g = verificationFixture()
    await g.api.load()
    const queued = g.api.persistDraft()
    g.api.dispose()
    await queued
    assert.deepEqual(g.calls.drafts, [])
  }
)

regression(
  'stale local draft survives unchanged navigation and repeated context reads preserve newly typed values',
  () => {
    const storage = memoryStorage()
    const oldWindow = globalThis.window
    globalThis.window = { localStorage: storage, clearTimeout, setTimeout }
    try {
      const state = {
        draftReady: ref(true),
        draftStatus: ref(''),
        ownReview: ref(false),
        page: ref({ id: 'p' }),
        currentUserId: ref('u'),
        initialRowJson: ref('{"词":"当前"}'),
        hasUnsavedChanges: ref(false),
        verificationContext: ref(null),
        restoredLocalDraft: ref(null),
        staleLocalDrafts: ref([]),
        originalRow: ref({ 词: '当前' })
      }
      let row = { 词: '当前' }
      state.stringifyEditedRow = () => JSON.stringify(row)
      state.replaceEditedRow = (value) => {
        row = { ...value }
      }
      const { useProofreadDrafts } = evaluate(
        'composables/proofread/useProofreadDrafts.js',
        ['useProofreadDrafts'],
        taskDraft
      )
      const old = {
        userId: 'u',
        pageId: 'p',
        sourceSignature: 'old-source',
        contextBasis: 'old-context',
        row: { 词: '珍贵旧草稿' }
      }
      taskDraft.saveTaskDraft(storage, old)
      const api = useProofreadDrafts(state)
      api.restoreDraft()
      api.flushDraft()
      assert.equal(taskDraft.loadTaskDraftHistory(storage, old)[0].row.词, '珍贵旧草稿')
      state.restoredLocalDraft.value = {
        ...old,
        sourceSignature: state.initialRowJson.value,
        savedAt: new Date().toISOString()
      }
      row = { 词: '刚恢复' }
      api.receiveVerificationContext({ basis: 'new-context' })
      assert.deepEqual(row, { 词: '当前' })
      row = { 词: '用户重新输入' }
      api.receiveVerificationContext({ basis: 'new-context' })
      assert.deepEqual(row, { 词: '用户重新输入' })
    } finally {
      globalThis.window = oldWindow
    }
  }
)

function sessionFixture(send) {
  const listeners = new Set()
  const store = {
    token: 'a-token',
    model: { id: 'a' },
    isValid: true,
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    save(token, record) {
      this.token = token
      this.model = record
      this.isValid = Boolean(token)
      for (const listener of listeners) listener(token, record)
    },
    clear() {
      this.save('', null)
    }
  }
  const api = evaluate(
    'services/authService.js',
    [
      'bindExternalIdentity',
      'loginWithPassword',
      'loginWithExternalProvider',
      'refreshStoredAuth',
      'updateProfile',
      'logoutAllDevices',
      'changeAccountPassword'
    ],
    {
      pb: {
        authStore: store,
        send,
        collection: () => ({
          // PocketBase SDK methods publish auth responses before their promise resolves.
          authWithPassword: async () => {
            const result = await send()
            store.save(result.token, result.record)
            return result
          },
          authRefresh: async () => {
            const result = await send()
            store.save(result.token, result.record)
            return result
          }
        })
      },
      shouldClearAuthAfterRefreshError: (error) => [401, 403].includes(error.status)
    }
  )
  return { api, store, listeners }
}

regression(
  'late external binding and login responses cannot resurrect a cleared or replaced session',
  async () => {
    for (const method of [
      'bindExternalIdentity',
      'loginWithExternalProvider',
      'loginWithPassword'
    ]) {
      const waiting = deferred()
      const { api, store, listeners } = sessionFixture(() => waiting.promise)
      const pending =
        method === 'loginWithPassword'
          ? api[method]('identity', 'password')
          : api[method]('provider', 'identity', 'password')
      store.clear()
      if (method !== 'loginWithPassword') store.save('b-token', { id: 'b' })
      waiting.resolve({ token: 'late-a-token', record: { id: 'a' } })
      await assert.rejects(pending, { name: 'AbortError' })
      assert.equal(store.token, method === 'loginWithPassword' ? '' : 'b-token')
      assert.equal(listeners.size, 0)
    }
  }
)

regression(
  'late refresh rejection cannot log out a newer account and current refresh still updates credentials',
  async () => {
    const waiting = deferred()
    const { api, store } = sessionFixture(() => waiting.promise)
    const refresh = api.refreshStoredAuth()
    store.save('b-token', { id: 'b' })
    waiting.reject({ status: 403 })
    assert.equal(await refresh, null)
    assert.equal(store.token, 'b-token')
    const current = sessionFixture(async () => ({ token: 'fresh-token', record: { id: 'a' } }))
    await current.api.refreshStoredAuth()
    assert.equal(current.store.token, 'fresh-token')
    const rejected = sessionFixture(async () => {
      throw { status: 401 }
    })
    await rejected.api.refreshStoredAuth()
    assert.equal(rejected.store.token, '')
  }
)

regression(
  'profile update does not roll a newer token for the same account backwards',
  async () => {
    const waiting = deferred()
    const { api, store } = sessionFixture(() => waiting.promise)
    const update = api.updateProfile({ name: 'updated', email: '' })
    store.save('newer-token', { id: 'a', name: 'newer' })
    waiting.resolve({ token: 'older-token', record: { id: 'a', name: 'updated' } })
    await assert.rejects(update, { name: 'AbortError' })
    assert.equal(store.token, 'newer-token')
    assert.equal(store.model.name, 'newer')
  }
)

regression(
  'confirmed same-component task navigation flushes the debounce draft before the task changes',
  () => {
    const source = readFileSync(
      new URL('../src/composables/proofread/useProofreadEditor.js', import.meta.url),
      'utf8'
    )
    const body = source.slice(
      source.indexOf('  function confirmDiscardChanges()'),
      source.indexOf('  function handleBeforeUnload')
    )
    let flushes = 0
    const guard = new Function(
      'saving',
      'releasing',
      'reclaiming',
      'returning',
      'ownReview',
      'hasUnsavedChanges',
      'flushDraft',
      `${body}; return confirmDiscardChanges`
    )(ref(false), ref(false), ref(false), ref(false), ref(false), ref(true), () => {
      flushes++
    })
    const original = globalThis.window
    globalThis.window = { confirm: () => true }
    try {
      assert.equal(guard(), true)
      assert.equal(flushes, 1)
    } finally {
      globalThis.window = original
    }
  }
)

regression(
  'a lease response after disposing its case cannot restart the renewal interval',
  async () => {
    const waiting = deferred(),
      started = deferred()
    let version = 1,
      timers = 0
    const original = globalThis.window
    globalThis.window = {
      sessionStorage: {},
      setInterval: () => {
        timers++
        return 1
      },
      clearInterval: () => {}
    }
    try {
      const { useProofreadLease } = evaluate(
        'composables/proofread/useProofreadLease.js',
        ['useProofreadLease'],
        {
          loadTaskLease: () => ({ token: 'token', expiresAt: 'future' }),
          saveTaskLease: () => {},
          renewTaskLease: () => {
            started.resolve()
            return waiting.promise
          }
        }
      )
      const context = Object.fromEntries(
        [
          'page',
          'currentUserId',
          'leaseToken',
          'leaseExpiresAt',
          'leaseLost',
          'saveError',
          'reviewingSubmission',
          'renewingLease',
          'reclaiming',
          'releasing',
          'leaseNavigationAllowed',
          'verificationPanel'
        ].map((key) => [key, ref(null)])
      )
      Object.assign(context, {
        page: ref({ id: 'a' }),
        captureCase: () => version,
        isCurrentCase: (scope) => scope === version
      })
      const api = useProofreadLease(context)
      const operation = api.restoreOrAcquireLease()
      await started.promise
      version++
      waiting.resolve({ leaseExpiresAt: 'future' })
      await operation
      assert.equal(timers, 0)
    } finally {
      globalThis.window = original
    }
  }
)

regression(
  'normalization filtering drops out-of-order responses and refresh preserves manual text for the same item',
  async () => {
    const old = deferred(),
      next = deferred()
    let calls = 0
    const api = evaluate(
      'components/admin/project/ProjectSchemePanel.vue',
      ['loadReviews', 'reviewRows', 'reviewDraft', 'reviewStatusFilter'],
      {
        defineProps: () => ({ projectId: 'p' }),
        defineExpose: () => {},
        listNormalizations: () =>
          ++calls === 1
            ? old.promise
            : calls === 2
              ? next.promise
              : Promise.resolve({
                  items: [{ id: 'latest', expected_basis: 'same-basis' }],
                  page: 1
                })
      }
    )
    const first = api.loadReviews()
    api.reviewStatusFilter.value = 'UNSUPPORTED'
    const second = api.loadReviews()
    next.resolve({ items: [{ id: 'latest', expected_basis: 'same-basis' }], page: 1 })
    await second
    old.resolve({ items: [{ id: 'old-filter' }], page: 1 })
    await first
    assert.equal(api.reviewRows.value[0].id, 'latest')
    Object.assign(api.reviewDraft.value.latest, { canonical: 'ɡa̤⁵³³', basis: '人工填写依据' })
    await api.loadReviews()
    assert.equal(api.reviewDraft.value.latest.canonical, 'ɡa̤⁵³³')
    assert.equal(api.reviewDraft.value.latest.basis, '人工填写依据')
  }
)

regression('PDF fallback arms expiration to recheck the authorization window', async () => {
  const originalFetch = globalThis.fetch,
    originalTimer = globalThis.setTimeout
  const timers = []
  const descriptor = {
    key: 'pdf',
    start: 1,
    end: 2,
    total: 8,
    expiresAt: new Date(Date.now() + 60000).toISOString()
  }
  globalThis.setTimeout = (callback, milliseconds) => {
    timers.push({ callback, milliseconds })
    return 1
  }
  globalThis.fetch = async (url) =>
    url.endsWith('/descriptor')
      ? Response.json(descriptor)
      : new Response('synthetic-pdf', {
          headers: {
            'X-PDF-Preview-Key': descriptor.key,
            'X-PDF-Expires-At': descriptor.expiresAt,
            'X-PDF-Start-Page': '1',
            'X-PDF-End-Page': '2',
            'X-PDF-Total-Pages': '8'
          }
        })
  try {
    const { useProjectPdf } = evaluate('composables/useProjectPdf.js', ['useProjectPdf'], {
      pb: {
        authStore: { record: { id: 'u' }, token: 'token', onChange: () => () => {} },
        buildURL: (value) => `https://example.test${value}`
      },
      createPdfPreviewCache: () => ({
        clear: () => {},
        get: () => null,
        put: () => ({ url: 'blob:pdf', expires: Date.parse(descriptor.expiresAt) })
      }),
      createPageImageCache: () => ({
        clear: () => {},
        load: async () => {
          throw new Error('no page image')
        }
      })
    })
    const api = useProjectPdf(ref({ id: 'page', pdf_page: 1 }))
    await api.resolveProjectPdf()
    assert.equal(api.pdfUrl.value, 'blob:pdf')
    assert.equal(timers.length, 1)
    assert.ok(timers[0].milliseconds > 0 && timers[0].milliseconds <= 60000)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalTimer
  }
})

regression(
  'arbitration progress only marks the submitted note as saved when the note changes during the request',
  async () => {
    const source = readFileSync(
      new URL('../src/views/admin/ArbitrationView.vue', import.meta.url),
      'utf8'
    )
    const body = source.slice(
      source.indexOf('async function saveProgress('),
      source.indexOf('function onFinalInput(')
    )
    const waiting = deferred()
    const context = {
      caseVersion: 1,
      pageId: ref('p'),
      projectId: ref('project'),
      submitting: ref(false),
      submitError: ref(''),
      progressMessage: ref(''),
      verificationData: ref({ context: { basis: 'basis' } }),
      finalRow: {},
      judgmentPayload: () => [],
      note: ref('submitted note'),
      resolutionSource: {},
      saveSourceJudgments: () => waiting.promise,
      judgmentDrafts: {},
      getVerification: async () => ({ context: { basis: 'basis' } }),
      touchedHeaders: new Set(),
      lastSavedNote: ref('old'),
      getPbMessage: (error) => error.message
    }
    const save = new Function('scope', `with(scope){ ${body}; return saveProgress }`)(context)
    const operation = save(false)
    context.note.value = 'new unsaved note'
    waiting.resolve({ judgments: [] })
    await operation
    assert.equal(context.lastSavedNote.value, 'submitted note')
    assert.notEqual(context.lastSavedNote.value, context.note.value)
  }
)

regression(
  'logout-all ends only its own local session, including uncertain network results',
  async () => {
    const waiting = deferred()
    const { api, store } = sessionFixture(() => waiting.promise)
    const pending = api.logoutAllDevices()
    store.save('b-token', { id: 'b' })
    waiting.resolve(null)
    await pending
    assert.equal(store.token, 'b-token')
    const uncertain = sessionFixture(async () => {
      throw new Error('network interrupted')
    })
    await assert.rejects(uncertain.api.logoutAllDevices(), /network interrupted/)
    assert.equal(uncertain.store.token, '')
  }
)
regression('password update cannot clear a newer tab session', async () => {
  const waiting = deferred()
  const { api, store } = sessionFixture(() => waiting.promise)
  const pending = api.changeAccountPassword('old', 'new', 'new')
  store.save('b-token', { id: 'b' })
  waiting.resolve({ id: 'a' })
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(store.token, 'b-token')
})
