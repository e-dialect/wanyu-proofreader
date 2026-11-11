<template>
  <main class="container page workspace-page project-workspace-page">
    <ProjectWorkspaceHeading :project="project" />
    <ProjectWorkspaceNav v-if="project" :project-id="projectId" :active="location.section" />
    <AppStatusPanel v-if="loadingProject" state="pending" message="正在打开项目…" />
    <AppStatusPanel
      v-else-if="projectError"
      state="error"
      :message="projectError"
      retry-label="重新加载"
      @retry="loadProject"
    />
    <template v-else-if="project">
      <ProjectOverview
        v-if="location.section === 'overview'"
        ref="overviewPanel"
        :project-id="projectId"
        :query="route.query"
      />
      <nav v-if="subviews.length" class="project-subnav" :aria-label="`${sectionLabel}功能`">
        <RouterLink
          v-for="item in subviews"
          :key="item.key"
          :to="item.to || link(location.section, item.key)"
          :class="{ 'is-active': location.view === item.key }"
          :aria-current="location.view === item.key ? 'page' : undefined"
          >{{ item.label }}</RouterLink
        >
      </nav>
      <div
        v-if="visited.has('entries')"
        v-show="location.section === 'work' && location.view === 'entries'"
      >
        <ProjectEntriesPanel
          ref="entries"
          :project-id="projectId"
          :project="project"
          :refresh-ledger="loadLedger"
        />
      </div>
      <ProjectWorkQueue
        v-if="location.section === 'work' && location.view === 'queue'"
        :project-id="projectId"
        :query="route.query"
      />
      <ProjectImportChoice
        v-if="location.section === 'materials' && location.view === 'import'"
        :project-id="projectId"
        :method="importMethod"
        @select="selectImport"
      />
      <section
        v-if="visited.has('pdf')"
        v-show="showImport('pdf')"
        id="project-files"
        class="card project-section mt-4"
      >
        <ProjectPanels.ProjectPdfUpload ref="pdfUpload" :project-id="projectId" />
      </section>
      <section
        v-if="visited.has('csv')"
        v-show="showImport('csv')"
        class="card project-section mt-4"
      >
        <ProjectPanels.ProjectCsvImport
          ref="csvImport"
          :project-id="projectId"
          :job-link="csvJobLink"
          @job-change="setCsvJobLink"
          :refresh-pages="loadPages"
          :refresh-stats="loadPageStats"
          :refresh-quality="loadQualitySummary"
          :refresh-ledger="loadLedger"
          :clear-selection="clearSelection"
        />
      </section>
      <section
        v-if="visited.has('ocr')"
        v-show="showImport('ocr')"
        class="card project-section mt-4"
      >
        <ProjectPanels.ProjectOcrImport
          :project-id="projectId"
          :active="showImport('ocr')"
          @changed="refreshAfterImport"
        />
      </section>
      <section
        v-if="visited.has('bundle')"
        v-show="showImport('bundle')"
        class="card project-section mt-4"
      >
        <ProjectPanels.ProjectBundleImport
          ref="bundleImport"
          :project-id="projectId"
          @changed="refreshAfterImport"
        />
      </section>
      <ProjectPanels.ProjectImportLedger
        v-if="visited.has('batches')"
        v-show="location.section === 'materials' && location.view === 'batches'"
        ref="ledgerPanel"
        :project-id="projectId"
      />
      <ProjectPanels.ProjectExportPanel
        v-if="visited.has('exports')"
        v-show="location.section === 'delivery' && location.view === 'exports'"
        :project-id="projectId"
        :project="project"
      />
      <ProjectPanels.ProjectProcessExport
        v-if="visited.has('process')"
        v-show="location.section === 'delivery' && location.view === 'process'"
        :project-id="projectId"
      />
      <ProjectPanels.ProjectAssistPanel
        v-if="visited.has('checks')"
        v-show="location.section === 'work' && location.view === 'checks'"
        :project-id="projectId"
        :displayed-pages="entries?.displayedPages"
        :displayed-page-offset="entries?.displayedPageOffset"
        :refresh-pages="loadPages"
        @jump-entry="jumpToEntry"
      />
      <ProjectPanels.ProjectToneBatch
        v-if="visited.has('tone')"
        v-show="location.section === 'work' && location.view === 'tone'"
        :project-id="projectId"
        :active="location.section === 'work' && location.view === 'tone'"
      />
      <ProjectPanels.ProjectSchemePanel
        v-if="visited.has('normalization')"
        v-show="location.section === 'work' && location.view === 'normalization'"
        ref="schemePanel"
        :project-id="projectId"
        :initial-view="route.query.schemeView === 'review' ? 'review' : 'jobs'"
      />
    </template>
    <WorkspaceLeaveGuard
      :dirty="
        !!pdfUpload?.uploadingPdf || !!csvImport?.hasPendingWork || !!bundleImport?.hasPendingWork
      "
      message="材料仍在上传、检查或等待确认。离开会暂停 PDF 上传并保留已有分片，返回后重新选择同一文件可继续；已发送的导入作业可能继续，请返回核对批次。"
    />
  </main>
