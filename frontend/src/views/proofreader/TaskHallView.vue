<template>
  <main class="container page workspace-page work-catalog task-catalog">
    <header class="page-heading">
      <div>
        <h1>我的任务</h1>
        <p>继续当前工作，或领取下一条材料。</p>
      </div>
      <AppButton variant="ghost" @click="loadProjects" :loading="loading" loading-label="正在刷新">
        <AppIcon name="refresh" />
        刷新项目
      </AppButton>
    </header>

    <div v-if="practiceReturn" class="alert mb-4" role="note">
      <p>
        <strong>{{ practiceProject.name }}</strong> · 练习项目
      </p>
      <RouterLink :to="practiceReturn" class="btn btn-secondary btn-sm">返回练习步骤</RouterLink>
    </div>

    <nav class="task-view-tabs" aria-label="任务视图">
      <RouterLink
        :to="taskViewRoute('active')"
        :class="{ 'is-active': taskView === 'active' }"
        :aria-current="taskView === 'active' ? 'page' : undefined"
        >进行中</RouterLink
      >
      <RouterLink
        :to="taskViewRoute('available')"
        :class="{ 'is-active': taskView === 'available' }"
        :aria-current="taskView === 'available' ? 'page' : undefined"
        >待领取</RouterLink
      >
      <RouterLink to="/tasks/problems">问题与草稿</RouterLink>
      <RouterLink
        :to="taskViewRoute('reviewed')"
        :class="{ 'is-active': taskView === 'reviewed' }"
        :aria-current="taskView === 'reviewed' ? 'page' : undefined"
        >已提交</RouterLink
      >
    </nav>
    <p v-if="selectedProject" class="task-project-filter">
      当前任务列表仅显示所选项目。
      <template v-if="practiceReturn">查看全部参与项目会退出当前练习范围。</template>
      <RouterLink :to="allProjectsTarget">查看全部参与项目</RouterLink>
    </p>
    <AppStatusPanel
      v-if="loadError"
      state="error"
      title="项目暂时无法加载"
      :message="loadError"
      retry-label="重新加载"
      :busy="loading"
      @retry="loadProjects"
    >
      <p>{{ loadError }}</p>
      <p v-if="hasCurrentResults">下方保留上次成功加载的项目和统计，可能不是最新结果。</p>
      <p v-else-if="hasLoadedProjects">本次列表暂不可用，概况保留上次读取的统计。</p>
      <p v-else>项目与统计暂不可用，这不代表没有任务。</p>
    </AppStatusPanel>

    <p v-if="selectedProject || searchQuery" class="text-sm text-muted">
      以下概况统计全部参与项目。
    </p>
    <dl class="catalog-summary" aria-label="全部参与项目的校对概况">
      <div>
        <dt>正在处理</dt>
        <dd>{{ hasLoadedProjects ? queueSummary.activeProjects : '—' }}<span>个项目</span></dd>
      </div>
      <div>
        <dt>现在可领取</dt>
        <dd>{{ hasLoadedProjects ? queueSummary.availableProjects : '—' }}<span>个项目</span></dd>
      </div>
      <div>
        <dt>校对已完成</dt>
        <dd>
          {{ hasLoadedProjects ? queueSummary.completedItems : '—'
          }}<span v-if="hasLoadedProjects"> / {{ queueSummary.totalItems }} 条</span>
        </dd>
      </div>
    </dl>

    <div v-if="actionError" class="alert alert-error" role="alert">{{ actionError }}</div>

    <section aria-labelledby="project-list-title">
      <div class="section-heading">
        <div>
          <h2 id="project-list-title">
            {{
              taskView === 'active'
                ? '继续校对'
                : taskView === 'reviewed'
                  ? '本人已提交记录'
                  : '可以领取的项目'
            }}
          </h2>
          <p>
            {{
              taskView === 'reviewed'
                ? '回看本人提交的结果，内容只读。'
                : '本机草稿自动保留，提交后继续同项目下一条。'
            }}
          </p>
        </div>
        <span v-if="hasCurrentResults && !loading" class="section-count"
          >{{ totalProjects }} 个项目</span
        >
      </div>

      <form class="task-project-search" role="search" @submit.prevent="applyProjectSearch">
        <AppField label="搜索项目名称">
          <input
            v-model="searchInput"
            type="search"
            class="form-control"
            autocomplete="off"
            placeholder="输入项目名称"
            :aria-invalid="searchError ? 'true' : undefined"
            :aria-describedby="searchError ? 'task-project-search-error' : undefined"
            @input="searchError = ''"
          />
        </AppField>
        <AppButton type="submit" variant="primary">搜索</AppButton>
        <AppButton v-if="searchInput || searchQuery" variant="ghost" @click="clearProjectSearch">
          清除搜索
        </AppButton>
      </form>
      <p v-if="searchError" id="task-project-search-error" class="alert alert-warning" role="alert">
        {{ searchError }}
      </p>
      <p v-if="searchQuery" class="text-sm text-muted task-search-keyword">
        当前搜索「{{ searchQuery }}」
      </p>

      <p
        v-if="loading && hasCurrentResults"
        class="text-sm text-muted"
        role="status"
        data-task-list-updating
      >
        正在更新任务列表，已有内容仍可查看。
      </p>
      <div v-if="loading && !hasCurrentResults" class="project-card-grid" aria-label="正在加载项目">
        <div
          v-for="index in 3"
          :key="index"
          class="project-work-card skeleton-card"
          aria-hidden="true"
        >
          <span class="skeleton-line skeleton-line--short"></span>
          <span class="skeleton-line"></span>
          <span class="skeleton-line"></span>
        </div>
      </div>

      <div
        v-else-if="hasCurrentResults && !loading && !loadError && displayQueues.length === 0"
        class="empty-state card"
      >
        <AppIcon name="check" />
        <div class="empty-state-text">
          {{
            searchQuery
              ? '当前视图没有匹配的项目'
              : taskView === 'active'
                ? '没有进行中的任务'
                : taskView === 'reviewed'
                  ? '还没有本人提交记录'
                  : '暂时没有可领取任务'
          }}
        </div>
        <p>
          {{
            searchQuery
              ? '可换一个关键词或切换任务视图。'
              : selectedProject
                ? '当前项目在此视图没有匹配任务。可以切换视图，或查看全部参与项目。'
                : '可以切换任务视图，或加入一个新的项目。'
          }}
        </p>
        <AppButton v-if="searchQuery" variant="secondary" @click="clearProjectSearch">
          清除搜索
        </AppButton>
        <RouterLink
          v-else-if="taskView === 'active'"
          :to="taskViewRoute('available')"
          class="btn btn-primary"
          >查看待领取任务</RouterLink
        >
        <RouterLink v-else to="/projects" class="btn btn-secondary">浏览项目</RouterLink>
      </div>

      <div v-else-if="hasCurrentResults" class="project-card-grid">
        <article
          v-for="queue in displayQueues"
          :key="queue.project.id"
          class="project-work-card"
          :class="`project-work-card--${queueAction(queue).tone}`"
        >
          <header class="project-work-card__header">
            <div class="catalog-project-identity">
              <AppIcon name="project" />
              <div>
                <span class="work-state" :class="`work-state--${queueAction(queue).tone}`">
                  {{
                    taskView === 'reviewed'
                      ? '本人提交 · 只读'
                      : queue.activeMine > 0
                        ? '进行中'
                        : queue.claimable > 0
                          ? '可领取'
                          : '暂无可领取任务'
                  }}
                </span>
                <h3>{{ queue.project.name }}</h3>
                <ProjectPurposeBadge :purpose="queue.project.purpose" />
              </div>
            </div>
            <span class="project-progress-number"
              ><small>校对完成</small><strong>{{ progressPct(queue) }}%</strong></span
            >
          </header>

          <p v-if="queue.project.description" class="project-description">
            {{ queue.project.description }}
          </p>

          <div
            class="progress project-progress"
            role="progressbar"
            :aria-label="`${queue.project.name} 校对进度`"
            :aria-valuenow="progressPct(queue)"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div class="progress-bar" :style="{ width: progressPct(queue) + '%' }"></div>
          </div>

          <dl class="queue-metrics">
            <div>
              <dt>可领取</dt>
              <dd>{{ queue.claimable }}</dd>
            </div>
            <div>
              <dt>我的进行中</dt>
              <dd>{{ queue.activeMine }}</dd>
            </div>
            <div>
              <dt>完成</dt>
              <dd>{{ queue.completed }} / {{ queue.total }}</dd>
            </div>
          </dl>

          <AppDisclosure
            v-if="taskView !== 'reviewed' && (tierRows(queue).length || queue.missingGlyph)"
            class="task-options"
            label="按难度选择任务"
          >
            <div class="queue-tiers" aria-label="按难度层级领取">
              <AppButton
                v-for="option in tierRows(queue)"
                :key="option.key"
                class="queue-tier"
                variant="secondary"
                size="sm"
                :disabled="loading || claimingProject === queue.project.id"
                @click="enterProject(queue, option.key)"
              >
                {{ option.label }} · {{ option.count }}
              </AppButton>
              <AppButton
                v-if="queue.missingGlyph"
                class="queue-tier queue-tier--glyph"
                variant="secondary"
                size="sm"
                :disabled="loading || claimingProject === queue.project.id"
                @click="enterProject(queue, '', true)"
              >
                缺字待登记 · {{ queue.missingGlyph }}
              </AppButton>
              <span v-if="tierUnknown(queue)" class="queue-tier queue-tier--muted">
                信号不足 {{ tierUnknown(queue) }}
              </span>
              <span v-if="tierUnlabeled(queue)" class="queue-tier queue-tier--muted">
                未评估 {{ tierUnlabeled(queue) }}
              </span>
              <span v-if="tierResidual(queue)" class="queue-tier queue-tier--warn" role="status">
                {{ tierResidualText(queue) }}
              </span>
            </div>
          </AppDisclosure>

          <footer class="project-work-card__footer">
            <span>{{
              taskView === 'reviewed' ? '选择要回看的本人提交条目' : queueAction(queue).detail
            }}</span>
            <div class="project-work-card__actions">
              <AppButton
                :variant="taskView === 'reviewed' ? 'primary' : 'ghost'"
                :disabled="loading || Boolean(claimingProject)"
                @click="openOwnSubmissions(queue)"
              >
                回看已提交
              </AppButton>
              <AppButton
                v-if="taskView !== 'reviewed'"
                variant="primary"
                :loading="claimingProject === queue.project.id"
                loading-label="正在打开…"
                :disabled="
                  loading || claimingProject === queue.project.id || !queueAction(queue).canEnter
                "
                @click="enterProject(queue)"
              >
                {{ queueAction(queue).label }}
                <AppIcon v-if="queueAction(queue).canEnter" name="arrow" />
              </AppButton>
            </div>
          </footer>
        </article>
      </div>
      <AppPagination
        v-if="hasCurrentResults && totalPages > 1"
        :page="currentPage"
        :total-pages="totalPages"
        :busy="loading"
        label="项目分页"
        @change="changeProjectPage"
      />
    </section>
  </main>
