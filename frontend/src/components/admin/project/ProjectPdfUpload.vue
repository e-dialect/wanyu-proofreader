<template>
  <!-- PDF upload -->
  <div ref="panelElement">
    <h4 class="font-semibold mb-2">来源 PDF</h4>
    <div v-if="primaryLoading && !primaryPdf" class="text-sm text-muted mb-3" role="status">
      正在读取主 PDF…
    </div>
    <div v-if="primaryError" class="alert mb-3" role="status">
      {{ primaryError }}
      <AppButton v-if="!accessLost" variant="secondary" @click="loadPdfPanel">重新读取</AppButton>
    </div>
    <section v-if="primaryPdf" class="pdf-current mb-3" aria-label="当前主 PDF">
      <div class="pdf-current-info">
        <span class="text-sm text-muted">当前主 PDF</span>
        <strong>{{ primaryPdf.original_filename || primaryPdf.file }}</strong>
        <p class="text-sm text-muted">
          {{ primaryPdf.page_count ? `${primaryPdf.page_count} 个物理页` : '物理页数未记录' }}
          · {{ primaryValidationDate ? `校验完成于 ${primaryValidationDate}` : '校验时间未记录' }}
        </p>
      </div>
      <div class="pdf-actions">
        <span ref="previewTrigger">
          <AppButton variant="secondary" :disabled="previewOpen" @click="openPdfPreview"
            >预览原文</AppButton
          >
        </span>
        <AppButton variant="ghost" @click="emit('continue', 'csv')">继续导入 CSV</AppButton>
        <AppButton variant="ghost" @click="emit('continue', 'ocr')">去 PDF 文字提取</AppButton>
      </div>
    </section>
    <section
      v-if="previewOpen"
      class="pdf-preview mb-3"
      aria-labelledby="project-pdf-preview-heading"
    >
      <div class="pdf-actions pdf-preview-heading">
        <div>
          <h5 id="project-pdf-preview-heading" ref="previewHeading" tabindex="-1">原文预览</h5>
          <p v-if="previewPageCount && !primaryPdf?.page_count" class="text-sm text-muted">
            本次预览读到 {{ previewPageCount }} 个物理页
          </p>
        </div>
        <AppButton variant="secondary" @click="closePdfPreview(true)">关闭预览</AppButton>
      </div>
      <p v-if="previewLoading" class="text-sm text-muted" role="status">正在读取原文…</p>
      <div v-else-if="previewError" class="alert" role="alert">
        {{ previewError }}
        <AppButton variant="secondary" @click="loadPdfPreview">重试预览</AppButton>
      </div>
      <div v-else-if="previewUrl" class="pdf-preview-viewer">
        <PdfSinglePageViewer
          :src="previewUrl"
          :page-number="previewPage"
          @document-loaded="previewPageCount = $event"
          :watermark-user-id="currentUserId()"
          :watermark-project-id="projectId"
        >
          <template #navigation>
            <div v-if="previewPageCount > 1" class="pdf-actions" aria-label="物理页导航">
              <AppButton variant="secondary" :disabled="previewPage <= 1" @click="previewPage--"
                >上一页</AppButton
              >
              <AppButton
                variant="secondary"
                :disabled="previewPage >= previewPageCount"
                @click="previewPage++"
                >下一页</AppButton
              >
            </div>
          </template>
        </PdfSinglePageViewer>
      </div>
    </section>
    <p class="text-sm text-muted mb-3">
      {{
        primaryPdf
          ? '新文件通过校验后才会设为主 PDF。已绑定原文的条目会继续使用原文件。'
          : '上传 PDF 供校对时查看原文。导入 CSV 或提取 PDF 文字可生成条目。'
      }}
    </p>
    <div v-if="pdfResume && !uploadingPdf" class="alert mt-2" role="status">
      <p>
        有未完成的 PDF 上传：{{ pdfResume.name }}
        <span v-if="pdfResumeExpired">，已过期，请重新选择文件上传。</span>
        <span v-else>。请重新选择同一文件继续；不能只靠文件名和大小匹配。</span>
      </p>
      <div class="mt-3 flex gap-2">
        <AppButton
          type="button"
          variant="primary"
          @click="pdfInput.click()"
          :disabled="pdfBusy || accessLost"
        >
          重新选择同一 PDF
        </AppButton>
        <AppButton type="button" variant="ghost" @click="abandonPdfResume">
          放弃未完成上传
        </AppButton>
      </div>
    </div>
    <input
      type="file"
      accept=".pdf"
      @change="onPdfSelected"
      :disabled="pdfBusy || accessLost"
      ref="pdfInput"
      class="file-input-hidden"
    />
    <AppButton
      v-if="!pdfResume || uploadingPdf"
      variant="secondary"
      @click="pdfInput.click()"
      :disabled="pdfBusy || accessLost"
    >
      {{ primaryPdf ? '更换主 PDF' : '选择 PDF 文件' }}
    </AppButton>
    <span v-if="pdfFile" class="text-sm ml-2">{{ pdfFile.name }}</span>
    <div v-if="pdfError && pdfRetryable && pdfFile && !uploadingPdf" class="mt-3">
      <AppButton variant="primary" :disabled="pdfBusy || accessLost" @click="uploadPdf"
        >重试上传 PDF</AppButton
      >
    </div>
    <div v-if="uploadingPdf && !pdfProcessing" class="mt-2" role="status">
      <progress :value="pdfUploadProgress" max="100" aria-label="PDF 上传进度"></progress>
      <span
        >已上传 {{ pdfUploadProgress }}%{{ pdfUploadProgress === 100 ? '，正在保存…' : '' }}</span
      >
      <AppButton variant="ghost" size="sm" @click="pdfUploadController?.abort()"
        >取消上传</AppButton
      >
    </div>
    <div v-if="pdfProcessing" class="alert mt-2" role="status">PDF 已上传，正在校验文件…</div>
    <JobStatusPanel
      v-if="pdfJobTarget && pdfObservation.state !== 'live'"
      label="PDF 校验"
      kind="pdf"
      :observation="pdfObservation"
      @retry="retryPdfJob"
    />
    <div v-if="pdfSuccess" class="alert alert-success mt-2" role="status">
      PDF 深度校验完成，共 {{ pdfMetadata?.page_count }} 页，已设为项目主 PDF。
    </div>
    <div v-if="pdfError" class="alert alert-error mt-2" role="alert">
      {{ pdfError }}
      <span v-if="pdfJob?.status === 'failed' && primaryPdf">当前主 PDF 仍可使用。</span>
    </div>
  </div>
