<template>
  <main class="container page">
    <RouterLink :to="`/admin/projects/${projectId}`" class="back-link">← 返回项目</RouterLink>
    <h1>用途编选（D 工序）</h1>
    <p>
      按这一批交付的用途圈定范围：先选接收方与筛选规则、看数量，人工只处理少数例外，再确认本批范围。
      这里的「编选」是整批交付取舍，不是仲裁台里选哪一份校对结果的「采用」；B
      的校对成果与状态不会因为编选而改变。
    </p>
    <AppStatusPanel v-if="loading && !loaded" state="pending" message="正在加载编选批次…" />
    <AppStatusPanel
      v-if="loadError && !loaded"
      state="error"
      :message="loadError"
      retry-label="重试"
      :busy="loading"
      @retry="load()"
    />
    <div v-if="operationError" class="alert alert-error" role="alert">{{ operationError }}</div>
    <p v-if="message" class="alert alert-success" role="status">{{ message }}</p>

    <template v-if="loaded">
      <section class="card mb-4">
        <h2>新建编选批次</h2>
        <p>
          规则会在创建时固定下来，之后只能新开一批。用途结论不是「允许」的来源不会被任何规则放行——
          权利是硬边界，未知按未决定处理。
        </p>
        <form @submit.prevent="create">
          <div class="adoption-form-grid">
            <AppField layout="plain"
              ><template #label>用途 </template
              ><select v-model="createForm.purpose" class="form-control" required>
                <option v-for="code in purposes" :key="code" :value="code">
                  {{ purposeLabel(code) }}
                </option>
              </select>
            </AppField>
            <AppField layout="plain"
              ><template #label>接收方 </template
              ><input
                v-model="createForm.recipient"
                class="form-control"
                maxlength="120"
                required
                placeholder="例如：乡声集盒春节版"
              />
            </AppField>
          </div>
          <fieldset class="adoption-fieldset">
            <legend>校对状态</legend>
            <label v-for="code in pageStatuses" :key="code" class="adoption-check">
              <input v-model="createForm.statuses" type="checkbox" :value="code" />
              {{ statusLabel(code) }}
            </label>
          </fieldset>
          <fieldset class="adoption-fieldset">
            <legend>质量状态（不勾＝不看这一维）</legend>
            <label v-for="code in qualityStates" :key="code" class="adoption-check">
              <input v-model="createForm.qualityStates" type="checkbox" :value="code" />
              {{ qualityStateLabel(code) }}
            </label>
          </fieldset>
          <label class="adoption-check">
            <input v-model="createForm.requirePinyin" type="checkbox" /> 要求拼音已定稿（EXACT /
            REVIEWED）
          </label>
          <AppField layout="plain"
            ><template #label>只在这些导入批次里选（可选） </template
            ><input
              v-model="createForm.importJobsText"
              class="form-control"
              placeholder="15 位批次 id，逗号分隔；留空表示整个项目"
            />
          </AppField>
          <AppField layout="plain"
            ><template #label>说明（可选） </template
            ><textarea
              v-model="createForm.note"
              class="form-control"
              maxlength="500"
              rows="2"
            ></textarea>
          </AppField>
          <button class="btn btn-primary mt-3" :disabled="busy || loading">创建并预览数量</button>
        </form>
      </section>

      <section v-if="current" class="card mb-4">
        <header class="adoption-batch-head">
          <h2>当前批次</h2>
          <span class="badge">{{ batchStatusLabel(current.status) }}</span>
        </header>
        <p>
          {{ purposeLabel(current.purpose) }} · 交给 {{ current.recipient }} · 规则：{{
            ruleSummary(current.rule)
          }}
        </p>
        <p v-if="current.note">{{ current.note }}</p>

        <div class="adoption-counts">
          <div class="adoption-count">
            <span class="adoption-count-value">{{ counts.total }}</span
            ><span>本批条目</span>
          </div>
          <div class="adoption-count">
            <span class="adoption-count-value">{{ counts.selected }}</span
            ><span>进入本批</span>
          </div>
          <div class="adoption-count">
            <span class="adoption-count-value">{{ counts.excluded }}</span
            ><span>已定不进入</span>
          </div>
          <div class="adoption-count">
            <span class="adoption-count-value">{{ counts.pending }}</span
            ><span>待处理（规则判不了）</span>
          </div>
        </div>
        <p v-if="!consistent" class="alert alert-warning" role="alert">
          三个数之和对不上总数，界面不照抄：请重新预览；若仍不一致，说明数据被绕过接口改过。
        </p>
        <p v-else-if="counts.pending > 0" class="alert alert-warning" role="alert">
          还有 {{ counts.pending }} 条待处理。确认后导出的清单会写明
          <code>complete: false</code>，不会把部分结果冒充全量。
        </p>
        <p v-if="batchEvents.stale" class="alert alert-warning" role="alert">
          这一批确认之后，来源的用途权利变过。采用范围可能需要重评——重评只会追加一条记录，
          不会改写确认时的数字。
        </p>

        <div v-if="current.reasons.length" class="mt-3">
          <h3 class="adoption-subhead">未进入本批的理由分布</h3>
          <ul class="adoption-reasons">
            <li v-for="item in current.reasons" :key="item.code">
              {{ reasonLabel(item.code) }} · {{ item.count }} 条
            </li>
          </ul>
        </div>

        <div class="adoption-actions">
          <button
            class="btn btn-secondary"
            :disabled="busy || loading || current.status === 'confirmed'"
            @click="preview"
          >
            重新预览数量
          </button>
          <button
            class="btn btn-primary"
            :disabled="busy || loading || current.status !== 'previewed'"
            @click="confirm"
          >
            确认本批采用范围
          </button>
          <button class="btn btn-secondary" :disabled="busy || loading" @click="reevaluate">
            按当前数据重新评估
          </button>
          <button
            class="btn btn-secondary"
            :disabled="busy || loading"
            @click="exportManifest('select')"
          >
            导出本批清单
          </button>
          <button class="btn btn-quiet" :disabled="busy || loading" @click="exportManifest('all')">
            导出全部条目（需平台管理员）
          </button>
          <button
            v-if="current.status !== 'confirmed'"
            class="btn btn-quiet"
            :disabled="busy || loading"
            @click="remove"
          >
            删除这一批
          </button>
        </div>
        <p class="adoption-hint">
          导出默认只含进入本批的条目；未采用与待处理的数量写在清单的 <code>omitted</code> 里。
        </p>
        <details v-if="batchEvents.events.length" class="mt-3">
          <summary>这一批的事件（{{ batchEvents.events.length }}）</summary>
          <ul class="adoption-reasons">
            <li v-for="item in batchEvents.events" :key="item.id">
              {{ eventKindLabel(item.kind) }} · {{ item.created }}
              <span v-if="item.affected"> · 涉及 {{ item.affected }} 条</span>
              <div>{{ item.note }}</div>
              <div v-if="item.stored" class="adoption-hint">
                确认时 {{ item.stored.selected }}/{{ item.stored.total }} → 重评时
                {{ item.current.selected }}/{{ item.current.total }}
              </div>
            </li>
          </ul>
        </details>
      </section>

      <section v-if="current" class="card mb-4">
        <h2>例外（人工只处理规则判不了的那些）</h2>
        <p v-if="exceptions.pendingTotal">
          {{ exceptions.pendingTotal }} 条待处理。下面是其中前 {{ exceptions.pending.length }} 条：
          给结论、选理由、写依据，三样都留痕。改动例外会把批次退回草稿，需要重新预览再确认。
        </p>
        <p v-else class="empty-state-text">没有待处理的例外。</p>
        <article v-for="item in exceptions.pending" :key="item.page" class="adoption-pending">
          <h3>第 {{ item.pageNumber }} 条 · {{ reasonLabel(item.reason) }}</h3>
          <div class="adoption-form-grid">
            <AppField layout="plain"
              ><template #label>结论 </template
              ><select v-model="draftFor(item.page).decision" class="form-control">
                <option value="select">{{ DECISION_LABELS.select }}</option>
                <option value="exclude">{{ DECISION_LABELS.exclude }}</option>
              </select>
            </AppField>
            <AppField v-if="draftFor(item.page).decision === 'exclude'" layout="plain"
              ><template #label>理由 </template
              ><select v-model="draftFor(item.page).reason" class="form-control">
                <option value="">请选择理由</option>
                <option v-for="code in reasonCodes" :key="code" :value="code">
                  {{ reasonLabel(code) }}
                </option>
              </select>
            </AppField>
          </div>
          <AppField layout="plain"
            ><template #label>依据 </template
            ><input
              v-model="draftFor(item.page).note"
              class="form-control"
              maxlength="500"
              placeholder="写清为什么这样判，例如取得书面许可、缺字表已补齐"
            />
          </AppField>
          <button
            class="btn btn-secondary btn-sm mt-3"
            :disabled="busy || loading"
            @click="decide(item.page)"
          >
            保存这一条
          </button>
        </article>

        <details v-if="exceptions.exceptions.length" class="mt-3">
          <summary>已处理的例外（{{ exceptions.exceptions.length }}）</summary>
          <ul class="adoption-reasons">
            <li v-for="item in exceptions.exceptions" :key="item.page">
              {{ DECISION_LABELS[item.decision] || item.decision }}
              <span v-if="item.reason"> · {{ reasonLabel(item.reason) }}</span>
              · {{ item.note }} · {{ item.decidedAt }}
            </li>
          </ul>
        </details>
      </section>

      <section v-if="summary" class="card mb-4">
        <h2>度量</h2>
        <p>
          数字取各批确认时的值（那是交付依据）；「需重评」只表示确认之后用途权利变过，
          不等于已经改过范围。
        </p>
        <dl class="adoption-metrics">
          <div class="adoption-metric">
            <dt>批次</dt>
            <dd>{{ summary.batches.total }}</dd>
            <small
              >草稿 {{ summary.batches.byStatus.draft || 0 }} · 已预览
              {{ summary.batches.byStatus.previewed || 0 }} · 已确认
              {{ summary.batches.byStatus.confirmed || 0 }}</small
            >
          </div>
          <div class="adoption-metric">
            <dt>已确认范围</dt>
            <dd>{{ summary.confirmed.selected }}/{{ summary.confirmed.total }}</dd>
            <small>条进入本批；待处理 {{ summary.confirmed.pending }} 条</small>
          </div>
          <div class="adoption-metric">
            <dt>例外</dt>
            <dd>{{ summary.exceptions.decided }}</dd>
            <small>条已处理</small>
          </div>
          <div class="adoption-metric">
            <dt>需重评</dt>
            <dd>{{ summary.events.staleBatches }}</dd>
            <small
              >批在确认后遇到权利变更（另有 {{ summary.events.reevaluated }} 次重评记录）</small
            >
          </div>
        </dl>
        <p v-if="!summary.confirmed.complete" class="adoption-hint">
          有已确认批次仍带待处理条目：它们导出的清单里 <code>complete</code> 是 <code>false</code>。
        </p>
        <div v-if="summary.reasons.length" class="mt-3">
          <h3 class="adoption-subhead">已确认批次的排除理由分布</h3>
          <ul class="adoption-reasons">
            <li v-for="item in summary.reasons" :key="item.code">
              {{ reasonLabel(item.code) }} · {{ item.count }} 条
            </li>
          </ul>
        </div>
      </section>

      <section class="card" :aria-busy="loading">
        <h2>历史批次</h2>
        <AppStatusPanel v-if="loading" state="pending" message="正在加载历史批次…" />
        <div v-if="loadError" class="alert alert-error" role="alert">
          {{ loadError }}
          <button class="btn btn-secondary btn-sm" :disabled="loading" @click="load()">重试</button>
        </div>
        <AppStatusPanel
          v-if="!loading && !loadError && !batches.length"
          state="empty"
          reason="none"
          message="这个项目还没有编选批次。"
        />
        <ul class="adoption-history">
          <li
            v-for="item in batches"
            :key="item.id"
            :class="{ 'adoption-history-current': item.id === currentId }"
          >
            <button
              class="btn btn-quiet btn-sm"
              :disabled="busy || loading"
              @click="selectBatch(item.id)"
            >
              {{ purposeLabel(item.purpose) }} · {{ batchStatusLabel(item.status) }} ·
              {{ item.counts.selected }}/{{ item.counts.total }} 条进入本批
            </button>
            <span class="adoption-hint">交给 {{ item.recipient }} · {{ item.created }}</span>
          </li>
        </ul>
        <AppPagination
          :page="historyPage"
          :total-pages="historyTotalPages"
          :busy="busy || loading"
          label="编选历史分页"
          button-class="btn btn-secondary btn-sm"
          @change="load"
        >
          <template #position
            >第 {{ historyPage }} / {{ historyTotalPages }} 页 · 共
            {{ historyTotalItems }} 批</template
          >
        </AppPagination>
      </section>
    </template>
  </main>
