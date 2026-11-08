<template>
  <nav class="project-hub-tabs" aria-label="项目视图">
    <RouterLink
      to="/projects?view=mine"
      :class="{ 'is-active': active === 'mine' }"
      :aria-current="active === 'mine' ? 'page' : undefined"
      >我的项目</RouterLink
    >
    <RouterLink
      to="/projects?view=discover"
      :class="{ 'is-active': active === 'discover' }"
      :aria-current="active === 'discover' ? 'page' : undefined"
      >可加入</RouterLink
    >
    <RouterLink
      v-if="auth.isPlatformAdmin || auth.hasManagedProjects"
      to="/admin"
      :class="{ 'is-active': active === 'managed' }"
      :aria-current="active === 'managed' ? 'page' : undefined"
      >项目管理</RouterLink
    >
  </nav>
</template>
<script setup>
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
defineProps({ active: { type: String, default: 'mine' } })
const auth = useAuthStore()
</script>
