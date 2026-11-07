<template>
  <main class="container page workspace-page delivery-workspace">
    <ProjectWorkspaceNav :project-id="projectId" active="delivery" />
    <header class="page-heading">
      <div>
        <div class="page-eyebrow">项目交付</div>
        <h1>
          {{
            view === 'prepare'
              ? '准备交付包'
              : view === 'detail'
                ? '交付详情'
                : view === 'impacts'
                  ? '来源变更影响'
                  : '交付包与回执'
          }}
        </h1>
        <p>核对交付范围，保留每次交付与后续处置的凭据。</p>
      </div>
      <button
        v-if="view === 'records'"
        class="btn btn-primary"
        :disabled="busy"
        @click="view = 'prepare'"
      >
        准备新交付
      </button>
      <button v-else class="btn btn-secondary" :disabled="busy" @click="view = 'records'">
        返回交付记录
      </button>
    </header>
    <nav class="delivery-tabs" aria-label="交付工作">
      <button
        type="button"
        :disabled="busy"
        :aria-current="['records', 'detail'].includes(view) ? 'page' : undefined"
        @click="view = 'records'"
      >
        交付记录
      </button>
      <button
        type="button"
        :disabled="busy"
        :aria-current="view === 'prepare' ? 'page' : undefined"
        @click="view = 'prepare'"
      >
        准备交付
      </button>
      <button
        type="button"
        :disabled="busy"
        :aria-current="view === 'impacts' ? 'page' : undefined"
        @click="view = 'impacts'"
      >
        来源变更影响
      </button>
    </nav>
    <div v-if="loadError" class="alert alert-error" role="alert">
      {{ loadError }}
      <button type="button" class="btn btn-secondary btn-sm" :disabled="loading" @click="load">
        重新加载
      </button>
    </div>
    <div v-if="operationError" class="alert alert-error" role="alert">{{ operationError }}</div>
    <div v-if="success" class="alert alert-success" role="status">{{ success }}</div>

    <section v-if="view === 'prepare'" class="card mb-6">
      <div class="delivery-steps" aria-label="交付准备步骤">
        <span :aria-current="!preview ? 'step' : undefined">1 选择清单</span
        ><span :aria-current="preview ? 'step' : undefined">2 检查范围</span
        ><span>3 人工确认与生成</span>
      </div>
      <h2>发布前检查</h2>
      <p class="text-muted">
        使用已确认的编选交接清单。范围外与待处理条目只声明标识和理由，默认不携带正文。
      </p>
      <RouterLink :to="`/admin/projects/${projectId}/adoption`" class="btn btn-quiet btn-sm"
        >前往用途编选，取得交接清单 →</RouterLink
      >
      <form v-if="!preview" class="settings-form mt-3" @submit.prevent="preflight">
        <div class="form-group">
          <span class="form-label">批次交接清单</span
          ><input
            ref="handoffInput"
            type="file"
            aria-label="批次交接清单"
            accept=".json,application/json"
            class="file-input-hidden"
            :disabled="busy"
            @change="readHandoff"
          />
          <button
            type="button"
            class="btn btn-secondary"
            :disabled="busy"
            @click="handoffInput.click()"
          >
            选择交接清单 JSON
          </button>
          <p v-if="handoffFilename" class="text-sm mt-2 delivery-filename">
            {{ handoffFilename }}
          </p>
        </div>
        <label class="form-group"
          ><span class="form-label">本次人工核查者</span
          ><input
            v-model.trim="reviewer"
            class="form-control"
            required
            maxlength="200"
            :disabled="busy"
            @input="invalidatePreview"
        /></label>
        <p v-if="handoff" class="text-sm">
          交给 {{ handoff.recipient }} · {{ purposeLabel(handoff.purpose) }}
        </p>
        <button class="btn btn-primary" :disabled="busy || !handoff">
          {{ busy ? '正在检查…' : '检查本批交付范围' }}
        </button>
      </form>
      <div v-if="preview" class="mt-4" role="status">
        <label class="form-group delivery-reviewer"
          ><span class="form-label">本次人工核查者</span
          ><input
            v-model.trim="reviewer"
            class="form-control"
            required
            maxlength="200"
            :disabled="busy"
            @input="invalidatePreview"
        /></label>
        <h3>
          {{
            preview.reconciliation.status === 'consistent'
              ? '数量一致，等待人工决定'
              : '检查不通过，已阻止出包'
          }}
        </h3>
        <dl class="delivery-counts">
          <div>
            <dt>采用</dt>
            <dd>{{ preview.reconciliation.counts.adopted }}</dd>
          </div>
          <div>
            <dt>范围外</dt>
            <dd>{{ preview.reconciliation.counts.excluded }}</dd>
          </div>
          <div>
            <dt>待处理</dt>
            <dd>{{ preview.reconciliation.counts.pending }}</dd>
          </div>
          <div>
            <dt>来源覆盖</dt>
            <dd>
              {{ preview.reconciliation.source_covered }} /
              {{ preview.reconciliation.source_total }}
            </dd>
          </div>
        </dl>
        <p>范围外及待处理占比 {{ percent(preview.reconciliation.outside_ratio) }}</p>
        <ul v-if="preview.reconciliation.problems.length">
          <li v-for="problem in preview.reconciliation.problems" :key="problem">{{ problem }}</li>
        </ul>
        <p class="text-sm text-muted">对账一致不代表可发布。仍须核查许可、交付范围及接收方要求。</p>
        <div v-if="preview.can_generate" class="delivery-confirmation">
          <label class="flex gap-2 items-center"
            ><input
              v-model="confirmed"
              type="checkbox"
              :disabled="busy"
            />我已核查范围并决定生成本次交付包</label
          ><button class="btn btn-primary mt-3" :disabled="busy || !confirmed" @click="generate">
            生成交付包
          </button>
        </div>
        <button
          type="button"
          class="btn btn-quiet mt-3"
          :disabled="busy"
          @click="invalidatePreview"
        >
          返回更换清单或核查者
        </button>
      </div>
      <details class="mt-4">
        <summary class="text-sm text-muted">当前交付方式与范围</summary>
        <p class="text-sm text-muted">
          当前提供文件往返与人工回执。原生批次编选、独立导出整合、消费方实测与双方签字尚待接入；对账一致不代表可发布。
        </p>
      </details>
    </section>

    <section v-if="view === 'records'" class="card mb-6">
      <div class="section-heading">
        <div>
          <h2>交付记录</h2>
          <p v-if="metrics">
            共 {{ metrics.package_count }} 包 · 未回执
            {{ metrics.receipt_states.awaiting_receipt }} 包 · 已停用
            {{ metrics.withdrawn_packages }} 包
          </p>
        </div>
        <button class="btn btn-secondary btn-sm" :disabled="busy || loading" @click="load">
          刷新
        </button>
      </div>
      <p v-if="loading" role="status">正在加载交付记录…</p>
      <div v-else-if="loadError" class="text-muted">
        交付记录暂时无法读取，请用上方「重新加载」重试。
      </div>
      <div v-else-if="!items.length" class="empty-state">
        <div class="empty-state-text">还没有交付包</div>
        <p>检查通过并经人工确认后，首个包会显示在这里。</p>
        <button class="btn btn-secondary mt-3" @click="view = 'prepare'">准备首个交付包</button>
      </div>
      <ul class="delivery-records">
        <li v-for="item in items" :key="item.id">
          <div>
            <strong>{{ item.recipient }} · 第 {{ item.version }} 版</strong>
            <p>
              {{ purposeLabel(item.purpose) }} · 正文 {{ item.reconciliation.payload_count }} 条
            </p>
            <span
              class="text-sm"
              :class="item.withdrawn || item.rights_blocked ? 'text-danger' : 'text-muted'"
              >{{
                item.withdrawn
                  ? '已停用'
                  : item.rights_blocked
                    ? '当前用途许可阻断下载'
                    : receiptLabel(item)
              }}</span
            >
          </div>
          <button class="btn btn-secondary" :disabled="busy" @click="openDelivery(item)">
            查看交付详情
          </button>
        </li>
      </ul>
    </section>

    <section v-if="view === 'detail'" class="mb-6">
      <article v-for="item in visibleDeliveries" :key="item.id" class="card">
        <div class="section-heading">
          <div>
            <h2>{{ item.recipient }} · 第 {{ item.version }} 版</h2>
            <p>{{ purposeLabel(item.purpose) }} · {{ receiptLabel(item) }}</p>
          </div>
          <button
            class="btn btn-primary"
            :disabled="busy || item.withdrawn || item.rights_blocked"
            @click="download(item)"
          >
            下载交付包
          </button>
        </div>
        <p v-if="item.withdrawn" class="alert alert-warning" role="alert">
          已停用 ·
          {{ item.notice_state === 'manual_notice_recorded' ? '已登记人工通知' : '待通知消费方' }}
        </p>
        <p v-else-if="item.rights_blocked" class="alert alert-warning" role="alert">
          当前来源用途许可已阻断下载。请核对来源变更并按实际情况追加处置记录。
        </p>
        <p v-if="item.pending_actions.length" class="alert alert-warning" role="alert">
          上游待办 {{ item.pending_actions.length }} 项，处置完成后才能重发。
        </p>
        <p v-if="item.receipt_state === 'awaiting_receipt'" class="text-muted">
          等待回执 {{ Math.floor(item.waiting_seconds / 3600) }} 小时
        </p>
        <dl class="delivery-counts">
          <div>
            <dt>正文</dt>
            <dd>{{ item.reconciliation.payload_count }}</dd>
          </div>
          <div>
            <dt>采用</dt>
            <dd>{{ item.reconciliation.counts.adopted }}</dd>
          </div>
          <div>
            <dt>范围外</dt>
            <dd>{{ item.reconciliation.counts.excluded }}</dd>
          </div>
          <div>
            <dt>待处理</dt>
            <dd>{{ item.reconciliation.counts.pending }}</dd>
          </div>
        </dl>
        <button class="btn btn-secondary mt-3" :disabled="busy" @click="selectEvent(item)">
          登记回执或处置
        </button>
        <details class="mt-4">
          <summary>包标识与来源凭据</summary>
          <p class="text-sm">
            包标识：{{ item.package_id }}<br />来源：{{ item.source_ref }} · 批次：{{
              item.import_job
            }}
          </p>
          <p v-if="item.previous" class="text-sm">
            前包：{{ item.previous }} · 变更：{{ item.change_reason }}
          </p>
          <p class="text-sm delivery-digest">SHA-256：{{ item.sha256 }}</p>
        </details>
        <section class="delivery-history mt-4">
          <h3>回执与处置记录</h3>
          <p v-if="!item.events.length" class="text-muted">尚无回执或处置记录。</p>
          <article v-for="event in item.events" :key="event.id">
            <strong>{{ eventLabel(event.kind) }} · {{ event.created }}</strong>
            <p>{{ event.payload.reason }} · 核查者 {{ event.payload.reviewer }}</p>
            <p v-if="event.payload.responsible">
              上游 {{ event.payload.target }} · 责任人 {{ event.payload.responsible }}
            </p>
            <p v-if="event.kind === 'receipt'">{{ receiptEventNote(event) }}</p>
            <p v-if="event.payload.evidence">凭据：{{ event.payload.evidence }}</p>
            <details>
              <summary class="text-sm text-muted">记录标识</summary>
              <p class="text-sm">事件 {{ event.id }} · 操作者 {{ event.actor }}</p>
            </details>
          </article>
        </section>
      </article>
      <p v-if="!visibleDeliveries.length" class="card text-muted">
        这份交付记录暂时不可用，请返回列表重新选择。
      </p>
    </section>

    <section
      v-if="view === 'detail' && selected"
      ref="eventEditor"
      class="card mb-6 delivery-event-editor"
    >
      <h2>登记：{{ selected.recipient }} 第 {{ selected.version }} 版</h2>
      <p class="text-muted">
        保存会追加一条凭据。冲突或失败需由上游修复，再使用新交接清单关联前包重发。
      </p>
      <form class="settings-form" @submit.prevent="saveEvent">
        <label class="form-group"
          ><span class="form-label">动作</span
          ><select v-model="eventForm.kind" class="form-control">
            <option v-for="(label, value) in eventLabels" :key="value" :value="value">
              {{ label }}
            </option>
          </select></label
        >
        <template v-if="eventForm.kind === 'receipt'">
          <p class="text-sm text-muted">
            对方自动回传尚未接入。这条记录是人工回执，写在当前包标识和第
            {{ selected.version }} 版上。失败会记成整体失败，不会改成尚未回执。
          </p>
          <label class="form-group"
            ><span class="form-label">消费方导入结果</span
            ><select v-model="eventForm.status" class="form-control">
              <option value="success">全部成功</option>
              <option value="partial_conflict">部分冲突</option>
              <option value="failed_rolled_back">整体失败并回滚</option>
            </select></label
          >
          <label class="form-group"
            ><span class="form-label">影响条数（冲突时填冲突条数）</span
            ><input
              v-model.number="eventForm.affected"
              type="number"
              min="0"
              :max="selected.reconciliation.payload_count"
              class="form-control"
              required
          /></label>
        </template>
        <label class="form-group"
          ><span class="form-label">原因／处置说明</span
          ><textarea
            v-model.trim="eventForm.reason"
            class="form-control"
            required
            maxlength="1000"
          />
        </label>
        <label class="form-group"
          ><span class="form-label">人工核查者</span
          ><input v-model.trim="eventForm.reviewer" class="form-control" required maxlength="200"
        /></label>
        <label class="form-group"
          ><span class="form-label">修复／通知责任人</span
          ><input v-model.trim="eventForm.responsible" class="form-control" maxlength="200"
        /></label>
        <label class="form-group"
          ><span class="form-label">退回位置</span
          ><select v-model="eventForm.target" class="form-control">
            <option value="">不涉及上游退回</option>
            <option value="A">来源与权利</option>
            <option value="D">批次编选</option>
          </select></label
        >
        <label class="form-group"
          ><span class="form-label">处置凭据（停用时填升级记录；失败时填回滚凭据）</span
          ><input v-model.trim="eventForm.evidence" class="form-control" maxlength="1000"
        /></label>
        <label v-if="eventForm.kind === 'resolution'" class="form-group"
          ><span class="form-label">已处置的待办</span
          ><select v-model="eventForm.resolves" class="form-control" required>
            <option value="">请选择待办记录</option>
            <option
              v-for="event in selected.events.filter((event) =>
                selected.pending_actions.includes(event.id)
              )"
              :key="event.id"
              :value="event.id"
            >
              {{ eventLabel(event.kind) }} · {{ event.created }} · {{ event.payload.reason }}
            </option>
          </select></label
        >
        <div class="flex gap-2">
          <button class="btn btn-primary" :disabled="busy">保存凭据</button
          ><button
            type="button"
            class="btn btn-secondary"
            :disabled="busy"
            @click="selected = null"
          >
            取消
          </button>
        </div>
      </form>
    </section>

    <section v-if="view === 'impacts'" class="card">
      <h2>来源权利变更后的影响</h2>
      <p>查询受影响的历史包，再逐包追加停用凭据、升级记录和消费方通知。历史包保持原样。</p>
      <form class="settings-form" @submit.prevent="findImpacts">
        <ProjectSourcePicker
          v-model="sourceRef"
          label="需要核对的来源"
          empty-label="选择要查询的来源"
          empty-hint="当前没有可查询的来源，可以填写已登记的来源标识。"
          :disabled="busy"
        /><button class="btn btn-secondary mt-3" :disabled="busy || !sourceRef">
          查询受影响交付包
        </button>
      </form>
      <div v-if="impacts" class="mt-3" role="status">
        <p>找到 {{ impacts.length }} 包</p>
        <ul class="delivery-records">
          <li v-for="item in impacts" :key="item.id">
            <div>
              <strong>{{ item.recipient }} · 第 {{ item.version }} 版</strong>
              <p>
                {{ item.reconciliation.payload_count }} 条 ·
                {{ item.rights_blocked ? '当前权利已阻断下载' : '当前用途许可允许' }} ·
                {{ item.withdrawn ? '已追加停用' : '尚未追加停用' }}
              </p>
            </div>
            <button
              type="button"
              class="btn btn-secondary"
              :disabled="busy"
              @click="openImpact(item)"
            >
              查看与处置
            </button>
          </li>
        </ul>
      </div>
    </section>
  </main>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import ProjectWorkspaceNav from '@/components/admin/project/ProjectWorkspaceNav.vue'
