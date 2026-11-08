<template>
  <a class="skip-link" href="#main-content">跳到主要内容</a>
  <AppErrorBoundary>
    <AppShell
      v-if="route.meta.requiresAuth && protectedViewReady && !auth.mustChangePassword"
      :key="auth.user?.id || 'anonymous'"
    >
      <RouterView :key="auth.user?.id || 'anonymous'" />
    </AppShell>
    <RouterView
      v-else-if="!route.meta.requiresAuth || protectedViewReady"
      :key="route.meta.requiresAuth ? auth.user?.id || 'anonymous' : 'public'"
    />
    <main v-else class="auth-pending" role="status">正在更新登录状态…</main>
  </AppErrorBoundary>
</template>

<script setup>
import { computed, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { resolveNavigation } from '@/lib/access'
import AppErrorBoundary from '@/components/AppErrorBoundary.vue'
import AppShell from '@/components/AppShell.vue'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const protectedViewReady = computed(
  () => auth.isLoggedIn && (!auth.mustChangePassword || route.meta.allowInitialPassword)
)
watch(
  () => [auth.user?.id, auth.mustChangePassword],
  () => {
    // Guest views retain their own redirect target while sign-in completes.
    if (auth.isLoggedIn && !auth.mustChangePassword) return
    const destination = resolveNavigation(route, {
      isLoggedIn: auth.isLoggedIn,
      mustChangePassword: auth.mustChangePassword
    })
    if (destination) void router.replace(destination)
  }
)
</script>
