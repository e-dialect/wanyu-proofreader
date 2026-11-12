<template>
  <!-- Export section -->
  <section id="project-export" class="card project-section mb-6">
    <div class="card-title">导出结果</div>
    <RouterLink :to="deliveryTarget" class="btn btn-secondary mb-3">交付包与回执</RouterLink>
    <h3>核验结果 CSV</h3>
    <p class="text-sm text-muted mb-3">
      项目全量文件含完成状态，未完成记录会明确标为导入值回退。业务已完成文件排除阻塞问题、暂缓判断和依据失效的记录，保留实际声调写法与合法空白。
    </p>
    <div class="flex flex-wrap gap-2 items-center mb-3">
      <button class="btn btn-primary" @click="exportCsv('all')" :disabled="exporting">
        全量 CSV（含状态）
      </button>
      <button class="btn btn-secondary" @click="exportCsv('completed')" :disabled="exporting">
        业务已完成 CSV
      </button>
      <RouterLink :to="`/admin/projects/${projectId}/verification`">来源覆盖与过程导出</RouterLink>
    </div>
    <h3>来源与校对记录</h3>
    <p class="text-sm text-muted mb-3">
      文件由服务端生成，包含来源、质量状态和仲裁信息。已完成条目使用最终校对行，其余条目使用原始行并标明未完成；默认排除暂缓外发条目。文件内注明本次范围与条数，筛选结果不会冒充全量。
      此处按校对状态筛选，不代表已经通过来源核验或达到业务完成条件；需要已完成结果时，请使用上方“业务已完成
      CSV”。
    </p>
    <div class="settings-form mb-3">
      <AppField class="form-group"
        ><template #label>文件格式</template
        ><select v-model="exportFormat" class="form-control" :disabled="exporting">
          <option value="csv">CSV 表格</option>
          <option value="jsonl">JSONL 逐条数据</option>
        </select></AppField
      >
      <AppField class="form-group"
        ><template #label>校对范围</template
        ><select v-model="exportStatus" class="form-control" :disabled="exporting">
          <option value="">全部可导出状态</option>
          <option value="approved">仅已完成校对</option>
        </select></AppField
      >
      <AppField class="form-group"
        ><template #label>质量状态</template
        ><select v-model="exportQuality" class="form-control" :disabled="exporting">
          <option value="">全部质量状态</option>
          <option v-for="state in QUALITY_STATES" :key="state" :value="state">
            {{ QUALITY_STATE_LABELS[state] }}
          </option>
        </select></AppField
      >
      <AppField class="form-group"
        ><template #label>更新起点（可留空）</template
        ><input
          v-model="exportSince"
          type="datetime-local"
          class="form-control"
          :disabled="exporting"
      /></AppField>
      <label class="flex gap-2 items-center"
        ><input
          v-model="exportWithheld"
          type="checkbox"
          :disabled="exporting"
        />包含暂缓外发条目（需项目管理权限）</label
      >
    </div>
    <div class="flex flex-wrap gap-2 items-center">
      <button class="btn btn-primary" @click="exportResults" :disabled="exporting">
        {{ exporting ? '导出中...' : '下载服务端导出文件' }}
      </button>
      <span v-if="exportError" role="alert" class="alert alert-error feedback-inline">{{
        exportError
      }}</span>
      <span v-if="exportSuccess" role="status" class="alert alert-success feedback-inline">{{
        exportSuccess
      }}</span>
    </div>
  </section>
</template>

<script setup>
import AppField from '@/components/AppField.vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { batchReportNavigationQuery, readBatchReportContext } from '@/lib/batchReportContext'
import { exportVerification } from '@/services/verificationService'
import { downloadText } from '@/lib/downloadText'
import { downloadProjectExport } from '@/services/projectExportService'
import { QUALITY_STATES, QUALITY_STATE_LABELS } from '@/constants/qualityState'
import { toRef } from 'vue'
const props = defineProps({
  projectId: { type: String, required: true },
  project: { type: Object, required: true }
})
const projectId = props.projectId
const route = useRoute()
const deliveryTarget = computed(() => ({
  path: `/admin/projects/${encodeURIComponent(projectId)}/deliveries`,
  query: batchReportNavigationQuery(readBatchReportContext(route.query, projectId))
}))
const project = toRef(props, 'project')
const exporting = ref(false)

const exportFormat = ref('csv')

const exportStatus = ref('')

const exportQuality = ref('')

const exportSince = ref('')

const exportWithheld = ref(false)

let projectExportController = null

const exportError = ref('')

const exportSuccess = ref('')

async function exportCsv(mode = 'all') {
  if (exporting.value) return
  exporting.value = true
  exportError.value = ''
  exportSuccess.value = ''
  try {
    const result = await exportVerification(projectId, mode)
    downloadText(
      result.csv,
      `${project.value?.name || 'project'}_${mode === 'all' ? '全量含状态' : '业务已完成'}.csv`,
      'text/csv;charset=utf-8'
    )
    exportSuccess.value = `已导出 ${result.selected_count} 条记录`
  } catch (e) {
    exportError.value = e?.message || '导出失败，请重试'
  } finally {
    exporting.value = false
  }
}

async function exportResults() {
  if (exporting.value) return
  exporting.value = true
  exportError.value = ''
  exportSuccess.value = ''
  try {
    projectExportController = new AbortController()
    const count = await downloadProjectExport(projectId, {
      signal: projectExportController.signal,
      format: exportFormat.value,
      filters: {
        status: exportStatus.value,
        quality_state: exportQuality.value,
        since: exportSince.value ? new Date(exportSince.value).toISOString() : '',
        include_withheld: exportWithheld.value
      }
    })
    exportSuccess.value = `已导出 ${count} 条记录，文件内含范围说明与来源信息`
  } catch (e) {
    exportError.value = e?.message || '导出失败，请重试'
  } finally {
    exporting.value = false
  }
}
onBeforeUnmount(() => projectExportController?.abort())
</script>
