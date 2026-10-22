<template>
  <h1 class="sr-only">{{ verificationMode ? '来源核验' : '条目仲裁' }}</h1>
  <DocumentReviewWorkspace
    :page="casePage"
    :keyboard-available="keyboardAvailable"
    :suspended="(mobile && overview) || reviewingSubmission"
    :loading="loading"
    :watermark-user-id="currentUserId"
    :return-to="`/admin/projects/${projectId}?status=arbitration`"
    return-label="返回列表"
    content-labelled-by="arbitration-panel-title"
    empty-pdf-description="请保存进度并处理来源问题，待来源 PDF 可用后继续核验。"
  >
    <template #panel-header>
      <header class="editor-panel-header editor-panel-header--task">
        <div class="editor-context">
          <span>{{ verificationMode ? '管理员来源核验' : '管理员仲裁台' }} · 第 {{ casePage?.proofread_round || '—' }} 轮</span>
          <strong id="arbitration-panel-title">第 {{ casePage?.page_number || '—' }} 条</strong>
        </div>
        <div class="editor-toolbar">
          <RouterLink v-if="mobile" :to="`/admin/projects/${projectId}?status=arbitration`" class="btn btn-quiet">返回列表</RouterLink>
          <span v-if="casePage" class="task-position">{{ resolvedCount }} / {{ differingHeaders.length }} 项差异</span>
          <button
            class="btn btn-success btn-sm"
            :disabled="submitting || loading || unresolvedHeaders.length > 0 || !caseData"
            @click="openSubmitReview"
          >{{ submitting ? '保存中…' : verificationMode ? '检查并完成核验' : '检查并完成仲裁' }}</button>
        </div>
      </header>
    </template>

    <template #default="{ inputMode }">
    <div v-if="loading" class="panel-loading" aria-live="polite">正在加载校对结果与原文…</div>
    <div v-else-if="error" class="alert alert-error" role="alert">{{ error }}</div>

    <template v-else-if="caseData">
      <section v-if="verificationData" class="alert" role="note">
        <strong>来源 PDF：{{ verificationData.context.source?.name || '未记录' }} · 物理第 {{ verificationData.context.pdf_page }} 页</strong>
        <p>{{ verificationData.context.policy?.instructions || '逐字段对照固定来源 PDF；约定版本尚未记录。' }}</p>
        <p>约定版本：{{ verificationData.context.policy_id || '旧版／未记录' }}。采用最终值不代表其他合法提交错误；未核实字段不自动记为正确。</p>
        <p v-if="verificationData.completion?.needs_review">来源或约定已变化，旧判断需要复核。</p>
      </section>
      <p v-if="progressMessage" class="alert alert-success" role="status">{{ progressMessage }}</p>
      <section class="arbitration-summary" aria-label="仲裁进度">
        <div>
          <div class="page-eyebrow">差异确认</div>
          <strong>{{ resolvedCount }} / {{ differingHeaders.length }}</strong>
          <span>个不一致字段已明确处理</span>
        </div>
        <div class="arbitration-progress">
          <div class="progress" role="progressbar" aria-label="仲裁差异确认进度" :aria-valuenow="resolutionPct" aria-valuemin="0" aria-valuemax="100">
            <div class="progress-bar" :style="{ width: `${resolutionPct}%` }"></div>
          </div>
          <p v-if="unresolvedHeaders.length">还需确认：{{ unresolvedHeaders.join('、') }}</p>
          <p v-else>所有差异字段均已确认，可以检查说明并提交。</p>
        </div>
      </section>

      <RareCharacterNotice :texts="[...Object.values(originalRow), ...Object.values(finalRow), ...attemptRows.flatMap(item => Object.values(item.row))]" />

      <section class="arbitration-workspace">
        <header class="arbitration-toolbar">
          <div>
            <h2>校对结果对比</h2>
            <p>对照 PDF，采用任一版本或直接编辑最终内容。</p>
          </div>
          <div class="arbitration-toolbar__view" role="group" aria-label="字段显示范围">
            <button type="button" :class="{ active: !showAllFields }" :aria-pressed="!showAllFields" @click="showAllFields = false">
              仅看差异 {{ differingHeaders.length }}
            </button>
            <button type="button" :class="{ active: showAllFields }" :aria-pressed="showAllFields" @click="showAllFields = true">
              全部字段 {{ headers.length }}
            </button>
          </div>
        </header>

        <details :open="!mobile" class="bulk-actions-menu"><summary>批量处理</summary>
        <div v-if="differingHeaders.length" class="bulk-source-actions" aria-label="批量采用来源">
          <span>批量处理差异项</span>
          <button type="button" class="btn btn-secondary btn-sm" @click="applySourceToDifferences('original')">全部采用导入值</button>
          <button
            v-for="item in attemptRows"
            :key="`bulk-${item.key}`"
            type="button"
            class="btn btn-secondary btn-sm"
            @click="applySourceToDifferences(item.key)"
          >全部采用{{ item.label }}</button>
        </div>

        </details>
        <div v-if="visibleHeaders.length" class="arbitration-fields">
          <article
            v-for="header in visibleHeaders"
            :key="header"
            class="arbitration-field"
            v-show="!mobile || overview || currentField === header"
            :class="{
              'arbitration-field--resolved': isResolved(header),
              'arbitration-field--matching': !differs(header)
            }"
          >
            <header class="arbitration-field__header">
              <button v-if="mobile && overview" class="btn btn-secondary" @click="selectField(visibleHeaders.indexOf(header))">修改此字段</button>
              <h3>{{ header }}</h3>
              <span v-if="!differs(header)" class="resolution-state resolution-state--matching">结果一致</span>
              <span v-else-if="isResolved(header)" class="resolution-state resolution-state--resolved">已确认 · {{ resolutionLabel(header) }}</span>
              <span v-else class="resolution-state resolution-state--pending">待确认</span>
            </header>

            <div class="arbitration-source-grid">
              <section class="comparison-option" :class="{ selected: sourceIs(header, 'original') }">
                <span>导入文本</span>
                <p>{{ displayValue(originalRow[header]) }}</p>
                <button type="button" @click="pickValue(header, 'original')">采用导入值</button>
              </section>
              <section
                v-for="item in attemptRows"
                :key="`${header}-${item.key}`"
                class="comparison-option"
                :class="{ selected: sourceIs(header, item.key) }"
              >
                <span>{{ item.label }}</span>
                <p>{{ displayValue(item.row[header]) }}</p>
                <button type="button" @click="pickValue(header, item.key)">采用此结果</button>
                <SourceJudgmentInput v-if="verificationData" :disabled="submitting" :label="item.label" :model-value="judgmentFor(item.attempt.id, header)" @update:model-value="setJudgment(item.attempt.id, header, $event)" />
              </section>
              <div class="final-value" :class="{ selected: sourceIs(header, 'custom') }">
                <span>最终结果</span>
                <textarea
                :inputmode="inputMode"
                :readonly="submitting || (mobile && overview)"
                  :ref="(element) => setTextareaRef(header, element)"
                  v-model="finalRow[header]"
                  class="form-control"
                  :aria-label="`${header}的最终仲裁结果`"
                  @focus="rememberSelection(header, $event)"
                  @blur="rememberSelection(header, $event)"
                @select="rememberSelection(header, $event)"
                  @keyup="rememberSelection(header, $event)"
                  @click="rememberSelection(header, $event)"
                  @input="onFinalInput(header)"
                ></textarea>
                <SourceJudgmentInput v-if="verificationData" :disabled="submitting" label="最终采用值" :model-value="judgmentFor('final', header)" @update:model-value="setJudgment('final', header, $event)" />
              </div>
            </div>
          </article>
        </div>

        <div v-else class="empty-state">
          <div class="empty-state-mark" aria-hidden="true">同</div>
          <div class="empty-state-text">所有校对结果一致</div>
          <p>可切换到“全部字段”并结合原文复核。</p>
        </div>
      </section>


      <section v-show="!mobile || overview" class="arbitration-submit-card">
        <div class="flex gap-2">
          <button class="btn btn-secondary" :disabled="submitting" @click="saveProgress(false)">保存判断与进度</button>
          <button class="btn btn-secondary" :disabled="submitting" @click="saveProgress(true)">暂缓本条完成</button>
        </div>
        <div class="form-group">
          <label class="form-label" for="arbitration-note">仲裁说明 <span class="text-muted">（可选）</span></label>
          <textarea
            id="arbitration-note"
            v-model="note"
            class="form-control"
            maxlength="4000"
            placeholder="记录选择依据、疑难点或需要后续统一的校对规范"
          ></textarea>
        </div>
        <div v-if="submitError" class="alert alert-error" role="alert">{{ submitError }}</div>
        <div class="arbitration-submit-actions">
          <p>
            <strong v-if="unresolvedHeaders.length">还有 {{ unresolvedHeaders.length }} 个差异字段未确认</strong>
            <strong v-else>最终结果已准备好</strong>
            <span>提交后将完成条目，并永久保留全部校对结果与本次仲裁记录。</span>
          </p>
          <button
            class="btn btn-success"
            :disabled="submitting || unresolvedHeaders.length > 0"
            :title="unresolvedHeaders.length ? '请先确认所有差异字段' : ''"
            @click="openSubmitReview"
          >{{ submitting ? '保存中…' : verificationMode ? '检查并完成核验' : '检查并完成仲裁' }}</button>
        </div>
        <details v-if="verificationData?.history?.length" class="mt-3"><summary>处理与判断历史（{{ verificationData.history.length }}）</summary>
          <ul><li v-for="event in verificationData.history" :key="event.id">{{ event.at }} · {{ event.field || '本条' }} · {{ historyLabel(event) }} · {{ historyReason(event) }}<span v-if="event.payload.value !== undefined"> · 当时值：{{ displayValue(event.payload.value) }}</span></li></ul>
        </details>
      </section>
    </template>
    </template>
    <template #navigation><FieldNavigation :headers="visibleHeaders" :index="fieldIndex" :overview="overview" @select="selectField" @next="nextField">
      <template #submit><button class="btn btn-success" @click="openSubmitReview">检查并提交</button></template>
    </FieldNavigation></template>
    <template #keyboard><ProjectKeyboard v-if="casePage" :project-id="casePage.project" @availability="keyboardAvailable = $event" @insert="insertText" /></template>
  </DocumentReviewWorkspace>

  <AppModal
    :open="reviewingSubmission"
    title-id="arbitration-review-title"
    mark="裁"
    @close="closeSubmitReview"
  >
    <div class="page-eyebrow">最终确认</div>
    <h2 id="arbitration-review-title">完成第 {{ casePage?.page_number }} 条{{ verificationMode ? '来源核验' : '仲裁' }}？</h2>
    <p>已确认 {{ differingHeaders.length }} 个差异字段，其中 {{ sourceCount('custom') }} 个经过手工编辑。</p>
    <label class="form-label"><input v-model="reviewSourceChecked" type="checkbox"> 我已逐字段对照本条当前来源 PDF（依据变更时必须重新确认）</label>
    <p class="text-sm text-muted">提交后条目进入“校对完成”，该操作不能在当前界面撤回。</p>
    <template #actions>
      <button type="button" class="btn btn-secondary" @click="closeSubmitReview">继续检查</button>
      <button autofocus type="button" class="btn btn-success" :disabled="submitting" @click="submitFinal">
        {{ submitting ? '正在保存…' : verificationMode ? '确认完成核验' : '确认完成仲裁' }}
      </button>
    </template>
  </AppModal>
