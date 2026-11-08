<template>
  <section
    id="project-tone-batch"
    class="project-section card tone-batch"
    aria-labelledby="tone-batch-title"
  >
    <header class="section-heading">
      <div>
        <h2 id="tone-batch-title">调值数字转上标</h2>
        <p>
          把已经明确的调值数字排成上标。生成新候选文件供人工核对，项目条目、校对与来源判断均不改写。
        </p>
      </div>
      <AppButton
        v-if="options && !error"
        variant="ghost"
        size="sm"
        :loading="loading"
        :disabled="busy || confirming"
        @click="reloadColumnConfiguration"
        >重新读取列配置</AppButton
      >
    </header>
    <AppStatusPanel v-if="loading" state="pending" message="正在读取记音列与可用依据…" />
    <AppStatusPanel
      v-if="loadError"
      state="error"
      :message="loadError"
      retry-label="重新加载"
      :busy="loading"
      @retry="loadOptions"
    />
    <template v-if="options">
      <AppStatusPanel
        v-if="!columns.length"
        state="empty"
        reason="not_computed"
        message="尚未标注记音列。请先在项目设置中指定需要处理的列用途。"
      />
      <AppDisclosure
        v-else
        v-model="configOpen"
        label="转换配置与调值依据"
        class="tone-config-disclosure"
      >
        <form @submit.prevent="previewBatch">
          <fieldset :disabled="busy || confirming || loading || !!loadError" class="tone-config">
            <legend class="sr-only">调值上标配置</legend>
            <div class="tone-scope">
              <AppField label="取值范围"
                ><AppSelect
                  v-model="sourceMode"
                  aria-label="取值范围"
                  :disabled="busy || confirming || loading || !!loadError"
                  :options="sourceOptions"
              /></AppField>
              <AppField label="起始条号"
                ><input v-model.number="startItem" class="form-control" type="number" min="1"
              /></AppField>
              <AppField label="结束条号"
                ><input
                  v-model.number="endItem"
                  class="form-control"
                  type="number"
                  :min="startItem || 1"
              /></AppField>
            </div>
            <p class="text-sm text-muted">
              范围按条号计算，不是 PDF 页码。每批最多 {{ options.max_rows }} 条、{{
                options.max_columns
              }}
              列；超过 8 MiB 原文时请缩小范围。
            </p>
            <p v-if="sourceMode === 'approved'" class="text-sm text-muted">
              只处理校对状态为已完成的最终采用行；空值保持为空，字段缺失不会退回导入值。
            </p>
            <label class="tone-check"
              ><input
                v-model="includeWithheld"
                type="checkbox"
              />显式包含暂缓外发条目（仅生成内部核对候选，不表示获准外发）</label
            >
            <h3>选择记音列与调值依据</h3>
            <div v-for="column in columns" :key="column.name" class="tone-column">
              <label class="tone-check"
                ><input v-model="column.selected" type="checkbox" /><strong>{{
                  column.name
                }}</strong></label
              >
              <div v-if="column.selected" class="tone-column-fields">
                <AppField :label="`${column.name} · 字段类型`"
                  ><AppSelect
                    v-model="column.kind"
                    :aria-label="`${column.name} · 字段类型`"
                    :disabled="busy || confirming || loading || !!loadError"
                    :options="kindOptions"
                /></AppField>
                <AppField :label="`${column.name} · 合法调值依据`"
                  ><AppSelect
                    v-model="column.profile"
                    :aria-label="`${column.name} · 合法调值依据`"
                    :disabled="busy || confirming || loading || !!loadError"
                    :options="profileOptions"
                /></AppField>
                <AppField v-if="column.profile === 'custom'" :label="`${column.name} · 合法调值`"
                  ><input
                    v-model="column.legal"
                    class="form-control"
                    placeholder="如 53, 35, 0；每个完整调值以逗号分开"
                /></AppField>
                <p v-else-if="column.profile" class="text-sm text-muted">
                  {{ profileDescription(column.profile) }}
                </p>
                <AppField :label="`${column.name} · 依据说明`" class="tone-basis">
                  <textarea
                    v-model="column.basis"
                    class="form-control"
                    rows="2"
                    maxlength="1000"
                    placeholder="请写明本列使用调值的资料、页码或约定；自定义集合必须有明确依据。"
                  />
                </AppField>
              </div>
            </div>
            <p class="text-sm text-muted">
              登记集合只适用于其声明的资料。53
              不在莆田登记集合内；其他资料可明确填写自己的合法调值集合。此工具不从调类序号推导调值。
            </p>
            <label class="tone-check"
              ><input
                v-model="declared"
                type="checkbox"
              />我已确认所选字段的数字是已有调值，不是调类号、页码或其他编号，并已选择相应依据。</label
            >
          </fieldset>
          <div class="tone-actions">
            <AppButton
              variant="primary"
              type="submit"
              :loading="previewing"
              :disabled="busy || confirming || loading || !!loadError || !declared"
              >预览转换</AppButton
            ><AppButton v-if="busy" variant="ghost" @click="cancelPending">取消当前操作</AppButton>
          </div>
        </form>
      </AppDisclosure>
      <AppStatusPanel
        v-if="error"
        state="error"
        :message="error"
        retry-label="重新读取列配置"
        :busy="loading"
        @retry="reloadColumnConfiguration"
      />
      <p v-if="notice" role="status" class="text-sm text-muted">{{ notice }}</p>
      <section v-if="preview" class="tone-preview" aria-labelledby="tone-preview-title">
        <header class="section-heading">
          <div>
            <h3 id="tone-preview-title">候选预览</h3>
            <p>
              {{ preview.row_count }} 条 · {{ preview.cells.length }} 个单元格 ·
              {{ preview.changed_count }} 格有上标候选
            </p>
          </div>
          <AppButton variant="primary" :disabled="busy || stale" @click="confirming = true"
            >确认并下载候选 ZIP</AppButton
          >
        </header>
        <p class="text-sm text-muted">
          原值来自{{
            preview.request.source_mode === 'approved' ? '已完成校对的最终采用行' : '导入行'
          }}。不支持或有歧义时整格不改；即使生成候选，也须人工核对。
        </p>
        <RareCharacterNotice :texts="previewFontTexts" />
        <label class="tone-check"
          ><input v-model="exceptionsOnly" type="checkbox" />只看需要人工判断或未处理的单元格</label
        >
        <p class="tone-scroll-hint text-sm text-muted">左右滑动查看候选与结果。</p>
        <AppDataTable label="调值上标候选预览" table-class="tone-preview-table"
          ><template #head
            ><tr>
              <th>条目 / 字段</th>
              <th>原值</th>
              <th>候选</th>
              <th>结果</th>
            </tr></template
          >
          <tr v-for="cell in shownCells" :key="`${cell.entry_id}:${cell.column}`">
            <td>
              <strong>第 {{ cell.item_number }} 条</strong
              ><small v-if="cell.pdf_page">PDF 第 {{ cell.pdf_page }} 页</small
              ><span>{{ cell.column }}</span>
            </td>
            <td>
              <AppFieldValue
                class="tone-value"
                tabindex="0"
                :aria-label="`第${cell.item_number}条${cell.column}原值`"
                :value="cell.original"
                :font-notice="false"
              />
            </td>
            <td>
              <AppFieldValue
                class="tone-value"
                tabindex="0"
                :aria-label="`第${cell.item_number}条${cell.column}候选`"
                :value="cell.candidate"
                :font-notice="false"
              />
            </td>
            <td>
              <span>{{ statusLabel(cell.status) }}</span
              ><small v-if="cell.reason">{{ reasonLabel(cell.reason) }}</small>
            </td>
          </tr></AppDataTable
        >
        <p v-if="!shownCells.length" class="text-sm text-muted">当前范围没有需要处理的异常。</p>
        <AppPagination
          v-if="pageCount > 1"
          :page="page"
          :total-pages="pageCount"
          label="调值候选分页"
          @change="page = $event"
        />
        <AppDisclosure label="下载内容与原值保真"
          ><p class="text-sm">
            ZIP 包含完整原值与候选 CSV、精确保留空白及组合符的 JSONL、逐格原因报告和依据清单。CSV
            沿用工作文件的公式防护；JSONL
            保留精确字段值。这不是正式交付包，也不表示质量通过。人工核对后可按现有材料导入旅程使用；新材料导入会新建条目，本工具不做原项目覆盖。
          </p></AppDisclosure
        >
      </section>
    </template>
    <ConfirmDialog :open="confirming" title-id="tone-confirm-title" @close="closeConfirm"
      ><h3 id="tone-confirm-title">下载调值上标候选</h3>
      <p>
        将重新检查当前原值、角色、键盘与规则依据；若有变化，必须重新预览。候选文件仍需人工核对，项目数据不改写。
      </p>
      <label class="tone-check"
        ><input
          v-model="reviewed"
          type="checkbox"
          :disabled="downloading"
        />我已查看预览，理解这是供人工核对的新候选文件。</label
      ><template #actions
        ><AppButton v-if="downloading" variant="ghost" @click="cancelDownload">取消下载</AppButton>
        <AppButton v-else @click="closeConfirm">返回预览</AppButton
        ><AppButton
          variant="primary"
          :loading="downloading"
          :disabled="!reviewed || downloading || stale"
          @click="downloadBatch"
          >下载候选 ZIP</AppButton
        ></template
      ></ConfirmDialog
    >
  </section>