</template>

<script setup>
import AppButton from '@/components/AppButton.vue'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import PdfSinglePageViewer from '@/components/editor/PdfSinglePageViewer.vue'
import { useProtectedPageScope } from '@/composables/useProtectedPageScope'
import JobStatusPanel from '@/components/admin/project/JobStatusPanel.vue'
import { useJobObserver } from '@/composables/useJobObserver'
import {
  createProjectPdf,
  fetchProjectPdfPreview,
  findLatestProjectPdf,
  findLatestPdfValidation,
  getProjectFile,
  listProjectPdfUploads,
  cancelProjectPdfUpload
} from '@/services/projectFilesService'
import {
  validatePdfFile,
  loadPdfUploadResume,
  clearPdfUploadResume,
  PDF_UPLOAD_PAUSED
} from '@/lib/chunkedPdfUpload'
import { currentUserId } from '@/services/authService'
import { getPbStatus, getUploadErrorMessage, isRetryablePdfUploadError } from '@/utils/pbErrors'
const props = defineProps({ projectId: { type: String, required: true }, active: Boolean })
const emit = defineEmits(['continue'])
const projectId = props.projectId
const pdfInput = ref(null)
const panelElement = ref(null)
const pdfJobTarget = ref(null)
const {
  snapshot: pdfJob,
  observation: pdfObservation,
  retry: retryPdfJob,
  seed: seedPdfJob
} = useJobObserver({
  projectId: () => props.projectId,
  kind: 'pdf',
  job: pdfJobTarget,
  panel: panelElement,
  read: async (id, options) => normalizePdfValidation(await getProjectFile(id, options))
})

const pdfFile = ref(null)

const pdfUploadProgress = ref(0)

let pdfUploadController = null

const pdfResume = ref(null)

const uploadingPdf = ref(false)

const pdfSuccess = ref(false)

const pdfMetadata = ref(null)

const pdfProcessing = ref(false)

const pdfError = ref('')

const pdfRetryable = ref(false)

let pdfPollGeneration = 0

const primaryPdf = ref(null)
const primaryLoading = ref(false)
const primaryError = ref('')
const previewOpen = ref(false)
const previewLoading = ref(false)
const previewError = ref('')
const previewUrl = ref('')
const previewPage = ref(1)
const previewTrigger = ref(null)
const previewHeading = ref(null)
const previewPageCount = ref(0)
const primaryValidationDate = computed(() => {
  const timestamp = primaryPdf.value?.validated_at
  const date = timestamp ? new Date(timestamp) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN') : ''
})
const pdfBusy = computed(() => uploadingPdf.value || pdfProcessing.value)
let panelRequest
let previewRequest
let resumeRequest
const scope = useProtectedPageScope(() => {
  closePdfPreview()
  primaryPdf.value = pdfResume.value = pdfFile.value = pdfJobTarget.value = null
  primaryLoading.value = uploadingPdf.value = pdfProcessing.value = pdfSuccess.value = false
  pdfError.value = ''
  primaryError.value = '无法读取来源 PDF，请核对登录状态和项目权限。'
  pdfPollGeneration += 1
  pdfUploadController?.abort(PDF_UPLOAD_PAUSED)
})
const { accessLost } = scope

