import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ref, computed } from 'vue'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function mountActions(view, resourceResults = []) {
  const script = readFileSync(new URL(`../src/views/${view}.vue`, import.meta.url), 'utf8')
    .split('<script setup>')[1]
    .split('</script>')[0]
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\n/gm, '')
  const reloadCalls = []
  const cleanup = [],
    watchers = [],
    pushes = [],
    writes = []
  const request = deferred()
  const auth = {
    user: { id: 'alice' },
    token: 'session-a',
    accessContext: {},
    loadAccessContext: async () => ({})
  }
  const route = { path: '/tasks', fullPath: '/tasks?view=available', query: { view: 'available' } }
  let resources = 0
  const environment = {
    ref,
    computed,
    useRouter: () => ({ push: async (path) => pushes.push(path) }),
    useRoute: () => route,
    useAuthStore: () => auth,
    onMounted: () => {},
    onBeforeUnmount: (callback) => cleanup.push(callback),
    watch: (read, callback) => watchers.push({ read, callback }),
    useQueueReturnPosition: () => {},
    useAsyncResource: () => {
      const index = resources++
      return {
        data: ref(null),
        pending: ref(false),
        error: ref(''),
        reload: async () => {
          reloadCalls.push(index)
          return resourceResults[index] || { ok: false }
        },
        cancel: () => {}
      }
    },
    summarizeProofreaderQueues: () => ({}),
    currentUserId: () => auth.user.id,
    getProofreaderQueueAction: () => ({ canEnter: true }),
    claimNextProjectPage: () => request.promise,
    loadRecentWork: () => [],
    browserLocalStorage: () => null,
    saveTaskLease: (_storage, value) => writes.push(['lease', value]),
    saveGlyphQueue: (_storage, value) => writes.push(['glyph', value]),
    window: { sessionStorage: {} },
    getPbMessage: (error) => error.message,
    formatClaimConflict: (error) => error.message,
    formatPbError: (_label, error) => error.message
  }
  const proxy = new Proxy(environment, {
    has: () => true,
    get: (target, key) =>
      key === Symbol.unscopables ? undefined : key in target ? target[key] : globalThis[key]
  })
  const names = view.endsWith('TaskHallView')
    ? 'enterProject,openOwnSubmissions,claimingProject,actionError,taskView,hasLoadedProjects'
    : 'startProject,opening,actionError,refresh'
  const api = new Function('environment', `with(environment) { ${script}; return { ${names} } }`)(
    proxy
  )
  return {
    ...api,
    auth,
    route,
    request,
    pushes,
    writes,
    watchers,
    reloadCalls,
    dispose: () => cleanup.forEach((callback) => callback())
  }
}
const queue = { project: { id: 'project1' }, nextPage: { id: 'task1' } }
const claim = { id: 'task1', leaseToken: 'synthetic-lease-token', leaseExpiresAt: '2099-01-01' }

for (const interruption of ['dispose', 'token', 'route'])
  test(`a delayed task claim cannot save a lease or navigate after ${interruption}`, async () => {
    const mounted = mountActions('proofreader/TaskHallView')
    const result = mounted.enterProject(queue)
    if (interruption === 'dispose') mounted.dispose()
    if (interruption === 'token') mounted.auth.token = 'session-b'
    if (interruption === 'route') mounted.route.fullPath = '/tasks?view=reviewed'
    mounted.request.resolve(claim)
    await result
    assert.deepEqual(mounted.pushes, [])
    assert.deepEqual(mounted.writes, [])
    if (interruption !== 'dispose') assert.equal(mounted.claimingProject.value, '')
  })

test('a current task claim keeps the one-click path and saves its exact lease', async () => {
  const mounted = mountActions('proofreader/TaskHallView')
  const result = mounted.enterProject(queue)
  mounted.request.resolve(claim)
  await result
  assert.deepEqual(mounted.pushes, [{ path: '/tasks/task1/edit', query: {} }])
  assert.equal(mounted.writes[0][1].token, claim.leaseToken)
})

test('opening own submissions keeps the original queue location without reading or claiming a task', async () => {
  const mounted = mountActions('proofreader/TaskHallView')
  mounted.route.query.project = 'project1'
  await mounted.openOwnSubmissions(queue)
  assert.deepEqual(mounted.pushes, [
    {
      name: 'OwnSubmissions',
      params: { projectId: 'project1' },
      query: { taskView: 'available', taskPage: '1', taskProject: 'project1' }
    }
  ])
  assert.deepEqual(mounted.writes, [])
  assert.deepEqual(mounted.reloadCalls, [])
})

test('a delayed home claim cannot redirect after the workbench unmounts', async () => {
  const mounted = mountActions('WorkspaceHomeView')
  const result = mounted.startProject(queue)
  mounted.dispose()
  mounted.request.resolve(claim)
  await result
  assert.deepEqual(mounted.pushes, [])
  assert.deepEqual(mounted.writes, [])
})

test('home reads manager work from its successful context even while the shell owns store publication', async () => {
  const mounted = mountActions('WorkspaceHomeView', [
    { ok: true, data: { managedProjectIds: ['project1'] } }
  ])
  await mounted.refresh()
  assert.deepEqual(mounted.reloadCalls, [0, 1, 2])
})

test('a proofreader home does not request management data without management capability', async () => {
  const mounted = mountActions('WorkspaceHomeView', [{ ok: true, data: { managedProjectIds: [] } }])
  await mounted.refresh()
  assert.deepEqual(mounted.reloadCalls, [0, 1])
})
