<template>
  <!-- CSV upload -->
  <div ref="panelElement">
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
    <AppButton variant="secondary" :disabled="uploadingCsv" @click="csvInput.click()">
      选择 CSV 文件
    </AppButton>
    <span v-if="csvFile" class="text-sm ml-2">{{ csvFile.name }}</span>
    <div v-if="csvFile" class="mt-3">
      <AppButton
        variant="primary"
        @click="uploadCsv"
        :loading="uploadingCsv"
        loading-label="正在检查"
      >
        检查 CSV
      </AppButton>
    </div>
    <JobStatusPanel
      v-if="csvJobTarget && csvStatusVisible"
      label="CSV 导入"
      kind="csv"
      :observation="csvObservation"
      @retry="refreshCsvJob"
    />
    <div
      v-if="csvError && !csvJob"
      role="alert"
      class="alert alert-error mt-3 preserve-line-breaks"
    >
      {{ csvError }}
    </div>
    <div v-if="csvJob" class="csv-inspection mt-3">
      <template v-if="csvJob.status === 'validated'">
        <h5 class="csv-inspection-title">检查完成，待确认</h5>
        <p class="text-sm text-muted mt-2" role="status">
          尚未写入校对条目。请核对来源、数量和样本，再确认导入。
        </p>
      </template>
      <div
        v-if="csvSuccess && csvJob.status !== 'validated'"
        class="alert mt-2"
        :class="csvJob.failed_count > 0 ? 'alert-warning' : 'alert-success'"
        role="status"
      >
        {{ csvSuccess }}
      </div>
      <p v-if="csvSourcePending" class="text-sm text-muted mt-2" role="status">正在核对作业来源…</p>
      <p v-else-if="csvActualSource" class="csv-inspection-source text-sm mt-2" role="note">
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
      <dl v-if="csvInspection" class="csv-inspection-counts" aria-label="CSV 检查数量">
        <div>
          <dt>文件行数</dt>
          <dd>{{ csvInspection.totalRows }}</dd>
        </div>
        <div>
          <dt>可导入</dt>
          <dd>{{ csvInspection.validRows }}</dd>
        </div>
        <div :class="{ 'csv-inspection-counts__warning': csvInspection.invalidRows > 0 }">
          <dt>需跳过</dt>
          <dd>{{ csvInspection.invalidRows }}</dd>
        </div>
      </dl>
      <p v-if="csvInspection?.invalidRows > 0" class="csv-inspection-warning" role="note">
        {{ csvInspection.invalidRows }} 行无法导入，确认后将跳过这些行。
        可先查看下方错误记录，修改原 CSV 后重新检查。
      </p>
      <p v-if="csvJob.skipped_count > 0" class="csv-inspection-warning" role="note">
        重复跳过 {{ csvJob.skipped_count }} 条，不新增入库。
      </p>
      <div v-if="csvError" role="alert" class="alert alert-error mt-3 preserve-line-breaks">
        {{ csvError }}
      </div>
      <div
        v-if="csvJob.error_message && csvJob.status !== 'failed'"
        class="alert alert-warning mt-2 preserve-line-breaks"
        role="alert"
      >
        {{ csvJob.error_message }}
      </div>
      <ImportErrorsPanel
        v-if="csvJob.id && (csvJob.failed_count > 0 || csvJob.status === 'failed')"
        :project-id="projectId"
        :job-id="csvJob.id"
        :revision="`${csvJob.status}:${csvJob.updated || ''}`"
      />
      <div v-if="csvInspection && csvJob.status === 'validated'" class="csv-inspection-action">
        <AppButton
          variant="primary"
          @click="confirmCsvImport"
          :loading="uploadingCsv"
          loading-label="正在确认导入"
          :disabled="uploadingCsv || !csvSourceReady"
        >
          确认导入
        </AppButton>
        <span v-if="!csvSourceReady" class="text-sm text-muted">等待作业来源核对完成</span>
      </div>
      <RareCharacterNotice
        v-if="csvInspection"
        :texts="[
          ...csvInspection.headers,
          ...csvInspection.preview.flatMap((row) => Object.values(row))
        ]"
      />
      <AppDisclosure
        v-if="csvInspection"
        :key="csvJob?.id"
        class="csv-preview-disclosure mt-3"
        :label="`查看预览样本（${csvInspection.preview.length} 条）`"
        lazy
      >
        <p class="text-sm text-muted">
          只读预览前 {{ csvInspection.previewLimit }} 条有效记录，当前显示
          {{ csvInspection.preview.length }} 条。
          这是样本，不代表其余记录均正确；需要修改时，请修改原 CSV 后重新检查。
        </p>
        <AppDataTable
          label="CSV 预检内容"
          v-if="csvInspection.preview.length"
          class="table-wrapper mt-2"
          ><template #head>
            <tr>
              <th>原 CSV 行号</th>
              <th>PDF 物理页码</th>
              <th v-for="header in csvPreviewHeaders" :key="header">{{ header }}</th>
            </tr>
          </template>
          <tr v-for="(row, index) in csvInspection.preview" :key="index">
            <td>{{ csvInspection.previewLocations[index]?.csvLine ?? '旧记录未保存' }}</td>
            <td>{{ csvInspection.previewLocations[index]?.pdfPage ?? '旧记录未保存' }}</td>
            <td v-for="header in csvPreviewHeaders" :key="header">
              <AppFieldValue
                :value="row[header]"
                :lang="fieldValueLanguage(header)"
                :font-notice="false"
              />
            </td>
          </tr>
        </AppDataTable>
        <p v-if="!csvInspection.preview.length" class="text-sm text-muted mt-2">
          此作业没有可显示的预览样本，请核对检查数量与错误记录。
        </p>
      </AppDisclosure>
      <AppDisclosure :key="`process:${csvJob.id}`" class="mt-2" label="查看检查与导入详情" lazy>
        <JobStatusPanel
          v-if="!csvStatusVisible"
          label="CSV 导入"
          kind="csv"
          :observation="csvObservation"
          @retry="refreshCsvJob"
        />
        <p class="text-sm">{{ csvJobProgressText(csvJob) }}</p>
        <p class="text-sm text-muted mt-2">
          作业：{{ csvJob.id }}；来源关联：{{ csvJob.source_link }}；来源记录：{{
            csvJob.source || '未关联'
          }}；来源标识：{{ csvActualSource?.logical_id || '未读取或未关联' }}
        </p>
        <template v-if="csvInspection">
          <p class="text-sm mt-2">
            编码：{{ csvInspection.encoding || '未知' }}； 页码字段：<code>{{
              csvInspection.pdfPageField
            }}</code
            >； 页码范围：{{
              csvInspection.minPdfPage && csvInspection.maxPdfPage
                ? `${csvInspection.minPdfPage}–${csvInspection.maxPdfPage}`
                : '无有效页码'
            }}。
          </p>
          <p class="text-sm mt-2">
            检测到的表头：<code>{{ csvInspection.headers.join('、') }}</code>
          </p>
        </template>
      </AppDisclosure>
    </div>
  </div>