</template>

<script setup>
import ProjectPurposeBadge from '@/components/ProjectPurposeBadge.vue'
import { computed, ref, onBeforeUnmount, onMounted, watch } from 'vue'
import { useAsyncResource } from '@/composables/useAsyncResource'
import { useQueueReturnPosition } from '@/composables/useQueueReturnPosition'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import AppPagination from '@/components/AppPagination.vue'
import AppButton from '@/components/AppButton.vue'
import AppField from '@/components/AppField.vue'
import { normalizeTaskSearchQuery, taskHallNavigationQuery } from '@/lib/taskHallContext'
import AppDisclosure from '@/components/AppDisclosure.vue'
import AppIcon from '@/components/AppIcon.vue'
import '@/styles/work-catalog.css'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { currentUserId } from '@/services/authService'
import { claimNextProjectPage, listProjectQueueSummaries } from '@/services/pagesService'
import { getProofreaderQueueAction, summarizeProofreaderQueues } from '@/lib/workspaceInsights'
import { taskTierLabel, tierBreakdown } from '@/lib/taskTiers'
import { formatClaimConflict, formatPbError } from '@/utils/pbErrors'
import { saveTaskLease, saveGlyphQueue } from '@/lib/taskLease'
import {
  readPracticeContext,
  practiceNavigationQuery,
  practiceGuideTarget,
  canUsePracticeProject
} from '@/lib/practiceContext'
import { getProject } from '@/services/projectsService'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const loading = ref(true)
const hasLoadedProjects = ref(false)
const claimingProject = ref('')
const loadError = ref('')
const actionError = ref('')
let active = true
let actionGeneration = 0
onBeforeUnmount(() => {
  active = false
  actionGeneration++
})
function beginAction() {
  const generation = ++actionGeneration
  const userId = currentUserId(auth.user)
  const token = auth.token
  const fullPath = route.fullPath
  const isLatest = () => active && generation === actionGeneration
  return {
    isLatest,
    isCurrent: () =>
      isLatest() &&
      currentUserId(auth.user) === userId &&
      auth.token === token &&
      route.fullPath === fullPath
  }
}
watch(
  () => route.fullPath,
  () => {
    actionGeneration++
    claimingProject.value = ''
  }
)

