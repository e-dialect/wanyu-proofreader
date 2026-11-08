<template>
  <section class="import-errors-panel" aria-label="导入错误记录" :aria-busy="loading">
    <div class="import-errors-heading">
      <div>
        <h3>导入错误记录</h3>
        <p v-if="job" class="text-sm text-muted">
          {{ job.original_filename || '本批资料' }} · 失败 {{ job.failed_count || 0 }}
          {{ job.mode === 'ocr' ? '页' : '行' }}；共 {{ total }} 条错误记录。
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <AppButton size="sm" :disabled="loading || downloading" @click="load(1)"
          >刷新记录</AppButton
        >
        <AppButton
          size="sm"
          :disabled="loading || !job || !importErrorsReady(job)"
          :loading="downloading"
          @click="download"
        >
          下载全部错误（JSON）
        </AppButton>
        <AppButton v-if="downloading" size="sm" @click="cancelDownload">取消下载</AppButton>
      </div>
    </div>
    <p v-if="loadError" class="alert alert-error" role="alert">{{ loadError }}</p>
    <p v-else-if="loading" class="text-muted" role="status">正在读取错误记录…</p>
    <template v-else-if="job">
      <p v-if="!importErrorsReady(job)" class="text-muted" role="status">
        作业仍在处理，完成后可查看与下载错误报告。
      </p>
      <template v-else>
        <p v-if="job.error_code" class="text-sm preserve-line-breaks">
          {{ job.error_code }}：{{ job.error_message }}
        </p>
        <AppDataTable v-if="total" label="导入失败记录" class="import-error-table">
          <template #head
            ><tr>
              <th>资料行</th>
              <th>字段</th>
              <th>原因</th>
            </tr></template
          >
          <tr v-for="item in rows" :key="item.id">
            <td>{{ item.row_number || '—' }}</td>
            <td>{{ item.column_name || '—' }}</td>
            <td>
              <span class="preserve-line-breaks">{{ item.message }}</span>
              <details>
                <summary>错误详情</summary>
                <p>
                  <code>{{ item.error_code }}</code>
                </p>
                <template v-if="item.raw_value !== '' && item.raw_value != null">
                  <p class="text-sm text-muted">原值</p>
                  <pre class="import-error-raw">{{ item.raw_value }}</pre>
                </template>
              </details>
            </td>
          </tr>
        </AppDataTable>
        <p v-else class="text-muted">本批没有逐行错误记录；作业级失败原因以上方说明为准。</p>
        <AppPagination
          v-if="totalPages > 1"
          :page="page"
          :total-pages="totalPages"
          :busy="loading || downloading"
          label="导入错误分页"
          @change="load"
        />
        <p class="text-sm text-muted">
          失败行数与错误记录条数分别统计。报告包含全部分页的记录及原值，保留字符与空白。
        </p>
      </template>
    </template>
    <p v-if="downloadError" class="alert alert-error" role="alert">{{ downloadError }}</p>
    <p v-if="downloadStatus" class="text-sm" role="status">{{ downloadStatus }}</p>
  </section>
</template>

<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import AppButton from '@/components/AppButton.vue'
import AppDataTable from '@/components/AppDataTable.vue'
import AppPagination from '@/components/AppPagination.vue'
import { getImportJob, listImportJobErrors } from '@/services/importJobsService'
import {
  checkedImportErrorPage,
  IMPORT_ERROR_PAGE_SIZE,
  importErrorsReady,
  readImportErrorReport
} from '@/lib/importErrors'
import { downloadText } from '@/lib/downloadText'
import { useAuthStore } from '@/stores/auth'
import { getPbMessage } from '@/utils/pbErrors'

const props = defineProps({
  projectId: { type: String, required: true },
  jobId: { type: String, required: true },
  revision: { type: String, default: '' }
})
const auth = useAuthStore()
const job = ref(null),
  rows = ref([]),
  page = ref(1),
  total = ref(0),
  totalPages = ref(0)
