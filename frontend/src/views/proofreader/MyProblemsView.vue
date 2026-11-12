<template>
  <main class="container page workspace-page problem-followup">
    <header class="page-heading">
      <div>
        <RouterLink :to="hallTarget" class="back-link"
          ><AppIcon name="back" />返回我的任务</RouterLink
        >
        <h1>我的问题与草稿</h1>
        <p>继续未完成的校对，跟进管理员反馈。草稿与问题报告不计入完整校对人数。</p>
      </div>
      <AppButton :loading="loading" :disabled="accessLost || !!busyRow" @click="load"
        >刷新记录</AppButton
      >
    </header>
    <section class="card followup-panel" aria-label="我的跟进记录" :aria-busy="loading">
      <div class="followup-filters">
        <AppField label="项目" class="followup-project">
          <AppSelect
            v-if="data"
            :model-value="context.project"
            :options="projectOptions"
            :disabled="accessLost"
            @update:model-value="changeFilter({ project: $event })"
          />
          <span v-else class="text-sm text-muted" role="status">
            {{ error ? '项目暂未读取，请查看下方说明。' : '正在读取项目…' }}
          </span>
        </AppField>
        <div class="followup-views" role="group" aria-label="记录范围">
          <AppButton
            v-for="view in views"
            :key="view.value"
            :variant="context.view === view.value ? 'secondary' : 'ghost'"
            :aria-pressed="context.view === view.value"
            @click="changeFilter({ view: view.value })"
            >{{ view.label }}</AppButton
          >
        </div>
      </div>
      <AppStatusPanel v-if="error" state="error" :message="error" />
      <p v-if="loading" class="text-muted" role="status">正在读取问题与草稿…</p>
      <p v-if="error && data" class="text-sm text-muted">
        下方保留上次读取的记录，可刷新后查看最新处理情况。
      </p>
      <template v-if="data">
        <p v-if="!visibleCount" class="followup-empty">
          {{ context.project ? '这个项目在当前范围内没有记录。' : '当前范围内暂无记录。' }}
          <AppButton
            v-if="context.project || context.view !== 'all'"
            variant="ghost"
            @click="changeFilter({ project: '', view: 'all' })"
            >查看全部记录</AppButton
          >
          <RouterLink v-else :to="hallTarget" class="back-link">前往我的任务</RouterLink>
        </p>
        <section
          v-for="section in sections"
          :key="section.key"
          class="followup-section"
          :aria-labelledby="`followup-${section.key}`"
        >
          <div class="followup-section-heading">
            <h2 :id="`followup-${section.key}`">{{ section.title }}</h2>
            <span class="text-sm text-muted"
              >{{ section.rows.length }} {{ section.key === 'drafts' ? '份' : '项' }}</span
            >
          </div>
          <p v-if="!section.rows.length && visibleCount" class="text-sm text-muted">
            {{ section.empty }}
          </p>
          <ul class="followup-list">
            <li v-for="item in section.rows" :key="item.id" class="followup-row">
              <div class="followup-row-main">
                <div class="followup-identity">
                  <h3>
                    {{ item.project_name || '项目名称未记录' }} · 第 {{ item.page_number }} 条
                  </h3>
                  <span class="followup-state">{{
                    section.key === 'reports'
                      ? PROBLEM_STATES[item.issue?.status] || '状态待确认'
                      : '未完成草稿'
                  }}</span>
                </div>
                <template v-if="section.key === 'reports'">
                  <p class="text-sm text-muted">
                    {{ item.field || '整条' }} · {{ PROBLEM_TYPES[item.category] || '问题报告' }}
                  </p>
                  <p class="followup-text">{{ item.description }}</p>
                  <div class="followup-feedback">
                    <strong class="text-sm">管理员反馈</strong>
                    <p class="followup-text">
                      {{
                        item.issue?.feedback ||
                        (item.issue?.status === 'resolved'
                          ? '管理员已标记处理，暂未填写反馈说明。'
                          : '暂未收到文字反馈，可稍后刷新查看。')
                      }}
                    </p>
                    <p v-if="item.issue?.impact" class="followup-text text-sm">
                      影响范围：{{ item.issue.impact }}
                    </p>
                  </div>
                </template>
                <p v-else class="text-sm text-muted">
                  草稿不计作完整提交；继续任务前请对照最新来源核对。
                </p>
                <p v-if="item.stale" class="text-sm text-muted">
                  {{
                    section.key === 'drafts'
                      ? '来源或约定已变化，恢复后请重新核对。'
                      : '来源、约定或配置已变化，请确认旧处理意见是否仍适用。'
                  }}
                </p>
                <p v-if="item.task?.message" class="text-sm text-muted">{{ item.task.message }}</p>
                <p v-else-if="!item.task" class="text-sm text-muted">
                  暂未读取到可继续的任务状态，请刷新记录。
                </p>
                <p
                  v-if="rowErrors[rowKey(section.key, item)]"
                  class="alert alert-error followup-text"
                  role="alert"
                >
                  {{ rowErrors[rowKey(section.key, item)] }}
                </p>
              </div>
              <div v-if="actionable(item)" class="followup-actions">
                <AppButton
                  v-if="item.task.state === 'resume'"
                  :loading="busyRow === rowKey(section.key, item)"
                  :disabled="!!busyRow || loading"
                  @click="resume(item, section.key)"
                  >{{ section.key === 'drafts' ? '恢复草稿任务' : '恢复对应任务' }}</AppButton
                >
                <RouterLink
                  v-else
                  :to="
                    editTarget(
                      item.task.page,
                      item.task.state === 'review',
                      context,
                      item.task.state === 'current_task'
                    )
                  "
                  class="btn btn-secondary"
                  >{{
                    item.task.state === 'review' ? '回看本人提交' : '继续当前在手条目'
                  }}</RouterLink
                >
              </div>
            </li>
          </ul>
        </section>
      </template>
    </section>
  </main>
