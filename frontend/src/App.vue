<template>
  <a class="skip-link" href="#main-content">跳到主要内容</a>
  <AppErrorBoundary>
    <RouterView :key="route.meta.requiresAuth ? auth.user?.id || 'anonymous' : 'public'" />
  </AppErrorBoundary>
</template>

<script setup>
import { watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { resolveNavigation } from '@/lib/access'
import AppErrorBoundary from '@/components/AppErrorBoundary.vue'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
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
