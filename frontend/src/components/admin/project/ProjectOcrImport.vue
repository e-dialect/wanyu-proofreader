<template>
  <section ref="panelElement" aria-labelledby="project-ocr-title">
    <h4 id="project-ocr-title" class="font-semibold mb-2">提取 PDF 文字层</h4>
    <p class="text-sm text-muted mb-3">
      按单栏逐行生成“原文”字段，再对照 PDF
      修正。仅支持不含图像的单栏文字层页面，扫描页、含装饰图的页和多列表格请先整理为 CSV。
    </p>
    <div class="ocr-source-card">
      <div class="ocr-source-heading">
        <strong>当前原文</strong>
        <AppButton size="sm" variant="ghost" :disabled="pdfLoading || starting" @click="loadSource">
          刷新原文
        </AppButton>
      </div>
      <p v-if="pdfLoading" class="text-sm text-muted" role="status">正在读取主 PDF…</p>
      <p v-else-if="pdfError" class="text-sm" role="alert">{{ pdfError }}</p>
      <template v-else-if="primaryPdf">
        <p class="ocr-source-name">{{ primaryPdf.original_filename || primaryPdf.file }}</p>
        <p class="text-sm text-muted">共 {{ primaryPdf.page_count }} 个 PDF 物理页</p>
        <p v-if="pdfChanged" class="text-sm mt-2" role="status">
          主 PDF 已更换，请按当前文件重新核对页段。
        </p>
      </template>
      <p v-else class="text-sm">
        请先上传供提取的来源 PDF。
        <RouterLink :to="uploadTarget">前往上传来源 PDF</RouterLink>
      </p>
    </div>
    <div v-if="sourceReady" class="grid-2">
      <AppField label="提取起始页"
        ><input
          v-model="startPage"
          type="number"
          min="1"
          :max="primaryPdf.page_count"
          class="form-control"
          :disabled="running || startUnknown"
      /></AppField>
      <AppField label="提取结束页"
        ><input
          v-model="endPage"
          type="number"
          min="1"
          :max="primaryPdf.page_count"
          class="form-control"
          :disabled="running || startUnknown"
      /></AppField>
    </div>
    <p v-if="sourceReady" class="text-sm text-muted mb-2">
      使用 PDF 阅读器显示的物理页码，可能与书中印刷页码不同。每次最多 200 页。
      <span v-if="!rangeError">本次选择 {{ Number(endPage) - Number(startPage) + 1 }} 页。</span>
    </p>
    <p v-if="sourceReady && rangeError" class="text-sm mb-2" role="alert">{{ rangeError }}</p>
    <p v-if="sourceReady" class="text-sm text-muted mb-2">
      建议先提取少量页面核对排版。再次提取会创建新批次，不覆盖已有条目。
    </p>
    <AppButton
      variant="secondary"
      :disabled="running || loadingLatest || startUnknown || !sourceReady || Boolean(rangeError)"
      @click="startRecognition"
      :loading="starting"
      loading-label="正在提交"
    >
      {{ running ? '提取进行中…' : '提取文字层' }}
    </AppButton>
    <AppStatusPanel
      v-if="error"
      class="mt-2 preserve-line-breaks"
      state="error"
      :message="error"
      :retry-label="startUnknown ? '确认本次请求状态' : ''"
      :busy="starting"
      @retry="confirmStart"
    />
    <JobStatusPanel
      v-if="jobTarget"
      label="文字层提取"
      kind="ocr"
      :observation="observation"
      @retry="retryJob"
    />
    <div v-if="job" class="import-job-card mt-3">
      <strong>{{ statusLabel }}</strong>
      <p v-if="jobPdf" class="text-sm text-muted">
        本次作业原文：{{ jobPdf.original_filename || jobPdf.file }}
      </p>
      <p v-if="position" class="text-sm">
        本次作业页段：PDF 物理第 {{ position.startPage
        }}{{ position.endPage === position.startPage ? '' : `–${position.endPage}` }} 页。
        <span v-if="position.nextPage !== null"
          >尚未完成的首个物理页：第 {{ position.nextPage }} 页（以已保存进度为准）。</span
        >
      </p>
      <p class="text-sm">
        已处理 {{ job.processed_count || 0 }} / {{ job.total_count || 0 }} 页；成功
        {{ job.success_count || 0 }} 页，失败 {{ job.failed_count || 0 }} 页。
      </p>
      <p v-if="job.error_message" class="text-sm preserve-line-breaks">{{ job.error_message }}</p>
      <p v-if="result.rows !== undefined" class="text-sm">
        {{ published ? '生成' : '识别中间记录' }} {{ result.rows }} 行；确定
        {{ result.certain || 0 }} 格、待确认 {{ result.needs_review || 0 }} 格、弃权
        {{ result.abstained || 0 }} 格。状态描述识别输出，不代表来源核验通过。
      </p>
      <p v-if="job.status === 'failed'" class="text-sm">
        本批提取失败，暂存条目未发布为任务。提取会在遇到问题后停止，上方不是完整的问题页清单；可缩小页段重试，或将内容整理为
        CSV。
      </p>
      <RouterLink v-if="published && result.rows" :to="entriesTarget">查看条目并修正</RouterLink>
      <div v-if="result.artifacts?.length" class="mt-2">
        <p class="text-sm">原始文字、坐标和识别状态保存在受权限保护的中间产物中：</p>
        <AppButton
          v-for="artifact in result.artifacts"
          :key="artifact.id"
          variant="ghost"
          size="sm"
          :disabled="Boolean(downloading)"
          @click="downloadArtifact(artifact)"
        >
          下载第 {{ artifact.page }} 页原始 JSON
        </AppButton>
      </div>
    </div>
  </section>
