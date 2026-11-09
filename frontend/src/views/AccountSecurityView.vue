<template>
  <main class="container page account-security">
    <RouterLink to="/tasks/profile">← 个人中心</RouterLink>
    <h1 class="compact-page-title mt-4 mb-4">账户安全</h1>
    <p class="text-muted mb-6">
      密码、邮箱和本机资料由你管理。改密或退出所有设备后，其他设备需重新登录；已经提交的校对记录仍保留。
    </p>
    <div v-if="error" class="alert alert-error mb-4" role="alert">{{ error }}</div>
    <div v-if="message" class="alert alert-success mb-4" role="status">{{ message }}</div>
    <section class="card mb-6" aria-labelledby="password-title">
      <h2 id="password-title" class="card-title">修改密码</h2>
      <form @submit.prevent="changePassword">
        <label class="form-group"
          ><span class="form-label">当前密码</span
          ><input
            v-model="oldPassword"
            type="password"
            class="form-control"
            autocomplete="current-password"
            required
            :disabled="busy"
        /></label>
        <label class="form-group"
          ><span class="form-label">新密码</span
          ><input
            v-model="password"
            type="password"
            class="form-control"
            autocomplete="new-password"
            maxlength="71"
            required
            :disabled="busy"
        /></label>
        <label class="form-group"
          ><span class="form-label">确认新密码</span
          ><input
            v-model="confirmation"
            type="password"
            class="form-control"
            autocomplete="new-password"
            maxlength="71"
            required
            :disabled="busy"
        /></label>
        <p class="text-muted text-sm mb-4">
          10–71 个字符，UTF-8 编码不超过 72 字节。外部账号没有本地密码时，可先通过已验证邮箱恢复。
        </p>
        <button class="btn btn-primary" :disabled="busy">
          {{ busy ? '正在处理…' : '更新密码并重新登录' }}
        </button>
      </form>
    </section>
    <section class="card mb-6" aria-labelledby="email-title">
      <h2 id="email-title" class="card-title">登录邮箱</h2>
      <p class="mb-4">
        {{ auth.user?.email || '尚未设置' }} ·
        {{ auth.user?.verified && auth.user?.email ? '已验证' : '未验证' }}
      </p>
      <p v-if="capabilityLoading" role="status">正在检查邮箱服务…</p>
      <p v-else-if="!emailEnabled" class="text-muted">
        本站尚未启用邮箱操作。需要恢复账号时，请联系项目管理员。
      </p>
      <template v-else>
        <button
          v-if="auth.user?.email && !auth.user?.verified"
          class="btn btn-secondary mb-4"
          :disabled="busy"
          @click="verifyEmail"
        >
          发送验证邮件
        </button>
        <form @submit.prevent="changeEmail">
          <label class="form-group"
            ><span class="form-label">新邮箱</span
            ><input
              v-model.trim="newEmail"
              type="email"
              autocomplete="email"
              class="form-control"
              required
              maxlength="255"
              :disabled="busy"
          /></label>
          <p class="text-muted text-sm mb-4">
            打开新邮箱中的链接并输入当前密码后生效，所有设备随后需重新登录。
          </p>
          <button class="btn btn-secondary" :disabled="busy">发送更换邮箱确认邮件</button>
        </form>
      </template>
    </section>
    <section class="card mb-6" aria-labelledby="sessions-title">
      <h2 id="sessions-title" class="card-title">登录状态</h2>
      <p class="text-muted mb-4">
        在公共设备使用过账号，或怀疑密码泄露时，可使所有现有登录失效。已完成的操作不会撤回，本机草稿不会被清除。
      </p>
      <button class="btn btn-secondary" :disabled="busy" @click="confirmLogout = true">
        退出所有设备
      </button>
    </section>
    <section class="card mb-6" aria-labelledby="drafts-title">
      <h2 id="drafts-title" class="card-title">当前账号的本机草稿</h2>
      <p class="text-muted mb-4">
        此浏览器保留 {{ drafts.length }} 份草稿（含历史版本），其中 {{ oldDraftCount }} 份超过 30
        天。它们可能尚未提交，不会自动删除；其他设备与其他账号的资料不在此列表。
      </p>
      <p v-if="!drafts.length" role="status">当前账号没有保存在此浏览器的草稿。</p>
      <ul v-else class="mb-4">
        <li v-for="draft in drafts.slice(0, 10)" :key="draft.key">
          条目 {{ draft.pageId }} · {{ draft.history ? '历史版本' : '当前草稿' }} ·
          {{ draft.savedAt ? formatTime(draft.savedAt) : '时间未知' }}
        </li>
      </ul>
      <div class="flex gap-2">
        <button class="btn btn-secondary" :disabled="!drafts.length" @click="exportDrafts">
          导出全部草稿</button
        ><button class="btn btn-secondary" :disabled="!drafts.length" @click="prepareDraftRemoval">
          清理本机草稿…</button
        ><button class="btn btn-secondary" @click="loadDrafts">刷新</button>
      </div>
    </section>
    <section class="card mb-6" aria-labelledby="events-title">
      <h2 id="events-title" class="card-title">最近的账户安全记录</h2>
      <p v-if="eventsLoading" role="status">正在读取记录…</p>
      <p v-else-if="eventsError" role="alert">
        {{ eventsError }} <button class="btn btn-secondary btn-sm" @click="loadEvents">重试</button>
      </p>
      <p v-else-if="!events.length" class="text-muted">暂无记录。启用前的历史操作不会补记。</p>
      <ul v-else>
        <li v-for="event in events" :key="event.id">
          {{ securityEventLabel(event.eventType) }} · {{ securityOutcomeLabel(event.outcome) }} ·
          {{ formatTime(event.created) }}
        </li>
      </ul>
    </section>
    <AppModal :open="confirmLogout" title-id="logout-all-title" @close="confirmLogout = false">
      <h2 id="logout-all-title">退出所有设备？</h2>
      <p>当前页面也会退出。请先保存正在编辑的工作。</p>
      <template #actions
        ><button class="btn btn-secondary" :disabled="busy" @click="confirmLogout = false">
          取消</button
        ><button class="btn btn-primary" :disabled="busy" @click="logoutAll">
          确认退出
        </button></template
      >
    </AppModal>
    <AppModal
      :open="confirmDraftRemoval"
      title-id="remove-drafts-title"
      @close="confirmDraftRemoval = false"
    >
      <h2 id="remove-drafts-title">清理此账号的本机草稿？</h2>
      <p>
        这会删除
        {{ removalSnapshot.length }} 份本机草稿，可能包含尚未提交的内容。先导出并妥善保存文件。
      </p>
      <label class="form-group"
        ><input v-model="removalAcknowledged" type="checkbox" />
        我已导出需要保留的草稿，或确认这些内容可以删除。</label
      >
      <template #actions
        ><button class="btn btn-secondary" @click="confirmDraftRemoval = false">取消</button
        ><button class="btn btn-primary" :disabled="!removalAcknowledged" @click="removeDrafts">
          确认清理
        </button></template
      >
    </AppModal>
  </main>
