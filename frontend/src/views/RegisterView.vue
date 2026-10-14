<template>
  <div class="auth-container">
    <div class="auth-card">
      <div class="auth-logo">
        <h1>万语校坊</h1>
        <p>注册新账号</p>
      </div>

      <form @submit.prevent="handleRegister">
        <div class="form-group">
          <label for="register-name" class="form-label">昵称（可用于登录）</label>
          <input id="register-name" v-model.trim="name" type="text" class="form-control" placeholder="请输入唯一昵称" autocomplete="nickname" maxlength="255" :disabled="loading" required />
        </div>
        <div class="form-group">
          <label class="form-label">邮箱</label>
          <input v-model="email" type="email" class="form-control" placeholder="请输入邮箱" required />
        </div>
        <div class="form-group">
          <label class="form-label">密码</label>
          <input v-model="password" type="password" class="form-control" placeholder="至少8位" required minlength="8" />
        </div>
        <div class="form-group">
          <label class="form-label">确认密码</label>
          <input v-model="passwordConfirm" type="password" class="form-control" placeholder="再次输入密码" required />
        </div>

        <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>
        <div v-if="success" class="alert alert-success" role="status">注册成功！正在跳转到登录页...</div>

        <button type="submit" class="btn btn-primary btn-block btn-lg" :disabled="loading">
          {{ loading ? '注册中...' : '注册' }}
        </button>
      </form>

      <p class="text-center mt-4 text-sm text-muted">
        已有账号？
        <RouterLink to="/login">直接登录</RouterLink>
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { checkNicknameAvailable } from '@/services/authService'
import { getPbMessage } from '@/utils/pbErrors'

const router = useRouter()
const auth = useAuthStore()
const name = ref('')
const email = ref('')
const password = ref('')
const passwordConfirm = ref('')
const loading = ref(false)
const error = ref('')
const success = ref(false)

async function handleRegister() {
  if (loading.value) return
  error.value = ''
  if (!name.value.trim()) {
    error.value = '昵称不能为空'
    return
  }
  if (password.value !== passwordConfirm.value) {
    error.value = '两次输入的密码不一致'
    return
  }
  loading.value = true
  try {
    const { available } = await checkNicknameAvailable(name.value)
    if (!available) {
      error.value = '昵称已被占用，请换一个昵称。'
      return
    }
    await auth.register(email.value, password.value, passwordConfirm.value, name.value)
    success.value = true
    setTimeout(() => router.push('/login'), 1500)
  } catch (e) {
    error.value = getPbMessage(e, '注册失败，请检查填写的信息')
  } finally {
    loading.value = false
  }
}
</script>