</template>
<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import AppButton from '@/components/AppButton.vue'
import AppField from '@/components/AppField.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppSelect from '@/components/AppSelect.vue'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import { useQueueReturnPosition } from '@/composables/useQueueReturnPosition'
import { useProtectedPageScope } from '@/composables/useProtectedPageScope'
import {
  getMyProblems,
  resumeProblemTask,
  PROBLEM_STATES,
  PROBLEM_TYPES
} from '@/services/verificationService'
import {
  readProblemFollowupContext,
  problemFollowupNavigationQuery,
  problemFollowupReturnTarget,
  problemFollowupHallTarget
} from '@/lib/problemFollowupContext'
import { saveTaskLease } from '@/lib/taskLease'
import { currentUserId } from '@/services/authService'
import { getPbMessage } from '@/utils/pbErrors'
const router = useRouter()
const route = useRoute()
const data = ref(null)
const loading = ref(false)
const busyRow = ref('')
const rowErrors = ref({})
const error = ref('')
const { capture, invalidate, accessLost } = useProtectedPageScope(() => {
  data.value = null
  rowErrors.value = {}
  loading.value = false
  busyRow.value = ''
  error.value = '当前账号已无法读取这些记录，请返回我的任务。'
})
const context = computed(
  () => readProblemFollowupContext(route.query) || { view: 'all', project: '' }
)
const hallTarget = computed(() => problemFollowupHallTarget(context.value))
useQueueReturnPosition(computed(() => Boolean(data.value) && !loading.value))
const views = [
  { value: 'all', label: '全部' },
  { value: 'drafts', label: '草稿' },
  { value: 'reports', label: '问题反馈' }
]
const projectOptions = computed(() => {
  const projects = new Map()
  for (const row of [...(data.value?.drafts || []), ...(data.value?.items || [])]) {
    if (row.project) projects.set(row.project, row.project_name || '项目名称未记录')
  }
  if (context.value.project && !projects.has(context.value.project))
    projects.set(context.value.project, '所选项目')
  return [
    { value: '', label: '全部项目' },
    ...Array.from(projects, ([value, label]) => ({ value, label }))
  ]
})
const sections = computed(() =>
  [
    {
      key: 'drafts',
      title: '未完成草稿',
      empty: '暂无服务端草稿。',
      rows: data.value?.drafts || []
    },
    { key: 'reports', title: '问题反馈', empty: '尚未提交问题。', rows: data.value?.items || [] }
  ]
    .filter((section) => context.value.view === 'all' || context.value.view === section.key)
    .map((section) => ({
      ...section,
      rows: section.rows.filter(
        (row) => !context.value.project || row.project === context.value.project
      )
    }))
)
const visibleCount = computed(() =>
  sections.value.reduce((total, section) => total + section.rows.length, 0)
)
const rowKey = (section, item) => `${section}:${item.id}`
const actionable = (item) =>
  ['resume', 'review', 'current_task'].includes(item.task?.state) &&
  /^[a-z0-9]{15}$/.test(item.task?.page || '')