</template>

<script setup>
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import AppPagination from '@/components/AppPagination.vue'
import { useAsyncResource } from '@/composables/useAsyncResource'
import AppField from '@/components/AppField.vue'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import {
  DECISION_LABELS,
  DEFAULT_STATUSES,
  PAGE_STATUS_LABELS,
  QUALITY_STATE_LABELS,
  batchStatusLabel,
  countsConsistent,
  eventKindLabel,
  includeLabel,
  manifestFilename,
  normalizeCounts,
  purposeLabel,
  qualityStateLabel,
  reasonLabel,
  ruleFromForm,
  ruleSummary,
  statusLabel
} from '@/lib/adoption'
import {
  confirmAdoptionBatch,
  createAdoptionBatch,
  deleteAdoptionBatch,
  exportAdoptionManifest,
  decideAdoptionException,
  getAdoptionSummary,
  listAdoptionBatches,
  listAdoptionEvents,
  listAdoptionExceptions,
  previewAdoptionBatch,
  reevaluateAdoptionBatch
} from '@/services/adoptionService'
import { downloadText } from '@/lib/downloadText'
import { getPbMessage } from '@/utils/pbErrors'

const route = useRoute()
const projectId = computed(() => String(route.params.id))
const pageStatuses = Object.keys(PAGE_STATUS_LABELS)
const qualityStates = Object.keys(QUALITY_STATE_LABELS)