</template>
<script setup>
import AppButton from '@/components/AppButton.vue'
import { RouterLink } from 'vue-router'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppField from '@/components/AppField.vue'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import JobStatusPanel from '@/components/admin/project/JobStatusPanel.vue'
import { useJobObserver } from '@/composables/useJobObserver'
import {
  getImportJob,
  latestOcrJob,
  startOcr,
  fetchOcrArtifact
} from '@/services/importJobsService'
import { downloadText } from '@/lib/downloadText'
import { parseOcrObject, validateOcrRange } from '@/lib/ocrJob'
import { ocrJobPosition } from '@/lib/ocrJobPosition'
import { currentUserId } from '@/services/authService'
import {
  readPendingOcrStart,
  savePendingOcrStart,
  clearPendingOcrStart
} from '@/lib/ocrStartRequest'
import { getPbMessage, getPbStatus } from '@/utils/pbErrors'
import { findLatestProjectPdf, getProjectFile } from '@/services/projectFilesService'
const props = defineProps({
  projectId: { type: String, required: true },
  active: { type: Boolean, default: true }
})
const emit = defineEmits(['changed'])
const userId = currentUserId()
const pendingStart = ref(null)
const startUnknown = ref(false)
const startPage = ref(1),
  endPage = ref(1)
const panelElement = ref(null)
const primaryPdf = ref(null),
  pdfLoading = ref(false),
  pdfError = ref(''),
  pdfChanged = ref(false)
const jobPdf = ref(null)
let sourceGeneration = 0,
  jobSourceGeneration = 0
const sourceReady = computed(
  () =>
    !pdfLoading.value &&
    !pdfError.value &&
    Number.isSafeInteger(primaryPdf.value?.page_count) &&
    primaryPdf.value.page_count > 0
)
const rangeError = computed(() =>
  validateOcrRange(startPage.value, endPage.value, primaryPdf.value?.page_count)
)
const uploadTarget = computed(() => ({
  path: `/admin/projects/${props.projectId}`,
  query: { section: 'materials', view: 'import', method: 'pdf' }
}))
const entriesTarget = computed(() => ({
  path: `/admin/projects/${props.projectId}`,
  query: { section: 'work', view: 'entries' }
}))
const jobTarget = ref(null)
const {
  snapshot: job,
  observation,
  retry: retryJob,
  seed: seedJob
} = useJobObserver({
  projectId: () => props.projectId,
  kind: 'ocr',
  job: jobTarget,
  panel: panelElement,
  read: getImportJob
})
const error = ref(''),
  loadingLatest = ref(true),
  starting = ref(false),
  downloading = ref('')
