<template>
  <section aria-labelledby="project-ocr-title">
    <h4 id="project-ocr-title" class="font-semibold mb-2">OCR 识别</h4>
    <p class="text-sm text-muted mb-3">
      读取主 PDF
      中不含图像、可映射的单栏纯文字层页面；含扫描图或装饰图的页当前不生成识别条目。按单栏逐行生成「原文」字段，不推测词头、记音或释义。请对照
      PDF 修正后再校对。
    </p>
    <div class="grid-2">
      <AppField label="OCR 起始页"
        ><input
          v-model="startPage"
          type="number"
          min="1"
          class="form-control"
          :disabled="running || startUnknown"
      /></AppField>
      <AppField label="OCR 结束页"
        ><input
          v-model="endPage"
          type="number"
          min="1"
          class="form-control"
          :disabled="running || startUnknown"
      /></AppField>
    </div>
    <p class="text-sm text-muted mb-2">
      页码为 PDF 物理页码，单次最多 200
      页。扫描引擎的难字安全评测尚未通过；文字层中的记音、上标和缺字也需对照原文核对。再次识别会创建新批次，不覆盖已有条目。
    </p>
    <button
      class="btn btn-secondary"
      :disabled="running || loadingLatest || startUnknown"
      @click="startRecognition"
    >
      {{ running ? '识别进行中…' : '发起识别' }}
    </button>
    <AppStatusPanel
      v-if="error"
      class="mt-2 preserve-line-breaks"
      state="error"
      :message="error"
      :retry-label="startUnknown ? '确认本次请求状态' : ''"
      :busy="starting"
      @retry="confirmStart"
    />
    <div v-if="job" class="import-job-card mt-3" aria-live="polite">
      <strong>{{ statusLabel }}</strong>
      <p class="text-sm text-muted">作业 {{ job.id }}</p>
      <progress :value="progress" max="100" aria-label="OCR 已处理页数进度"></progress>
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
      <p v-if="job.status === 'failed'" class="text-sm">本批识别失败，暂存条目未发布为任务。</p>
      <a v-if="published && result.rows" href="#project-entries">查看条目预览并修正</a>
      <div v-if="result.artifacts?.length" class="mt-2">
        <p class="text-sm">原始文字、坐标和识别状态保存在受权限保护的中间产物中：</p>
        <button
          v-for="artifact in result.artifacts"
          :key="artifact.id"
          class="btn btn-quiet btn-sm"
          :disabled="Boolean(downloading)"
          @click="downloadArtifact(artifact)"
        >
          下载第 {{ artifact.page }} 页原始 JSON
        </button>
      </div>
      <button
        v-if="pollError && running"
        class="btn btn-secondary btn-sm mt-2"
        @click="resumePolling"
      >
        重新读取作业状态
      </button>
    </div>
  </section>
</template>
<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppField from '@/components/AppField.vue'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import {
  getImportJob,
  latestOcrJob,
  startOcr,
  fetchOcrArtifact
} from '@/services/importJobsService'
import { downloadText } from '@/lib/downloadText'
import { ocrProgress, parseOcrObject, validateOcrRange } from '@/lib/ocrJob'
import { currentUserId } from '@/services/authService'
import {
  readPendingOcrStart,
  savePendingOcrStart,
  clearPendingOcrStart
} from '@/lib/ocrStartRequest'
import { getPbMessage, getPbStatus } from '@/utils/pbErrors'
const props = defineProps({ projectId: { type: String, required: true } })
const emit = defineEmits(['changed'])
const userId = currentUserId()
const pendingStart = ref(null)
const startUnknown = ref(false)
const startPage = ref(1),
  endPage = ref(1)
const job = ref(null),
  error = ref(''),
  loadingLatest = ref(true),
  starting = ref(false),
  pollError = ref(false),
  downloading = ref('')
const running = computed(
  () => starting.value || ['queued', 'processing'].includes(job.value?.status)
)
const published = computed(() => ['completed', 'completed_with_errors'].includes(job.value?.status))
const progress = computed(() => ocrProgress(job.value))
const result = computed(() => parseOcrObject(job.value?.ocr_result_json))
const statusLabel = computed(
  () =>
    ({
      queued: '等待识别',
      processing: '识别进行中',
      completed: '识别完成',
      completed_with_errors: '识别完成，部分页面失败',
      failed: '识别失败'
    })[job.value?.status] || '未开始'
)
let generation = 0,
  timer,
  disposed = false
const controller = new AbortController()
onBeforeUnmount(() => {
  disposed = true
  generation++
  clearTimeout(timer)
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
    job.value = latest
    if (running.value) resumePolling()
  } catch (failure) {
    if (!disposed) error.value = getPbMessage(failure, '读取上次识别作业失败，可重新发起。')
  } finally {
    if (!disposed) loadingLatest.value = false
  }
})
async function startRecognition() {
  if (running.value || startUnknown.value) return
  error.value = validateOcrRange(startPage.value, endPage.value)
  if (error.value) return
  const request = {
    projectId: props.projectId,
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
    job.value = created
    startUnknown.value = false
    pendingStart.value = null
    try {
      clearPendingOcrStart(window.sessionStorage, userId, props.projectId)
    } catch {
      /* Retained keys remain safe: the server returns the original job. */
    }
    resumePolling()
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
    } else {
      startUnknown.value = true
      error.value = `本次请求结果未知；请确认本次请求状态，将复用原请求避免重复入册。${getPbMessage(failure, '')}`
    }
  } finally {
    if (!disposed) starting.value = false
  }
}

function resumePolling() {
  clearTimeout(timer)
  const current = ++generation
  pollError.value = false
  error.value = ''
  const tick = async () => {
    try {
      const updated = await getImportJob(job.value.id, { signal: controller.signal })
      if (disposed || current !== generation) return
      job.value = updated
      if (['queued', 'processing'].includes(updated.status)) timer = setTimeout(tick, 1000)
      else emit('changed')
    } catch (failure) {
      if (disposed || current !== generation) return
      pollError.value = true
      error.value = getPbMessage(
        failure,
        '暂时无法读取作业状态；识别仍可能在后台进行，请重试状态读取。'
      )
    }
  }
  tick()
}
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
