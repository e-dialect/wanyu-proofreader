<template>
  <!-- Import ledger -->
  <section id="project-ledger" class="card project-section mb-6">
    <div class="card-title">批次台账</div>
    <p class="text-sm text-muted mb-3">
      本项目的导入批次汇总：入册行数、来源覆盖与未知来源计数均由系统对账给出。「跳过」列为 Review
      Bundle 复用自然键的条数；CSV 预检被跳过的无效行计入「失败」列。
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
        <tr v-for="batch in ledger.batches" :key="batch.id">
          <td>
            <code>{{ batch.id }}</code>
          </td>
          <td>{{ batch.finished_at || batch.created || '—' }}</td>
          <td>{{ batch.original_filename || '—' }}</td>
          <td>{{ batch.status }}</td>
          <td>{{ batch.total_count }}</td>
          <td>{{ batch.inserted_count }}</td>
          <td>{{ batch.skipped_count }}</td>
          <td>{{ batch.failed_count }}</td>
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
import { ref } from 'vue'
import { listImportLedger } from '@/services/importJobsService'
import { getPbMessage } from '@/utils/pbErrors'
const props = defineProps({ projectId: { type: String, required: true } })
const projectId = props.projectId
const ledger = ref(null)

const ledgerError = ref('')

const loadingLedger = ref(false)

async function loadLedger() {
  loadingLedger.value = true
  ledgerError.value = ''
  try {
    ledger.value = await listImportLedger(projectId)
  } catch (e) {
    ledger.value = null
    ledgerError.value = getPbMessage(e, '批次台账加载失败。')
  } finally {
    loadingLedger.value = false
  }
}
defineExpose({ loadLedger })
</script>