</template>
<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppButton from '@/components/AppButton.vue'
import AppSelect from '@/components/AppSelect.vue'
import AppField from '@/components/AppField.vue'
import AppDataTable from '@/components/AppDataTable.vue'
import AppFieldValue from '@/components/AppFieldValue.vue'
import AppPagination from '@/components/AppPagination.vue'
import AppDisclosure from '@/components/AppDisclosure.vue'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import RareCharacterNotice from '@/components/editor/RareCharacterNotice.vue'
import { useAuthStore } from '@/stores/auth'
import { getPbMessage, getPbStatus } from '@/utils/pbErrors'
import {
  getToneBatchOptions,
  previewToneBatch,
  downloadToneBatch
} from '@/services/toneBatchService'
const props = defineProps({
  projectId: { type: String, required: true },
  active: { type: Boolean, default: true }
})
const auth = useAuthStore()
const configOpen = ref(true)
const options = ref(null),
  columns = ref([]),
  loading = ref(false),
  loadError = ref('')
const sourceMode = ref(''),
  startItem = ref(1),
  endItem = ref(1),
  includeWithheld = ref(false),
  declared = ref(false)
const preview = ref(null),
  previewing = ref(false),
  downloading = ref(false),
  confirming = ref(false),
  reviewed = ref(false),
  stale = ref(false),
  error = ref(''),
  notice = ref('')
