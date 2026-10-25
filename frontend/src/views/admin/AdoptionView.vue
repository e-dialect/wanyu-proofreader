<template>
  <main class="container page">
    <RouterLink :to="`/admin/projects/${projectId}`" class="back-link">← 返回项目</RouterLink>
    <h1>用途编选（D 工序）</h1>
    <p>
      按这一批交付的用途圈定范围：先选接收方与筛选规则、看数量，人工只处理少数例外，再确认本批范围。
      这里的「编选」是整批交付取舍，不是仲裁台里选哪一份校对结果的「采用」；B 的校对成果与状态不会因为编选而改变。
    </p>
    <p v-if="loading" role="status">正在加载…</p>
    <div v-if="loadError" class="alert alert-error" role="alert">
      {{ loadError }} <button class="btn btn-secondary btn-sm" @click="load">重试</button>
    </div>
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
            <label class="form-label">用途
              <select v-model="createForm.purpose" class="form-control" required>
                <option v-for="code in purposes" :key="code" :value="code">{{ purposeLabel(code) }}</option>
              </select>
            </label>
            <label class="form-label">接收方
              <input v-model="createForm.recipient" class="form-control" maxlength="120" required placeholder="例如：乡声集盒春节版">
            </label>
          </div>
          <fieldset class="adoption-fieldset">
            <legend>校对状态</legend>
            <label v-for="code in pageStatuses" :key="code" class="adoption-check">
              <input v-model="createForm.statuses" type="checkbox" :value="code"> {{ statusLabel(code) }}
            </label>
          </fieldset>
          <fieldset class="adoption-fieldset">
            <legend>质量状态（不勾＝不看这一维）</legend>
            <label v-for="code in qualityStates" :key="code" class="adoption-check">
              <input v-model="createForm.qualityStates" type="checkbox" :value="code"> {{ qualityStateLabel(code) }}
            </label>
          </fieldset>
          <label class="adoption-check">
            <input v-model="createForm.requirePinyin" type="checkbox"> 要求拼音已定稿（EXACT / REVIEWED）
          </label>
          <label class="form-label">只在这些导入批次里选（可选）
            <input v-model="createForm.importJobsText" class="form-control" placeholder="15 位批次 id，逗号分隔；留空表示整个项目">
          </label>
          <label class="form-label">说明（可选）
            <textarea v-model="createForm.note" class="form-control" maxlength="500" rows="2"></textarea>
          </label>
          <button class="btn btn-primary mt-3" :disabled="busy">创建并预览数量</button>
        </form>
      </section>

      <section v-if="current" class="card mb-4">
        <header class="adoption-batch-head">
          <h2>当前批次</h2>
          <span class="badge">{{ batchStatusLabel(current.status) }}</span>
        </header>
        <p>
          {{ purposeLabel(current.purpose) }} · 交给 {{ current.recipient }} · 规则：{{ ruleSummary(current.rule) }}
        </p>
        <p v-if="current.note">{{ current.note }}</p>

        <div class="adoption-counts">
          <div class="adoption-count"><span class="adoption-count-value">{{ counts.total }}</span><span>本批条目</span></div>
          <div class="adoption-count"><span class="adoption-count-value">{{ counts.selected }}</span><span>进入本批</span></div>
          <div class="adoption-count"><span class="adoption-count-value">{{ counts.excluded }}</span><span>已定不进入</span></div>
          <div class="adoption-count"><span class="adoption-count-value">{{ counts.pending }}</span><span>待处理（规则判不了）</span></div>
        </div>
        <p v-if="!consistent" class="alert alert-warning" role="alert">
          三个数之和对不上总数，界面不照抄：请重新预览；若仍不一致，说明数据被绕过接口改过。
        </p>
        <p v-else-if="counts.pending > 0" class="alert alert-warning" role="alert">
          还有 {{ counts.pending }} 条待处理。确认后导出的清单会写明 <code>complete: false</code>，不会把部分结果冒充全量。
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
          <button class="btn btn-secondary" :disabled="busy || current.status === 'confirmed'" @click="preview">重新预览数量</button>
          <button
            class="btn btn-primary"
            :disabled="busy || current.status !== 'previewed'"
            @click="confirm"
          >确认本批采用范围</button>
          <button class="btn btn-secondary" :disabled="busy" @click="exportManifest('select')">导出本批清单</button>
          <button class="btn btn-quiet" :disabled="busy" @click="exportManifest('all')">导出全部条目（需平台管理员）</button>
          <button
            v-if="current.status !== 'confirmed'"
            class="btn btn-quiet"
            :disabled="busy"
            @click="remove"
          >删除这一批</button>
        </div>
        <p class="adoption-hint">导出默认只含进入本批的条目；未采用与待处理的数量写在清单的 <code>omitted</code> 里。</p>
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
            <label class="form-label">结论
              <select v-model="draftFor(item.page).decision" class="form-control">
                <option value="select">{{ DECISION_LABELS.select }}</option>
                <option value="exclude">{{ DECISION_LABELS.exclude }}</option>
              </select>
            </label>
            <label v-if="draftFor(item.page).decision === 'exclude'" class="form-label">理由
              <select v-model="draftFor(item.page).reason" class="form-control">
                <option value="">请选择理由</option>
                <option v-for="code in reasonCodes" :key="code" :value="code">{{ reasonLabel(code) }}</option>
              </select>
            </label>
          </div>
          <label class="form-label">依据
            <input v-model="draftFor(item.page).note" class="form-control" maxlength="500" placeholder="写清为什么这样判，例如取得书面许可、缺字表已补齐">
          </label>
          <button
            class="btn btn-secondary btn-sm mt-3"
            :disabled="busy"
            @click="decide(item.page)"
          >保存这一条</button>
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

      <section class="card">
        <h2>历史批次</h2>
        <p v-if="!batches.length" class="empty-state-text">这个项目还没有编选批次。</p>
        <ul class="adoption-history">
          <li v-for="item in batches" :key="item.id" :class="{ 'adoption-history-current': item.id === currentId }">
            <button class="btn btn-quiet btn-sm" :disabled="busy" @click="selectBatch(item.id)">
              {{ purposeLabel(item.purpose) }} · {{ batchStatusLabel(item.status) }} · {{ item.counts.selected }}/{{ item.counts.total }} 条进入本批
            </button>
            <span class="adoption-hint">交给 {{ item.recipient }} · {{ item.created }}</span>
          </li>
        </ul>
      </section>
    </template>
  </main>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import {
  DECISION_LABELS,
  DEFAULT_STATUSES,
  PAGE_STATUS_LABELS,
  QUALITY_STATE_LABELS,
  batchStatusLabel,
  countsConsistent,
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
  listAdoptionBatches,
  listAdoptionExceptions,
  previewAdoptionBatch
} from '@/services/adoptionService'
import { downloadText } from '@/lib/downloadText'
import { getPbMessage } from '@/utils/pbErrors'

