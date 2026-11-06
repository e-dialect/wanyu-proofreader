<template>
  <main class="container page workspace-page">
    <header class="page-heading project-detail-heading">
      <div>
        <RouterLink to="/admin" class="back-link">← 返回项目总览</RouterLink>
        <div class="page-eyebrow">项目工作区</div>
        <h1>{{ project?.name || '项目详情' }}</h1>
        <p v-if="project?.description">{{ project.description }}</p>
        <RouterLink
          v-if="project?.capabilities?.canManage"
          :to="`/admin/projects/${projectId}/settings#project-details`"
          class="btn btn-secondary btn-sm mt-3"
          >编辑项目资料</RouterLink
        >
      </div>
      <nav v-if="project" class="project-section-nav" aria-label="项目页面分区">
        <a href="#project-entries">条目管理</a>
        <a href="#project-files">文件准备</a>
        <a href="#project-ledger">批次台账</a>
        <a href="#project-export">导出结果</a>
        <a v-if="project?.capabilities?.canManage" href="#project-assist">机器疑点</a>
        <a v-if="project?.capabilities?.canManage" href="#project-scheme">拼音归一</a>
        <RouterLink :to="`/admin/projects/${projectId}/verification`"
          >来源核验与问题处理</RouterLink
        >
        <RouterLink :to="`/admin/projects/${projectId}/adoption`">用途编选（D 工序）</RouterLink>
        <RouterLink :to="`/admin/projects/${projectId}/settings`"
          >项目设置（资料与成员）</RouterLink
        >
      </nav>
    </header>

    <div v-if="loadingProject" class="project-detail-skeleton" aria-label="正在加载项目">
      <div class="skeleton-card project-detail-skeleton__heading" aria-hidden="true">
        <span class="skeleton-line skeleton-line--short"></span>
        <span class="skeleton-line"></span>
      </div>
      <div class="skeleton-card project-detail-skeleton__summary" aria-hidden="true">
        <span class="skeleton-line"></span>
        <span class="skeleton-line"></span>
      </div>
    </div>
    <div v-else-if="projectError" class="alert alert-error" role="alert">{{ projectError }}</div>
    <template v-else>
      <ProjectEntriesPanel
        ref="entries"
        :project-id="projectId"
        :project="project"
        :refresh-ledger="loadLedger"
      />
      <section id="project-files" class="card project-section mb-6">
        <div class="card-title">上传文件</div>
        <div class="grid-2">
          <ProjectPdfUpload ref="pdfUpload" :project-id="projectId" />
          <ProjectCsvImport
            :project-id="projectId"
            :refresh-pages="loadPages"
            :refresh-stats="loadPageStats"
            :refresh-quality="loadQualitySummary"
            :refresh-ledger="loadLedger"
            :clear-selection="clearSelection"
          />
          <ProjectOcrImport :project-id="projectId" @changed="refreshAfterImport" />
        </div>
      </section>
      <ProjectImportLedger ref="ledgerPanel" :project-id="projectId" />
      <ProjectExportPanel :project-id="projectId" :project="project" />
      <ProjectAssistPanel
        v-if="project?.capabilities?.canManage"
        :project-id="projectId"
        :displayed-pages="entries?.displayedPages"
        :displayed-page-offset="entries?.displayedPageOffset"
        :refresh-pages="loadPages"
        @jump-entry="entries?.jumpToPdfPage($event)"
      />
      <ProjectSchemePanel
        v-if="project?.capabilities?.canManage"
        ref="schemePanel"
        :project-id="projectId"
      />
    </template>
  </main>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { getProject } from '@/services/projectsService'
import { getPbMessage, getPbStatus } from '@/utils/pbErrors'
import ProjectEntriesPanel from '@/components/admin/project/ProjectEntriesPanel.vue'
import ProjectPdfUpload from '@/components/admin/project/ProjectPdfUpload.vue'
import ProjectCsvImport from '@/components/admin/project/ProjectCsvImport.vue'
import ProjectOcrImport from '@/components/admin/project/ProjectOcrImport.vue'
import ProjectImportLedger from '@/components/admin/project/ProjectImportLedger.vue'
import ProjectExportPanel from '@/components/admin/project/ProjectExportPanel.vue'
import ProjectAssistPanel from '@/components/admin/project/ProjectAssistPanel.vue'
import ProjectSchemePanel from '@/components/admin/project/ProjectSchemePanel.vue'
const route = useRoute()
const projectId = Array.isArray(route.params.id) ? route.params.id[0] : route.params.id
const project = ref(null)
const projectError = ref('')
const loadingProject = ref(true)
const entries = ref(null)
const pdfUpload = ref(null)
const ledgerPanel = ref(null)
const schemePanel = ref(null)
let pdfResumeIdleId
let pdfResumeTimer
const loadPages = () => entries.value?.loadPages()
const loadPageStats = () => entries.value?.loadPageStats()
const loadQualitySummary = () => entries.value?.loadQualitySummary()
const loadLedger = () => ledgerPanel.value?.loadLedger()
const scrollToEntries = () => entries.value?.scrollToEntries()
const setupSchemeObserver = () => schemePanel.value?.setupSchemeObserver()
const clearSelection = () => entries.value?.clearSelection()
const refreshAfterImport = () =>
  Promise.all([loadPages(), loadPageStats(), loadQualitySummary(), loadLedger()])
function scheduleSecondaryLoads() {
  const load = () => Promise.all([pdfUpload.value?.loadPdfResume(), loadLedger()])
  if (typeof window.requestIdleCallback === 'function')
    pdfResumeIdleId = window.requestIdleCallback(load, { timeout: 1500 })
  else pdfResumeTimer = setTimeout(load, 0)
}
onMounted(async () => {
  try {
    project.value = await getProject(projectId)
    if (!project.value.capabilities?.canManage) {
      projectError.value = '无权限管理该项目。'
      loadingProject.value = false
      return
    }
  } catch (e) {
    const status = getPbStatus(e)
    if (status === 401) {
      projectError.value = '登录状态已失效，请重新登录。'
    } else if (status === 403) {
      projectError.value = '无权限查看该项目。'
    } else if (status === 404) {
      projectError.value = '项目不存在。'
    } else {
      projectError.value = getPbMessage(e, '加载项目失败，请稍后重试。')
    }
    loadingProject.value = false
    return
  }
  loadingProject.value = false
  entries.value?.applyListQuery(route.query)
  await nextTick()
  setupSchemeObserver()
  await Promise.all([loadPages(), loadPageStats(), loadQualitySummary()])
  scheduleSecondaryLoads()
  if (entries.value?.hasActiveListFilter) {
    await nextTick()
    scrollToEntries()
  }
})
onBeforeUnmount(() => {
  if (pdfResumeIdleId) window.cancelIdleCallback?.(pdfResumeIdleId)
  clearTimeout(pdfResumeTimer)
})
</script>