const {
  pending: loadingBatches,
  error: batchError,
  reload: reloadBatches,
  cancel: cancelBatchLoad
} = useAsyncResource(
  async ({ signal }, id, page, selectedId) => {
    const data = await listAdoptionBatches(id, { page, perPage: 25, signal })
    const nextBatches = data.batches || []
    const nextId = nextBatches.some((item) => item.id === selectedId)
      ? selectedId
      : nextBatches[0]?.id || ''
    const [details, nextSummary] = await Promise.all([
      loadBatchDetails(nextId, signal),
      getAdoptionSummary(id, { signal })
    ])
    return { data, nextBatches, nextId, details, nextSummary }
  },
  { formatError: (cause) => getPbMessage(cause, '加载编选批次失败') }
)
const {
  pending: loadingDetails,
  error: detailsError,
  reload: reloadDetails,
  cancel: cancelDetails
} = useAsyncResource(({ signal }, id) => loadBatchDetails(id, signal), {
  formatError: (cause) => getPbMessage(cause, '加载批次详情失败')
})
const loading = computed(() => loadingBatches.value || loadingDetails.value)
const loadError = computed(() => batchError.value || detailsError.value)
const loaded = ref(false)
const busy = ref(false)
const operationError = ref('')
const message = ref('')

const batches = ref([])
const historyPage = ref(1)
const requestedHistoryPage = ref(1)
const historyTotalPages = ref(1)
const historyTotalItems = ref(0)
const purposes = ref([])
const reasonCodes = ref([])
const currentId = ref('')
const exceptions = ref({ exceptions: [], pending: [], pendingTotal: 0 })
const batchEvents = ref({ events: [], stale: false })
const summary = ref(null)
const decisionDrafts = reactive({})

