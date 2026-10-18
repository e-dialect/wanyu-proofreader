<template>
  <main class="container page workspace-page">
    <header class="page-heading">
      <div>
        <RouterLink :to="`/admin/projects/${projectId}`" class="back-link">← 返回项目</RouterLink>
        <div class="page-eyebrow">发布交付</div>
        <h1>交付包与回执</h1>
        <p>先核对数量、来源和范围，再由人决定出包。每次交付与回执都保留凭据。</p>
      </div>
    </header>
    <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>
    <div v-if="success" class="alert alert-success" role="status">{{ success }}</div>
    <div class="alert alert-info mb-6" role="status">
      当前提供文件往返与人工回执。原生批次编选、独立导出整合、消费方实测与双方签字尚待接入；对账一致不代表可发布。
    </div>

    <section class="card mb-6">
      <h2>发布前检查</h2>
      <p class="text-muted">上传经 D 线确认的整批交接清单。范围外与待处理条目只声明标识和理由，默认不携带正文。首次使用需先取得编选交接清单。</p>
      <form class="settings-form" @submit.prevent="preflight">
        <label class="form-group">
          <span class="form-label">批次交接清单</span>
          <input type="file" accept=".json,application/json" class="form-control" :disabled="busy" @change="readHandoff" />
        </label>
        <label class="form-group">
          <span class="form-label">本次人工核查者</span>
          <input v-model.trim="reviewer" class="form-control" required maxlength="200" :disabled="busy" @input="invalidatePreview" />
        </label>
        <p v-if="handoff" class="text-sm">编选凭据：{{ handoff.selection_ref }} · 接收方：{{ handoff.recipient }} · 用途：{{ purposeLabel(handoff.purpose) }}</p>
        <button class="btn btn-secondary" :disabled="busy || !handoff">{{ busy ? '正在处理…' : '检查本批交付范围' }}</button>
      </form>
      <div v-if="preview" class="mt-4" role="status">
        <h3>{{ preview.reconciliation.status === 'consistent' ? '数量一致，仍需人工决定' : '检查不通过，已阻止出包' }}</h3>
        <p>采用 {{ preview.reconciliation.counts.adopted }} 条 · 范围外 {{ preview.reconciliation.counts.excluded }} 条 · 待处理 {{ preview.reconciliation.counts.pending }} 条</p>
        <p>来源覆盖 {{ preview.reconciliation.source_covered }} / {{ preview.reconciliation.source_total }} 条 · 范围外及待处理占比 {{ percent(preview.reconciliation.outside_ratio) }}</p>
        <ul v-if="preview.reconciliation.problems.length">
          <li v-for="problem in preview.reconciliation.problems" :key="problem">{{ problem }}</li>
        </ul>
        <div v-if="preview.can_generate">
          <label class="flex gap-2 items-center mt-3"><input v-model="confirmed" type="checkbox" :disabled="busy" />我已核查范围并决定生成本次交付包</label>
          <button class="btn btn-primary mt-3" :disabled="busy || !confirmed" @click="generate">生成交付包</button>
        </div>
      </div>
    </section>

    <section class="card mb-6">
      <div class="section-heading">
        <div><h2>交付记录</h2><p v-if="metrics">共 {{ metrics.package_count }} 包 · 未回执 {{ metrics.receipt_states.awaiting_receipt }} 包 · 已停用 {{ metrics.withdrawn_packages }} 包</p></div>
        <button class="btn btn-secondary" :disabled="busy || loading" @click="load">刷新</button>
      </div>
      <p v-if="loading" role="status">正在加载交付记录…</p>
      <div v-else-if="!items.length" class="empty-state"><div class="empty-state-text">还没有交付包</div><p>检查通过并经人工确认后，首个包会显示在这里。</p></div>
      <article v-for="item in items" :key="item.id" class="card mt-3">
        <h3>{{ item.recipient }} · 第 {{ item.version }} 版</h3>
        <p>{{ purposeLabel(item.purpose) }} · {{ receiptLabel(item.receipt_state) }}<strong v-if="item.withdrawn"> · 已停用（{{ item.notice_state === 'manual_notice_recorded' ? '已登记人工通知' : '待通知消费方' }}）</strong></p>
        <p v-if="item.pending_actions.length">上游待办 {{ item.pending_actions.length }} 项，处置完成后才能重发。</p>
        <p v-if="item.receipt_state === 'awaiting_receipt'" class="text-muted">等待回执 {{ Math.floor(item.waiting_seconds / 3600) }} 小时</p>
        <p>正文 {{ item.reconciliation.payload_count }} 条 · 采用 {{ item.reconciliation.counts.adopted }} · 范围外 {{ item.reconciliation.counts.excluded }} · 待处理 {{ item.reconciliation.counts.pending }}</p>
        <p class="text-sm">包标识：{{ item.package_id }}<br />来源：{{ item.source_ref }} · 批次：{{ item.import_job }}</p>
        <p v-if="item.previous" class="text-sm">前包：{{ item.previous }} · 变更：{{ item.change_reason }}</p>
        <details><summary>校验和与事件凭据</summary><p class="text-sm delivery-digest">SHA-256：{{ item.sha256 }}</p>
          <p v-if="!item.events.length">尚无回执或处置记录。</p>
          <div v-for="event in item.events" :key="event.id" class="mt-2">
            <strong>{{ eventLabel(event.kind) }} · {{ event.created }}</strong>
            <p>{{ event.payload.reason }} · 操作者 {{ event.actor }} · 核查者 {{ event.payload.reviewer }}</p>
            <p v-if="event.payload.responsible">上游 {{ event.payload.target }} · 责任人 {{ event.payload.responsible }}</p>
            <p v-if="event.payload.evidence">凭据：{{ event.payload.evidence }}</p>
            <p class="text-sm">事件编号：{{ event.id }}</p>
          </div>
        </details>
        <div class="flex gap-2 mt-3">
          <button class="btn btn-secondary" :disabled="busy || item.withdrawn || item.rights_blocked" @click="download(item)">下载交付包</button>
          <button class="btn btn-secondary" :disabled="busy" @click="selectEvent(item)">登记回执或处置</button>
        </div>
      </article>
    </section>

    <section v-if="selected" class="card mb-6">
      <h2>登记：{{ selected.recipient }} 第 {{ selected.version }} 版</h2>
      <p class="text-muted">只追加凭据。部分冲突需交由 A／D 上游责任人修复，再用新的交接清单关联前包重发。</p>
      <form class="settings-form" @submit.prevent="saveEvent">
        <label class="form-group"><span class="form-label">动作</span><select v-model="eventForm.kind" class="form-control"><option v-for="(label, value) in eventLabels" :key="value" :value="value">{{ label }}</option></select></label>
        <template v-if="eventForm.kind === 'receipt'">
          <label class="form-group"><span class="form-label">消费方导入结果</span><select v-model="eventForm.status" class="form-control"><option value="success">全部成功</option><option value="partial_conflict">部分冲突</option><option value="failed_rolled_back">整体失败并回滚</option></select></label>
          <label class="form-group"><span class="form-label">影响条数（冲突时填冲突条数）</span><input v-model.number="eventForm.affected" type="number" min="0" :max="selected.reconciliation.payload_count" class="form-control" required /></label>
        </template>
        <label class="form-group"><span class="form-label">原因／处置说明</span><textarea v-model.trim="eventForm.reason" class="form-control" required maxlength="1000" /></label>
        <label class="form-group"><span class="form-label">人工核查者</span><input v-model.trim="eventForm.reviewer" class="form-control" required maxlength="200" /></label>
        <label class="form-group"><span class="form-label">修复／通知责任人</span><input v-model.trim="eventForm.responsible" class="form-control" maxlength="200" /></label>
        <label class="form-group"><span class="form-label">退回工序</span><select v-model="eventForm.target" class="form-control"><option value="">不涉及上游退回</option><option value="A">A 来源与权利</option><option value="D">D 批次编选</option></select></label>
        <label class="form-group"><span class="form-label">凭据（停用时填 Steering 记录；失败时填回滚凭据）</span><input v-model.trim="eventForm.evidence" class="form-control" maxlength="1000" /></label>
        <label v-if="eventForm.kind === 'resolution'" class="form-group"><span class="form-label">已处置的事件编号</span><input v-model.trim="eventForm.resolves" class="form-control" required /></label>
        <div class="flex gap-2"><button class="btn btn-primary" :disabled="busy">保存凭据</button><button type="button" class="btn btn-secondary" :disabled="busy" @click="selected = null">取消</button></div>
      </form>
    </section>

    <section class="card">
      <h2>来源权利变更后的影响</h2>
      <p>查询受影响的历史包，再逐包追加停用凭据，升级 Steering，并登记通知消费方停用的凭据。历史包不会被改写。</p>
      <form class="settings-form" @submit.prevent="findImpacts">
        <label class="form-group"><span class="form-label">来源标识</span><input v-model.trim="sourceRef" class="form-control" required /></label>
        <button class="btn btn-secondary" :disabled="busy">查询受影响交付包</button>
      </form>
      <div v-if="impacts" class="mt-3" role="status"><p>找到 {{ impacts.length }} 包</p><p v-for="item in impacts" :key="item.id">{{ item.recipient }} 第 {{ item.version }} 版 · {{ item.reconciliation.payload_count }} 条 · {{ item.rights_blocked ? '当前权利已阻断下载' : '当前用途许可允许' }} · {{ item.withdrawn ? '已追加停用' : '尚未追加停用' }}</p></div>
    </section>
  </main>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { appendDeliveryEvent, checkDelivery, createDelivery, downloadDelivery, findDeliveryImpacts, listDeliveries } from '@/services/deliveryService'