const projectQueues = ref([])
const queueSummary = ref(summarizeProofreaderQueues([]))
const requestedPage = computed(() => Math.max(1, Number(route.query.page) || 1))
const currentPage = ref(requestedPage.value)
const searchQuery = computed(() => normalizeTaskSearchQuery(route.query.q))
const searchInput = ref(searchQuery.value)
const searchError = ref('')
watch(searchQuery, (query) => {
  searchInput.value = query
  searchError.value = ''
})
const selectedProject = computed(() => String(route.query.project || ''))
const practiceContext = computed(() => readPracticeContext(route.query, selectedProject.value))
const {
  data: practiceProject,
  pending: practicePending,
  error: practiceError,
  reload: readPracticeProject,
  cancel: cancelPracticeProject
} = useAsyncResource(async ({ signal }, context) => {
  const project = await getProject(context.projectId, { signal })
  return canUsePracticeProject(project, context.role, auth.isPlatformAdmin) ? project : null
})
const practiceReturn = computed(() =>
  !practicePending.value &&
  !practiceError.value &&
  practiceContext.value &&
  practiceProject.value?.id === practiceContext.value.projectId &&
  canUsePracticeProject(practiceProject.value, practiceContext.value.role, auth.isPlatformAdmin)
    ? practiceGuideTarget(practiceContext.value)
    : null
)
watch(
  practiceContext,
  (context) => {
    if (context) void readPracticeProject(context)
    else cancelPracticeProject()
  },
  { immediate: true }
)
const taskView = computed(() =>
  ['active', 'available', 'reviewed'].includes(route.query.view) ? route.query.view : 'active'
)
const totalProjects = ref(0)
const totalPages = ref(1)
const queueResource = useAsyncResource(
  async ({ signal }) => {
    const userId = currentUserId(auth.user)
    if (!userId) throw new Error('登录状态已失效，请重新登录')
    return listProjectQueueSummaries(requestedPage.value, 12, {
      signal,
      filter: taskView.value,
      project: selectedProject.value || undefined,
      q: searchQuery.value || undefined
    })
  },
  {
    formatError: (error) => formatPbError('加载项目大厅失败', error),
    onChange: (state) => {
      loading.value = state.pending
      loadError.value = state.error
    }
  }
)