</template>
<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { createAccountViewScope } from '@/lib/accountViewScope'
import { useRouter } from 'vue-router'
import AppModal from '@/components/AppModal.vue'
import { useAuthStore } from '@/stores/auth'
import {
  accountCapabilities,
  changeAccountPassword,
  requestEmailChange,
  requestEmailVerification,
  logoutAllDevices,
  listSecurityEvents
} from '@/services/authService'
import { passwordProblem, securityEventLabel, securityOutcomeLabel } from '@/lib/accountSecurity'
import {
  listLocalAccountDrafts,
  exportLocalAccountDrafts,
  removeLocalAccountDrafts
} from '@/lib/localAccountData'
import { downloadText } from '@/lib/downloadText'
import { accountErrorMessage } from '@/lib/accountSecurity'
const auth = useAuthStore(),
  router = useRouter()
const oldPassword = ref(''),
  password = ref(''),
  confirmation = ref(''),
  newEmail = ref(''),
  error = ref(''),
  message = ref('')
const busy = ref(false),
  emailEnabled = ref(false),
  capabilityLoading = ref(true),
  confirmLogout = ref(false)
const drafts = ref([]),
  confirmDraftRemoval = ref(false),
  removalSnapshot = ref([]),
  removalAcknowledged = ref(false)
let removalUserId = ''
const oldDraftCount = computed(() => drafts.value.filter((d) => d.old).length)
const scope = createAccountViewScope(
  () => `${auth.user?.id || ''}|${auth.token || ''}|${auth.isLoggedIn}`
)
onBeforeUnmount(() => scope.dispose())
let eventsRequest = 0
const events = ref([]),
  eventsLoading = ref(false),
  eventsError = ref('')