import { USAGE_PURPOSE_LABELS } from '@/constants/sourceRegistry'
import { getPbMessage } from '@/utils/pbErrors'

const projectId = useRoute().params.id
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const success = ref('')
const items = ref([])
const metrics = ref(null)
const handoff = ref(null)
const reviewer = ref('')
const preview = ref(null)
const confirmed = ref(false)
const selected = ref(null)
const sourceRef = ref('')
const impacts = ref(null)
const eventLabels = { receipt: '人工导入回执', return: '退回上游', withdrawal: '追加停用并升级 Steering', notice: '已通知消费方停用', resolution: '登记处置完成' }
const eventForm = reactive({ kind: 'receipt', status: 'success', affected: 0, reason: '', reviewer: '', responsible: '', target: '', evidence: '', resolves: '' })
const receiptLabel = (value) => ({ awaiting_receipt: '对方尚未回执', success: '全部成功', partial_conflict: '部分冲突，待上游处理', failed_rolled_back: '整体失败并回滚' }[value] || value)
const eventLabel = (value) => eventLabels[value] || value
const purposeLabel = (value) => USAGE_PURPOSE_LABELS[value] || value
const percent = (value) => `${(value * 100).toFixed(1)}%`
function invalidatePreview() { preview.value = null; confirmed.value = false }
async function action(fn) {
  busy.value = true; error.value = ''; success.value = ''
  try { await fn() } catch (e) { error.value = getPbMessage(e, e?.message || '处理失败，请重试') } finally { busy.value = false }
}
async function load() {
  loading.value = true
  try { const data = await listDeliveries(projectId); items.value = data.items; metrics.value = data.metrics } catch (e) { error.value = getPbMessage(e, '交付记录加载失败') } finally { loading.value = false }
}
async function readHandoff(event) {
  invalidatePreview(); handoff.value = null
  await action(async () => {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) throw new Error('交接清单超过 2 MiB，请在编选环节拆分')
    const value = JSON.parse(await file.text())
    if (!value || !Array.isArray(value.entries) || !value.selection_ref) throw new Error('交接清单缺少批次编选凭据或条目范围')
    handoff.value = value
  })
}
const requestBody = () => ({ ...handoff.value, reviewer: reviewer.value })
async function preflight() {
  invalidatePreview()
  await action(async () => { preview.value = await checkDelivery(projectId, requestBody()) })
}
async function generate() {
  if (!confirmed.value || !preview.value?.can_generate) return
  const body = { ...requestBody(), preview_sha256: preview.value.preview_sha256 }
  await action(async () => {
    await createDelivery(projectId, body)
    invalidatePreview(); handoff.value = null
    success.value = '交付包已生成，尚未收到消费方回执。'
    await load()
  })
}
async function download(item) { await action(() => downloadDelivery(item.id)) }
function selectEvent(item) {
  selected.value = item
  Object.assign(eventForm, { kind: 'receipt', status: 'success', affected: item.reconciliation.payload_count, reason: '', reviewer: '', responsible: '', target: '', evidence: '', resolves: '' })
}
async function saveEvent() {
  await action(async () => { await appendDeliveryEvent(selected.value.id, { ...eventForm }); selected.value = null; success.value = '已追加凭据。'; await load() })
}
async function findImpacts() { await action(async () => { impacts.value = (await findDeliveryImpacts(projectId, sourceRef.value)).items }) }
onMounted(load)
</script>

<style scoped>
.delivery-digest, article { overflow-wrap: anywhere; }
</style>