function changeFilter(change) {
  const next = { ...context.value, ...change }
  router.replace(problemFollowupReturnTarget(next))
}
function editTarget(page, review = false, savedContext = context.value, continuing = false) {
  return {
    path: `/tasks/${page}/edit`,
    query: {
      ...problemFollowupNavigationQuery(savedContext),
      ...(review ? { mode: 'review' } : {}),
      ...(continuing ? { continueTask: '1' } : {})
    }
  }
}
onMounted(load)
async function load() {
  if (loading.value || accessLost.value || busyRow.value) return
  const request = capture()
  loading.value = true
  error.value = ''
  try {
    const result = await getMyProblems()
    if (request.isCurrent()) {
      data.value = result
      rowErrors.value = {}
    }
  } catch (e) {
    if (request.isCurrent() && !invalidate(e, request))
      error.value = getPbMessage(e, '问题与草稿读取失败，请刷新重试。')
  } finally {
    if (request.isCurrent()) loading.value = false
    request.finish()
  }
}
async function resume(item, section) {
  if (
    busyRow.value ||
    loading.value ||
    accessLost.value ||
    item.task?.state !== 'resume' ||
    !actionable(item)
  )
    return
  const key = rowKey(section, item)
  const pageId = item.task.page
  const savedContext = { ...context.value }
  const request = capture()
  busyRow.value = key
  rowErrors.value[key] = ''
  try {
    const result = await resumeProblemTask(pageId)
    if (!request.isCurrent()) return
    saveTaskLease(window.sessionStorage, {
      userId: currentUserId(),
      pageId,
      token: result.leaseToken,
      expiresAt: result.leaseExpiresAt
    })
    await router.push(editTarget(pageId, false, savedContext))
  } catch (e) {
    if (request.isCurrent())
      rowErrors.value[key] = getPbMessage(e, '恢复任务失败，请刷新记录后重试。')
  } finally {
    if (request.isCurrent()) busyRow.value = ''
    request.finish()
  }
}
</script>
<style scoped>
.problem-followup {
  max-width: 72rem;
}
.page-heading,
.followup-section-heading,
.followup-identity,
.followup-filters,
.followup-views {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.page-heading {
  justify-content: space-between;
  align-items: flex-start;
}
.page-heading .back-link {
  margin-bottom: var(--space-3);
}
.followup-panel {
  margin-top: var(--space-5);
}
.followup-filters {
  align-items: end;
  margin-bottom: var(--space-5);
}
.followup-project {
  width: min(100%, 24rem);
  margin-bottom: 0;
}
.followup-views {
  gap: var(--space-1);
}
.followup-views [aria-pressed='true'] {
  color: var(--primary);
  background: var(--primary-light);
}
.followup-section + .followup-section {
  margin-top: var(--space-6);
}
.followup-section-heading {
  margin-bottom: var(--space-3);
}
.followup-section-heading h2 {
  margin: 0;
}
.followup-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.followup-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  border-top: 1px solid var(--line);
  padding: var(--space-4) 0;
}
.followup-row-main {
  min-width: 0;
  flex: 1;
}
.followup-identity {
  gap: var(--space-2);
}
.followup-identity h3 {
  margin: 0;
  font-size: 1rem;
  overflow-wrap: anywhere;
}
.followup-state {
  color: var(--ink-muted);
  font-size: 0.8125rem;
}
.followup-row p {
  margin: var(--space-2) 0 0;
}
.followup-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.followup-feedback {
  border-left: 2px solid var(--line);
  padding-left: var(--space-3);
  margin-top: var(--space-3);
}
.followup-actions {
  flex-shrink: 0;
  max-width: 100%;
}
.followup-actions .btn {
  white-space: normal;
  text-align: center;
}
.followup-empty {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) 0;
}
@media (max-width: 640px) {
  .followup-row {
    flex-direction: column;
    gap: var(--space-3);
  }
  .followup-project {
    width: 100%;
  }
  .followup-actions {
    align-self: flex-start;
  }
}
</style>
