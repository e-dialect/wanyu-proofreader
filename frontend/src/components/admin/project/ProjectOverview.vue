<template>
  <section class="project-progress" aria-labelledby="project-progress-title" :aria-busy="pending">
    <header class="project-progress__heading">
      <div>
        <h2 id="project-progress-title">项目推进清单</h2>
        <p v-if="workflow" class="text-sm text-muted">
          <span v-if="error" class="project-progress__stale">未更新 · </span>
          <span v-else-if="pending">正在更新 · </span>
          <template v-if="generatedAt">
            上次统计于 <time :datetime="workflow.generated_at">{{ generatedAt }}</time>
          </template>
          <span v-else>统计时间未记录</span>
        </p>
      </div>
      <AppButton
        v-if="!unavailable"
        variant="ghost"
        size="sm"
        :loading="pending"
        loading-label="正在更新"
        @click="loadOverview"
      >
        <AppIcon name="refresh" />刷新进度
      </AppButton>
    </header>

    <AppStatusPanel
      v-if="error"
      state="error"
      :title="unavailable ? '无法查看项目进度' : '暂时无法更新进度'"
      :message="error"
      :retry-label="unavailable ? '' : '重新读取'"
      :busy="pending"
      @retry="loadOverview"
    />
    <AppStatusPanel v-else-if="pending && !workflow" state="pending" message="正在读取项目进度…" />
    <RouterLink v-if="unavailable" class="btn btn-secondary" to="/admin">返回项目列表</RouterLink>

    <template v-if="workflow">
      <dl v-if="workflow.summary" class="project-progress__totals" aria-label="全项目条目统计">
        <div v-for="item in totals" :key="item.key">
          <dt>{{ item.label }}</dt>
          <dd>{{ formatCount(item.count, '条') }}</dd>
        </div>
      </dl>

      <section v-if="recommendation" class="project-progress__priority" aria-label="建议先处理">
        <div>
          <p class="project-progress__priority-label">建议先处理</p>
          <h3>{{ recommendation.title }}</h3>
          <p>{{ recommendation.detail }}</p>
          <p v-if="recommendation.role" class="project-progress__role">
            负责 · {{ recommendation.role }}
          </p>
        </div>
        <RouterLink :to="recommendation.target" class="btn btn-primary">
          {{ recommendation.action.label }}<AppIcon name="arrow" />
        </RouterLink>
      </section>

      <p class="project-progress__scope text-sm text-muted">
        各环节可同时推进。完成校对后，仍需分别核对来源、用途与接收记录。
      </p>
      <ul class="project-progress__stages" aria-label="项目环节与分工">
        <li v-for="stage in workflow.stages" :key="stage.key" class="project-progress__stage">
          <header class="project-progress__stage-heading">
            <h3>{{ stage.title }}</h3>
            <span class="project-progress__state" :data-stage-state="stage.state">
              {{ stage.state_label }}
            </span>
          </header>
          <p v-if="stage.role" class="project-progress__role">负责 · {{ stage.role }}</p>
          <p v-if="stage.summary" class="project-progress__summary">{{ stage.summary }}</p>
          <dl v-if="stage.metrics?.length" class="project-progress__facts">
            <div v-for="metric in stage.metrics" :key="metric.key">
              <dt>{{ metric.label }}</dt>
              <dd>{{ formatCount(metric.count, metric.unit) }}</dd>
            </div>
          </dl>
          <ul
            v-if="stage.blockers?.length"
            class="project-progress__blockers"
            aria-label="待处理事项"
          >
            <li v-for="blocker in stage.blockers" :key="blocker.code">{{ blocker.message }}</li>
          </ul>
          <footer v-if="stage.actions?.length || stage.note" class="project-progress__stage-footer">
            <div v-if="stage.actions?.length" class="project-progress__links">
              <template v-for="action in stage.actions" :key="action.key">
                <RouterLink
                  v-if="actionTarget(action)"
                  :to="actionTarget(action)"
                  :aria-label="`${stage.title} · ${action.label}`"
                  class="back-link"
                >
                  {{ action.label }}<AppIcon name="arrow" />
                </RouterLink>
              </template>
            </div>
            <details v-if="stage.note" class="project-progress__explanation">
              <summary>统计说明</summary>
              <p class="project-progress__note">{{ stage.note }}</p>
            </details>
          </footer>
        </li>
      </ul>
    </template>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { getProjectWorkflow } from '@/services/projectsService'
