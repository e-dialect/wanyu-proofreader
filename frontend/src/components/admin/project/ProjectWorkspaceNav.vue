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
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { projectWorkspaceTarget } from '@/lib/projectWorkspace'
import {
  batchReportNavigationQuery,
  normalizeReportHistoryPage,
  readBatchReportContext
} from '@/lib/batchReportContext'
import { reportId } from '@/lib/batchReport'
import '@/styles/project-workspace.css'

const props = defineProps({
  projectId: { type: String, required: true },
  active: { type: String, default: 'work' },
  projectName: { type: String, default: '' }
})
const route = useRoute()
const reportQuery = computed(() =>
  batchReportNavigationQuery(
    route.name === 'ProjectBatchReport' && route.params.id === props.projectId
      ? {
          projectId: props.projectId,
          batchId: reportId(route.params.batchId),
          exportId: reportId(route.query.export),
          historyPage: normalizeReportHistoryPage(route.query.historyPage),
          section: 'overview'
        }
      : readBatchReportContext(route.query, props.projectId)
  )
)
const items = [
  { key: 'overview', label: '概览' },
  { key: 'materials', label: '材料' },
  { key: 'work', label: '校勘' },
  { key: 'delivery', label: '交付' },
  { key: 'settings', label: '设置' }
]
function target(item) {
  if (item.key === 'settings')
    return {
      path: `/admin/projects/${encodeURIComponent(props.projectId)}/settings`,
      query: reportQuery.value
    }
  return projectWorkspaceTarget(props.projectId, item.key, undefined, {
    ...(route.name === 'ProjectBatchReport' ? {} : route.query),
    ...reportQuery.value
  })
}
</script>