</template>

<script setup>
import AppButton from '@/components/AppButton.vue'
import AppDisclosure from '@/components/AppDisclosure.vue'
import RareCharacterNotice from '@/components/editor/RareCharacterNotice.vue'
import AppFieldValue from '@/components/AppFieldValue.vue'
import { fieldValueLanguage } from '@/lib/fieldValue'
import ProjectSourcePicker from '@/components/admin/project/ProjectSourcePicker.vue'
import AppDataTable from '@/components/AppDataTable.vue'
import ImportErrorsPanel from '@/components/admin/project/ImportErrorsPanel.vue'
import JobStatusPanel from '@/components/admin/project/JobStatusPanel.vue'
import { useJobObserver } from '@/composables/useJobObserver'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
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

const panelElement = ref(null)
const csvJobTarget = ref(null)
const {
  snapshot: csvJob,
  observation: csvObservation,
  retry: retryCsvJob,
  seed: seedCsvJob
} = useJobObserver({
  projectId: () => props.projectId,
  kind: 'csv',
  job: csvJobTarget,
  panel: panelElement,
  read: getImportJob
})

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
const csvStatusVisible = computed(
  () =>
    !['validated', 'completed', 'completed_with_errors'].includes(csvJob.value?.status) ||
    ['loading', 'stale', 'offline', 'unauthorized', 'unavailable'].includes(
      csvObservation.value.state
    ) ||
    Boolean(csvObservation.value.error) ||
    Boolean(csvSourceError.value)
)

let csvPollGeneration = 0

const csvInspection = computed(() => parseCsvInspection(csvJob.value?.inspection_json))

const csvPreviewHeaders = computed(() => csvInspection.value?.headers || [])

function onCsvSelected(e) {
  csvPollGeneration++
  csvFile.value = e.target.files[0] || null
  csvSuccess.value = ''
  csvError.value = ''
  csvJobTarget.value = null
  csvActualSource.value = null
  csvSourcePending.value = false
  csvSourceError.value = ''
}