</template>

<script setup>
import AppModal from '@/components/AppModal.vue'
import RareCharacterNotice from '@/components/editor/RareCharacterNotice.vue'
import SourceJudgmentInput from '@/components/editor/SourceJudgmentInput.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import DocumentReviewWorkspace from '@/components/editor/DocumentReviewWorkspace.vue'
import FieldNavigation from '@/components/editor/FieldNavigation.vue'
import { useFieldNavigation } from '@/composables/useFieldNavigation'
import ProjectKeyboard from '@/components/editor/ProjectKeyboard.vue'
import { composeRowText, safeParseRowJson } from '@/composables/useStructuredRow'
import { getDifferingHeadersForRows, getUnresolvedHeaders } from '@/lib/workspaceInsights'
import { currentUserId as getCurrentUserId } from '@/services/authService'
import { getArbitrationCase, submitArbitration } from '@/services/arbitrationService'
import { getVerification, saveSourceJudgments } from '@/services/verificationService'
import { getPbMessage } from '@/utils/pbErrors'

const route = useRoute()
const router = useRouter()
const projectId = String(route.params.projectId || '')
const pageId = String(route.params.pageId || '')
const verificationMode = computed(() => caseData.value?.mode === 'verification' || route.query.mode === 'verification')
const verificationData = ref(null)
const judgmentDrafts = reactive({})
const progressMessage = ref('')
const reviewSourceChecked = ref(false)

