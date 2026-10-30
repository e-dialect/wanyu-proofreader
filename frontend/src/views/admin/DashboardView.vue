<template>
  <main class="container page workspace-page">
    <header class="page-heading">
      <div>
        <div class="page-eyebrow">项目管理工作台</div>
        <h1>先处理异常，再推进项目</h1>
        <p>按项目查看校对进展，优先处理待仲裁条目，再继续准备文件、管理条目或导出结果。</p>
      </div>
      <div class="page-heading-actions">
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="loadDashboard()">
          <span aria-hidden="true">↻</span>{{ loading ? '正在刷新' : '刷新' }}
        </button>
        <RouterLink v-if="auth.canCreateProjects" to="/admin/projects/new" class="btn btn-primary">创建新项目</RouterLink>
      </div>
    </header>

    <div v-if="error" class="alert alert-error" role="alert">
      <strong>{{ hasResult ? '更新失败，当前显示上次结果。' : '项目状态暂时无法加载。' }}</strong>
      <span>{{ error }}</span>
      <button v-if="hasResult" type="button" class="btn btn-secondary btn-sm ml-2" :disabled="loading" @click="loadDashboard()">重新加载</button>
    </div>

    <section class="workspace-summary admin-workspace-summary" aria-label="项目总体状态" :aria-busy="loading">
      <article class="workspace-stat">
        <span>项目总数</span>
        <strong>{{ hasResult ? overallSummary.projects : '—' }}</strong>
        <small>{{ hasResult ? `${overallSummary.total} 条方言材料` : '统计尚未加载' }}</small>
      </article>
      <article class="workspace-stat workspace-stat--accent">
        <span>整体完成率</span>
        <strong>{{ hasResult ? overallSummary.completionPct : '—' }}<em v-if="hasResult">%</em></strong>
        <small>{{ hasResult ? `${overallSummary.approved} 条已完成 · ${overallSummary.incomplete} 条未完成` : '完成统计不受列表筛选影响' }}</small>
      </article>
      <article class="workspace-stat">
        <span>校对处理中</span>
        <strong>{{ hasResult ? overallSummary.active : '—' }}</strong>
        <small>条已由校对员领取</small>
      </article>
      <article class="workspace-stat" :class="{ 'workspace-stat--urgent': hasResult && overallSummary.arbitration > 0 }">
        <span>等待管理员仲裁</span>
        <strong>{{ hasResult ? overallSummary.arbitration : '—' }}</strong>
        <small>{{ !hasResult ? '统计尚未加载' : overallSummary.arbitration ? '需要逐字段确认' : '目前没有异常积压' }}</small>
      </article>
    </section>

    <section class="card admin-projects-card" aria-labelledby="admin-project-list-title" :aria-busy="loading">
      <div class="section-heading">
        <div>
          <h2 id="admin-project-list-title">项目进展</h2>
          <p>总体统计覆盖全部项目；搜索与快捷筛选只改变下方列表。</p>
        </div>
        <span v-if="loading && hasResult" class="admin-updating" role="status">正在更新…</span>
        <span v-else-if="hasResult" class="section-count">{{ pagination.totalItems }} 个项目</span>
      </div>

      <div class="admin-list-filters admin-insights-controls">
        <label class="admin-filter-field" for="admin-project-search">
          <span>搜索项目名或简介</span>
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
          <button
            v-for="option in FILTER_OPTIONS"
            :key="option.value"
            type="button"
            class="btn btn-sm"
            :class="dashboardQuery.filter === option.value ? 'btn-primary' : 'btn-secondary'"
            :aria-pressed="dashboardQuery.filter === option.value"
            @click="setFilter(option.value)"
          >{{ option.label }}</button>
        </div>
      </div>

      <div v-if="loading && !hasResult" class="project-card-grid admin-project-skeletons" aria-label="正在加载项目">
        <div v-for="index in 3" :key="index" class="project-work-card skeleton-card" aria-hidden="true">
          <span class="skeleton-line skeleton-line--short"></span>
          <span class="skeleton-line"></span>
          <span class="skeleton-line"></span>
        </div>
      </div>

      <div v-else-if="!hasResult && error" class="empty-state">
        <div class="empty-state-mark" aria-hidden="true">!</div>
        <div class="empty-state-text">项目状态暂时不可用</div>
        <p>请检查网络连接后重试；重试不会清空当前筛选条件。</p>
        <button type="button" class="btn btn-secondary mt-3" :disabled="loading" @click="loadDashboard()">重新加载</button>
      </div>

      <div v-else-if="projectInsights.length === 0" class="empty-state">
        <template v-if="hasActiveFilters && overallSummary.projects > 0">
          <div class="empty-state-mark" aria-hidden="true">筛</div>
          <div class="empty-state-text">没有符合条件的项目</div>
          <p>当前搜索或快捷筛选没有结果，可以清除条件后查看全部项目。</p>
          <button type="button" class="btn btn-secondary mt-3" @click="clearFilters">清除搜索与筛选</button>
        </template>
        <template v-else>
          <div class="empty-state-mark" aria-hidden="true">项</div>
          <div class="empty-state-text">还没有项目</div>
          <p>创建项目后，先上传原文 PDF，再用 CSV 导入待校对条目。</p>
          <RouterLink v-if="auth.canCreateProjects" to="/admin/projects/new" class="btn btn-primary mt-3">创建第一个项目</RouterLink>
          <RouterLink v-else to="/projects" class="btn btn-secondary mt-3">发现可加入项目</RouterLink>
        </template>
      </div>

      <div v-else class="table-wrapper" role="region" tabindex="0" aria-label="项目进展表">
        <table class="admin-project-table">
          <thead>
            <tr>
              <th>项目</th>
              <th>完成进度</th>
              <th>待仲裁</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in projectInsights"
              :key="item.project.id"
              :class="{ 'admin-project-row--urgent': item.summary.arbitration > 0 }"
            >
              <td>
                <div class="admin-project-name">
                  <RouterLink :to="`/admin/projects/${item.project.id}`" class="project-name-link">
                    {{ item.project.name }}
                  </RouterLink>
                  <span v-if="item.summary.arbitration" class="badge badge-arbitration">待仲裁</span>
                </div>
                <p>{{ item.project.description || '暂无项目简介' }}</p>
                <details class="project-status-details">
                  <summary>状态明细 <span>{{ item.summary.total }} 条</span></summary>
                  <dl class="project-pipeline">
                    <div><dt>待开始</dt><dd>{{ item.summary.unstarted }}</dd></div>
                    <div><dt>处理中</dt><dd>{{ item.summary.active }}</dd></div>
                    <div><dt>收集中</dt><dd>{{ item.summary.collecting }}</dd></div>
                    <div><dt>已完成</dt><dd>{{ item.summary.approved }}</dd></div>
                  </dl>
                </details>
              </td>
              <td class="project-progress-cell">
                <div class="progress" role="progressbar" :aria-label="`${item.project.name} 校对进度`" :aria-valuenow="item.summary.completionPct" aria-valuemin="0" aria-valuemax="100">
                  <div class="progress-bar" :style="{ width: item.summary.completionPct + '%' }"></div>
                </div>
                <span>{{ item.summary.completionPct }}% · {{ item.summary.approved }}/{{ item.summary.total }}</span>
              </td>
              <td>
                <RouterLink
                  v-if="item.summary.arbitration"
                  :to="`/admin/projects/${item.project.id}?status=${PAGE_STATUS.ARBITRATION}`"
                  class="attention-count"
                >
                  {{ item.summary.arbitration }} 条待仲裁
                </RouterLink>
                <span v-else class="attention-clear">无异常</span>
              </td>
              <td class="text-sm text-muted">{{ formatDate(item.project.created) }}</td>
              <td>
                <div class="admin-project-actions">
                  <RouterLink
                    :to="item.summary.arbitration
                      ? `/admin/projects/${item.project.id}?status=${PAGE_STATUS.ARBITRATION}`
                      : `/admin/projects/${item.project.id}`"
                    class="btn btn-sm"
                    :class="item.summary.arbitration ? 'btn-warn' : 'btn-secondary'"
                  >
                    {{ item.summary.arbitration ? '处理仲裁' : '管理项目' }}
                  </RouterLink>
                  <details class="project-more-actions">
                    <summary class="btn btn-quiet btn-sm" :aria-label="`${item.project.name} 更多操作`">更多操作</summary>
                    <div class="project-more-actions__menu">
                      <RouterLink :to="`/admin/projects/${item.project.id}/settings`" class="btn btn-quiet btn-sm">项目设置</RouterLink>
                    </div>
                  </details>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <nav v-if="hasResult && projectInsights.length && pagination.totalPages > 1" class="admin-pagination" aria-label="项目分页">
        <button type="button" class="btn btn-secondary" :disabled="pagination.page <= 1" @click="goToPage(pagination.page - 1)">上一页</button>
        <span aria-live="polite">第 {{ pagination.page }} / {{ pagination.totalPages }} 页</span>
        <button type="button" class="btn btn-secondary" :disabled="pagination.page >= pagination.totalPages" @click="goToPage(pagination.page + 1)">下一页</button>
      </nav>
    </section>
  </main>