const createForm = reactive({
  purpose: 'public_display',
  recipient: '',
  note: '',
  statuses: [...DEFAULT_STATUSES],
  qualityStates: [],
  requirePinyin: false,
  importJobsText: ''
})

const current = computed(() => batches.value.find((item) => item.id === currentId.value) || null)
const counts = computed(() => normalizeCounts(current.value?.counts))
const consistent = computed(() => countsConsistent(current.value?.counts))
const EMPTY_EXCEPTIONS = { exceptions: [], pending: [], pendingTotal: 0 }
const EMPTY_EVENTS = { events: [], stale: false }
let batchLoadGeneration = 0
let projectGeneration = 0

watch(projectId, resetProject, { immediate: true })
onBeforeUnmount(() => {
  ++batchLoadGeneration
  ++projectGeneration
})

function resetProject() {
  cancelBatchLoad()
  cancelDetails()
  ++batchLoadGeneration
  ++projectGeneration
  loaded.value = false
  busy.value = false
  batches.value = []
  currentId.value = ''
  historyPage.value = requestedHistoryPage.value = 1
  historyTotalPages.value = 1
  historyTotalItems.value = 0
  exceptions.value = { ...EMPTY_EXCEPTIONS }
  batchEvents.value = { ...EMPTY_EVENTS }
  summary.value = null
  operationError.value = message.value = ''
  for (const key of Object.keys(decisionDrafts)) delete decisionDrafts[key]
  Object.assign(createForm, {
    purpose: 'public_display',
    recipient: '',
    note: '',
    statuses: [...DEFAULT_STATUSES],
    qualityStates: [],
    requirePinyin: false,
    importJobsText: ''
  })
  return load(1)
}

