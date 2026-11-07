<template>
  <!-- CSV upload -->
  <div>
    <h4 class="font-semibold mb-2">上传 CSV 文件（每行一条待校对文本）</h4>
    <p class="text-sm text-muted mb-3">
      CSV 需包含 <code>PDF页码</code>、<code>page</code>、<code>pdf_page</code> 或
      <code>页码</code> 中的一个字段。<br />
      系统会在后端预检，并将每行去掉页码字段后的内容导入为新条目。
    </p>
    <AppField class="form-group mt-3"
      ><template #label>本批来源（可留空）</template>
      <input
        v-model.trim="sourceId"
        class="form-control"
        placeholder="来源 logical_id，留空则标为 source:unknown"
      />
    </AppField>
    <input
      type="file"
      accept=".csv"
      @change="onCsvSelected"
      ref="csvInput"
      class="file-input-hidden"
    />
    <button class="btn btn-secondary" @click="csvInput.click()">选择 CSV 文件</button>
    <span v-if="csvFile" class="text-sm ml-2">{{ csvFile.name }}</span>
    <div v-if="csvFile" class="mt-3">
      <button class="btn btn-primary" @click="uploadCsv" :disabled="uploadingCsv">
        {{ uploadingCsv ? '后端预检中...' : '后端预检 CSV' }}
      </button>
    </div>
    <div v-if="csvJob" class="import-job-card mt-3">
      <div class="flex items-center justify-between gap-2">
        <strong>{{ csvJobStatusLabel }}</strong>
        <span class="text-sm text-muted">作业 {{ csvJob.id }}</span>
      </div>
      <div class="progress mt-2">
        <div class="progress-bar" :style="{ width: csvJobProgress + '%' }"></div>
      </div>
      <div class="text-sm mt-2">{{ csvJobProgressText(csvJob) }}</div>
      <div class="text-sm text-muted mt-1">
        {{
          csvJob.source_link === 'linked'
            ? '本批已关联来源。'
            : '本批未关联来源，已标为 source:unknown。'
        }}
      </div>
      <div
        v-if="csvJob.error_message && csvJob.status !== 'failed'"
        class="text-sm text-muted mt-1"
      >
        {{ csvJob.error_message }}
      </div>
    </div>
    <div v-if="csvInspection" class="csv-inspection mt-3">
      <div class="font-semibold">后端预检结果</div>
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
        :disabled="uploadingCsv"
      >
        {{ uploadingCsv ? '导入处理中...' : '确认导入' }}
      </button>
    </div>
    <div v-if="csvSuccess" class="alert alert-success mt-2" role="status">{{ csvSuccess }}</div>
    <div v-if="csvError" role="alert" class="alert alert-error mt-2 preserve-line-breaks">
      {{ csvError }}
    </div>
    <div v-if="csvImportErrors.length" class="mt-3">
      <div class="font-semibold mb-2">错误明细（显示前 {{ csvImportErrors.length }} 条）</div>
      <AppDataTable label="CSV 导入错误" class="table-wrapper import-error-table"
        ><template #head>
          <tr>
            <th>CSV 行</th>
            <th>字段</th>
            <th>错误代码</th>
            <th>原因</th>
          </tr>
        </template>
        <tr v-for="item in csvImportErrors" :key="item.id">
          <td>{{ item.row_number || '—' }}</td>
          <td>{{ item.column_name || '—' }}</td>
          <td>
            <code>{{ item.error_code }}</code>
          </td>
          <td>
            {{ item.message }}
            <span v-if="item.raw_value" class="text-muted">（值：{{ item.raw_value }}）</span>
          </td>
        </tr>
      </AppDataTable>
    </div>
  </div>
</template>