const projectId = String(useRoute().params.id)
const pageStatuses = Object.keys(PAGE_STATUS_LABELS)
const qualityStates = Object.keys(QUALITY_STATE_LABELS)

const loading = ref(false)
const loaded = ref(false)
const busy = ref(false)
const loadError = ref('')
const operationError = ref('')
const message = ref('')

const batches = ref([])
const purposes = ref([])
const reasonCodes = ref([])
const currentId = ref('')
const exceptions = ref({ exceptions: [], pending: [], pendingTotal: 0 })
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

onMounted(load)

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await listAdoptionBatches(projectId)
    batches.value = data.batches || []
    purposes.value = data.purposes || []
    reasonCodes.value = data.reasons || []
    if (!currentId.value || !batches.value.some((item) => item.id === currentId.value)) {
      currentId.value = batches.value[0]?.id || ''
    }
    await loadExceptions()
    loaded.value = true
  } catch (e) {
    loadError.value = getPbMessage(e, '加载编选批次失败')
  } finally {
    loading.value = false
  }
}

async function loadExceptions() {
  if (!currentId.value) {
    exceptions.value = { exceptions: [], pending: [], pendingTotal: 0 }
    return
  }
  exceptions.value = await listAdoptionExceptions(currentId.value)
  for (const item of exceptions.value.pending) draftFor(item.page)
}