import { useProtectedPageScope } from '@/composables/useProtectedPageScope'
import { getPbStatus } from '@/utils/pbErrors'
import AppButton from '@/components/AppButton.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppStatusPanel from '@/components/AppStatusPanel.vue'

const props = defineProps({
  projectId: { type: String, required: true },
  query: { type: Object, default: () => ({}) }
})
const data = ref(null)
const pending = ref(false)
const error = ref('')
const projectMissing = ref(false)
const scope = useProtectedPageScope((status) => {
  data.value = null
  pending.value = false
  error.value =
    status === 401
      ? '登录状态已失效，请重新登录后查看。'
      : '当前账号无权管理此项目，请返回项目列表。'
})
const unavailable = computed(() => scope.accessLost.value || projectMissing.value)
const workflow = computed(() =>
  !unavailable.value && data.value?.project?.id === props.projectId ? data.value : null
)
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
const generatedAt = computed(() => {
  const date = Date.parse(workflow.value?.generated_at)
  return Number.isFinite(date) ? dateFormat.format(date) : ''
})
const totals = computed(() => [
  { key: 'entries', label: '材料条目', count: workflow.value?.summary?.entries },
  {
    key: 'proofreading',
    label: '校对流程完成',
    count: workflow.value?.summary?.proofreading_completed
  },
  { key: 'arbitration', label: '等待仲裁', count: workflow.value?.summary?.arbitration }
])

function actionTarget(action) {
  const path = action?.target?.path
  const base = `/admin/projects/${encodeURIComponent(props.projectId)}`
  if (
    typeof path !== 'string' ||
    (path !== base && !path.startsWith(base + '/')) ||
    !/^\/[a-z0-9/_-]+$/i.test(path)
  )
    return null
  return { path, query: action.target.query || {} }
}
const recommendation = computed(() => {
  if (error.value || pending.value) return null
  const suggestion = workflow.value?.recommendation
  const target = actionTarget(suggestion?.action)
  return target ? { ...suggestion, target } : null
})

function formatCount(count, unit) {
  return Number.isSafeInteger(count) && count >= 0
    ? `${count.toLocaleString('zh-CN')}${unit ? ` ${unit}` : ''}`
    : '未读取'
}

async function loadOverview() {
  if (scope.accessLost.value) return
  scope.cancel()
  const request = scope.capture()
  const projectId = props.projectId
  pending.value = true
  error.value = ''
  projectMissing.value = false
  try {
    const result = await getProjectWorkflow(projectId, { signal: request.signal })
    if (!request.isCurrent()) return
    if (result?.project?.id !== projectId || !Array.isArray(result.stages) || !result.stages.length)
      throw new Error('未读取到当前项目的进度。')
    data.value = result
  } catch (cause) {
    if (!request.isCurrent() || scope.invalidate(cause, request)) return
    if (getPbStatus(cause) === 404) {
      projectMissing.value = true
      data.value = null
      error.value = '项目或进度入口不可用，请返回项目列表。'
    } else {
      error.value = workflow.value
        ? '当前显示上次读取的结果，请重新读取。'
        : '未读取到项目进度，请重试。'
    }
  } finally {
    if (request.isCurrent()) pending.value = false
    request.finish()
  }
}
watch(() => props.projectId, loadOverview, { immediate: true })
defineExpose({ reload: loadOverview })
</script>

