<template>
  <main class="container page workspace-page work-catalog admin-catalog">
    <header class="page-heading">
      <div>
        <h1>项目管理</h1>
        <p>查看项目进展，优先处理需要判断的条目。</p>
      </div>
      <div class="page-heading-actions">
        <AppButton
          variant="ghost"
          :loading="loading"
          loading-label="正在刷新"
          @click="loadDashboard()"
        >
          <AppIcon name="refresh" />刷新
        </AppButton>
        <RouterLink v-if="auth.canCreateProjects" to="/admin/projects/new" class="btn btn-primary"
          ><AppIcon name="plus" />创建项目</RouterLink
        >
      </div>
    </header>
    <ProjectHubTabs active="managed" />

    <AppStatusPanel
      v-if="error"
      state="error"
      :title="hasResult ? '更新失败，当前显示上次结果。' : '项目状态暂时无法加载。'"
      retry-label="重新加载"
      :busy="loading"
      @retry="loadDashboard()"
    >
      <span>{{ error }}</span>
    </AppStatusPanel>

    <dl
      class="catalog-summary catalog-summary--four admin-summary"
      aria-label="项目总体状态"
      :aria-busy="loading"
    >
      <div>
        <dt>项目总数</dt>
        <dd>{{ hasResult ? overallSummary.projects : '—' }}<span>个项目</span></dd>
        <small v-if="hasResult">{{ overallSummary.total }} 条材料</small>
      </div>
      <div>
        <dt>校对完成率</dt>
        <dd>{{ hasResult ? overallSummary.completionPct : '—' }}<span v-if="hasResult">%</span></dd>
        <small>{{
          hasResult
            ? `${overallSummary.approved} 条已完成 · ${overallSummary.incomplete} 条未完成`
            : '完成统计不受列表筛选影响'
        }}</small>
      </div>
      <div>
        <dt>校对处理中</dt>
        <dd>{{ hasResult ? overallSummary.active : '—' }}<span>条</span></dd>
      </div>
      <div :class="{ 'catalog-summary__attention': hasResult && overallSummary.arbitration > 0 }">
        <dt>等待仲裁</dt>
        <dd>{{ hasResult ? overallSummary.arbitration : '—' }}<span>条</span></dd>
      </div>
    </dl>

    <section
      class="admin-projects-card catalog-projects"
      aria-labelledby="admin-project-list-title"
      :aria-busy="loading"
    >
      <div class="section-heading">
        <div>
          <h2 id="admin-project-list-title">项目进展</h2>
        </div>
        <span v-if="loading && hasResult" class="admin-updating" role="status">正在更新…</span>
        <span v-else-if="hasResult" class="section-count">{{ pagination.totalItems }} 个项目</span>
      </div>

      <div class="admin-list-filters admin-insights-controls">
        <label class="admin-filter-field" for="admin-project-search">
          <span class="sr-only">搜索项目名或简介</span>
          <input
            id="admin-project-search"
            v-model="searchQuery"
            class="form-control"
            type="search"
            autocomplete="off"
            placeholder="输入项目名或简介关键词"
            @input="scheduleSearch"
          />
        </label>
        <div class="admin-quick-filters" role="group" aria-label="项目快捷筛选">
          <AppButton
            v-for="option in FILTER_OPTIONS"
            :key="option.value"
            type="button"
            size="sm"
            variant="ghost"
            :aria-pressed="dashboardQuery.filter === option.value"
            @click="setFilter(option.value)"
          >
            {{ option.label }}
          </AppButton>
        </div>
      </div>

      <AppStatusPanel v-if="loading && !hasResult" state="pending" message="正在加载项目…" />

      <div v-else-if="!hasResult && error" class="empty-state">
        <AppIcon name="refresh" />
        <div class="empty-state-text">项目状态暂时不可用</div>
        <p>请检查网络连接后重试；重试不会清空当前筛选条件。</p>
        <AppButton class="mt-3" :loading="loading" @click="loadDashboard()"> 重新加载 </AppButton>
      </div>

      <AppStatusPanel v-else-if="projectInsights.length === 0" state="empty" reason="none">
        <template v-if="hasActiveFilters && overallSummary.projects > 0">
          <AppIcon name="search" />
          <div class="empty-state-text">没有符合条件的项目</div>
          <p>当前搜索或快捷筛选没有结果，可以清除条件后查看全部项目。</p>
          <AppButton class="mt-3" @click="clearFilters"> 清除搜索与筛选 </AppButton>
        </template>
        <template v-else>
          <AppIcon name="project" />
          <div class="empty-state-text">还没有项目</div>
          <p>创建项目后，先上传原文 PDF，再用 CSV 导入待校对条目。</p>
          <RouterLink
            v-if="auth.canCreateProjects"
            to="/admin/projects/new"
            class="btn btn-primary mt-3"
            >创建第一个项目</RouterLink
          >
          <RouterLink v-else to="/projects" class="btn btn-secondary mt-3"
            >发现可加入项目</RouterLink
          >
        </template>
      </AppStatusPanel>

      <AppDataTable v-else label="项目进展表" table-class="admin-project-table">
        <template #head>
          <tr>
            <th>项目</th>
            <th>完成进度</th>
            <th>待办</th>
            <th>操作</th>
          </tr>
        </template>
        <tr
          v-for="item in projectInsights"
          :key="item.project.id"
          :data-project-id="item.project.id"
          :class="{ 'admin-project-row--urgent': item.summary.arbitration > 0 }"
        >
          <td class="admin-project-identity">
            <div class="admin-project-name">
              <RouterLink :to="`/admin/projects/${item.project.id}`" class="project-name-link">
                {{ item.project.name }}
              </RouterLink>
            </div>
            <p v-if="item.project.description">{{ item.project.description }}</p>
            <AppDisclosure class="project-status-details" label="状态与创建信息">
              <dl class="project-pipeline">
                <div>
                  <dt>待开始</dt>
                  <dd>{{ item.summary.unstarted }}</dd>
                </div>
                <div>
                  <dt>处理中</dt>
                  <dd>{{ item.summary.active }}</dd>
                </div>
                <div>
                  <dt>收集中</dt>
                  <dd>{{ item.summary.collecting }}</dd>
                </div>
                <div>
                  <dt>已完成</dt>
                  <dd>{{ item.summary.approved }}</dd>
                </div>
              </dl>
              <p class="project-created">创建于 {{ formatDate(item.project.created) }}</p>
            </AppDisclosure>
          </td>
          <td class="project-progress-cell">
            <div
              class="progress"
              role="progressbar"
              :aria-label="`${item.project.name} 校对进度`"
              :aria-valuenow="item.summary.completionPct"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <div class="progress-bar" :style="{ width: item.summary.completionPct + '%' }"></div>
            </div>
            <span
              >{{ item.summary.approved }} / {{ item.summary.total }} 条已完成 ·
              {{ item.summary.completionPct }}%</span
            >
          </td>
          <td class="admin-project-attention">
            <RouterLink
              v-if="item.summary.arbitration"
              :to="`/admin/projects/${item.project.id}?status=${PAGE_STATUS.ARBITRATION}`"
              class="attention-count"
            >
              {{ item.summary.arbitration }} 条待仲裁
            </RouterLink>
            <span v-else class="attention-clear">暂无待仲裁</span>
          </td>
          <td class="admin-project-action-cell">
            <div class="admin-project-actions">
              <RouterLink
                :to="
                  item.summary.arbitration
                    ? `/admin/projects/${item.project.id}?status=${PAGE_STATUS.ARBITRATION}`
                    : `/admin/projects/${item.project.id}`
                "
                class="btn btn-sm"
                :class="item.summary.arbitration ? 'btn-primary' : 'btn-secondary'"
              >
                {{ item.summary.arbitration ? '处理仲裁' : '管理项目' }}
              </RouterLink>
              <AppDropdown
                :aria-label="`${item.project.name} 更多操作`"
                :items="[{ label: '项目设置', to: `/admin/projects/${item.project.id}/settings` }]"
              />
            </div>
          </td>
        </tr>
      </AppDataTable>

      <AppPagination
        v-if="hasResult && projectInsights.length && pagination.totalPages > 1"
        :page="pagination.page"
        :total-pages="pagination.totalPages"
        :busy="loading"
        label="项目分页"
        @change="goToPage"
      />
    </section>
  </main>