function normalizePdfValidation(record) {
  return record?.status === 'error' ? { ...record, status: 'failed' } : record
}

async function loadPdfPanel() {
  if (accessLost.value) return
  panelRequest?.cancel()
  const request = (panelRequest = scope.capture())
  primaryLoading.value = true
  primaryError.value = ''
  try {
    const [ready, pending] = await Promise.allSettled([
      findLatestProjectPdf(projectId, { signal: request.signal }),
      findLatestPdfValidation(projectId, { signal: request.signal })
    ])
    if (!request.isCurrent()) return
    for (const result of [ready, pending]) {
      if (result.status === 'rejected' && scope.invalidate(result.reason, request)) return
    }
    if (ready.status === 'fulfilled') {
      if (primaryPdf.value?.id !== ready.value?.id) closePdfPreview()
      primaryPdf.value = ready.value
    }
    const validation = pending.status === 'fulfilled' ? normalizePdfValidation(pending.value) : null
    if (!uploadingPdf.value && ['processing', 'failed'].includes(validation?.status)) {
      pdfProcessing.value = validation.status === 'processing'
      pdfJobTarget.value = validation
      seedPdfJob(validation)
    } else if (
      !uploadingPdf.value &&
      validation?.status === 'ready' &&
      pdfJob.value?.status === 'failed'
    ) {
      pdfJobTarget.value = null
      pdfError.value = ''
    }
    if (ready.status === 'rejected' || pending.status === 'rejected') {
      primaryError.value = '暂时无法更新主 PDF 或校验进度。'
    }
  } finally {
    if (request.isCurrent()) primaryLoading.value = false
    request.finish()
  }
}

async function loadPdfPreview() {
  if (!primaryPdf.value || !previewOpen.value || accessLost.value) return
  previewRequest?.cancel()
  const request = (previewRequest = scope.capture())
  previewLoading.value = true
  previewError.value = ''
  try {
    const blob = await fetchProjectPdfPreview(primaryPdf.value, { signal: request.signal })
    if (request.isCurrent()) previewUrl.value = URL.createObjectURL(blob)
  } catch (error) {
    if (request.isCurrent() && !scope.invalidate(error, request)) {
      previewError.value = '暂时无法读取原文，请重试。'
    }
  } finally {
    if (request.isCurrent()) previewLoading.value = false
    request.finish()
  }
}

async function openPdfPreview() {
  previewOpen.value = true
  previewPage.value = 1
  void loadPdfPreview()
  await nextTick()
  previewHeading.value?.focus()
}

function closePdfPreview(restoreFocus = false) {
  previewRequest?.cancel()
  previewOpen.value = previewLoading.value = false
  previewError.value = ''
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
  previewPageCount.value = 0
  if (restoreFocus) void nextTick(() => previewTrigger.value?.querySelector('button')?.focus())
}

const pdfResumeExpired = computed(() => Boolean(pdfResume.value?.expired))

watch(
  () => [pdfJob.value?.id, pdfJob.value?.status, pdfObservation.value.state],
  ([id, status, state]) => {
    if (['unauthorized', 'unavailable'].includes(state)) {
      pdfProcessing.value = uploadingPdf.value = pdfSuccess.value = false
      pdfMetadata.value = null
      return
    }
    if (!id) return
    pdfProcessing.value = status === 'processing'
    if (!['ready', 'failed'].includes(status)) return
    uploadingPdf.value = false
    pdfFile.value = pdfResume.value = null
    if (pdfInput.value) pdfInput.value.value = ''
    if (status === 'ready') {
      pdfSuccess.value = true
      pdfMetadata.value = pdfJob.value
      pdfError.value = ''
      if (props.active) void loadPdfPanel()
    } else {
      pdfSuccess.value = false
      pdfError.value = `${pdfJob.value.error_message || 'PDF 校验失败'}，请重新选择 PDF 文件。`
      pdfRetryable.value = false
    }
  }
)

async function onPdfSelected(e) {
  if (pdfBusy.value || accessLost.value) return
  const selectedFile = e.target.files[0]
  if (!selectedFile) return
  pdfFile.value = selectedFile
  pdfSuccess.value = false
  pdfMetadata.value = null
  pdfProcessing.value = false
  pdfJobTarget.value = null
  pdfError.value = ''
  pdfRetryable.value = false
  pdfUploadProgress.value = 0
  try {
    validatePdfFile(pdfFile.value)
    await uploadPdf()
  } catch (error) {
    pdfFile.value = null
    pdfError.value = error.message
    pdfRetryable.value = false
  } finally {
    e.target.value = ''
  }
}

