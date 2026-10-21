<template>
  <main class="container page workspace-page">
    <header class="page-heading">
      <div>
        <div class="page-eyebrow">项目管理工作台</div>
        <h1>先处理异常，再推进项目</h1>
        <p>待仲裁项目已优先排列；进入项目后可继续准备文件、管理条目或导出结果。</p>
      </div>
      <div class="page-heading-actions">
        <button class="btn btn-secondary" :disabled="loading" @click="loadDashboard">
          <span aria-hidden="true">↻</span>{{ loading ? '正在刷新' : '刷新' }}
        </button>
        <RouterLink v-if="auth.canCreateProjects" to="/admin/projects/new" class="btn btn-primary">创建新项目</RouterLink>
      </div>
    </header>

    <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>
    <div v-if="warning" class="alert alert-info" role="status">{{ warning }}</div>

    <section class="workspace-summary admin-workspace-summary" aria-label="项目总体状态">
      <article class="workspace-stat">
        <span>项目总数</span>
        <strong>{{ projects.length }}</strong>
        <small>{{ overallSummary.total }} 条方言材料</small>
      </article>
      <article class="workspace-stat workspace-stat--accent">
        <span>整体完成率</span>
        <strong>{{ overallSummary.completionPct }}<em>%</em></strong>
        <small>{{ overallSummary.approved }} 条完成一致校对或仲裁</small>
      </article>
      <article class="workspace-stat">
        <span>校对处理中</span>
        <strong>{{ overallSummary.active }}</strong>
        <small>条已由校对员领取</small>
      </article>
      <article class="workspace-stat" :class="{ 'workspace-stat--urgent': overallSummary.arbitration > 0 }">
        <span>等待管理员仲裁</span>
        <strong>{{ overallSummary.arbitration }}</strong>
        <small>{{ overallSummary.arbitration ? '需要逐字段确认' : '目前没有异常积压' }}</small>
      </article>
    </section>

    <section class="card admin-projects-card" aria-labelledby="admin-project-list-title">
      <div class="section-heading">
        <div>
          <h2 id="admin-project-list-title">项目进展</h2>
          <p>同优先级下，未完成条目更多的项目排在前面。</p>
        </div>
        <span v-if="!loading" class="section-count">{{ projectInsights.length }} 个项目</span>
      </div>

      <div v-if="loading && !error" class="admin-dashboard-loading" aria-live="polite">
        正在汇总项目状态…
      </div>
      <div v-else-if="!error && projects.length === 0" class="empty-state">
        <div class="empty-state-mark" aria-hidden="true">项</div>
        <div class="empty-state-text">还没有项目</div>
        <p>创建项目后，先上传原文 PDF，再用 CSV 导入待校对条目。</p>
        <RouterLink v-if="auth.canCreateProjects" to="/admin/projects/new" class="btn btn-primary mt-3">创建第一个项目</RouterLink>
        <RouterLink v-else to="/projects" class="btn btn-secondary mt-3">发现可加入项目</RouterLink>
      </div>
      <div v-else-if="!error" class="table-wrapper" role="region" tabindex="0" aria-label="项目进展表">
        <table class="admin-project-table">
          <thead>
            <tr>
              <th>项目</th>
              <th>校对管线</th>
              <th>完成进度</th>
              <th>需关注</th>
              <th>创建时间</th>
              <th>下一步</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in projectInsights"
              :key="item.project.id"
              :class="{ 'admin-project-row--urgent': item.summary.arbitration > 0 }"
            >
              <td>
                <RouterLink :to="`/admin/projects/${item.project.id}`" class="project-name-link">
                  {{ item.project.name }}
                </RouterLink>
                <p>{{ item.project.description || '暂无项目简介' }}</p>
              </td>
              <td>
                <dl class="project-pipeline">
                  <div><dt>待开始</dt><dd>{{ item.summary.unstarted }}</dd></div>
                  <div><dt>处理中</dt><dd>{{ item.summary.active }}</dd></div>
                  <div><dt>收集中</dt><dd>{{ item.summary.collecting }}</dd></div>
                  <div><dt>已完成</dt><dd>{{ item.summary.approved }}</dd></div>
                </dl>
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
                <RouterLink
                  :to="item.summary.arbitration
                    ? `/admin/projects/${item.project.id}?status=${PAGE_STATUS.ARBITRATION}`
                    : `/admin/projects/${item.project.id}`"
                  class="btn btn-sm"
                  :class="item.summary.arbitration ? 'btn-warn' : 'btn-secondary'"
                >
                  {{ item.summary.arbitration ? '处理仲裁' : '管理项目' }}
                </RouterLink>
                <RouterLink :to="`/admin/projects/${item.project.id}/settings`" class="btn btn-quiet btn-sm">项目设置</RouterLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { PAGE_STATUS } from '@/constants/pageStatus'
import { sortProjectInsights, summarizePages } from '@/lib/workspaceInsights'
import { listAllPages } from '@/services/pagesService'
import { listProjects } from '@/services/projectsService'
import { useAuthStore } from '@/stores/auth'
import { getPbMessage, getPbStatus } from '@/utils/pbErrors'

const projects = ref([])
const allPages = ref([])
const loading = ref(true)
const error = ref('')
const warning = ref('')
const auth = useAuthStore()

const overallSummary = computed(() => summarizePages(allPages.value))
const projectInsights = computed(() => {
  const pagesByProject = new Map()
  for (const page of allPages.value) {
    if (!pagesByProject.has(page.project)) pagesByProject.set(page.project, [])
    pagesByProject.get(page.project).push(page)
  }
  return sortProjectInsights(projects.value.map((project) => ({
    project,
    summary: summarizePages(pagesByProject.get(project.id) || [])
  })))
})

onMounted(loadDashboard)

async function loadDashboard() {
  loading.value = true
  error.value = ''
  warning.value = ''
  projects.value = []
  allPages.value = []

  try {
    await auth.loadAccessContext({ force: true })
    projects.value = await listProjects({ scope: 'managed' })
  } catch (e) {
    const status = getPbStatus(e)
    if (status === 401) {
      error.value = '登录状态已失效，请重新登录。'
    } else if (status === 403) {
      error.value = '无权限读取项目列表，请检查 projects 的 list/view 规则。'
    } else {
      error.value = getPbMessage(e, '加载项目列表失败，请稍后重试。')
    }
    loading.value = false
    return
  }

  try {
    allPages.value = await listAllPages({ fields: 'project,status' })
  } catch (e) {
    const status = getPbStatus(e)
    warning.value = status === 403
      ? '项目已加载，但暂无权限读取条目统计。请检查 pages 的 list/view 规则。'
      : getPbMessage(e, '项目已加载，但状态统计暂时不可用。')
  } finally {
    loading.value = false
  }
}

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString('zh-CN') : '—'
}
</script>