function draftFor(pageId) {
  if (!decisionDrafts[pageId]) {
    decisionDrafts[pageId] = { decision: 'select', reason: '', note: '' }
  }
  return decisionDrafts[pageId]
}

async function act(fn, success) {
  busy.value = true
  operationError.value = ''
  message.value = ''
  try {
    await fn()
    message.value = success
    await load()
  } catch (e) {
    operationError.value = getPbMessage(e, '操作失败，请重试')
  } finally {
    busy.value = false
  }
}

async function create() {
  const built = ruleFromForm(createForm)
  if (built.error) {
    operationError.value = built.error
    return
  }
  await act(async () => {
    const batch = await createAdoptionBatch(projectId, {
      purpose: createForm.purpose,
      recipient: createForm.recipient.trim(),
      note: createForm.note.trim(),
      rule: built.rule
    })
    currentId.value = batch.id
    await previewAdoptionBatch(batch.id)
    // 接收方保留：同一批交付常常要按不同用途连续开几条；说明是一次性的。
    createForm.note = ''
  }, '批次已创建并完成预览；核对数量后再确认。')
}

async function preview() {
  await act(() => previewAdoptionBatch(current.value.id), '已按当前数据重新计算。')
}

async function confirm() {
  await act(() => confirmAdoptionBatch(current.value.id), '已确认本批采用范围；导出与下游都以这份清单为准。')
}

async function remove() {
  await act(async () => {
    await deleteAdoptionBatch(current.value.id)
    currentId.value = ''
  }, '草稿已删除。')
}

async function exportManifest(include) {
  busy.value = true
  operationError.value = ''
  message.value = ''
  try {
    const manifest = await exportAdoptionManifest(current.value.id, include)
    downloadText(JSON.stringify(manifest, null, 2), manifestFilename(current.value), 'application/json')
    message.value = include === 'select'
      ? includeLabel('select')
      : `${includeLabel('all')}；未采用与待处理的数量写在清单里。`
  } catch (e) {
    operationError.value = getPbMessage(e, '导出失败')
  } finally {
    busy.value = false
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
  currentId.value = id
  loading.value = true
  loadError.value = ''
  try {
    await loadExceptions()
  } catch (e) {
    loadError.value = getPbMessage(e, '加载例外失败')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.back-link { display: inline-block; margin-bottom: var(--space-3); }
.adoption-form-grid { display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.adoption-fieldset { border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-2) var(--space-3); margin: var(--space-3) 0; }
.adoption-check { display: inline-block; margin-right: var(--space-3); }
.adoption-batch-head { display: flex; align-items: center; gap: var(--space-2); }
.adoption-counts { display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); margin: var(--space-3) 0; }
.adoption-count { border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-2) var(--space-3); }
.adoption-count-value { display: block; font-size: 1.6rem; font-weight: 600; }
.adoption-reasons { margin: var(--space-2) 0 0; padding-left: 1.2rem; }
.adoption-subhead { font-size: 1rem; margin: var(--space-3) 0 var(--space-1); }
.adoption-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-3); }
.adoption-hint { color: var(--gray-600); font-size: .85rem; }
.adoption-pending { border-top: 1px solid var(--line); margin-top: var(--space-3); padding-top: var(--space-2); }
.adoption-history { list-style: none; padding: 0; }
.adoption-history-current { font-weight: 600; }
</style>
