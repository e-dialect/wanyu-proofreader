<template>
  <!-- Import ledger -->
  <section id="project-ledger" class="card project-section mb-6">
    <div class="card-title">批次台账</div>
    <p class="text-sm text-muted mb-3">
      本项目的导入批次汇总：入册行数、来源覆盖与未知来源计数均由系统对账给出。「跳过」列为 Review
      Bundle 复用自然键的条数；CSV 预检被跳过的无效行计入「失败」列。OCR
      输入与失败按物理页计，入册仍按条目行计。
    </p>
    <div v-if="loadingLedger" class="text-muted">加载中...</div>
    <div v-else-if="ledgerError" class="alert alert-error" role="alert">{{ ledgerError }}</div>
    <template v-else-if="ledger">
      <div class="flex flex-wrap gap-4 text-sm mb-3">
        <span
          ><strong>{{ ledger.summary.total_batches }}</strong> 批</span
        >
        <span
          ><strong>{{ ledger.summary.total_rows }}</strong> 行输入</span
        >
        <span
          ><strong>{{ ledger.summary.ocr_pages || 0 }}</strong> OCR 页输入</span
        >
        <span
          ><strong>{{ ledger.summary.imported_rows }}</strong> 行入册</span
        >
        <span
          ><strong>{{ ledger.summary.unknown_source_rows }}</strong> 行未知来源</span
        >
        <span v-if="ledger.summary.sources.length">
          来源覆盖：
          <template
            v-for="(source, index) in ledger.summary.sources"
            :key="source.logical_id || index"
          >
            {{ source.logical_id || '未登记来源' }}（{{ source.rows }} 行）<span
              v-if="index < ledger.summary.sources.length - 1"
              >、</span
            >
          </template>
        </span>
      </div>
      <AppDataTable label="项目导入批次台账" class="table-wrapper"
        ><template #head>
          <tr>
            <th>作业</th>
            <th>完成时间</th>
            <th>文件名</th>
            <th>状态</th>
            <th>输入</th>
            <th>入库</th>
            <th>跳过</th>
            <th>失败</th>
            <th>对账</th>
            <th>来源</th>
          </tr>
        </template>
        <tr v-for="batch in ledger.batches" :id="`import-batch-${batch.id}`" :key="batch.id">
          <td>
            <code>{{ batch.id }}</code>
            <RouterLink
              :to="{
                name: 'ProjectBatchReport',
                params: { id: props.projectId, batchId: batch.id }
              }"
              :aria-label="`质量与交付报告 · ${batch.original_filename || batch.id}`"
              class="batch-report-link"
            >
              质量与交付报告
            </RouterLink>
          </td>
          <td>{{ batch.finished_at || batch.created || '—' }}</td>
          <td>{{ batch.original_filename || '—' }}</td>
          <td>{{ batchImportStatus(batch.status) }}</td>
          <td>{{ batch.total_count }} {{ batch.count_unit === 'pages' ? '页' : '行' }}</td>
          <td>{{ batch.inserted_count }} 行</td>
          <td>{{ batch.skipped_count }} {{ batch.count_unit === 'pages' ? '页' : '行' }}</td>
          <td>
            {{ batch.failed_count }} {{ batch.count_unit === 'pages' ? '页' : '行' }}
            <AppButton
              v-if="batch.failed_count > 0 || ['failed', 'error'].includes(batch.status)"
              size="sm"
              variant="ghost"
              :aria-label="`查看 ${batch.original_filename || batch.id} 的错误记录`"
              @click="selectedErrorJob = selectedErrorJob === batch.id ? '' : batch.id"
              >{{ selectedErrorJob === batch.id ? '收起错误' : '查看错误' }}</AppButton
            >
          </td>
          <td>
            {{ batch.counts_label
            }}<span v-if="batch.counts_note" class="text-muted">（{{ batch.counts_note }}）</span>
          </td>
          <td>
            {{
              batch.source_hint ||
              batch.source_logical_id ||
              (batch.source_link === 'unknown' ? '未登记来源' : '—')
            }}
          </td>
        </tr>
        <tr v-if="!ledger.batches.length">
          <td colspan="10" class="text-muted">还没有导入批次。</td>
        </tr>
      </AppDataTable>
      <ImportErrorsPanel
        v-if="selectedErrorJob"
        :key="`${props.projectId}:${selectedErrorJob}`"
        :project-id="props.projectId"
        :job-id="selectedErrorJob"
      />
      <ul v-if="ledger.errors && ledger.errors.length" class="text-sm mt-3">
        <li
          v-for="item in ledger.errors"
          :key="`${item.job}-${item.error_code}-${item.column_name}`"
        >
          作业 <code>{{ item.job }}</code> · {{ item.error_code }} · 字段
          {{ item.column_name || '—' }} · {{ item.count }} 条 · 首行 {{ item.first_row }} ·
          {{ item.message }}
        </li>
      </ul>
      <p v-if="ledger.errors_omitted" class="text-sm text-muted mt-2">
        另有 {{ ledger.errors_omitted }} 组未列出。
      </p>
    </template>
  </section>
</template>

<script setup>
import AppDataTable from '@/components/AppDataTable.vue'
import AppButton from '@/components/AppButton.vue'
import ImportErrorsPanel from '@/components/admin/project/ImportErrorsPanel.vue'
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { batchImportStatus } from '@/lib/batchReport'
import { listImportLedger } from '@/services/importJobsService'
import { getPbMessage } from '@/utils/pbErrors'
const props = defineProps({ projectId: { type: String, required: true } })
const route = useRoute()
const ledger = ref(null)
const selectedErrorJob = ref('')
let generation = 0,
  disposed = false

const ledgerError = ref('')

const loadingLedger = ref(false)

async function loadLedger() {
  const version = ++generation
  loadingLedger.value = true
  ledgerError.value = ''
  try {
    const value = await listImportLedger(props.projectId)
    if (disposed || version !== generation) return
    ledger.value = value
    await nextTick()
    if (!disposed && version === generation && /^#import-batch-[a-z0-9]{15}$/.test(route.hash)) {
      document.getElementById(route.hash.slice(1))?.scrollIntoView({ block: 'center' })
    }
  } catch (e) {
    if (disposed || version !== generation) return
    ledger.value = null
    ledgerError.value = getPbMessage(e, '批次台账加载失败。')
  } finally {
    if (!disposed && version === generation) loadingLedger.value = false
  }
}
watch(
  () => props.projectId,
  () => {
    ledger.value = null
    selectedErrorJob.value = ''
    loadLedger()
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  disposed = true
  generation++
})
defineExpose({ loadLedger })
</script>

<style scoped>
.batch-report-link {
  display: flex;
  align-items: center;
  font-size: var(--text-sm);
  min-height: var(--control-height);
  white-space: nowrap;
}
@media (max-width: 768px) {
  .batch-report-link {
    min-height: var(--control-height-touch);
  }
}
</style>
