<template>
  <nav class="navbar" aria-label="主导航">
    <div class="container">
      <RouterLink to="/" class="navbar-brand">
        <span class="navbar-seal" aria-hidden="true">万</span>
        <span>万语校坊</span>
        <span class="sub">线上方言校对工坊</span>
      </RouterLink>
      <div class="navbar-nav">
        <slot name="nav-links" />
        <span class="navbar-divider" aria-hidden="true"></span>
        <RouterLink to="/tasks/profile" class="navbar-user" aria-label="个人中心" :title="auth.user?.email">
          <UserAvatar :user="auth.user" />
          <span>{{ auth.user?.name || auth.user?.email || auth.user?.username }}</span>
        </RouterLink>
        <button class="btn btn-quiet btn-sm" @click="handleLogout">退出</button>
      </div>
    </div>
  </nav>
</template>

<script setup>
import UserAvatar from '@/components/UserAvatar.vue'
import { useAuthStore } from '@/stores/auth'
import { useRouter } from 'vue-router'

const auth = useAuthStore()
const router = useRouter()

function handleLogout() {
  auth.logout()
  router.push('/login')
}
</script>