const loadedQueueScope = ref('')
const queueScope = computed(() =>
  JSON.stringify([taskView.value, selectedProject.value, searchQuery.value, requestedPage.value])
)
const hasCurrentResults = computed(
  () => hasLoadedProjects.value && loadedQueueScope.value === queueScope.value
)
useQueueReturnPosition(computed(() => hasCurrentResults.value && !loading.value))
const displayQueues = computed(() =>
  projectQueues.value.filter((queue) =>
    taskView.value === 'active'
      ? queue.activeMine > 0
      : taskView.value === 'available'
        ? Boolean(queue.nextPage)
        : true
  )
)
const allProjectsTarget = computed(() => ({
  path: '/tasks',
  query: { view: taskView.value, ...(searchQuery.value ? { q: searchQuery.value } : {}) }
}))
function taskViewRoute(view) {
  const query = { ...route.query, page: undefined, view }
  const context = practiceContext.value
  if (practiceReturn.value && context?.role === 'proofreader') {
    const steps = { active: 'proofread', available: 'claim', reviewed: 'reviewed' }
    Object.assign(query, practiceNavigationQuery({ ...context, step: steps[view] }))
  }
  return { path: '/tasks', query }
}
function applyProjectSearch() {
  const query = normalizeTaskSearchQuery(searchInput.value)
  if ([...query].length > 100) {
    searchError.value = '项目名称最多输入 100 个字符。'
    return
  }
  searchInput.value = query
  searchError.value = ''
  return router.push({
    path: route.path,
    query: { ...route.query, page: undefined, q: query || undefined }
  })
}
function clearProjectSearch() {
  searchInput.value = ''
  return applyProjectSearch()
}
watch(queueScope, () => void loadProjects())
onMounted(loadProjects)

async function loadProjects({ keepActionError = false } = {}) {
  if (!keepActionError) actionError.value = ''
  const scope = queueScope.value
  const result = await queueResource.reload()
  if (!result.ok || queueScope.value !== scope) return
  projectQueues.value = result.data.items
  loadedQueueScope.value = scope
  queueSummary.value = result.data.summary
  currentPage.value = result.data.page
  totalPages.value = result.data.totalPages
  totalProjects.value = Number(result.data.totalItems) || 0
  hasLoadedProjects.value = true
}

