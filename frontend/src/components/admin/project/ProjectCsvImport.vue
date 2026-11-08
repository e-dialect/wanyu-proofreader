<template>
  <!-- CSV upload -->
  <div>
    <h4 class="font-semibold mb-2">从 CSV 导入条目</h4>
    <p class="text-sm text-muted mb-3">每行生成一条待校对材料。先检查页码与内容，再确认导入。</p>
    <details class="mb-3">
      <summary class="text-sm text-muted">查看 CSV 格式要求</summary>
      <p class="text-sm text-muted">
        CSV 需包含 <code>PDF页码</code>、<code>page</code>、<code>pdf_page</code> 或
        <code>页码</code> 中的一个字段；页码字段用于定位原文，其余字段保留为条目内容。
      </p>
    </details>
    <ProjectSourcePicker
      v-if="!csvJob"
      v-model="sourceId"
      class="form-group mt-3"
      :disabled="uploadingCsv || csvJob?.status === 'validated'"
    />
    <input
      type="file"
      accept=".csv"
      @change="onCsvSelected"
      ref="csvInput"
      class="file-input-hidden"
      :disabled="uploadingCsv"
    />
    <button class="btn btn-secondary" :disabled="uploadingCsv" @click="csvInput.click()">
      选择 CSV 文件
    </button>
    <span v-if="csvFile" class="text-sm ml-2">{{ csvFile.name }}</span>
    <div v-if="csvFile" class="mt-3">
      <button class="btn btn-primary" @click="uploadCsv" :disabled="uploadingCsv">
        {{ uploadingCsv ? '正在检查…' : '检查 CSV' }}
      </button>
    </div>
    <div v-if="csvJob" class="import-job-card mt-3">
      <div class="flex items-center justify-between gap-2">
        <strong>{{ csvJobStatusLabel }}</strong>
      </div>
      <div class="progress mt-2">
        <div class="progress-bar" :style="{ width: csvJobProgress + '%' }"></div>
      </div>
      <div class="text-sm mt-2">{{ csvJobProgressText(csvJob) }}</div>
      <p v-if="csvSourcePending" class="text-sm text-muted mt-2" role="status">正在核对作业来源…</p>
      <p v-else-if="csvActualSource" class="text-sm mt-2" role="note">
        本次实际来源：<strong>{{ csvActualSource.title }}</strong
        >。
        {{ csvJob.status === 'validated' ? '确认导入将沿用这个来源。' : '来源以此作业记录为准。' }}
      </p>
      <p v-if="csvSourceMismatch" class="alert alert-warning mt-2" role="alert">
        刚才选择的「{{ requestedSourceLabel }}」未应用：相同文件沿用了已有作业，实际来源为「{{
          csvActualSource.title
        }}」。此处不会改写已有作业的来源。
      </p>
      <p v-if="csvSourceError" class="alert alert-warning mt-2" role="alert">
        {{ csvSourceError }} 请刷新后核对，暂不能确认导入。
      </p>
      <button
        type="button"
        class="btn btn-secondary btn-sm mt-2"
        :disabled="uploadingCsv"
        @click="refreshCsvJob"
      >
        刷新检查与导入进度
      </button>
      <details class="text-sm text-muted mt-2">
        <summary>查看作业详情</summary>
        <p>
          作业：{{ csvJob.id }}；来源关联：{{ csvJob.source_link }}；来源记录：{{
            csvJob.source || '未关联'
          }}；来源标识：{{ csvActualSource?.logical_id || '未读取或未关联' }}
        </p>
      </details>
      <div
        v-if="csvJob.error_message && csvJob.status !== 'failed'"
        class="text-sm text-muted mt-1"
      >
        {{ csvJob.error_message }}
      </div>
    </div>
    <div v-if="csvInspection" class="csv-inspection mt-3">
      <div class="font-semibold">导入前检查</div>
      <RareCharacterNotice
        :texts="[
          ...csvInspection.headers,
          ...csvInspection.preview.flatMap((row) => Object.values(row))
        ]"
      />
      <div class="text-sm mt-2">
        编码：{{ csvInspection.encoding || '未知' }}； 页码字段：<code>{{
          csvInspection.pdfPageField
        }}</code
        >； 页码范围：{{
          csvInspection.minPdfPage && csvInspection.maxPdfPage
            ? `${csvInspection.minPdfPage}–${csvInspection.maxPdfPage}`
            : '无有效页码'
        }}； 共 {{ csvInspection.totalRows }} 行，可导入 {{ csvInspection.validRows }} 行，需跳过
        {{ csvInspection.invalidRows }} 行。
      </div>
      <div class="text-sm mt-2">
        检测到的表头：<code>{{ csvInspection.headers.join('、') }}</code>
      </div>
      <AppDataTable
        label="CSV 预检内容"
        v-if="csvInspection.preview.length"
        class="table-wrapper mt-2"
        ><template #head>
          <tr>
            <th v-for="header in csvPreviewHeaders" :key="header">{{ header }}</th>
          </tr>
        </template>
        <tr v-for="(row, index) in csvInspection.preview" :key="index">
          <td v-for="header in csvPreviewHeaders" :key="header">
            <AppFieldValue
              :value="row[header]"
              :lang="fieldValueLanguage(header)"
              :font-notice="false"
            />
          </td>
        </tr>
      </AppDataTable>
      <button
        v-if="csvJob?.status === 'validated'"
        class="btn btn-primary mt-3"
        @click="confirmCsvImport"
        :disabled="uploadingCsv || !csvSourceReady"
      >
        {{ uploadingCsv ? '导入处理中...' : '确认导入' }}
      </button>
    </div>
    <div v-if="csvSuccess" class="alert alert-success mt-2" role="status">{{ csvSuccess }}</div>
    <div v-if="csvError" role="alert" class="alert alert-error mt-2 preserve-line-breaks">
      {{ csvError }}
    </div>
    <ImportErrorsPanel
      v-if="csvJob?.id && (csvJob.failed_count > 0 || csvJob.status === 'failed')"
      :project-id="projectId"
      :job-id="csvJob.id"
      :revision="`${csvJob.status}:${csvJob.updated || ''}`"
    />
  </div>
