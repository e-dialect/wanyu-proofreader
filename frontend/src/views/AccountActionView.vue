<template>
  <main class="auth-container">
    <section class="auth-card" aria-labelledby="account-action-title">
      <div class="auth-logo">
        <div class="page-eyebrow">万语校坊 · 账户安全</div>
        <h1 id="account-action-title">{{ title }}</h1>
      </div>
      <p v-if="action === 'recover'" class="text-muted mb-4">
        输入万语校坊账号的邮箱。未设置邮箱的志愿者请联系项目管理员；外部账号请到对应平台恢复。
      </p>
      <p v-if="loading" role="status">正在检查邮箱服务…</p>
      <div v-if="error" class="alert alert-error mb-4" role="alert">{{ error }}</div>
      <div v-if="message" class="alert alert-success mb-4" role="status">{{ message }}</div>
      <form
        v-if="!done && !loading && (action !== 'recover' || emailEnabled)"
        @submit.prevent="submit"
      >
        <label v-if="action === 'recover'" class="form-group"
          ><span class="form-label">邮箱</span
          ><input
            v-model.trim="email"
            class="form-control"
            type="email"
            autocomplete="email"
            required
            maxlength="255"
            :disabled="busy"
        /></label>
        <template v-if="action === 'reset-password'">
          <label class="form-group"
            ><span class="form-label">新密码</span
            ><input
              v-model="password"
              class="form-control"
              type="password"
              autocomplete="new-password"
              required
              maxlength="71"
              :disabled="busy"
          /></label>
          <p class="text-muted text-sm mb-4">
            10–71 个字符，UTF-8 编码不超过 72 字节。重置后所有设备需重新登录。
          </p>
          <label class="form-group"
            ><span class="form-label">确认新密码</span
            ><input
              v-model="confirmation"
              class="form-control"
              type="password"
              autocomplete="new-password"
              required
              maxlength="71"
              :disabled="busy"
          /></label>
        </template>
        <label v-if="action === 'confirm-email'" class="form-group"
          ><span class="form-label">当前万语校坊密码</span
          ><input
            v-model="password"
            class="form-control"
            type="password"
            autocomplete="current-password"
            required
            :disabled="busy"
        /></label>
        <p v-if="action === 'verify-email'" class="text-muted mb-4">
          确认此链接对应的邮箱属于你。请勿将链接转发给别人。
        </p>
        <button
          class="btn btn-primary btn-block"
          :disabled="busy || (action !== 'recover' && !token)"
        >
          {{ busy ? '正在处理…' : action === 'recover' ? '发送恢复邮件' : '确认' }}
        </button>
      </form>
      <p class="mt-4">
        <RouterLink to="/login">返回登录</RouterLink
        ><span v-if="action !== 'recover'">
          · <RouterLink to="/account/recover">重新申请恢复邮件</RouterLink></span
        >
      </p>
    </section>
  </main>
</template>
<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { createAccountViewScope } from '@/lib/accountViewScope'
import { useRoute } from 'vue-router'
import {
  accountCapabilities,
  requestPasswordReset,
  confirmAccountAction,
  refreshStoredAuth
} from '@/services/authService'
import { passwordProblem, takeAccountActionToken } from '@/lib/accountSecurity'
import { accountErrorMessage } from '@/lib/accountSecurity'
const route = useRoute()
const action = computed(() => String(route.params.action))
const title = computed(
  () =>
    ({
      recover: '恢复账号',
      'reset-password': '设置新密码',
      'confirm-email': '确认更换邮箱',
      'verify-email': '验证邮箱'
    })[action.value]
)
const token = ref('')
const email = ref(''),
  password = ref(''),
  confirmation = ref(''),
  error = ref(''),
  message = ref('')
const busy = ref(false),
  loading = ref(false),
  done = ref(false),
  emailEnabled = ref(false)
const scope = createAccountViewScope(() => `${action.value}|${route.hash || ''}`)
onBeforeUnmount(() => scope.dispose())
watch(
  () => [action.value, route.hash],
  async () => {
    scope.invalidate()
    const ticket = scope.capture()
    token.value = takeAccountActionToken(window.location, window.history)
    error.value = ''
    message.value = ''
    done.value = false
    busy.value = false
    loading.value = false
    emailEnabled.value = false
    password.value = ''
    confirmation.value = ''
    if (action.value !== 'recover') {
      if (!token.value) error.value = '链接缺少有效凭据，请从最新邮件重新打开。'
      return
    }
    loading.value = true
    try {
      const capabilities = await accountCapabilities({ signal: ticket.signal })
      if (!scope.isCurrent(ticket)) return
      emailEnabled.value = Boolean(capabilities.emailActionsEnabled)
      if (!emailEnabled.value) error.value = '本站尚未启用邮箱恢复，请联系项目管理员协助恢复账号。'
    } catch {
      if (scope.isCurrent(ticket)) error.value = '暂时无法检查恢复服务，请稍后重试。'
    } finally {
      if (scope.isCurrent(ticket)) loading.value = false
    }
  },
  { immediate: true, flush: 'sync' }
)

async function submit() {
  if (busy.value) return
  const ticket = scope.capture()
  const submittedAction = action.value
  const submittedToken = token.value
  error.value = ''
  message.value = ''
  if (submittedAction === 'reset-password') {
    error.value = passwordProblem(password.value, confirmation.value)
    if (error.value) return
  }
  busy.value = true
  try {
    if (submittedAction === 'recover') {
      await requestPasswordReset(email.value)
      if (!scope.isCurrent(ticket)) return
      message.value = '如果该邮箱可用于恢复，你将收到邮件。请检查收件箱与垃圾邮件，勿频繁重试。'
    } else {
      await confirmAccountAction(
        submittedAction,
        submittedToken,
        password.value,
        confirmation.value
      )
      if (!scope.isCurrent(ticket)) return
      token.value = ''
      password.value = ''
      confirmation.value = ''
      done.value = true
      if (submittedAction !== 'verify-email') await refreshStoredAuth()
      if (!scope.isCurrent(ticket)) return
      message.value =
        submittedAction === 'verify-email'
          ? '邮箱验证成功。'
          : '账户已更新，现有登录已失效，请重新登录。'
    }
  } catch (e) {
    if (scope.isCurrent(ticket))
      error.value = accountErrorMessage(e, '操作未完成。链接可能已过期或已使用，请重新申请。')
  } finally {
    if (scope.isCurrent(ticket)) busy.value = false
  }
}
</script>
