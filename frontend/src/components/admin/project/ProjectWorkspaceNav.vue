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
  <RouterLink
    v-if="practiceContext"
    :to="practiceGuideTarget(practiceContext)"
    class="practice-workspace-return back-link"
  >
    <AppIcon name="back" />返回练习步骤
  </RouterLink>
</template>
<script setup>
import { computed, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, RouterLink, useRoute } from 'vue-router'
import AppIcon from '@/components/AppIcon.vue'
import { useAsyncResource } from '@/composables/useAsyncResource'
import { getProject } from '@/services/projectsService'
import { useAuthStore } from '@/stores/auth'
import {
  canUsePracticeProject,
  practiceGuideTarget,
  practiceNavigationQuery,
  readPracticeContext
} from '@/lib/practiceContext'
import { projectWorkspaceTarget } from '@/lib/projectWorkspace'
import '@/styles/project-workspace.css'

const props = defineProps({
  projectId: { type: String, required: true },
  active: { type: String, default: 'work' },
  projectName: { type: String, default: '' }
})
const route = useRoute()
const auth = useAuthStore()
const requestedContext = computed(() => readPracticeContext(route.query, props.projectId))
const {
  data: verified,
  pending: verificationPending,
  error: verificationError,
  reload: verify,
  cancel: cancelVerification
} = useAsyncResource(async ({ signal }, id, userId) => ({
  project: await getProject(id, { signal }),
  userId
}))
watch(
  [() => requestedContext.value?.projectId, () => auth.user?.id],
  ([id, userId]) => {
    if (id && userId) void verify(id, userId)
    else cancelVerification()
  },
  { immediate: true }
)
const practiceContext = computed(() => {
  const context = requestedContext.value
  const entry = verified.value
  return context &&
    !verificationPending.value &&
    !verificationError.value &&
    entry?.userId === auth.user?.id &&
    entry?.project?.id === context.projectId &&
    canUsePracticeProject(entry.project, context.role, auth.isPlatformAdmin)
    ? context
    : null
})
const practiceQueryKeys = ['practiceProject', 'practiceRole', 'practiceStep']
function scopedQuery(query) {
  const otherQuery = { ...query }
  for (const key of practiceQueryKeys) delete otherQuery[key]
  return practiceContext.value
    ? { ...otherQuery, ...practiceNavigationQuery(practiceContext.value) }
    : otherQuery
}
function carryPracticeContext(to) {
  const path = `/admin/projects/${encodeURIComponent(props.projectId)}`
  if (to.path !== path && !to.path.startsWith(path + '/')) return
  const query = scopedQuery(to.query)
  if (practiceQueryKeys.some((key) => to.query[key] !== query[key]))
    return { path: to.path, query, hash: to.hash }
}
onBeforeRouteUpdate(carryPracticeContext)
onBeforeRouteLeave(carryPracticeContext)

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
      query: practiceContext.value ? practiceNavigationQuery(practiceContext.value) : {}
    }
  const query = scopedQuery(route.query)
  delete query.todoFrom
  return projectWorkspaceTarget(props.projectId, item.key, undefined, query)
}
</script>

<style scoped>
.practice-workspace-return {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-height);
}
@media (max-width: 768px) {
  .practice-workspace-return {
    min-height: var(--control-height-touch);
  }
}
</style>