</template>

<script setup>
import ProjectHubTabs from '@/components/ProjectHubTabs.vue'
import { useQueueReturnPosition } from '@/composables/useQueueReturnPosition'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import AppDataTable from '@/components/AppDataTable.vue'
import AppPagination from '@/components/AppPagination.vue'
import AppButton from '@/components/AppButton.vue'
import AppDropdown from '@/components/AppDropdown.vue'
import AppDisclosure from '@/components/AppDisclosure.vue'
import AppIcon from '@/components/AppIcon.vue'
import '@/styles/work-catalog.css'
import { useAsyncResource } from '@/composables/useAsyncResource'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { PAGE_STATUS } from '@/constants/pageStatus'
import {
  normalizeProjectInsightsQuery,
  toProjectInsightsRouteQuery
} from '@/lib/adminProjectInsights'
import { listProjectInsights } from '@/services/projectsService'
import { useAuthStore } from '@/stores/auth'
import { getPbMessage, getPbStatus } from '@/utils/pbErrors'

const PROJECTS_PER_PAGE = 12
const FILTER_OPTIONS = Object.freeze([
  { value: 'all', label: '全部' },
  { value: 'attention', label: '待仲裁' },
  { value: 'incomplete', label: '未完成' },
  { value: 'completed', label: '已完成' }
])

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const projectInsights = ref([])
const overallSummary = ref(emptySummary())
const pagination = ref({ page: 1, perPage: PROJECTS_PER_PAGE, totalItems: 0, totalPages: 0 })
const searchQuery = ref('')
const {
  pending: loading,
  error,
  hasValue: hasResult,
  reload: reloadDashboard
} = useAsyncResource(({ signal }, requested) => listProjectInsights(requested, { signal }), {
  formatError: dashboardError
})
useQueueReturnPosition(hasResult)
const dashboardQuery = computed(() =>
  normalizeProjectInsightsQuery({
    ...route.query,
    perPage: PROJECTS_PER_PAGE
  })
)
const hasActiveFilters = computed(
  () => Boolean(dashboardQuery.value.q) || dashboardQuery.value.filter !== 'all'
)
let searchTimer = null

