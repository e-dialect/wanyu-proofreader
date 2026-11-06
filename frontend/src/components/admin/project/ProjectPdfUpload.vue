<template>
  <!-- PDF upload -->
  <div>
    <h4 class="font-semibold mb-2">上传 PDF 文件</h4>
    <p class="text-sm text-muted mb-3">
      上传 PDF 作为校对原文预览。上传本身不生成条目。可通过 CSV 导入，或在本地 OCR
      已启用时按页发起识别并修正结果。
    </p>
    <div v-if="pdfResume && !uploadingPdf" class="alert mt-2" role="status">
      <p>
        有未完成的 PDF 上传：{{ pdfResume.name }}
        <span v-if="pdfResumeExpired">，已过期，请重新选择文件上传。</span>
        <span v-else>。请重新选择同一文件继续；不能只靠文件名和大小匹配。</span>
      </p>
      <div class="mt-3 flex gap-2">
        <button type="button" class="btn btn-primary" @click="pdfInput.click()">
          重新选择同一 PDF
        </button>
        <button type="button" class="btn btn-quiet" @click="abandonPdfResume">
          放弃未完成上传
        </button>
      </div>
    </div>
    <input
      type="file"
      accept=".pdf"
      @change="onPdfSelected"
      :disabled="uploadingPdf"
      ref="pdfInput"
      class="file-input-hidden"
    />
    <button
      v-if="!pdfResume || uploadingPdf"
      class="btn btn-secondary"
      @click="pdfInput.click()"
      :disabled="uploadingPdf"
    >
      选择 PDF 文件
    </button>
    <span v-if="pdfFile" class="text-sm ml-2">{{ pdfFile.name }}</span>
    <div v-if="pdfError && pdfRetryable && pdfFile && !uploadingPdf" class="mt-3">
      <button class="btn btn-primary" @click="uploadPdf">重试上传 PDF</button>
    </div>
    <div v-if="uploadingPdf && !pdfProcessing" class="mt-2" role="status">
      <progress :value="pdfUploadProgress" max="100" aria-label="PDF 上传进度"></progress>
      <span
        >已上传 {{ pdfUploadProgress }}%{{ pdfUploadProgress === 100 ? '，正在保存…' : '' }}</span
      >
      <button class="btn btn-quiet btn-sm" @click="pdfUploadController?.abort()">取消上传</button>
    </div>
    <div v-if="pdfProcessing" class="alert mt-2" role="status">PDF 已上传，后端正在校验文件...</div>
    <div v-if="pdfSuccess" class="alert alert-success mt-2" role="status">
      PDF 深度校验完成，共 {{ pdfMetadata?.page_count || 0 }} 页，已设为项目主
      PDF，可在校对编辑器中预览。
    </div>
    <div v-if="pdfError" class="alert alert-error mt-2" role="alert">{{ pdfError }}</div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import {
  createProjectPdf,
  getProjectFile,
  listProjectPdfUploads,
  cancelProjectPdfUpload
} from '@/services/projectFilesService'
import { validatePdfFile, loadPdfUploadResume, clearPdfUploadResume } from '@/lib/chunkedPdfUpload'
import { currentUserId } from '@/services/authService'
import { getPbStatus, getUploadErrorMessage, isRetryablePdfUploadError } from '@/utils/pbErrors'
const props = defineProps({ projectId: { type: String, required: true } })
const projectId = props.projectId
const pdfInput = ref(null)

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

const pdfResumeExpired = computed(() => Boolean(pdfResume.value?.expired))

async function onPdfSelected(e) {
  if (uploadingPdf.value) return
  const selectedFile = e.target.files[0]
  if (!selectedFile) return
  pdfFile.value = selectedFile
  pdfSuccess.value = false
  pdfMetadata.value = null
  pdfProcessing.value = false
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
  const userId = currentUserId()
  const stored = loadPdfUploadResume(
    typeof localStorage === 'undefined' ? null : localStorage,
    userId,
    projectId
  )
  try {
    const listed = await listProjectPdfUploads(projectId)
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
  } catch {
    /* Local resume is enough to prompt re-selection after a network error. */
  }
  pdfResume.value = decoratePdfResume(stored)
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
  if (!pdfFile.value || uploadingPdf.value) return
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
    let record = await createProjectPdf({
      projectId,
      file: pdfFile.value,
      signal,
      userId: currentUserId(),
      onProgress: (value) => {
        if (generation === pdfPollGeneration) pdfUploadProgress.value = value
      }
    })
    if (generation !== pdfPollGeneration) return
    pdfProcessing.value = record.status === 'processing'
    while (record.status === 'processing' && generation === pdfPollGeneration) {
      await pollDelay(1000)
      record = await getProjectFile(record.id)
    }
    if (generation !== pdfPollGeneration) return
    pdfProcessing.value = false
    if (record.status === 'ready') {
      pdfSuccess.value = true
      pdfMetadata.value = record
      pdfFile.value = null
      pdfResume.value = null
      if (pdfInput.value) pdfInput.value.value = ''
    } else {
      pdfError.value = `${record.error_message || 'PDF 后端校验失败'}，请重新选择 PDF 文件。`
      pdfFile.value = null
      pdfResume.value = null
      pdfRetryable.value = false
      if (pdfInput.value) pdfInput.value.value = ''
    }
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
    if (generation === pdfPollGeneration) uploadingPdf.value = false
  }
}

function pollDelay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
onBeforeUnmount(() => {
  pdfUploadController?.abort()
  pdfPollGeneration += 1
})
defineExpose({ loadPdfResume })
</script>