function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN')
}
async function perform(operation) {
  if (busy.value) return
  const ticket = scope.capture()
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    await operation(() => scope.isCurrent(ticket))
  } catch (e) {
    if (scope.isCurrent(ticket)) error.value = accountErrorMessage(e, '操作未完成，请稍后重试。')
  } finally {
    if (scope.isCurrent(ticket)) busy.value = false
  }
}
async function changePassword() {
  error.value = passwordProblem(password.value, confirmation.value)
  if (error.value) return
  await perform(async () => {
    await changeAccountPassword(oldPassword.value, password.value, confirmation.value)
    // The synchronous identity watcher clears fields after this session ends.
    if (!auth.isLoggedIn) await router.replace('/login?passwordChanged=1')
  })
}
async function changeEmail() {
  await perform(async (current) => {
    await requestEmailChange(newEmail.value)
    if (current()) message.value = '更换邮箱请求已受理。请在新邮箱打开确认链接并输入当前密码。'
  })
}
async function verifyEmail() {
  await perform(async (current) => {
    await requestEmailVerification(auth.user.email)
    if (current()) message.value = '验证请求已受理，请检查邮箱。'
  })
}
async function logoutAll() {
  if (busy.value) return
  const ticket = scope.capture()
  busy.value = true
  let result = '1'
  try {
    await logoutAllDevices()
  } catch {
    result = 'unknown'
  } finally {
    if (scope.isCurrent(ticket)) {
      busy.value = false
      confirmLogout.value = false
    }
  }
  if (!auth.isLoggedIn) await router.replace({ path: '/login', query: { sessionsEnded: result } })
}
function loadDrafts() {
  try {
    drafts.value = listLocalAccountDrafts(window.localStorage, auth.user?.id)
  } catch {
    error.value = '无法读取本机存储，浏览器可能禁用了此功能。'
  }
}
function exportDrafts() {
  try {
    downloadText(
      exportLocalAccountDrafts(window.localStorage, auth.user?.id),
      '万语校坊-本机草稿.json',
      'application/json;charset=utf-8'
    )
  } catch {
    error.value = '草稿导出失败，尚未删除任何内容。'
  }
}
function prepareDraftRemoval() {
  loadDrafts()
  removalUserId = auth.user?.id
  removalSnapshot.value = [...drafts.value]
  removalAcknowledged.value = false
  confirmDraftRemoval.value = true
}
function removeDrafts() {
  if (!removalAcknowledged.value || auth.user?.id !== removalUserId) return
  try {
    const count = removeLocalAccountDrafts(
      window.localStorage,
      removalUserId,
      removalSnapshot.value
    )
    message.value = `已清理 ${count} 份本机草稿；确认期间发生新保存的草稿会保留。`
    confirmDraftRemoval.value = false
    loadDrafts()
  } catch {
    error.value = '清理未完整完成，请刷新列表确认。'
  }
}
async function loadEvents() {
  const ticket = scope.capture(),
    request = ++eventsRequest
  eventsLoading.value = true
  eventsError.value = ''
  try {
    const result = await listSecurityEvents(
      { scope: 'mine', perPage: 25 },
      { signal: ticket.signal }
    )
    if (scope.isCurrent(ticket) && request === eventsRequest) events.value = result.items
  } catch {
    if (scope.isCurrent(ticket) && request === eventsRequest)
      eventsError.value = '暂时无法读取安全记录。'
  } finally {
    if (scope.isCurrent(ticket) && request === eventsRequest) eventsLoading.value = false
  }
}
watch(
  () => [auth.user?.id, auth.isLoggedIn, auth.token],
  async () => {
    scope.invalidate()
    const ticket = scope.capture()
    drafts.value = []
    events.value = []
    eventsError.value = ''
    eventsLoading.value = false
    removalSnapshot.value = []
    removalUserId = ''
    removalAcknowledged.value = false
    confirmDraftRemoval.value = false
    confirmLogout.value = false
    busy.value = false
    oldPassword.value = ''
    password.value = ''
    confirmation.value = ''
    newEmail.value = ''
    error.value = ''
    message.value = ''
    emailEnabled.value = false
    capabilityLoading.value = false
    if (!auth.isLoggedIn || !auth.user?.id) return
    loadDrafts()
    void loadEvents()
    capabilityLoading.value = true
    try {
      const result = await accountCapabilities({ signal: ticket.signal })
      if (scope.isCurrent(ticket)) emailEnabled.value = Boolean(result.emailActionsEnabled)
    } catch {
      if (scope.isCurrent(ticket)) error.value = '暂时无法检查邮箱服务，可稍后刷新页面。'
    } finally {
      if (scope.isCurrent(ticket)) capabilityLoading.value = false
    }
  },
  { immediate: true, flush: 'sync' }
)
</script>
<style scoped>
.account-security {
  max-width: 54rem;
}
.account-security li {
  margin-block: var(--space-2);
  overflow-wrap: anywhere;
}
</style>