const loading = ref(true)
const error = ref('')
const submitting = ref(false)
const submitError = ref('')
const submitted = ref(false)
const reviewingSubmission = ref(false)
const showAllFields = ref(false)
const caseData = ref(null)
const attemptRows = ref([])
const originalRow = reactive({})
const finalRow = reactive({})
const resolutionSource = reactive({})
const resolvedHeaders = reactive(new Set())
const touchedHeaders = reactive(new Set())
const note = ref('')
const lastSavedNote = ref('')
const activeSelection = ref({ field: '', start: null, end: null })
const textareaRefs = new Map()

const currentUserId = computed(() => getCurrentUserId() || '')
const casePage = computed(() => caseData.value?.page || null)
const headers = computed(() => [...new Set([
  ...Object.keys(originalRow),
  ...attemptRows.value.flatMap((item) => Object.keys(item.row))
])])
const differingHeaders = computed(() => getDifferingHeadersForRows(
  headers.value,
  attemptRows.value.map((item) => item.row),
  verificationData.value?.context.policy
))
const visibleHeaders = computed(() => showAllFields.value ? headers.value : differingHeaders.value)
const unresolvedHeaders = computed(() => getUnresolvedHeaders(differingHeaders.value, resolvedHeaders))
const resolvedCount = computed(() => differingHeaders.value.length - unresolvedHeaders.value.length)
const resolutionPct = computed(() => differingHeaders.value.length
  ? Math.round((resolvedCount.value / differingHeaders.value.length) * 100)
  : 100)