</template>
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { getProject } from '@/services/projectsService'
import { useQueueReturnPosition } from '@/composables/useQueueReturnPosition'
import {
  projectWorkspaceLocation,
  projectWorkspaceSubviews,
  projectWorkspaceTarget
} from '@/lib/projectWorkspace'
import { getPbMessage, getPbStatus } from '@/utils/pbErrors'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import ProjectWorkspaceHeading from '@/components/admin/project/ProjectWorkspaceHeading.vue'
import ProjectWorkspaceNav from '@/components/admin/project/ProjectWorkspaceNav.vue'
import ProjectImportChoice from '@/components/admin/project/ProjectImportChoice.vue'
import WorkspaceLeaveGuard from '@/components/admin/project/WorkspaceLeaveGuard.vue'
import ProjectOverview from '@/components/admin/project/ProjectOverview.vue'
import ProjectWorkQueue from '@/components/admin/project/ProjectWorkQueue.vue'
import ProjectEntriesPanel from '@/components/admin/project/ProjectEntriesPanel.vue'
import * as ProjectPanels from '@/components/admin/project/projectPanels'
const route = useRoute()
const router = useRouter()
const projectId = String(Array.isArray(route.params.id) ? route.params.id[0] : route.params.id)
const project = ref(null)
const projectError = ref('')
const loadingProject = ref(true)
const entries = ref(null)
const pdfUpload = ref(null)
const csvImport = ref(null)
const bundleImport = ref(null)
const ledgerPanel = ref(null)
const schemePanel = ref(null)
const visited = reactive(new Set())
const initialized = new Set()
const location = computed(() => projectWorkspaceLocation(route.query, route.hash))
const sectionLabel = computed(
  () => ({ materials: '材料', work: '校勘', delivery: '交付' })[location.value.section]
)
const subviews = computed(() => projectWorkspaceSubviews(projectId, location.value.section))
const importMethod = ref(
  ['pdf', 'csv', 'ocr', 'bundle'].includes(route.query.method) ? route.query.method : 'pdf'
)
const csvJobLink = computed(() =>
  route.query.csvJob === undefined
    ? ''
    : typeof route.query.csvJob === 'string' && route.query.csvJob
      ? route.query.csvJob
      : 'invalid'
)
function setCsvJobLink(id) {
  const query = { ...route.query }
  if (id) query.csvJob = id
  else delete query.csvJob
  void router.replace({ path: route.path, query, hash: route.hash })
}
const overviewPanel = ref(null)
let disposed = false
let projectLoadGeneration = 0
const link = (section, view) => projectWorkspaceTarget(projectId, section, view, route.query)
const showImport = (method) =>
  location.value.section === 'materials' &&
  location.value.view === 'import' &&
  importMethod.value === method
const loadPages = () => entries.value?.loadPages()
const loadPageStats = () => entries.value?.loadPageStats()
const loadQualitySummary = () => entries.value?.loadQualitySummary()
const loadLedger = () => ledgerPanel.value?.loadLedger()
const clearSelection = () => entries.value?.clearSelection()
const refreshAfterImport = () =>
  Promise.all([loadPages(), loadPageStats(), loadQualitySummary(), loadLedger(), loadOverview()])
const loadOverview = () => overviewPanel.value?.reload()
async function selectImport(method) {
  importMethod.value = method
  await activate()
  await router.replace({
    ...link('materials', 'import'),
    query: { ...link('materials', 'import').query, method }
  })
}
async function jumpToEntry(page) {
  await router.push(link('work', 'entries'))
  await nextTick()
  await entries.value?.jumpToPdfPage(page)
}
async function activate() {
  if (!project.value) return
  const view = location.value.view === 'import' ? importMethod.value : location.value.view
  visited.add(view)
  if (view === 'checks') visited.add('entries')
  await nextTick()
  if (disposed) return
  if (['entries', 'checks'].includes(view) && !initialized.has('entries')) {
    initialized.add('entries')
    entries.value?.applyListQuery(route.query)
    await Promise.all([loadPages(), loadPageStats(), loadQualitySummary()])
    if (
      !route.query.section &&
      !route.hash &&
      !entries.value?.hasActiveListFilter &&
      entries.value?.hasLoadedPageStats &&
      entries.value?.pageStats?.total === 0
    ) {
      await router.replace(link('materials', 'import'))
    }
  }
  if (!initialized.has(view)) {
    initialized.add(view)
  }
  if (route.hash) {
    const target = document.getElementById(route.hash.slice(1))
    target?.scrollIntoView({ block: 'start' })
  }
}
async function loadProject() {
  const generation = ++projectLoadGeneration
  loadingProject.value = true
  projectError.value = ''
  try {
    const data = await getProject(projectId)
    if (disposed || generation !== projectLoadGeneration) return
    if (!data.capabilities?.canManage)
      throw Object.assign(new Error('无权限管理该项目。'), { status: 403 })
    project.value = data
  } catch (error) {
    if (disposed || generation !== projectLoadGeneration) return
    const status = getPbStatus(error)
    projectError.value =
      status === 401
        ? '登录状态已失效，请重新登录。'
        : status === 403
          ? '无权限查看该项目。'
          : status === 404
            ? '项目不存在。'
            : getPbMessage(error, '加载项目失败，请稍后重试。')
  } finally {
    if (!disposed && generation === projectLoadGeneration) loadingProject.value = false
  }
  if (project.value) await activate()
}
watch([() => location.value.section, () => location.value.view], activate)
watch(
  () => route.query.method,
  (value) => {
    if (['pdf', 'csv', 'ocr', 'bundle'].includes(value)) {
      importMethod.value = value
      activate()
    }
  }
)
watch(
  () => route.query.schemeView,
  (value) => schemePanel.value?.setView(value === 'review' ? 'review' : 'jobs')
)
useQueueReturnPosition(
  () =>
    !loadingProject.value &&
    Boolean(project.value) &&
    (location.value.section === 'work' && location.value.view === 'entries'
      ? Boolean(entries.value?.hasLoadedPages)
      : true)
)
onMounted(loadProject)
onBeforeUnmount(() => {
  disposed = true
  projectLoadGeneration++
})
</script>