<style scoped>
.project-progress {
  display: grid;
  gap: var(--space-4);
}
.project-progress__heading,
.project-progress__priority,
.project-progress__stage-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2) var(--space-4);
}
.project-progress__heading {
  flex-wrap: wrap;
}
.project-progress__heading h2 {
  margin-block: 0 var(--space-1);
  font-size: var(--text-xl);
}
.project-progress__heading .app-button,
.project-progress__priority .btn {
  flex-shrink: 0;
}
.project-progress__stale {
  color: var(--warn-ink);
  font-weight: 600;
}
.project-progress__totals {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-5);
  border-block: 1px solid var(--line);
  margin: 0;
  padding: var(--space-3) 0;
}
.project-progress__totals > div {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
}
.project-progress__totals dt,
.project-progress__facts dt,
.project-progress__role,
.project-progress__note {
  color: var(--ink-muted);
  font-size: var(--text-sm);
}
.project-progress__totals dd,
.project-progress__facts dd {
  margin: 0;
  color: var(--ink);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.project-progress__priority {
  align-items: center;
  border: 1px solid var(--primary-line);
  border-radius: var(--radius-card);
  background: var(--primary-glow-soft);
  padding: var(--space-4);
}
.project-progress__priority-label {
  color: var(--primary);
  font-size: var(--text-xs);
  font-weight: 600;
}
.project-progress__priority h3 {
  margin: var(--space-1) 0;
  font-size: var(--text-lg);
}
.project-progress__priority p,
.project-progress__scope,
.project-progress__stage p {
  margin: 0;
}
.project-progress__priority .project-progress__role {
  margin-top: var(--space-2);
}
.project-progress__stages {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  padding: 0;
  margin: 0;
  list-style: none;
}
.project-progress__stage {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  border: 1px solid var(--line-card);
  border-radius: var(--radius-card);
  background: var(--surface);
  overflow-wrap: anywhere;
}
.project-progress__stage-heading {
  align-items: baseline;
  flex-wrap: wrap;
}
.project-progress__stage-heading h3 {
  margin: 0;
  font-size: var(--text-lg);
}
.project-progress__state {
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-2);
  color: var(--ink-muted);
  font-size: var(--text-xs);
  font-weight: 600;
}
.project-progress__state[data-stage-state='needs_action'] {
  border-color: var(--warn-border);
  background: var(--warn-bg);
  color: var(--warn-ink);
}
.project-progress__state[data-stage-state='in_progress'],
.project-progress__state[data-stage-state='recorded'] {
  border-color: var(--primary-line);
  background: var(--primary-glow-soft);
  color: var(--primary);
}
.project-progress__summary {
  color: var(--ink);
  font-size: var(--text-sm);
  line-height: 1.6;
}
.project-progress__facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-4);
  margin: 0;
}
.project-progress__facts > div {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1);
}
.project-progress__facts dd {
  font-size: var(--text-sm);
}
.project-progress__blockers {
  display: grid;
  gap: var(--space-1);
  padding-inline-start: var(--space-4);
  margin: 0;
  color: var(--warn-ink);
  font-size: var(--text-sm);
}
.project-progress__stage-footer,
.project-progress__links {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 0 var(--space-4);
}
.project-progress__stage-footer {
  margin-top: auto;
}
.project-progress__explanation[open] {
  flex-basis: 100%;
}
.project-progress__explanation summary {
  min-height: var(--control-height-sm);
  line-height: var(--control-height-sm);
  color: var(--ink-muted);
  font-size: var(--text-xs);
  cursor: pointer;
}
.project-progress__explanation summary:hover {
  color: var(--primary);
}
.project-progress__note {
  padding-bottom: var(--space-2);
}
.project-progress__links a {
  display: inline-flex;
  gap: var(--space-2);
  align-items: center;
  min-height: var(--control-height-sm);
}
@media (max-width: 720px) {
  .project-progress__stages {
    grid-template-columns: 1fr;
  }
  .project-progress__priority {
    align-items: stretch;
    flex-direction: column;
  }
  .project-progress__priority .btn {
    white-space: normal;
  }
  .project-progress__explanation summary {
    line-height: var(--control-height-touch);
  }
  .project-progress__links a,
  .project-progress__explanation summary,
  .project-progress__priority .btn {
    min-height: var(--control-height-touch);
  }
}
</style>