</template>

<script setup>
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
const loading = ref(true)
const hasResult = ref(false)
const error = ref('')
const dashboardQuery = computed(() => normalizeProjectInsightsQuery({
  ...route.query,
  perPage: PROJECTS_PER_PAGE
}))
const hasActiveFilters = computed(() => Boolean(dashboardQuery.value.q) || dashboardQuery.value.filter !== 'all')
let loadGeneration = 0
let searchTimer = null

watch(dashboardQuery, (query) => {
  clearSearchTimer()
  searchQuery.value = query.q
  loadDashboard(query)
}, { immediate: true })

onMounted(() => {
  auth.loadAccessContext().catch(() => {})
})

onBeforeUnmount(() => {
  loadGeneration += 1
  clearSearchTimer()
})

async function loadDashboard(requestedQuery = dashboardQuery.value) {
  const requested = normalizeProjectInsightsQuery({ ...requestedQuery, perPage: PROJECTS_PER_PAGE })
  const generation = ++loadGeneration
  loading.value = true
  error.value = ''

  try {
    const result = await listProjectInsights(requested)
    if (generation !== loadGeneration) return
    projectInsights.value = result.items || []
    overallSummary.value = result.summary || emptySummary()
    pagination.value = {
      page: result.page ?? requested.page,
      perPage: result.perPage ?? PROJECTS_PER_PAGE,
      totalItems: result.totalItems ?? projectInsights.value.length,
      totalPages: result.totalPages ?? 0
    }
    hasResult.value = true
    if (pagination.value.page !== requested.page) {
      router.replace({ query: toProjectInsightsRouteQuery({ ...requested, page: pagination.value.page }) })
    }
  } catch (cause) {
    if (generation !== loadGeneration) return
    error.value = dashboardError(cause)
  } finally {
    if (generation === loadGeneration) loading.value = false
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