</template>

<script setup>
import RareCharacterNotice from '@/components/editor/RareCharacterNotice.vue'
import AppFieldValue from '@/components/AppFieldValue.vue'
import { fieldValueLanguage } from '@/lib/fieldValue'
import ProjectSourcePicker from '@/components/admin/project/ProjectSourcePicker.vue'
import AppDataTable from '@/components/AppDataTable.vue'
import ImportErrorsPanel from '@/components/admin/project/ImportErrorsPanel.vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import { listSources } from '@/services/sourcesService'
import { commitCsvImport, createCsvInspection, getImportJob } from '@/services/importJobsService'
import {
  csvFatalMessage,
  csvFixedSource,
  csvImportResultText,
  csvJobProgressText,
  parseCsvInspection
} from '@/lib/csvInspection'
import { getPbMessage, getUploadErrorMessage } from '@/utils/pbErrors'
const props = defineProps({
  projectId: { type: String, required: true },
  refreshPages: { type: Function, required: true },
  refreshStats: { type: Function, required: true },
  refreshQuality: { type: Function, required: true },
  refreshLedger: { type: Function, required: true },
  clearSelection: { type: Function, required: true }
})
const projectId = props.projectId
const loadPages = props.refreshPages
const loadPageStats = props.refreshStats
const loadQualitySummary = props.refreshQuality
const loadLedger = props.refreshLedger
const csvInput = ref(null)

const csvFile = ref(null)

const sourceId = ref('')

const uploadingCsv = ref(false)

const csvSuccess = ref('')

const csvError = ref('')

const csvJob = ref(null)

const csvActualSource = ref(null)
const csvSourcePending = ref(false)
const csvSourceError = ref('')
const requestedSourceId = ref('')
const requestedSourceLabel = ref('未关联来源')
const csvSourceReady = computed(
  () =>
    !csvSourcePending.value &&
    !csvSourceError.value &&
    (!csvJob.value?.source || Boolean(csvActualSource.value))
)
const csvSourceMismatch = computed(
  () => csvActualSource.value && csvActualSource.value.logical_id !== requestedSourceId.value
)

let csvPollGeneration = 0

const csvJobProgress = computed(() => {
  const processed = Number(csvJob.value?.processed_count || 0)
  const total = Number(csvJob.value?.total_count || 0)
  if (['validated', 'completed', 'completed_with_errors'].includes(csvJob.value?.status)) return 100
  if (!total) return ['inspecting', 'processing'].includes(csvJob.value?.status) ? 10 : 0
  return Math.min(99, Math.round((processed / total) * 100))
})

const csvJobStatusLabel = computed(
  () =>
    ({
      inspecting: '正在检查 CSV',
      validated: 'CSV 检查完成',
      queued: '等待导入',
      processing: '正在导入',
      completed: '导入完成',
      completed_with_errors: '导入完成，部分条目失败未入库',
      failed: '导入失败'
    })[csvJob.value?.status] || '准备导入'
)

const csvInspection = computed(() => parseCsvInspection(csvJob.value?.inspection_json))

const csvPreviewHeaders = computed(() => csvInspection.value?.headers.slice(0, 6) || [])

function onCsvSelected(e) {
  csvPollGeneration++
  csvFile.value = e.target.files[0] || null
  csvSuccess.value = ''
  csvError.value = ''
  csvJob.value = null
  csvActualSource.value = null
  csvSourcePending.value = false
  csvSourceError.value = ''
}

async function readCsvSource(job, generation) {
  csvSourcePending.value = true
  csvSourceError.value = ''
  csvActualSource.value = null
  try {
    const items = job.source ? (await listSources()).items || [] : []
    if (generation !== csvPollGeneration) return
    requestedSourceLabel.value =
      items.find((item) => item.logical_id === requestedSourceId.value)?.title ||
      requestedSourceId.value ||
      '未关联来源'
    csvActualSource.value = csvFixedSource(job, items)
    if (!csvActualSource.value)
      csvSourceError.value = '当前权限下未能读取此作业实际关联的来源资料。'
  } catch (cause) {
    if (generation === csvPollGeneration)
      csvSourceError.value = getPbMessage(cause, '作业来源暂时无法读取。')
  } finally {
    if (generation === csvPollGeneration) csvSourcePending.value = false
  }
}