const hasUnsubmittedWork = computed(() => !submitted.value && (touchedHeaders.size > 0 || note.value !== lastSavedNote.value || Object.values(judgmentDrafts).some(item => item.dirty)))

onMounted(() => {
  window.addEventListener('beforeunload', handleBeforeUnload)
  loadCase()
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
})

onBeforeRouteLeave(() => {
  if (!hasUnsubmittedWork.value || submitting.value) return true
  return window.confirm('仲裁选择尚未提交，确定离开吗？')
})

async function loadCase() {
  loading.value = true
  error.value = ''
  try {
    const results = await Promise.allSettled([getArbitrationCase(pageId, route.query.mode === 'verification' ? 'verification' : ''), getVerification(pageId)])
    for (const result of results) if (result.status === 'rejected') throw result.reason
    const [result, verification] = results.map(result => result.value)
    verificationData.value = verification
    if (result?.page?.project && projectId && result.page.project !== projectId) {
      throw new Error('仲裁条目与当前项目不匹配，请返回项目详情页后重新进入。')
    }
    caseData.value = result
    Object.assign(originalRow, safeParseRowJson(result.page?.ocr_row_json) || { 内容: result.page?.ocr_text || '' })
    attemptRows.value = (result.attempts || [])
      .filter((attempt) => attempt.kind !== 'arbitration')
      .sort((left, right) => Number(left.pass_no) - Number(right.pass_no))
      .map((attempt, index) => ({
        attempt,
        key: `attempt:${attempt.id || index}`,
        label: attempt.proofreader_name || `校对结果 ${index + 1}`,
        row: safeParseRowJson(attempt.row_json) || {}
      }))

    for (const header of headers.value) {
      finalRow[header] = (result.mode === 'verification' ? safeParseRowJson(result.page.proofread_row_json)?.[header] : undefined) ?? attemptRows.value[0]?.row?.[header] ?? originalRow[header] ?? ''
      if (!differingHeaders.value.includes(header)) resolutionSource[header] = 'matching'
      if (result.mode === 'verification') { resolutionSource[header] = 'existing_final'; resolvedHeaders.add(header) }
    }
    const progress = [...(verification.history || [])].reverse().find(event => event.kind === 'review_progress' && event.context.basis === verification.context.basis)
    if (progress && result.mode === 'arbitration') {
      Object.assign(finalRow, progress.payload.row)
      Object.assign(resolutionSource, progress.payload.selections || {})
      for (const header of differingHeaders.value) if (resolutionSource[header]) resolvedHeaders.add(header)
      note.value = progress.payload.note || ''
      lastSavedNote.value = note.value
    }
    showAllFields.value = true
    for (const field of headers.value) for (const target of ['final', ...attemptRows.value.map(item => item.attempt.id)]) judgmentFor(target, field)
  } catch (e) {
    error.value = getPbMessage(e, '加载仲裁材料失败')
  } finally {
    loading.value = false
  }
}