const loading = ref(false),
  loadError = ref(''),
  downloading = ref(false),
  downloadError = ref(''),
  downloadStatus = ref('')
let generation = 0,
  disposed = false,
  readController,
  downloadController

function cancelDownload() {
  downloadController?.abort()
  downloadController = null
  downloading.value = false
  downloadStatus.value = ''
}
function invalidate() {
  generation++
  readController?.abort()
  cancelDownload()
}
async function load(target = 1) {
  invalidate()
  const version = generation,
    project = props.projectId,
    id = props.jobId
  const controller = new AbortController()
  readController = controller
  loading.value = true
  loadError.value = downloadError.value = downloadStatus.value = ''
  const active = () => !disposed && version === generation && !controller.signal.aborted
  try {
    const value = await getImportJob(id, { signal: controller.signal })
    if (!active()) return
    if (value.project !== project) throw new Error('该导入作业不属于当前项目。')
    let result = { items: [], totalItems: 0, totalPages: 0 }
    if (importErrorsReady(value))
      result = checkedImportErrorPage(
        await listImportJobErrors(id, target, IMPORT_ERROR_PAGE_SIZE, {
          signal: controller.signal
        }),
        target,
        IMPORT_ERROR_PAGE_SIZE
      )
    if (!active()) return
    job.value = value
    rows.value = result.items
    page.value = target
    total.value = result.totalItems
    totalPages.value = result.totalPages
  } catch (cause) {
    if (active()) loadError.value = getPbMessage(cause, '错误记录读取失败，请刷新重试。')
  } finally {
    if (active()) loading.value = false
  }
}
async function download() {
  if (!job.value || loading.value || downloading.value || !importErrorsReady(job.value)) return
  const version = generation,
    value = job.value
  const controller = new AbortController()
  downloadController = controller
  downloading.value = true
  downloadError.value = ''
  downloadStatus.value = '正在读取全部错误记录…'
  const active = () => !disposed && version === generation && !controller.signal.aborted
  try {
    const report = await readImportErrorReport(value, listImportJobErrors, getImportJob, {
      signal: controller.signal,
      onProgress: (count, all) => {
        if (active()) downloadStatus.value = `已读取 ${count} / ${all} 条错误记录…`
      }
    })
    if (!active()) return
    downloadText(
      JSON.stringify(report, null, 2) + '\n',
      `导入错误_${value.id}.json`,
      'application/json;charset=utf-8'
    )
    downloadStatus.value = `已下载全部 ${report.record_count} 条错误记录。`
  } catch (cause) {
    if (active()) {
      downloadStatus.value = ''
      downloadError.value = getPbMessage(cause, '完整报告读取失败，没有生成下载文件，请重试。')
    }
  } finally {
    if (active()) downloading.value = false
  }
}
watch(
  () => [props.projectId, props.jobId, props.revision, auth.user?.id],
  () => {
    job.value = null
    rows.value = []
    total.value = totalPages.value = 0
    load(1)
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  disposed = true
  invalidate()
})
</script>

<style scoped>
.import-errors-panel {
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--gray-200);
}
.import-errors-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: start;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}
.import-error-raw {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--font-rare), var(--font-ui);
}
.import-errors-panel details {
  margin-top: var(--space-2);
}
.import-errors-panel summary {
  min-height: 44px;
  padding-block: var(--space-2);
  cursor: pointer;
}
.import-error-table :deep(table) {
  min-width: 0;
  table-layout: fixed;
}
.import-error-table :deep(th),
.import-error-table :deep(td) {
  overflow-wrap: anywhere;
}
.import-error-table :deep(th:first-child) {
  width: 5.5rem;
}
.import-error-table :deep(th:nth-child(2)) {
  width: 6rem;
}
@media (max-width: 600px) {
  .import-error-table :deep(th),
  .import-error-table :deep(td) {
    padding-inline: var(--space-2);
  }
  .import-error-table :deep(th:first-child) {
    width: 4.25rem;
  }
  .import-error-table :deep(th:nth-child(2)) {
    width: 5rem;
  }
}
</style>