async function load(page = requestedHistoryPage.value) {
  ++batchLoadGeneration
  cancelDetails()
  requestedHistoryPage.value = page
  const result = await reloadBatches(projectId.value, page, currentId.value)
  if (!result.ok) return
  const { data, nextBatches, nextId, details, nextSummary } = result.data
  // Commit history and details together; failed reload keeps drafts and the last page.
  batches.value = nextBatches
  currentId.value = nextId
  historyPage.value = requestedHistoryPage.value = data.page
  historyTotalPages.value = data.totalPages
  historyTotalItems.value = data.totalItems
  purposes.value = data.purposes || []
  reasonCodes.value = data.reasons || []
  summary.value = nextSummary
  applyBatchDetails(details)
  loaded.value = true
}

async function loadBatchDetails(batchId, signal) {
  if (!batchId) return { exceptions: { ...EMPTY_EXCEPTIONS }, events: { ...EMPTY_EVENTS } }
  const [exceptionsData, eventsData] = await Promise.all([
    listAdoptionExceptions(batchId, { signal }),
    listAdoptionEvents(batchId, { signal })
  ])
  return { exceptions: exceptionsData, events: eventsData }
}

function applyBatchDetails(details) {
  exceptions.value = details.exceptions || { ...EMPTY_EXCEPTIONS }
  batchEvents.value = details.events || { ...EMPTY_EVENTS }
  for (const item of exceptions.value.pending) draftFor(item.page)
}

function draftFor(pageId) {
  if (!decisionDrafts[pageId]) {
    decisionDrafts[pageId] = { decision: 'select', reason: '', note: '' }
  }
  return decisionDrafts[pageId]
}

async function act(fn, success) {
  const id = projectId.value
  const generation = projectGeneration
  const isCurrent = () => generation === projectGeneration
  busy.value = true
  operationError.value = ''
  message.value = ''
  try {
    await fn(id, isCurrent)
    if (!isCurrent()) return
    if (success) message.value = success
    await load()
  } catch (e) {
    if (!isCurrent()) return
    operationError.value = getPbMessage(e, '操作失败，请重试')
  } finally {
    if (isCurrent()) busy.value = false
  }
}

async function create() {
  const built = ruleFromForm(createForm)
  if (built.error) {
    operationError.value = built.error
    return
  }
  await act(async (id, isCurrent) => {
    const batch = await createAdoptionBatch(id, {
      purpose: createForm.purpose,
      recipient: createForm.recipient.trim(),
      note: createForm.note.trim(),
      rule: built.rule
    })
    await previewAdoptionBatch(batch.id)
    if (!isCurrent()) return
    currentId.value = batch.id
    requestedHistoryPage.value = 1
    // 接收方保留：同一批交付常常要按不同用途连续开几条；说明是一次性的。
    createForm.note = ''
  }, '批次已创建并完成预览；核对数量后再确认。')
}

async function preview() {
  await act(() => previewAdoptionBatch(current.value.id), '已按当前数据重新计算。')
}

async function confirm() {
  await act(
    () => confirmAdoptionBatch(current.value.id),
    '已确认本批采用范围；导出与下游都以这份清单为准。'
  )
}