function differs(header) {
  return differingHeaders.value.includes(header)
}

function displayValue(value) {
  return String(value ?? '') || '（空白）'
}
function historyLabel(event) {
  const states = { correct: '判为正确', incorrect: '判为错误', pending: '待核实', withdrawn: '已撤回判断' }
  const kinds = { submission: '校对提交', field_action: '字段处理', judgment: '来源判断', review_progress: '保存核验进度', review_completed: '完成核验', machine_analysis: '机器提示分析', source_input_changed: '来源或导入值变更', final_adoption: '最终采用', report_created: '提交问题', report_moved: '报告关联变更', draft_superseded: '保留旧版草稿', verified_final_updated: '更新最终采用值', empty_source: '空记录处理', research_event: '研究过程', research_submission: '研究提交' }
  return states[event.payload.state] || kinds[event.kind] || '历史记录'
}
function historyReason(event) {
  const reason = event.payload.reason || event.payload.note || ''
  return { source_checked: '已对照来源', source_blank: '来源无内容，保留空白', source_content: '按来源补抄／修正', legal_notation: '保留合法声调形式', reported: '已提交问题' }[reason] || reason
}

function isResolved(header) {
  return !differs(header) || resolvedHeaders.has(header)
}

function sourceIs(header, source) {
  return resolutionSource[header] === source
}

function sourceLabel(source) {
  if (source === 'original') return '采用导入值'
  if (source === 'custom') return '手工编辑'
  if (source === 'existing_final') return '当前已保存的最终值'
  const item = attemptRows.value.find((candidate) => candidate.key === source)
  return item ? `采用${item.label}` : '已确认'
}

function resolutionLabel(header) {
  return sourceLabel(resolutionSource[header])
}