watch(
  dashboardQuery,
  (query) => {
    clearSearchTimer()
    searchQuery.value = query.q
    loadDashboard(query)
  },
  { immediate: true }
)

onMounted(() => {
  auth.loadAccessContext().catch(() => {})
})

onBeforeUnmount(() => {
  clearSearchTimer()
})

async function loadDashboard(requestedQuery = dashboardQuery.value) {
  const requested = normalizeProjectInsightsQuery({ ...requestedQuery, perPage: PROJECTS_PER_PAGE })
  const request = await reloadDashboard(requested)
  if (!request.ok) return
  const result = request.data
  projectInsights.value = result.items || []
  overallSummary.value = result.summary || emptySummary()
  pagination.value = {
    page: result.page ?? requested.page,
    perPage: result.perPage ?? PROJECTS_PER_PAGE,
    totalItems: result.totalItems ?? projectInsights.value.length,
    totalPages: result.totalPages ?? 0
  }
  if (pagination.value.page !== requested.page) {
    router.replace({
      query: toProjectInsightsRouteQuery({ ...requested, page: pagination.value.page })
    })
  }
}

function scheduleSearch() {
  clearSearchTimer()
  searchTimer = setTimeout(() => {
    searchTimer = null
    replaceFilters({ q: searchQuery.value, page: 1 })
  }, 300)
}

function setFilter(filter) {
  clearSearchTimer()
  replaceFilters({ q: searchQuery.value, filter, page: 1 })
}

function clearFilters() {
  clearSearchTimer()
  searchQuery.value = ''
  replaceFilters({ q: '', filter: 'all', page: 1 })
}

function replaceFilters(patch) {
  const next = normalizeProjectInsightsQuery({
    ...dashboardQuery.value,
    ...patch,
    perPage: PROJECTS_PER_PAGE
  })
  if (sameDashboardQuery(next, dashboardQuery.value)) return
  return router.replace({ query: toProjectInsightsRouteQuery(next) })
}

function goToPage(page) {
  const nextPage = Number(page)
  if (!Number.isInteger(nextPage) || nextPage < 1 || nextPage > pagination.value.totalPages) return
  clearSearchTimer()
  const next = normalizeProjectInsightsQuery({
    ...dashboardQuery.value,
    q: searchQuery.value,
    page: nextPage,
    perPage: PROJECTS_PER_PAGE
  })
  if (sameDashboardQuery(next, dashboardQuery.value)) return
  return router.push({ query: toProjectInsightsRouteQuery(next) })
}

function sameDashboardQuery(left, right) {
  return left.q === right.q && left.filter === right.filter && left.page === right.page
}

function clearSearchTimer() {
  if (searchTimer !== null) clearTimeout(searchTimer)
  searchTimer = null
}

function emptySummary() {
  return {
    projects: 0,
    total: 0,
    unstarted: 0,
    active: 0,
    collecting: 0,
    arbitration: 0,
    approved: 0,
    incomplete: 0,
    completionPct: 0
  }
}

function dashboardError(cause) {
  const status = getPbStatus(cause)
  if (status === 401) return '登录状态已失效，请重新登录。'
  if (status === 403) return '无权限读取项目状态，请检查项目与条目的访问规则。'
  return getPbMessage(cause, '加载项目状态失败，请稍后重试。')
}

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString('zh-CN') : '—'
}
</script>