// 重评只追加一条事件，不改写确认时的数字：D5.3 的红线是「追加，不改历史」。
// 界面上必须把这件事说出来，否则「重新评估」会被读成「把这一批改了」。
async function reevaluate() {
  await act(async (_id, isCurrent) => {
    const result = await reevaluateAdoptionBatch(current.value.id)
    if (!isCurrent()) return
    message.value = result.drift
      ? `已追加重评记录：${result.stored.selected}/${result.stored.total} → ${result.current.selected}/${result.current.total}，差异在「${result.drift}」。已确认的数字没有改。`
      : `已追加重评记录：与确认时一致（${result.current.selected}/${result.current.total}）。`
  }, '')
}

async function remove() {
  const batchId = current.value.id
  await act(async (_id, isCurrent) => {
    await deleteAdoptionBatch(batchId)
    if (isCurrent()) currentId.value = ''
  }, '草稿已删除。')
}

async function exportManifest(include) {
  const generation = projectGeneration
  const batch = current.value
  busy.value = true
  operationError.value = ''
  message.value = ''
  try {
    const manifest = await exportAdoptionManifest(batch.id, include)
    if (generation !== projectGeneration) return
    downloadText(JSON.stringify(manifest, null, 2), manifestFilename(batch), 'application/json')
    message.value =
      include === 'select'
        ? includeLabel('select')
        : `${includeLabel('all')}；未采用与待处理的数量写在清单里。`
  } catch (e) {
    if (generation !== projectGeneration) return
    operationError.value = getPbMessage(e, '导出失败')
  } finally {
    if (generation === projectGeneration) busy.value = false
  }
}

async function decide(pageId) {
  const draft = draftFor(pageId)
  const note = draft.note.trim()
  if (!note) {
    operationError.value = '处理例外必须写明依据。'
    return
  }
  if (draft.decision === 'exclude' && !draft.reason) {
    operationError.value = '判为不进入本批时必须选一个理由。'
    return
  }
  await act(async () => {
    await decideAdoptionException(current.value.id, {
      page: pageId,
      decision: draft.decision,
      reason: draft.decision === 'exclude' ? draft.reason : '',
      note
    })
    delete decisionDrafts[pageId]
  }, '例外已记录；批次退回草稿，请重新预览再确认。')
}

async function selectBatch(id) {
  requestedHistoryPage.value = historyPage.value
  currentId.value = id
  const generation = ++batchLoadGeneration
  // Clear old details immediately: they must never appear under a new batch.
  exceptions.value = { ...EMPTY_EXCEPTIONS }
  batchEvents.value = { ...EMPTY_EVENTS }
  const result = await reloadDetails(id)
  if (!result.ok || generation !== batchLoadGeneration) return
  applyBatchDetails(result.data)
}
</script>

<style scoped>
.back-link {
  display: inline-block;
  margin-bottom: var(--space-3);
}
.adoption-form-grid {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}
.adoption-fieldset {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
  margin: var(--space-3) 0;
}
.adoption-check {
  display: inline-block;
  margin-right: var(--space-3);
}
.adoption-batch-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.adoption-counts {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  margin: var(--space-3) 0;
}
.adoption-count {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
}
.adoption-count-value {
  display: block;
  font-size: 1.6rem;
  font-weight: 600;
}
.adoption-reasons {
  margin: var(--space-2) 0 0;
  padding-left: 1.2rem;
}
.adoption-subhead {
  font-size: 1rem;
  margin: var(--space-3) 0 var(--space-1);
}
.adoption-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.adoption-hint {
  color: var(--gray-600);
  font-size: 0.85rem;
}
.adoption-pending {
  border-top: 1px solid var(--line);
  margin-top: var(--space-3);
  padding-top: var(--space-2);
}
.adoption-metrics {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  margin: var(--space-3) 0;
}
.adoption-metric {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
}
.adoption-metric dt {
  font-size: 0.85rem;
  color: var(--gray-600);
}
.adoption-metric dd {
  font-size: 1.4rem;
  font-weight: 600;
  margin: 0;
}
.adoption-metric small {
  color: var(--gray-600);
}
.adoption-history {
  list-style: none;
  padding: 0;
}
.adoption-history-current {
  font-weight: 600;
}
</style>