function changeProjectPage(page) {
  router.push({ path: route.path, query: { ...route.query, page: String(page) } })
}

function taskEditorTarget(queue, pageId) {
  const context =
    queue.project.purpose === 'practice' ? readPracticeContext(route.query, queue.project.id) : null
  return {
    path: `/tasks/${pageId}/edit`,
    query: {
      ...taskHallNavigationQuery({
        view: taskView.value,
        page: currentPage.value,
        project: selectedProject.value,
        q: searchQuery.value
      }),
      ...(context ? practiceNavigationQuery(context) : {})
    }
  }
}

function openOwnSubmissions(queue) {
  const projectId = queue?.project?.id
  if (!projectId || claimingProject.value) return
  const context =
    queue.project.purpose === 'practice' ? readPracticeContext(route.query, projectId) : null
  return router.push({
    name: 'OwnSubmissions',
    params: { projectId },
    query: {
      taskView: taskView.value,
      taskPage: String(currentPage.value),
      ...(searchQuery.value ? { taskQ: searchQuery.value } : {}),
      ...(selectedProject.value === projectId ? { taskProject: projectId } : {}),
      ...(context?.role === 'proofreader'
        ? practiceNavigationQuery({ ...context, step: 'reviewed' })
        : {})
    }
  })
}

async function enterProject(queue, tier = '', glyph = false) {
  const projectId = queue?.project?.id
  if (!projectId || claimingProject.value || !queueAction(queue).canEnter) return
  const { isCurrent, isLatest } = beginAction()
  claimingProject.value = projectId
  actionError.value = ''
  try {
    const userId = currentUserId(auth.user)
    if (!userId) throw new Error('登录状态已失效，请重新登录')
    const page = await claimNextProjectPage(projectId, userId, '', tier, glyph)
    if (!isCurrent()) return
    if (!page?.id) {
      actionError.value = glyph
        ? '缺字待登记队列暂时没有可领取的条目。'
        : tier
          ? `暂无可领取的「${taskTierLabel(tier, '所选难度')}」任务，可选择其他难度或按默认顺序领取。`
          : '该项目暂无你可处理的条目。'
      await loadProjects({ keepActionError: true })
      return
    }
    saveTaskLease(window.sessionStorage, {
      userId,
      pageId: page.id,
      token: page.leaseToken,
      expiresAt: page.leaseExpiresAt
    })
    saveGlyphQueue(window.sessionStorage, { userId, projectId, glyph })
    await router.push(taskEditorTarget(queue, page.id))
  } catch (e) {
    if (!isCurrent()) return
    actionError.value = `进入项目失败：${formatClaimConflict(e, '该项目的下一条任务可能已被其他校对员接取，请刷新后重试')}`
    await loadProjects({ keepActionError: true })
  } finally {
    if (isLatest()) claimingProject.value = ''
  }
}

function queueAction(queue) {
  return getProofreaderQueueAction(queue)
}

// #162：层级是渐进增强。没算过标签的项目在这里就是空数组，卡片与改动前一致。
function tierRows(queue) {
  return tierBreakdown(queue)?.options ?? []
}

function tierUnlabeled(queue) {
  return tierBreakdown(queue)?.unlabeledCount ?? 0
}

// #247：unknown（算过但信号不足）与 unlabeled（从没算过）是两件事，
// 必须各说各的——合成一句"没层级"会让人以为再等等就有了。
function tierUnknown(queue) {
  return tierBreakdown(queue)?.unknownCount ?? 0
}

function tierResidual(queue) {
  return tierBreakdown(queue)?.residual ?? 0
}

function tierResidualText(queue) {
  const gap = tierResidual(queue)
  return gap > 0 ? `另有 ${gap} 条未落任何档` : `分层计数比可领取多 ${-gap} 条`
}

function progressPct(queue) {
  if (!queue?.total) return 0
  return Math.round((queue.completed / queue.total) * 100)
}
</script>

<style scoped>
.task-project-search {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-block: var(--space-3);
}

.task-project-search :deep(.form-group) {
  flex: 0 1 20rem;
  min-width: 0;
  margin: 0;
}

.task-project-search :deep(.form-control),
.task-project-search :deep(.btn) {
  min-height: 44px;
}

.task-search-keyword {
  margin-block-end: var(--space-3);
  overflow-wrap: anywhere;
}

@media (max-width: 480px) {
  .task-project-search :deep(.form-group) {
    flex-basis: 100%;
  }
}
</style>