let csvSourceRead = null
function readCsvSource(job, generation) {
  const key = `${generation}:${job.id}:${job.source || ''}`
  if (csvSourceRead?.key === key) return csvSourceRead.promise
  const promise = performReadCsvSource(job, generation).finally(() => {
    if (csvSourceRead?.promise === promise) csvSourceRead = null
  })
  csvSourceRead = { key, promise }
  return promise
}

async function performReadCsvSource(job, generation) {
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

watch(
  () => [csvJob.value?.id, csvJob.value?.status, csvJob.value?.source],
  async ([id, status], previous) => {
    if (!id || (id === previous?.[0] && status === previous?.[1])) return
    const generation = csvPollGeneration
    const job = csvJob.value
    csvError.value = csvFatalMessage(job)
    csvSuccess.value = ['validated', 'completed', 'completed_with_errors'].includes(status)
      ? csvImportResultText(job)
      : ''
    if (csvActualSource.value?.id !== (job.source || '')) await readCsvSource(job, generation)
    if (generation !== csvPollGeneration) return
    if (['completed', 'completed_with_errors'].includes(status)) {
      props.clearSelection()
      try {
        await Promise.all([loadPages(), loadPageStats(), loadQualitySummary(), loadLedger()])
      } catch (error) {
        if (generation === csvPollGeneration)
          csvError.value = getPbMessage(error, '导入已完成，项目列表暂时未更新，请刷新项目。')
      }
    } else if (['validated', 'failed'].includes(status)) {
      try {
        await loadLedger()
      } catch (error) {
        if (generation === csvPollGeneration)
          csvError.value = getPbMessage(error, '作业状态已更新，批次台账暂时未更新，请刷新项目。')
      }
    }
  }
)

function observeCsvJob(job) {
  csvJobTarget.value = job
  seedCsvJob(job)
}

async function uploadCsv() {
  if (!csvFile.value || uploadingCsv.value) return
  uploadingCsv.value = true
  csvError.value = ''
  csvSuccess.value = ''
  csvJobTarget.value = null
  const generation = ++csvPollGeneration
  requestedSourceId.value = sourceId.value
  try {
    const job = await createCsvInspection({
      projectId,
      file: csvFile.value,
      sourceId: sourceId.value
    })
    if (generation !== csvPollGeneration) return
    observeCsvJob(job)
    csvFile.value = null
    if (csvInput.value) csvInput.value.value = ''
    await readCsvSource(job, generation)
    if (generation !== csvPollGeneration) return
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
    const job = await commitCsvImport(csvJob.value.id)
    if (generation !== csvPollGeneration) return
    observeCsvJob(job)
    if (csvActualSource.value?.id !== (job.source || '')) await readCsvSource(job, generation)
  } catch (e) {
    if (generation === csvPollGeneration)
      csvError.value = getPbMessage(e, '确认导入失败，请稍后重试。')
  } finally {
    if (generation === csvPollGeneration) uploadingCsv.value = false
  }
}

async function refreshCsvJob() {
  if (!csvJobTarget.value?.id || uploadingCsv.value) return
  const generation = csvPollGeneration
  csvError.value = ''
  await retryCsvJob()
  if (generation === csvPollGeneration && csvJob.value)
    await readCsvSource(csvJob.value, generation)
}
onBeforeUnmount(() => {
  csvPollGeneration += 1
})
defineExpose({
  hasPendingWork: computed(
    () =>
      uploadingCsv.value ||
      Boolean(csvFile.value) ||
      ['inspecting', 'queued', 'processing', 'validated'].includes(csvJob.value?.status)
  )
})
</script>

<style scoped>
.csv-inspection-title {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 600;
}
.csv-inspection-source {
  line-height: 1.7;
}
.csv-inspection-counts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
  margin-top: var(--space-4);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--primary-line);
}
.csv-inspection-counts dt {
  color: var(--ink-muted);
  font-size: var(--text-sm);
}
.csv-inspection-counts dd {
  margin: var(--space-1) 0 0;
  color: var(--ink);
  font-size: var(--text-xl);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.csv-inspection-counts__warning dd {
  color: var(--warn-ink);
}
.csv-inspection-warning {
  margin-top: var(--space-3);
  color: var(--warn-ink);
  font-size: var(--text-sm);
  line-height: 1.7;
}
.csv-inspection-action {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-4) 0;
}
.csv-preview-disclosure {
  border-top: 1px solid var(--primary-line);
  padding-top: var(--space-2);
}
</style>