function sourceValue(header, source) {
  if (source === 'original') return originalRow[header]
  return attemptRows.value.find((item) => item.key === source)?.row?.[header]
}

function pickValue(header, source) {
  if (submitting.value) return
  finalRow[header] = String(sourceValue(header, source) ?? '')
  resolutionSource[header] = source
  touchedHeaders.add(header)
  if (differs(header)) resolvedHeaders.add(header)
  submitError.value = ''
  resetFinalJudgment(header)
}

function judgmentFor(target, field) {
  const key = `${target}\u0000${field}`
  if (!judgmentDrafts[key]) {
    const previous = verificationData.value?.judgments?.find(event => event.ref === target && event.field === field)
    judgmentDrafts[key] = {
      state: previous && !previous.stale ? previous.payload.state : '',
      reason: previous && !previous.stale ? previous.payload.reason : '',
      location: previous?.payload.location || `PDF 物理第 ${verificationData.value?.context.pdf_page || '—'} 页，${field}`,
      replaces: previous?.id || '', stale: previous?.stale || false, value: previous?.payload.value, dirty: false
    }
  }
  return judgmentDrafts[key]
}
function setJudgment(target, field, value) { judgmentDrafts[`${target}\u0000${field}`] = value }
function resetFinalJudgment(field) {
  const item = judgmentFor('final', field)
  if (item.state && item.value !== finalRow[field]) {
    item.state = ''; item.reason = ''; item.stale = true; item.dirty = false
  }
}
function judgmentPayload() {
  return Object.entries(judgmentDrafts).filter(([, item]) => item.dirty && item.state).map(([key, item]) => {
    const [attempt, field] = key.split('\u0000')
    return { attempt, field, state: item.state, reason: item.reason, location: item.location, replaces: item.replaces }
  })
}
async function saveProgress(defer) {
  if (submitting.value || !verificationData.value) return
  submitting.value = true; submitError.value = ''; progressMessage.value = ''
  try {
    const result = await saveSourceJudgments(pageId, { basis: verificationData.value.context.basis, row: { ...finalRow }, judgments: judgmentPayload(), note: note.value, selections: { ...resolutionSource }, defer })
    for (const event of result.judgments) {
      judgmentDrafts[`${event.ref}\u0000${event.field}`] = { state: event.payload.state, reason: event.payload.reason, location: event.payload.location, value: event.payload.value, replaces: event.id, dirty: false, stale: false }
    }
    verificationData.value = await getVerification(pageId)
    touchedHeaders.clear()
    lastSavedNote.value = note.value
    progressMessage.value = defer ? '进度已保存，本条暂缓完成；不会混入业务已完成结果。' : '已保存实际判断及进度；未核实字段仍保持未记录。'
  } catch (e) { submitError.value = getPbMessage(e, '保存判断失败') }
  finally { submitting.value = false }
}

function onFinalInput(header) {
  resolutionSource[header] = 'custom'
  touchedHeaders.add(header)
  if (differs(header)) resolvedHeaders.add(header)
  submitError.value = ''
  resetFinalJudgment(header)
}

function applySourceToDifferences(source) {
  for (const header of differingHeaders.value) pickValue(header, source)
}

function sourceCount(source) {
  return differingHeaders.value.filter((header) => resolutionSource[header] === source).length
}

function setTextareaRef(header, element) {
  if (element) textareaRefs.set(header, element)
  else textareaRefs.delete(header)
}

const keyboardAvailable = ref(false)
const { index: fieldIndex, overview, mobile, current: currentField, select: selectField, next: nextField } = useFieldNavigation(visibleHeaders, () => casePage.value?.id)
const fieldSelections = new Map()
watch(() => casePage.value?.id, () => { fieldSelections.clear(); keyboardAvailable.value = false })
watch([currentField, mobile], ([field]) => {
  if (field) activeSelection.value = fieldSelections.get(field) || { field, start: null, end: null }
})