function decoratePdfResume(item) {
  if (!item) return null
  const expiresAt = item.expiresAt
  let expired = false
  if (expiresAt) {
    const date = new Date(expiresAt)
    expired = Number.isNaN(date.getTime()) || date.getTime() <= Date.now()
  }
  return { ...item, expired }
}

async function loadPdfResume() {
  if (accessLost.value) return
  resumeRequest?.cancel()
  const request = (resumeRequest = scope.capture())
  const userId = currentUserId()
  const stored = loadPdfUploadResume(
    typeof localStorage === 'undefined' ? null : localStorage,
    userId,
    projectId
  )
  try {
    const listed = await listProjectPdfUploads(projectId, { signal: request.signal })
    if (!request.isCurrent()) return
    const item = listed?.items?.[0]
    if (item) {
      pdfResume.value = decoratePdfResume(item)
      return
    }
    // A successful empty list means the upload finished, expired, or was canceled.
    // Do not revive a local key that would hide "选择 PDF 文件" over an already-ready file.
    clearPdfUploadResume(
      typeof localStorage === 'undefined' ? null : localStorage,
      userId,
      projectId
    )
    pdfResume.value = null
    return
  } catch (error) {
    if (request.isCurrent() && !scope.invalidate(error, request)) {
      pdfResume.value = decoratePdfResume(stored)
    }
  } finally {
    request.finish()
  }
}

async function abandonPdfResume() {
  const userId = currentUserId()
  const sessionId = pdfResume.value?.id || pdfResume.value?.sessionId
  try {
    if (sessionId) await cancelProjectPdfUpload(projectId, sessionId)
  } catch {
    /* Clearing the local prompt still lets the user start a new file. */
  }
  clearPdfUploadResume(typeof localStorage === 'undefined' ? null : localStorage, userId, projectId)
  pdfResume.value = null
  pdfError.value = ''
  pdfRetryable.value = false
}

async function uploadPdf() {
  if (!pdfFile.value || pdfBusy.value || accessLost.value) return
  uploadingPdf.value = true
  pdfUploadProgress.value = 0
  pdfError.value = ''
  pdfRetryable.value = false
  pdfSuccess.value = false
  pdfMetadata.value = null
  pdfProcessing.value = false
  const generation = ++pdfPollGeneration
  try {
    pdfUploadController = new AbortController()
    const signal = pdfUploadController.signal
    const record = await createProjectPdf({
      projectId,
      file: pdfFile.value,
      signal,
      userId: currentUserId(),
      onProgress: (value) => {
        if (generation === pdfPollGeneration) pdfUploadProgress.value = value
      }
    })
    if (generation !== pdfPollGeneration) return
    const validation = normalizePdfValidation(record)
    pdfProcessing.value = validation.status === 'processing'
    pdfJobTarget.value = validation
    seedPdfJob(validation)
  } catch (e) {
    if (generation !== pdfPollGeneration) return
    pdfError.value = pdfUploadController?.signal.aborted
      ? '上传已取消'
      : getUploadErrorMessage(e, 'pdf')
    pdfRetryable.value = !pdfUploadController?.signal.aborted && isRetryablePdfUploadError(e)
    if (!pdfRetryable.value) {
      pdfFile.value = null
      if (getPbStatus(e) === 400 && !pdfError.value.includes('重新选择')) {
        pdfError.value += '，请重新选择 PDF 文件。'
      }
    }
    pdfProcessing.value = false
    await loadPdfResume()
  } finally {
    if (generation === pdfPollGeneration) uploadingPdf.value = pdfProcessing.value
  }
}
onBeforeUnmount(() => {
  pdfUploadController?.abort(PDF_UPLOAD_PAUSED)
  pdfPollGeneration += 1
  closePdfPreview()
})
watch(
  () => props.active,
  (active) => {
    if (active) {
      void loadPdfResume()
      void loadPdfPanel()
    } else {
      panelRequest?.cancel()
      closePdfPreview()
    }
  },
  { immediate: true }
)
defineExpose({ loadPdfResume, uploadingPdf })
</script>

<style scoped>
.pdf-current,
.pdf-preview {
  padding: 0.875rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
}
.pdf-current {
  background: var(--surface-raised);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.pdf-current-info {
  min-width: 0;
  display: grid;
  gap: 0.2rem;
  overflow-wrap: anywhere;
}
.pdf-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.pdf-preview-heading {
  justify-content: space-between;
  margin-bottom: 0.5rem;
}
.pdf-preview-viewer {
  height: clamp(20rem, 68vh, 48rem);
  min-width: 0;
}
</style>