import ProjectSourcePicker from '@/components/admin/project/ProjectSourcePicker.vue'
import { RouterLink, useRoute } from 'vue-router'
import {
  appendDeliveryEvent,
  checkDelivery,
  createDelivery,
  downloadDelivery,
  findDeliveryImpacts,
  listDeliveries
} from '@/services/deliveryService'
import { USAGE_PURPOSE_LABELS } from '@/constants/sourceRegistry'
import { getPbMessage } from '@/utils/pbErrors'

const projectId = useRoute().params.id
const view = ref('records')
const selectedPackageId = ref('')
const loading = ref(true)
const busy = ref(false)
const loadError = ref('')
const operationError = ref('')
const success = ref('')
const items = ref([])
const metrics = ref(null)
const handoff = ref(null)
const handoffInput = ref(null)
const handoffFilename = ref('')
const reviewer = ref('')
const preview = ref(null)
const confirmed = ref(false)
const selected = ref(null)
const eventEditor = ref(null)
const sourceRef = ref('')
const impacts = ref(null)
const visibleDeliveries = computed(() =>
  items.value.filter((item) => item.id === selectedPackageId.value)
)
let disposed = false
let loadGeneration = 0
let operationGeneration = 0
let impactSelectionGeneration = 0
watch(
  view,
  () => {
    impactSelectionGeneration++
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  disposed = true
  ++loadGeneration
  ++operationGeneration
})
function openDelivery(item) {
  selectedPackageId.value = item.id
  selected.value = null
  view.value = 'detail'
}
async function openImpact(item) {
  const generation = ++impactSelectionGeneration
  await load()
  if (disposed || generation !== impactSelectionGeneration) return
  openDelivery(item)
}
const eventLabels = {
  receipt: '人工导入回执',
  return: '退回上游',
  withdrawal: '停用交付包并登记升级',
  notice: '已通知消费方停用',
  resolution: '登记处置完成'
}
const eventForm = reactive({
  kind: 'receipt',
  status: 'success',
  affected: 0,
  reason: '',
  reviewer: '',
  responsible: '',
  target: '',
  evidence: '',
  resolves: ''
})
// receipt_state is append-only, so a conflict closed by a resolution keeps its
// state while pending_actions empties. The card must not keep claiming
// unfinished upstream work once a resend is allowed.
const receiptLabel = (item) => {
  const base =
    {
      awaiting_receipt: '对方尚未回执',
      success: '全部成功',
      partial_conflict: '部分冲突',
      failed_rolled_back: '整体失败并回滚'
    }[item.receipt_state] || item.receipt_state
  const label =
    item.receipt_state === 'partial_conflict'
      ? item.pending_actions.length
        ? `${base}，待上游处理`
        : `${base}，已登记处置`
      : base
  if (item.receipt_channel === 'manual') return `${label}（人工回执，对方自动回传未接入）`
  return label
}
const eventLabel = (value) => eventLabels[value] || value
const receiptEventNote = (event) => {
  const payload = event?.payload || {}
  const channel = payload.channel || 'manual'
  return `影响 ${payload.affected} 条 · ${channel === 'manual' ? '人工回执' : channel}`
}
const purposeLabel = (value) => USAGE_PURPOSE_LABELS[value] || value
const percent = (value) => `${(value * 100).toFixed(1)}%`
function invalidatePreview() {
  preview.value = null
  confirmed.value = false
}
async function action(fn) {
  const generation = ++operationGeneration
  const isCurrent = () => !disposed && generation === operationGeneration
  busy.value = true
  operationError.value = ''
  success.value = ''
  try {
    await fn(isCurrent)
  } catch (e) {
    if (isCurrent()) operationError.value = getPbMessage(e, e?.message || '处理失败，请重试')
  } finally {
    if (isCurrent()) busy.value = false
  }
}
async function load() {
  const generation = ++loadGeneration
  loading.value = true
  loadError.value = ''
  operationError.value = ''
  try {
    const data = await listDeliveries(projectId)
    if (disposed || generation !== loadGeneration) return
    items.value = data.items
    metrics.value = data.metrics
  } catch (e) {
    if (!disposed && generation === loadGeneration)
      loadError.value = getPbMessage(e, '交付记录加载失败')
  } finally {
    if (!disposed && generation === loadGeneration) loading.value = false
  }
}
async function readHandoff(event) {
  invalidatePreview()
  handoff.value = null
  await action(async (isCurrent) => {
    const file = event.target.files?.[0]
    if (!file) return
    event.target.value = ''
    handoffFilename.value = file.name
    if (file.size > 2 * 1024 * 1024) throw new Error('交接清单超过 2 MiB，请在编选环节拆分')
    const value = JSON.parse(await file.text())
    if (!isCurrent()) return
    if (!value || !Array.isArray(value.entries) || !value.selection_ref)
      throw new Error('交接清单缺少批次编选凭据或条目范围')
    handoff.value = value
  })
}
const requestBody = () => ({ ...handoff.value, reviewer: reviewer.value })
async function preflight() {
  invalidatePreview()
  await action(async (isCurrent) => {
    const result = await checkDelivery(projectId, requestBody())
    if (isCurrent()) preview.value = result
  })
}
async function generate() {
  if (!confirmed.value || !preview.value?.can_generate) return
  const body = { ...requestBody(), preview_sha256: preview.value.preview_sha256 }
  await action(async (isCurrent) => {
    const delivery = await createDelivery(projectId, body)
    if (!isCurrent()) return
    invalidatePreview()
    handoff.value = null
    success.value = '交付包已生成，尚未收到消费方回执。'
    await load()
    if (!isCurrent()) return
    selectedPackageId.value = delivery.id || items.value[0]?.id || ''
    view.value = selectedPackageId.value ? 'detail' : 'records'
  })
}
async function download(item) {
  await action(() => downloadDelivery(item.id))
}
function selectEvent(item) {
  openDelivery(item)
  selected.value = item
  Object.assign(eventForm, {
    kind: 'receipt',
    status: 'success',
    affected: item.reconciliation.payload_count,
    reason: '',
    reviewer: '',
    responsible: '',
    target: '',
    evidence: '',
    resolves: ''
  })
  nextTick(() => eventEditor.value?.scrollIntoView({ block: 'start' }))
}
async function saveEvent() {
  const id = selected.value.id,
    body = { ...eventForm }
  await action(async (isCurrent) => {
    await appendDeliveryEvent(id, body)
    if (!isCurrent()) return
    selected.value = null
    success.value = '已追加凭据。'
    await load()
  })
}
async function findImpacts() {
  await action(async (isCurrent) => {
    const result = await findDeliveryImpacts(projectId, sourceRef.value)
    if (isCurrent()) impacts.value = result.items
  })
}
onMounted(load)
</script>

