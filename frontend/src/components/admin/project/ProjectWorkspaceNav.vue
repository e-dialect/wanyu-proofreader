<template>
  <nav class="project-workspace-nav" aria-label="项目工作区">
    <RouterLink
      v-for="item in items"
      :key="item.key"
      :to="target(item)"
      :aria-current="active === item.key ? 'page' : undefined"
      :class="{ 'is-active': active === item.key }"
    >
      {{ item.label }}
    </RouterLink>
  </nav>
</template>
<script setup>
import { RouterLink, useRoute } from 'vue-router'
import { projectWorkspaceTarget } from '@/lib/projectWorkspace'
import '@/styles/project-workspace.css'

const props = defineProps({
  projectId: { type: String, required: true },
  active: { type: String, default: 'work' },
  projectName: { type: String, default: '' }
})
const route = useRoute()
const items = [
  { key: 'overview', label: '概览' },
  { key: 'materials', label: '材料' },
  { key: 'work', label: '校勘' },
  { key: 'delivery', label: '交付' },
  { key: 'settings', label: '设置' }
]
function target(item) {
  if (item.key === 'settings')
    return `/admin/projects/${encodeURIComponent(props.projectId)}/settings`
  return projectWorkspaceTarget(props.projectId, item.key, undefined, route.query)
}
</script>