const running = computed(
  () => starting.value || ['queued', 'processing'].includes(job.value?.status)
)
const published = computed(() => ['completed', 'completed_with_errors'].includes(job.value?.status))
const position = computed(() => ocrJobPosition(job.value))
const result = computed(() => parseOcrObject(job.value?.ocr_result_json))
const statusLabel = computed(
  () =>
    ({
      queued: '等待提取',
      processing: '提取进行中',
      completed: '提取完成',
      completed_with_errors: '提取完成，部分页面失败',
      failed: '提取失败'
    })[job.value?.status] || '未开始'
)
let disposed = false
const controller = new AbortController()
async function loadSource() {
  const generation = ++sourceGeneration
  pdfLoading.value = true
  pdfError.value = ''
  try {
    const next = await findLatestProjectPdf(props.projectId)
    if (disposed || generation !== sourceGeneration) return
    const changed = Boolean(primaryPdf.value && primaryPdf.value.id !== next?.id)
    primaryPdf.value = next
    pdfChanged.value = changed
    if (changed && !running.value && !startUnknown.value) {
      startPage.value = 1
      endPage.value = 1
    }
    if (next && (!Number.isSafeInteger(next.page_count) || next.page_count < 1))
      pdfError.value = '当前 PDF 尚无可用页数，请检查来源 PDF 的上传状态。'
  } catch (failure) {
    if (!disposed && generation === sourceGeneration) {
      primaryPdf.value = null
      pdfError.value = getPbMessage(failure, '暂时无法读取主 PDF，请刷新原文。')
    }
  } finally {
    if (!disposed && generation === sourceGeneration) pdfLoading.value = false
  }
}
watch(
  () => props.active,
  (active) => {
    if (active) void loadSource()
  },
  { immediate: true }
)
watch(
  () => job.value?.project_file,
  async (fileId) => {
    const generation = ++jobSourceGeneration
    jobPdf.value = null
    if (!fileId) return
    try {
      const file = await getProjectFile(fileId, { signal: controller.signal })
      if (!disposed && generation === jobSourceGeneration) jobPdf.value = file
    } catch {
      /* The immutable page range remains available on the job. */
    }
  }
)
onBeforeUnmount(() => {
  disposed = true
  controller.abort()
})
onMounted(async () => {
  try {
    const pending = readPendingOcrStart(window.sessionStorage, userId, props.projectId)
    if (pending) {
      pendingStart.value = pending
      startUnknown.value = true
      startPage.value = pending.startPage
      endPage.value = pending.endPage
      await confirmStart()
      return
    }
    const latest = await latestOcrJob(props.projectId, { signal: controller.signal })
    if (disposed) return
    jobTarget.value = latest
    if (latest) seedJob(latest)
  } catch (failure) {
    if (!disposed) error.value = getPbMessage(failure, '读取上次识别作业失败，可重新发起。')
  } finally {
    if (!disposed) loadingLatest.value = false
  }
})
async function startRecognition() {
  if (running.value || startUnknown.value || !sourceReady.value) return
  error.value = validateOcrRange(startPage.value, endPage.value, primaryPdf.value.page_count)
  if (error.value) return
  const request = {
    projectId: props.projectId,
    projectFileId: primaryPdf.value.id,
    requestId: crypto.randomUUID(),
    startPage: Number(startPage.value),
    endPage: Number(endPage.value),
    language: 'chi_sim+eng',
    layout: 'single_column'
  }
  try {
    // Persist before POST: reload and an uncertain response reuse the same intent.
    savePendingOcrStart(window.sessionStorage, userId, request)
  } catch {
    error.value = '无法保存识别请求的恢复信息，请检查浏览器会话存储后重试。'
    return
  }
  pendingStart.value = request
  await confirmStart()
}
async function confirmStart() {
  if (starting.value || !pendingStart.value) return
  starting.value = true
  error.value = ''
  try {
    const created = await startOcr(pendingStart.value)
    if (disposed) return
    jobTarget.value = created
    seedJob(created)
    startUnknown.value = false
    pendingStart.value = null
    try {
      clearPendingOcrStart(window.sessionStorage, userId, props.projectId)
    } catch {
      /* Retained keys remain safe: the server returns the original job. */
    }
  } catch (failure) {
    if (disposed) return
    if ([400, 422].includes(getPbStatus(failure))) {
      startUnknown.value = false
      pendingStart.value = null
      try {
        clearPendingOcrStart(window.sessionStorage, userId, props.projectId)
      } catch {
        /* No request was accepted. */
      }
      error.value = getPbMessage(failure, '识别参数无效，请修正后重试。')
      void loadSource()
    } else {
      startUnknown.value = true
      error.value = `本次请求结果未知；请确认本次请求状态，将复用原请求避免重复入册。${getPbMessage(failure, '')}`
    }
  } finally {
    if (!disposed) starting.value = false
  }
}

watch(
  () => [job.value?.id, job.value?.status],
  ([id, status], previous) => {
    if (
      id &&
      ['completed', 'completed_with_errors', 'failed'].includes(status) &&
      (id !== previous?.[0] || status !== previous?.[1])
    )
      emit('changed')
  }
)
async function downloadArtifact(artifact) {
  downloading.value = artifact.id
  error.value = ''
  try {
    const text = await fetchOcrArtifact(artifact.id, { signal: controller.signal })
    if (!disposed)
      downloadText(
        text,
        artifact.file_name || `ocr-page-${artifact.page}.json`,
        'application/json;charset=utf-8'
      )
  } catch (failure) {
    if (!disposed) error.value = getPbMessage(failure, '原始产物下载失败，请重试。')
  } finally {
    if (!disposed) downloading.value = ''
  }
}
</script>
<style scoped>
.ocr-source-card {
  margin-block: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}
.ocr-source-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.ocr-source-name {
  margin-top: var(--space-1);
  overflow-wrap: anywhere;
}
</style>