<style scoped>
.delivery-workspace {
  min-width: 0;
}
.delivery-workspace h1 {
  font-size: var(--text-2xl);
}
.delivery-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}
.delivery-tabs button {
  min-height: 44px;
  padding: var(--space-2) var(--space-3);
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--gray-600);
  font: inherit;
  cursor: pointer;
}
.delivery-tabs [aria-current='page'] {
  border-bottom-color: var(--primary);
  color: var(--primary);
  font-weight: 600;
}
.delivery-steps {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
  color: var(--gray-600);
  font-size: var(--text-sm);
}
.delivery-steps [aria-current='step'] {
  color: var(--primary);
  font-weight: 600;
}
.delivery-counts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: var(--space-4) 0;
  gap: var(--space-3);
}
.delivery-counts div {
  padding: var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.delivery-counts dt {
  color: var(--gray-600);
  font-size: var(--text-sm);
}
.delivery-counts dd {
  margin: var(--space-1) 0 0;
  font-size: var(--text-xl);
  font-weight: 600;
}
.delivery-records {
  list-style: none;
  padding: 0;
}
.delivery-records li {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--line);
}
.delivery-records li > div {
  min-width: 0;
}
.delivery-records p {
  color: var(--gray-600);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}
.delivery-history article {
  padding: var(--space-3) 0;
  border-top: 1px solid var(--line);
}
.delivery-confirmation {
  margin-top: var(--space-3);
  padding: var(--space-3);
  background: var(--primary-light);
  border-radius: var(--radius);
}
.delivery-reviewer {
  max-width: 28rem;
}
.delivery-event-editor {
  scroll-margin-top: var(--space-4);
}
.delivery-digest,
.delivery-filename,
article,
.delivery-records li {
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .delivery-counts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .delivery-records li {
    align-items: start;
    flex-direction: column;
  }
  .delivery-records .btn {
    min-height: 44px;
  }
}
</style>