<style scoped>
.admin-catalog .admin-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-4) var(--space-5);
  margin-bottom: var(--space-4);
  padding-bottom: var(--space-4);
}
.admin-summary > div {
  display: grid;
  align-content: start;
  gap: var(--space-1);
}
.admin-catalog .admin-summary dt,
.admin-catalog .admin-summary dd,
.admin-catalog .admin-summary small {
  margin: 0;
}
.admin-catalog .admin-summary dd {
  font-size: var(--text-xl);
}
.admin-project-identity {
  width: 44%;
}
.admin-catalog :deep(.admin-project-table) {
  width: 100%;
}
.admin-catalog :deep(.admin-project-table td) {
  vertical-align: top;
}
.admin-project-attention {
  white-space: nowrap;
}
.admin-project-action-cell {
  width: 170px;
}
.admin-catalog .project-status-details :deep(.app-disclosure__trigger) {
  min-height: var(--control-height-sm);
  align-content: center;
  color: var(--ink-muted);
  font-size: var(--text-xs);
  font-weight: 400;
}
.admin-catalog .project-status-details .project-created {
  white-space: normal;
  margin-top: var(--space-2);
}
@media (max-width: 640px) {
  .admin-catalog .page-heading {
    margin-bottom: var(--space-3);
  }
  .admin-catalog .project-hub-tabs {
    margin-bottom: var(--space-3);
  }
  .admin-catalog .admin-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3) var(--space-4);
    margin-bottom: var(--space-3);
    padding-bottom: var(--space-3);
  }
  .admin-catalog .admin-summary dt {
    font-size: var(--text-sm);
  }
  .admin-catalog .admin-summary dd {
    font-size: var(--text-lg);
  }
  .admin-catalog .admin-summary dd span {
    font-size: var(--text-xs);
  }
  .admin-catalog .admin-summary > div {
    gap: var(--space-1);
  }
  .admin-catalog .section-heading {
    margin-bottom: var(--space-3);
  }
  .admin-catalog .admin-insights-controls {
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }
  .admin-catalog .admin-filter-field {
    min-width: 0;
  }
  .admin-catalog :deep(.table-wrapper) {
    overflow: visible;
    border: 0;
    border-radius: var(--radius-none);
  }
  .admin-catalog :deep(.admin-project-table),
  .admin-catalog :deep(.admin-project-table tbody) {
    display: block;
    min-width: 0;
    width: 100%;
  }
  .admin-catalog :deep(.admin-project-table) {
    border-radius: var(--radius-panel);
  }
  .admin-catalog :deep(.admin-project-table thead) {
    display: none;
  }
  .admin-catalog :deep(.admin-project-table tr) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: 'identity identity' 'progress progress' 'attention actions';
    gap: var(--space-2) var(--space-3);
    padding: var(--space-4) var(--space-3);
    border-bottom: 1px solid var(--line);
  }
  .admin-catalog :deep(.admin-project-table tr:last-child) {
    border-bottom: 0;
  }
  .admin-catalog :deep(.admin-project-table td) {
    display: block;
    min-width: 0;
    width: auto;
    padding: 0;
    border: 0;
  }
  .admin-catalog :deep(.admin-project-table tr:hover td) {
    background: transparent;
  }
  .admin-project-identity {
    grid-area: identity;
  }
  .admin-catalog .admin-project-name {
    display: block;
  }
  .admin-catalog .project-name-link {
    display: inline-flex;
    align-items: center;
    min-height: var(--control-height-touch);
    font-size: var(--text-lg);
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .admin-catalog :deep(.admin-project-table td:first-child p) {
    max-width: none;
  }
  .admin-catalog :deep(.admin-project-table td.project-progress-cell) {
    grid-area: progress;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  .project-progress-cell .progress {
    width: 72px;
    margin: 0;
  }
  .admin-project-attention {
    grid-area: attention;
    align-self: center;
  }
  .admin-catalog .attention-count {
    padding: 0;
    background: transparent;
    min-height: var(--control-height-touch);
    align-items: center;
    font-size: var(--text-sm);
  }
  .admin-project-action-cell {
    grid-area: actions;
  }
  .admin-project-actions {
    flex-wrap: nowrap;
    align-items: center;
    gap: var(--space-2);
  }
  .admin-catalog .project-status-details {
    margin-top: 0;
  }
  .admin-catalog .project-status-details :deep(.app-disclosure__trigger) {
    min-height: var(--control-height-touch);
  }
  .admin-catalog .project-pipeline {
    min-width: 0;
    width: 100%;
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
</style>
