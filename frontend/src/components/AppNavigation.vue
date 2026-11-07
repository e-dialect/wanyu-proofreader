<template>
  <nav class="app-navigation" aria-label="主导航">
    <RouterLink to="/workspace" class="shell-brand" @click="$emit('navigate')"
      ><span class="shell-brand__seal" aria-hidden="true">万</span
      ><span><strong>万语校坊</strong><small>语言资料协同校勘</small></span></RouterLink
    >
    <div class="shell-navigation-group">
      <RouterLink
        v-for="item in mainNavigation"
        :key="item.path"
        :to="item.path"
        class="shell-nav-link"
        :class="{ 'is-active': activeArea === item.area }"
        :aria-current="activeArea === item.area ? 'page' : undefined"
        @click="$emit('navigate')"
        ><AppIcon :name="item.icon" /><span>{{ item.label }}</span></RouterLink
      >
      <RouterLink
        v-if="canManage"
        to="/admin/sources"
        class="shell-nav-link"
        :class="{ 'is-active': activeArea === 'sources' }"
        :aria-current="activeArea === 'sources' ? 'page' : undefined"
        @click="$emit('navigate')"
        ><AppIcon name="source" /><span>来源库</span></RouterLink
      >
    </div>
    <div
      v-if="auth.isPlatformAdmin"
      class="shell-navigation-group shell-navigation-group--platform"
    >
      <span class="shell-navigation-label">平台设置</span>
      <RouterLink
        to="/admin/creator-grants"
        class="shell-nav-link"
        :class="{ 'is-active': route.name === 'CreatorGrants' }"
        @click="$emit('navigate')"
        ><AppIcon name="settings" /><span>创建授权</span></RouterLink
      >
      <RouterLink
        to="/admin/gate-rules"
        class="shell-nav-link"
        :class="{ 'is-active': route.name === 'GateRules' }"
        @click="$emit('navigate')"
        ><AppIcon name="check" /><span>辅助规则</span></RouterLink
      >
    </div>
    <p class="shell-navigation-note">一份来源，多人独立核对。<br />让每次判断都有依据。</p>
  </nav>
</template>
<script setup>
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import AppIcon from '@/components/AppIcon.vue'
import { navigationArea } from '@/lib/workbenchNavigation'
defineEmits(['navigate'])
const auth = useAuthStore()
const route = useRoute()
const canManage = computed(() => auth.isPlatformAdmin || auth.hasManagedProjects)
const activeArea = computed(() => navigationArea(route))
const mainNavigation = [
  { path: '/workspace', label: '工作台', icon: 'home', area: 'workspace' },
  { path: '/tasks', label: '我的任务', icon: 'task', area: 'tasks' },
  { path: '/projects?view=mine', label: '项目', icon: 'project', area: 'projects' }
]
</script>