<script setup>
import RareCharacterNotice from '@/components/editor/RareCharacterNotice.vue'
import AppFieldValue from '@/components/AppFieldValue.vue'
import { fieldValueLanguage } from '@/lib/fieldValue'
import AppField from '@/components/AppField.vue'
import AppDataTable from '@/components/AppDataTable.vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import {
  commitCsvImport,
  createCsvInspection,
  getImportJob,
  listImportJobErrors
} from '@/services/importJobsService'
import {
  csvFatalMessage,
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

const csvImportErrors = ref([])

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
      inspecting: '后端正在预检',
      validated: '后端预检完成',
      queued: '等待后端处理',
      processing: '后端正在导入',
      completed: '导入完成',
      completed_with_errors: '导入完成，部分条目失败未入库',
      failed: '导入失败'
    })[csvJob.value?.status] || '准备导入'
)

const csvInspection = computed(() => parseCsvInspection(csvJob.value?.inspection_json))

const csvPreviewHeaders = computed(() => csvInspection.value?.headers.slice(0, 6) || [])

function onCsvSelected(e) {
  csvFile.value = e.target.files[0] || null
  csvSuccess.value = ''
  csvError.value = ''
  csvJob.value = null
  csvImportErrors.value = []
}

async function uploadCsv() {
  if (!csvFile.value) return
  uploadingCsv.value = true
  csvError.value = ''
  csvSuccess.value = ''
  csvJob.value = null
  csvImportErrors.value = []
  const generation = ++csvPollGeneration
  try {
    let job = await createCsvInspection({
      projectId,
      file: csvFile.value,
      sourceId: sourceId.value
    })
    csvJob.value = job
    csvFile.value = null
    if (csvInput.value) csvInput.value.value = ''
    while (
      ['inspecting', 'queued', 'processing'].includes(job.status) &&
      generation === csvPollGeneration
    ) {
      await pollDelay(1000)
      job = await getImportJob(job.id)
      csvJob.value = job
    }
    if (generation !== csvPollGeneration) return

    if (job.status === 'failed') {
      csvError.value = csvFatalMessage(job)
    } else if (job.status === 'validated') {
      const inspection = parseCsvInspection(job.inspection_json)
      csvSuccess.value = inspection ? csvImportResultText(job) : '后端预检完成，请确认后开始导入。'
      if (job.failed_count > 0) {
        const result = await listImportJobErrors(job.id, 1, 100)
        csvImportErrors.value = result.items
      }
    } else if (['completed', 'completed_with_errors'].includes(job.status)) {
      csvSuccess.value = '相同文件已经导入，无需重复处理。'
      await loadPages()
    }
    await loadLedger()
  } catch (e) {
    csvError.value = getUploadErrorMessage(e, 'csv')
  } finally {
    if (generation === csvPollGeneration) uploadingCsv.value = false
  }
}

async function confirmCsvImport() {
  if (csvJob.value?.status !== 'validated') return
  uploadingCsv.value = true
  csvError.value = ''
  csvSuccess.value = ''
  csvImportErrors.value = []
  const generation = ++csvPollGeneration
  try {
    let job = await commitCsvImport(csvJob.value.id)
    csvJob.value = job
    while (['queued', 'processing'].includes(job.status) && generation === csvPollGeneration) {
      await pollDelay(1000)
      job = await getImportJob(job.id)
      csvJob.value = job
    }
    if (generation !== csvPollGeneration) return
    if (job.status === 'failed') {
      csvError.value = csvFatalMessage(job)
      await loadLedger()
      return
    }
    csvSuccess.value = csvImportResultText(job)
    if (job.failed_count > 0) {
      const result = await listImportJobErrors(job.id, 1, 100)
      csvImportErrors.value = result.items
    }
    props.clearSelection()
    // 导入会改变条目总数，汇总必须跟着走：只刷表格的话，三枚分桶芯片与「共 N 条」
    // 会停在旧数字上，与正下方刚刷新出来的表格对不上账（#172 验收第 4 条问的就是这个数）。
    await Promise.all([loadPages(), loadPageStats(), loadQualitySummary(), loadLedger()])
  } catch (e) {
    csvError.value = getPbMessage(e, '确认导入失败，请稍后重试。')
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
</script>