const exceptionsOnly = ref(false),
  page = ref(1)
const busy = computed(() => previewing.value || downloading.value)
let generation = 0,
  controller,
  disposed = false
const sourceOptions = [
  { value: '', label: '请选择取值来源' },
  { value: 'imported', label: '导入值' },
  { value: 'approved', label: '已完成校对的最终采用值' }
]
const kindOptions = [
  { value: '', label: '请选择字段类型' },
  { value: 'reading', label: '音节 + 调值（如 ka53）' },
  { value: 'tone_only', label: '仅为调值（如 53）' }
]
const profiles = computed(() =>
  Object.entries(options.value?.rules?.schemes || {}).flatMap(([id, rule]) =>
    rule.annotation_system === 'tone_value'
      ? Object.entries(rule.tone_value_sets || {}).map(([set, values]) => ({
          value: `${id}:${set}`,
          label: `${rule.title} · ${set}`,
          schemeId: id,
          set,
          values,
          notation: rule.notation
        }))
      : []
  )
)
const profileOptions = computed(() => [
  { value: '', label: '请选择合法调值依据' },
  ...profiles.value,
  { value: 'custom', label: '自定义合法调值集合与依据' }
])
const filteredCells = computed(() =>
  (preview.value?.cells || []).filter(
    (cell) => !exceptionsOnly.value || ['AMBIGUOUS', 'UNSUPPORTED'].includes(cell.status)
  )
)
const pageCount = computed(() => Math.max(1, Math.ceil(filteredCells.value.length / 50)))
const shownCells = computed(() => filteredCells.value.slice((page.value - 1) * 50, page.value * 50))
const previewFontTexts = computed(() =>
  shownCells.value.flatMap((cell) => [cell.original, cell.candidate])
)
watch(exceptionsOnly, () => {
  page.value = 1
})
const config = computed(() => ({
  source_mode: sourceMode.value,
  start_item: Number(startItem.value),
  end_item: Number(endItem.value),
  include_withheld: includeWithheld.value,
  declared_tone_values: declared.value,
  columns: columns.value
    .filter((column) => column.selected)
    .map((column) => {
      const profile = profiles.value.find((item) => item.value === column.profile)
      return {
        name: column.name,
        kind: column.kind,
        scheme_id: column.profile === 'custom' ? 'custom' : profile?.schemeId || '',
        value_set: profile?.set || '',
        legal_values:
          column.profile === 'custom' ? column.legal.split(/[,，\s]+/u).filter(Boolean) : [],
        basis: column.basis
      }
    })
}))
watch(
  config,
  () => {
    preview.value = null
    stale.value = false
    notice.value = ''
    error.value = ''
    confirming.value = false
  },
  { deep: true }
)
function current(token, project, actor) {
  return (
    !disposed &&
    token === generation &&
    props.active &&
    props.projectId === project &&
    auth.user?.id === actor
  )
}
function cancelPending() {
  generation++
  controller?.abort()
  previewing.value = false
  downloading.value = false
  notice.value = '已取消当前操作，配置保留。'
}
function reloadColumnConfiguration() {
  preview.value = null
  stale.value = false
  error.value = ''
  declared.value = false
  confirming.value = false
  reviewed.value = false
  configOpen.value = true
  return loadOptions()
}
async function loadOptions() {
  const token = ++generation,
    project = props.projectId,
    actor = auth.user?.id
  controller?.abort()
  controller = new AbortController()
  loading.value = true
  loadError.value = ''
  try {
    const data = await getToneBatchOptions(project, controller.signal)
    if (!current(token, project, actor)) return
    options.value = data
    columns.value = data.columns.map((name) => ({
      name,
      selected: false,
      kind: '',
      profile: '',
      legal: '',
      basis: ''
    }))
    startItem.value = data.scope.first
    endItem.value = Math.min(data.scope.last, startItem.value + data.max_rows - 1)
  } catch (cause) {
    if (current(token, project, actor)) loadError.value = getPbMessage(cause, '读取失败，请重试。')
  } finally {
    if (current(token, project, actor)) loading.value = false
  }
}
async function previewBatch() {
  if (busy.value || confirming.value || loading.value || loadError.value || !props.active) return
  const request = JSON.parse(JSON.stringify(config.value))
  if (
    !request.source_mode ||
    !request.columns.length ||
    request.columns.some((column) => !column.kind || !column.scheme_id || !column.basis.trim())
  ) {
    error.value = '请选择取值来源、记音列、字段类型与合法集合，并填写依据说明。'
    return
  }
  const token = ++generation,
    project = props.projectId,
    actor = auth.user?.id
  controller?.abort()
  controller = new AbortController()
  previewing.value = true
  error.value = ''
  notice.value = ''
  preview.value = null
  try {
    const result = await previewToneBatch(project, request, controller.signal)
    if (!current(token, project, actor)) return
    preview.value = result
    configOpen.value = false
    stale.value = false
    page.value = 1
  } catch (cause) {
    if (current(token, project, actor))
      error.value = getPbMessage(cause, '预览失败，配置保留，请重试。')
  } finally {
    if (current(token, project, actor)) previewing.value = false
  }
}
function cancelDownload() {
  cancelPending()
  confirming.value = false
  reviewed.value = false
  notice.value = '下载已取消，预览与配置保留。'
}
function closeConfirm() {
  if (downloading.value) {
    cancelDownload()
    return
  }
  if (!downloading.value) {
    confirming.value = false
    reviewed.value = false
  }
}
async function downloadBatch() {
  if (!preview.value || busy.value || !reviewed.value || stale.value || !props.active) return
  const token = ++generation,
    project = props.projectId,
    actor = auth.user?.id
  const request = { ...preview.value.request, expected_basis: preview.value.expected_basis }
  controller?.abort()
  controller = new AbortController()
  downloading.value = true
  error.value = ''
  notice.value = ''
  const isCurrent = () => current(token, project, actor)
  try {
    const blob = await downloadToneBatch(project, request, { signal: controller.signal, isCurrent })
    if (!isCurrent()) return
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `tone_candidates_${project}.zip`
    link.click()
    URL.revokeObjectURL(url)
    confirming.value = false
    reviewed.value = false
    notice.value = '候选 ZIP 已下载；项目条目未改写，请继续人工核对。'
  } catch (cause) {
    if (!isCurrent()) return
    stale.value = getPbStatus(cause) === 409 || cause.status === 409
    confirming.value = false
    reviewed.value = false
    error.value = cause.message || '下载失败，预览保留，请重试。'
  } finally {
    if (isCurrent()) downloading.value = false
  }
}
watch(
  [() => props.projectId, () => auth.user?.id],
  () => {
    cancelPending()
    options.value = null
    configOpen.value = true
    columns.value = []
    sourceMode.value = ''
    declared.value = false
    includeWithheld.value = false
    preview.value = null
    error.value = ''
    notice.value = ''
    confirming.value = false
    reviewed.value = false
    if (props.active) loadOptions()
  },
  { immediate: true }
)
watch(
  () => props.active,
  (active) => {
    if (!active) {
      cancelPending()
      loading.value = false
      confirming.value = false
      reviewed.value = false
    } else if (!options.value) loadOptions()
  }
)
onBeforeUnmount(() => {
  disposed = true
  generation++
  controller?.abort()
})
function profileDescription(value) {
  const profile = profiles.value.find((item) => item.value === value)
  return profile ? `合法调值：${profile.values.join('、')}。${profile.notation}` : ''
}
function statusLabel(status) {
  return (
    {
      EXACT: '上标候选',
      EMPTY: '空值',
      NO_TONE: '无需转换',
      AMBIGUOUS: '需人工判断',
      UNSUPPORTED: '未处理'
    }[status] || status
  )
}
function reasonLabel(reason) {
  if (reason.startsWith('tone_run_holds_')) return '多个调值挤在同一数字串内，不能猜测音节边界'
  if (reason.startsWith('superscript_untypeable:')) return '当前项目字符键盘不支持所需上标'
  return (
    {
      tone_run_not_a_legal_value: '数字串不在所选合法集合中',
      placeholder_out_of_spec_length: '缺字登记号过长，无法判断边界',
      column_missing: '所选来源中缺少该字段，未回退其他值',
      non_text_value: '字段不是文本',
      invalid_source_row: '原始行结构损坏，未猜测字段',
      missing_syllable_context: '含裸数字或非记音编号，整格保持原值',
      tone_digits_without_phonetic_context: '含裸数字或非记音编号，整格保持原值',
      non_ascii_tone_digits: '含非 ASCII 调值数字，未猜测转换',
      mixed_tone_notation: '普通数字与上标混排，须人工核对',
      tone_only_requires_single_value: '仅调值字段含其他内容'
    }[reason] || '依据不足，保持原值；详细原因见下载报告'
  )
}
</script>
<style scoped>
.tone-batch {
  padding: var(--space-5);
  min-width: 0;
}
.tone-batch .section-heading p {
  max-width: 62em;
  color: var(--ink-muted);
  font-size: var(--text-sm);
}
.tone-config {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.tone-scope {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr;
  gap: var(--space-3);
}
.tone-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-height-touch);
  font-size: var(--text-sm);
  line-height: 1.6;
}
.tone-check input {
  flex: 0 0 auto;
}
.tone-column {
  border-top: 1px solid var(--line);
  padding: var(--space-3) 0;
}
.tone-column-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}
.tone-basis {
  grid-column: 1 / -1;
}
.tone-actions {
  display: flex;
  gap: var(--space-2);
  margin: var(--space-4) 0;
}
.tone-preview {
  border-top: 1px solid var(--line);
  margin-top: var(--space-5);
  padding-top: var(--space-4);
  min-width: 0;
}
.tone-preview :deep(.tone-preview-table td > small),
.tone-preview :deep(.tone-preview-table td > span) {
  display: block;
}
.tone-preview :deep(.tone-preview-table small) {
  color: var(--ink-muted);
  font-size: var(--text-sm);
}
.tone-scroll-hint {
  display: none;
}
.tone-preview :deep(.tone-preview-table) {
  width: 100%;
  min-width: 760px;
  table-layout: fixed;
}
.tone-preview :deep(.tone-preview-table th:first-child) {
  width: 18%;
}
.tone-preview :deep(.tone-preview-table th:last-child) {
  width: 30%;
}
.tone-preview :deep(.tone-value) {
  display: block;
  min-width: 130px;
  max-width: 32em;
  max-height: 12em;
  overflow: auto;
  font-size: var(--text-entry);
}
@media (max-width: 640px) {
  .tone-scroll-hint {
    display: block;
  }
  .tone-batch {
    padding: var(--space-4);
  }
  .tone-scope,
  .tone-column-fields {
    grid-template-columns: minmax(0, 1fr);
  }
  .tone-preview .section-heading {
    flex-wrap: wrap;
  }
}
</style>