function rememberSelection(header, event) {
  const target = event?.target
  const selection = {
    field: header,
    start: Number.isInteger(target?.selectionStart) ? target.selectionStart : null,
    end: Number.isInteger(target?.selectionEnd) ? target.selectionEnd : null
  }
  fieldSelections.set(header, selection)
  if (mobile.value && header !== currentField.value) return
  activeSelection.value = selection
  if (!mobile.value) {
    const index = visibleHeaders.value.indexOf(header)
    if (index >= 0) selectField(index)
  }
}

async function insertText(text) {
  if (submitting.value) return
  if (mobile.value && overview.value) return
  const header = mobile.value ? currentField.value : activeSelection.value.field || visibleHeaders.value[0] || headers.value[0]
  if (!header) return
  const current = String(finalRow[header] ?? '')
  const selection = activeSelection.value.field === header
    ? activeSelection.value
    : fieldSelections.get(header) || {}
  const start = Number.isInteger(selection.start) ? selection.start : current.length
  const end = Number.isInteger(selection.end) ? selection.end : start
  finalRow[header] = `${current.slice(0, start)}${text}${current.slice(end)}`
  onFinalInput(header)
  const cursor = start + text.length
  await nextTick()
  const target = textareaRefs.get(header)
  target?.focus({ preventScroll: true })
  if (mobile.value) target?.scrollIntoView({ block: 'nearest' })
  target?.setSelectionRange(cursor, cursor)
  activeSelection.value = { field: header, start: cursor, end: cursor }
  fieldSelections.set(header, { ...activeSelection.value })
}

function openSubmitReview() {
  if (mobile.value && !overview.value) { overview.value = true; return }
  if (unresolvedHeaders.value.length || submitting.value) {
    submitError.value = unresolvedHeaders.value.length
      ? `请先确认以下差异字段：${unresolvedHeaders.value.join('、')}`
      : ''
    return
  }
  submitError.value = ''
  reviewingSubmission.value = true
}

function closeSubmitReview() {
  if (submitting.value) return
  reviewingSubmission.value = false
}

function handleBeforeUnload(event) {
  if (!hasUnsubmittedWork.value || submitting.value) return
  event.preventDefault()
  event.returnValue = ''
}

async function submitFinal() {
  if (submitting.value || unresolvedHeaders.value.length) return
  submitting.value = true
  submitError.value = ''
  try {
    const body = {
      rowJson: JSON.stringify(finalRow),
      text: composeRowText(headers.value, finalRow),
      row: { ...finalRow }, note: note.value, basis: verificationData.value.context.basis,
      sourceChecked: reviewSourceChecked.value,
      judgments: judgmentPayload(), selections: { ...resolutionSource }
    }
    if (verificationMode.value) await saveSourceJudgments(pageId, { ...body, complete: true, adoptFinal: casePage.value.status === 'approved' })
    else await submitArbitration(pageId, body)
    submitted.value = true
    reviewingSubmission.value = false
    await router.push(verificationMode.value ? `/admin/projects/${projectId}/verification` : `/admin/projects/${projectId}?status=arbitration&arbitrated=1`)
  } catch (e) {
    reviewingSubmission.value = false
    submitError.value = getPbMessage(e, '仲裁提交失败')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.arbitration-summary { margin-bottom: 1rem; padding: 1rem; border: 1px solid var(--gray-200); border-radius: var(--radius); background: var(--surface); }
.arbitration-workspace { overflow: hidden; border: 1px solid var(--gray-200); border-radius: var(--radius); background: var(--surface); }
.arbitration-source-grid { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.arbitration-source-grid > .final-value { grid-column: 1 / -1; }
.arbitration-submit-card { margin-top: 1rem; padding: 1rem; border: 1px solid var(--gray-200); border-radius: var(--radius); background: var(--surface); }

@media (max-width: 640px) {
  .arbitration-source-grid { grid-template-columns: 1fr; }
}
</style>
