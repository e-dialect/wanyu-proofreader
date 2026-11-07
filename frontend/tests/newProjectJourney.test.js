import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ref } from 'vue'

const source = readFileSync(
  new URL('../src/views/admin/NewProjectView.vue', import.meta.url),
  'utf8'
)
const script = source
  .split('<script setup>')[1]
  .split('</script>')[0]
  .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\n/gm, '')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function mount({ create, refresh = async () => ({}), navigate = async () => {} } = {}) {
  const auth = {
    user: { id: 'owner' },
    token: 'session-a',
    canCreateProjects: true,
    loadAccessContext: refresh
  }
  const route = { fullPath: '/admin/projects/new' },
    created = [],
    navigations = [],
    cleanup = [],
    mounted = []
  const bindings = {
    ref,
    useRoute: () => route,
    useRouter: () => ({
      replace: async (target) => {
        navigations.push(target)
        return navigate(target)
      }
    }),
    useAuthStore: () => auth,
    onMounted: (callback) => mounted.push(callback),
    onBeforeUnmount: (callback) => cleanup.push(callback),
    getPbMessage: (error, fallback) => error?.message || fallback,
    createProject: async (payload) => {
      created.push(payload)
      return create ? create(payload) : { id: 'new-project' }
    }
  }
  const state = new Function(
    ...Object.keys(bindings),
    `${script};return { handleSubmit, form, checkingPermission, loading, error, success, createdProject }`
  )(...Object.values(bindings))
  state.checkingPermission.value = false
  state.form.value = {
    name: '合成项目',
    description: '精确字 a̤̍⁵³³',
    accessMode: 'password',
    password: 'SyntheticPassword'
  }
  return {
    ...state,
    auth,
    route,
    created,
    navigations,
    mounted,
    dispose: () => cleanup.forEach((callback) => callback())
  }
}

test('successful creation enters materials immediately even while capability refresh is pending', async () => {
  const pending = deferred()
  const state = mount({ refresh: () => pending.promise })
  await state.handleSubmit()
  assert.deepEqual(state.created, [
    {
      name: '合成项目',
      description: '精确字 a̤̍⁵³³',
      accessMode: 'password',
      password: 'SyntheticPassword'
    }
  ])
  assert.deepEqual(state.navigations, [
    { path: '/admin/projects/new-project', query: { section: 'materials', view: 'import' } }
  ])
  assert.equal(state.success.value, true)
  assert.equal(state.error.value, '')
  pending.resolve({})
})

for (const interruption of ['unmount', 'account', 'token', 'route']) {
  test(`a late creation result cannot publish or redirect after ${interruption}`, async () => {
    const pending = deferred()
    let refreshes = 0
    const state = mount({
      create: () => pending.promise,
      refresh: async () => {
        refreshes++
      }
    })
    const submission = state.handleSubmit()
    if (interruption === 'unmount') state.dispose()
    if (interruption === 'account') state.auth.user = { id: 'another-user' }
    if (interruption === 'token') state.auth.token = 'session-b'
    if (interruption === 'route') state.route.fullPath = '/workspace'
    pending.resolve({ id: 'late-project' })
    await submission
    assert.deepEqual(state.navigations, [])
    assert.equal(state.createdProject.value, null)
    assert.equal(state.success.value, false)
    assert.equal(refreshes, 0)
  })
}

test('double submission makes one creation request and creation quotas are still a client gate', async () => {
  const pending = deferred()
  const state = mount({ create: () => pending.promise })
  const first = state.handleSubmit()
  await state.handleSubmit()
  assert.equal(state.created.length, 1)
  pending.resolve({ id: 'new-project' })
  await first
  const denied = mount()
  denied.auth.canCreateProjects = false
  await denied.handleSubmit()
  assert.deepEqual(denied.created, [])
})

test('failed navigation retries the already-created project even if its creation quota is now exhausted', async () => {
  let calls = 0
  const state = mount({
    navigate: async () => {
      if (++calls === 1) throw Error('navigation unavailable')
    },
    refresh: async () => {
      throw Error('permission refresh offline')
    }
  })
  await state.handleSubmit()
  assert.equal(state.createdProject.value.id, 'new-project')
  assert.match(state.error.value, /项目已创建/)
  state.auth.canCreateProjects = false
  await state.handleSubmit()
  assert.equal(state.created.length, 1)
  assert.equal(state.navigations.length, 2)
  assert.equal(state.error.value, '')
})

test('an old account permission-check failure cannot publish into a new account view', async () => {
  const pending = deferred()
  const state = mount({ refresh: () => pending.promise })
  state.checkingPermission.value = true
  const mounted = state.mounted[0]()
  state.auth.user = { id: 'another-user' }
  pending.reject(Error('old account rejected'))
  await mounted
  assert.equal(state.error.value, '')
  assert.equal(state.checkingPermission.value, true)
})