async function followCsvJob(job, generation) {
  while (
    ['inspecting', 'queued', 'processing'].includes(job.status) &&
    generation === csvPollGeneration
  ) {
    await pollDelay(1000)
    if (generation !== csvPollGeneration) return job
    job = await getImportJob(job.id)
    if (generation !== csvPollGeneration) return job
    csvJob.value = job
    if (csvActualSource.value?.id !== (job.source || '')) await readCsvSource(job, generation)
  }
  return job
}

async function uploadCsv() {
  if (!csvFile.value || uploadingCsv.value) return
  uploadingCsv.value = true
  csvError.value = ''
  csvSuccess.value = ''
  csvJob.value = null
  const generation = ++csvPollGeneration
  requestedSourceId.value = sourceId.value
  try {
    let job = await createCsvInspection({
      projectId,
      file: csvFile.value,
      sourceId: sourceId.value
    })
    if (generation !== csvPollGeneration) return
    csvJob.value = job
    csvFile.value = null
    if (csvInput.value) csvInput.value.value = ''
    await readCsvSource(job, generation)
    if (generation !== csvPollGeneration) return
    job = await followCsvJob(job, generation)
    if (generation !== csvPollGeneration) return

    if (job.status === 'failed') {
      csvError.value = csvFatalMessage(job)
    } else if (job.status === 'validated') {
      const inspection = parseCsvInspection(job.inspection_json)
      csvSuccess.value = inspection ? csvImportResultText(job) : 'CSV 检查完成，请确认后开始导入。'
    } else if (['completed', 'completed_with_errors'].includes(job.status)) {
      csvSuccess.value = '相同文件已经导入，无需重复处理。'
      await loadPages()
    }
    if (generation !== csvPollGeneration) return
    await loadLedger()
  } catch (e) {
    if (generation === csvPollGeneration)
      csvError.value = csvJob.value?.id
        ? getPbMessage(e, '读取进度失败，已保留原作业，请原地刷新重试。')
        : getUploadErrorMessage(e, 'csv')
  } finally {
    if (generation === csvPollGeneration) uploadingCsv.value = false
  }
}

async function confirmCsvImport() {
  if (csvJob.value?.status !== 'validated' || uploadingCsv.value || !csvSourceReady.value) return
  uploadingCsv.value = true
  csvError.value = ''
  csvSuccess.value = ''
  const generation = ++csvPollGeneration
  try {
    let job = await commitCsvImport(csvJob.value.id)
    if (generation !== csvPollGeneration) return
    csvJob.value = job
    if (csvActualSource.value?.id !== (job.source || '')) await readCsvSource(job, generation)
    job = await followCsvJob(job, generation)
    if (generation !== csvPollGeneration) return
    if (job.status === 'failed') {
      csvError.value = csvFatalMessage(job)
      await loadLedger()
      return
    }
    csvSuccess.value = csvImportResultText(job)
    props.clearSelection()
    // 导入会改变条目总数，汇总必须跟着走：只刷表格的话，三枚分桶芯片与「共 N 条」
    // 会停在旧数字上，与正下方刚刷新出来的表格对不上账（#172 验收第 4 条问的就是这个数）。
    await Promise.all([loadPages(), loadPageStats(), loadQualitySummary(), loadLedger()])
  } catch (e) {
    if (generation === csvPollGeneration)
      csvError.value = getPbMessage(e, '确认导入失败，请稍后重试。')
  } finally {
    if (generation === csvPollGeneration) uploadingCsv.value = false
  }
}

async function refreshCsvJob() {
  if (!csvJob.value?.id || uploadingCsv.value) return
  const generation = ++csvPollGeneration
  uploadingCsv.value = true
  csvError.value = ''
  csvSuccess.value = ''
  try {
    let job = await getImportJob(csvJob.value.id)
    if (generation !== csvPollGeneration) return
    csvJob.value = job
    await readCsvSource(job, generation)
    if (generation !== csvPollGeneration) return
    job = await followCsvJob(job, generation)
    if (generation !== csvPollGeneration) return
    csvError.value = csvFatalMessage(job)
    if (['validated', 'completed', 'completed_with_errors'].includes(job.status))
      csvSuccess.value = csvImportResultText(job)
    await Promise.all([loadPages(), loadPageStats(), loadQualitySummary(), loadLedger()])
  } catch (cause) {
    if (generation === csvPollGeneration)
      csvError.value = getPbMessage(cause, '读取进度失败，已保留原作业，请原地刷新重试。')
  } finally {
    if (generation === csvPollGeneration) uploadingCsv.value = false
  }
}

function pollDelay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
onBeforeUnmount(() => {
  csvPollGeneration += 1
})
defineExpose({
  hasPendingWork: computed(
    () => uploadingCsv.value || Boolean(csvFile.value) || csvJob.value?.status === 'validated'
  )
})
</script>
