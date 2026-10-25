<template>
  <main class="container page">
    <RouterLink :to="`/admin/projects/${projectId}`">← 返回项目</RouterLink>
    <h1>来源核验与问题处理</h1>
    <p>维护工具与判断词条内容分别记录；完成问题处理后，相关条目仍须逐字段核对。</p>
    <p v-if="loading" role="status">正在加载…</p>
    <div v-if="loadError" class="alert alert-error" role="alert">{{ loadError }} <button class="btn btn-secondary" @click="load">重试</button></div>
    <div v-if="operationError" class="alert alert-error" role="alert">{{ operationError }}</div>
    <p v-if="message" class="alert alert-success" role="status">{{ message }}</p>
    <template v-if="loaded">
      <section class="card mb-4">
        <h2>固定来源与核验约定</h2>
        <p>当前版本：{{ policy?.id || '旧版／尚未记录' }}。变更会保留旧版，并使基于旧来源或约定的判断显示需复核。</p>
        <form @submit.prevent="savePolicy">
          <label class="form-label">核验说明<textarea v-model="form.instructions" class="form-control" maxlength="10000" required></textarea></label>
          <label class="form-label"><input v-model="form.tone_equivalence" type="checkbox"> 允许指定记音字段的声调普通数字与右上标等价（数字、顺序及所属音节必须相同）</label>
          <fieldset><legend>适用的明确记音字段</legend>
            <p v-if="!readingFields.length">请先在项目列角色中把适用字段标为“记音”。</p>
            <label v-for="field in readingFields" :key="field" class="fidelity-check"><input v-model="form.reading_fields" type="checkbox" :value="field"> {{ field }}</label>
          </fieldset>
          <label class="form-label">设置／变更依据<input v-model="form.reason" class="form-control" required maxlength="2000"></label>
          <button class="btn btn-primary mt-3" :disabled="busy">保存新版本约定</button>
        </form>
        <details class="mt-3"><summary>约定历史（{{ policyHistory.length }}）</summary><ul><li v-for="item in policyHistory" :key="item.id">{{ item.id }} · {{ item.at }} · {{ item.reason }}</li></ul></details>
      </section>
      <section class="card mb-4">
        <h2>集中问题处理</h2>
        <p v-if="!problems.items.length" class="empty-state-text">暂无报告。</p>
        <label class="form-label">合并／拆分依据<input v-model="groupReason" class="form-control" maxlength="2000"></label>
        <div class="fidelity-actions">
          <button class="btn btn-secondary" :disabled="busy || selection.length < 2" @click="group(false)">合并到所选第一份报告的事项</button>
          <button class="btn btn-secondary" :disabled="busy || !selection.length" @click="group(true)">拆分所选报告为新事项</button>
        </div>
        <article v-for="issue in activeIssues" :key="issue.id" class="fidelity-issue">
          <h3>{{ PROBLEM_STATES[issue.status] }} · {{ issue.report_count }} 份报告</h3>
          <ul><li v-for="report in reportsFor(issue.id)" :key="report.id">
            <label><input v-model="selection" type="checkbox" :value="report.id"> 第 {{ report.page_number }} 条 · {{ report.field || '整条' }} · {{ PROBLEM_TYPES[report.category] }}<span v-if="report.blocking"> · 阻塞</span></label>
            <p>{{ report.description }}<span v-if="report.stale">（来源或配置已变更，须复核适用性）</span></p>
          </li></ul>
          <form @submit.prevent="saveIssue(issue.id)">
            <label class="form-label">状态<select v-model="issueEdits[issue.id].status" class="form-control"><option v-for="(label, key) in PROBLEM_STATES" :key="key" :value="key">{{ label }}</option></select></label>
            <label class="form-label">具体共同原因<input v-model="issueEdits[issue.id].cause" class="form-control" maxlength="2000"></label>
            <label class="form-label">负责人<input v-model="issueEdits[issue.id].owner" class="form-control" maxlength="500"></label>
            <label class="form-label">技术跟进位置（可选）<input v-model="issueEdits[issue.id].external_ref" class="form-control" maxlength="1000"></label>
            <label class="form-label">受理反馈／实际处理<textarea v-model="issueEdits[issue.id].feedback" class="form-control" required maxlength="4000" placeholder="例如启用哪个现有键盘、修正哪条提示条件，或说明无需修改的原因"></textarea></label>
            <label class="form-label">影响范围<input v-model="issueEdits[issue.id].impact" class="form-control" maxlength="2000"></label>
            <label class="form-label">给项目成员的公共说明（可选）<textarea v-model="issueEdits[issue.id].public_note" class="form-control" maxlength="4000" placeholder="只填写可公开的工具说明，不包含他人的独立答案"></textarea></label>
            <button class="btn btn-primary mt-3" :disabled="busy">保存处理与反馈</button>
          </form>
        </article>
      </section>
      <section class="card mb-4">
        <h2>来源核验与复核入口</h2>
        <p>一致通过或已有提交的条目可补录来源正误，无需制造分歧；只核验部分字段时保留其余未核实状态。</p>
        <p v-if="!summary.length" class="empty-state-text">暂无条目。</p>
        <ul class="fidelity-queue"><li v-for="item in summary" :key="item.id">
          第 {{ item.page_number }} 条 · {{ item.source_empty ? '空记录／不适用' : item.business_complete ? '业务已完成' : '业务未完成' }} · 来源判断 {{ item.field_denominator }}/{{ item.required_fields }} 字段
          <strong v-if="item.needs_review"> · 依据变更需复核</strong><span v-if="item.pending_review"> · 判断暂缓</span>
          <RouterLink v-if="['approved', 'proofread', 'arbitration'].includes(item.status)" class="btn btn-secondary btn-sm" :to="`/admin/projects/${projectId}/arbitration/${item.id}${item.status === 'arbitration' ? '' : '?mode=verification'}`">{{ item.status === 'arbitration' ? '仲裁' : '来源核验' }}</RouterLink>
          <button class="btn btn-quiet btn-sm" :disabled="busy" @click="openEmpty(item)">{{ item.source_empty ? '撤回空记录确认' : '确认整条空记录／不适用' }}</button>
        </li></ul>
      </section>
      <section class="card">
        <h2>内容与过程导出</h2>
        <p>内容保留最终实际写法和合法空白；全量文件含状态列，未完成时明确标记为导入值回退。过程文件保留所有条目、原始提交及判断历史。</p>
        <div class="fidelity-actions">
          <button class="btn btn-primary" :disabled="busy" @click="download('all')">项目全量 CSV（含状态）</button>
          <button class="btn btn-primary" :disabled="busy" @click="download('completed')">业务已完成 CSV</button>
          <button class="btn btn-secondary" :disabled="busy" @click="download('source_reviewed')">全部字段已明确来源复核 CSV</button>
          <button class="btn btn-secondary" :disabled="busy" @click="download('all', true)">关联过程与研究记录 JSON</button>
        </div>
      </section>
    </template>
    <AppModal :open="Boolean(emptyTarget)" title-id="empty-source-title" :close-on-backdrop="!busy" :close-on-esc="!busy" @close="emptyTarget = null">
      <h2 id="empty-source-title">{{ emptyTarget?.source_empty ? '撤回空记录确认' : '确认整条空记录／不适用' }}</h2>
      <p>第 {{ emptyTarget?.page_number }} 条。此处理保留依据和历史，不计为已校对成品。</p>
      <form id="empty-source-form" @submit.prevent="markEmpty">
        <label class="form-label">来源 PDF 位置及确认依据<textarea v-model="emptyReason" class="form-control" required maxlength="2000"></textarea></label>
      </form>
      <template #actions>
        <button class="btn btn-secondary" :disabled="busy" @click="emptyTarget = null">取消</button>
        <button class="btn btn-primary" form="empty-source-form" type="submit" :disabled="busy || !emptyReason.trim()">{{ busy ? '正在保存…' : '保存空记录处理' }}</button>
      </template>
    </AppModal>
  </main>
</template>
<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import AppModal from '@/components/AppModal.vue'
import { getColumnRoles } from '@/services/projectsService'
import { getVerificationPolicy, saveVerificationPolicy, getProjectProblems, updateProblem, groupProblems, getVerificationSummary, exportVerification, getVerification, confirmEmptySource, PROBLEM_STATES, PROBLEM_TYPES } from '@/services/verificationService'
import { getPbMessage } from '@/utils/pbErrors'
import { downloadText } from '@/lib/downloadText'
const projectId = String(useRoute().params.id)
const loading = ref(false)
const loaded = ref(false)
const busy = ref(false)
const loadError = ref('')
const operationError = ref('')
const message = ref('')
const policy = ref(null)
const policyHistory = ref([])
const readingFields = ref([])
const problems = ref({ items: [], issues: [] })
const issueEdits = reactive({})
const summary = ref([])
const selection = ref([])
const groupReason = ref('')
const emptyTarget = ref(null)
const emptyReason = ref('')
const form = reactive({ instructions: '', tone_equivalence: false, reading_fields: [], reason: '' })
const activeIssues = computed(() => problems.value.issues.filter(issue => issue.report_count > 0))
const reportsFor = id => problems.value.items.filter(report => report.issue.id === id)
onMounted(load)
async function load() {
  loading.value = true; loadError.value = ''
  try {
    const results = await Promise.allSettled([getVerificationPolicy(projectId), getColumnRoles(projectId), getProjectProblems(projectId), getVerificationSummary(projectId)])
    for (const result of results) if (result.status === 'rejected') throw result.reason
    const [p, roles, issues, queue] = results.map(result => result.value)
    policy.value = p.current; policyHistory.value = p.history
    form.instructions = p.current?.instructions || p.default_instructions
    form.tone_equivalence = p.current?.tone_equivalence || false
    form.reading_fields = p.current?.reading_fields || []
    readingFields.value = (roles.columns || []).filter(item => item.role === 'reading' && item.present).map(item => item.name)
    problems.value = issues; summary.value = queue.items
    for (const issue of issues.issues) issueEdits[issue.id] = { ...issue }
    loaded.value = true
  } catch (e) { loadError.value = getPbMessage(e, '加载来源核验工作区失败') }
  finally { loading.value = false }
}
async function act(fn, success) {
  busy.value = true; operationError.value = ''; message.value = ''
  try { await fn(); message.value = success; await load() } catch (e) { operationError.value = getPbMessage(e, '保存失败，请重试') } finally { busy.value = false }
}
async function savePolicy() { await act(() => saveVerificationPolicy(projectId, { ...form }), '新约定版本已保存，旧依据仍保留。'); form.reason = '' }
async function saveIssue(id) { await act(() => updateProblem(projectId, id, issueEdits[id]), '处理与反馈已保存；词条内容状态未自动变更。') }
async function group(split) {
  const target = split ? '' : problems.value.items.find(report => report.id === selection.value[0])?.issue.id
  await act(() => groupProblems(projectId, { reports: selection.value, issue: target, reason: groupReason.value }), '报告关联已更新，原报告与历史保留。')
  if (!operationError.value) selection.value = []
}
function openEmpty(item) { emptyTarget.value = item; emptyReason.value = '' }
async function markEmpty() {
  const item = emptyTarget.value
  const reason = emptyReason.value.trim()
  if (!item || !reason) return
  await act(async () => {
    const data = await getVerification(item.id)
    await confirmEmptySource(item.id, { basis: data.context.basis, empty: !item.source_empty, reason })
  }, '空记录处理已保存；不计为已校对成品。')
  if (!operationError.value) emptyTarget.value = null
}
async function download(mode, process = false) {
  busy.value = true; operationError.value = ''; message.value = ''
  try {
    const result = await exportVerification(projectId, mode)
    if (process) { const { csv, ...bundle } = result; void csv; downloadText(JSON.stringify(bundle, null, 2), `${projectId}_过程记录.json`, 'application/json') }
    else downloadText(result.csv, `${projectId}_${mode}.csv`, 'text/csv;charset=utf-8')
    message.value = process ? '关联过程已导出，包含未完成、无提示及未记录状态。' : `已导出 ${result.selected_count} 条内容。`
  } catch (e) { operationError.value = getPbMessage(e, '导出失败') } finally { busy.value = false }
}
</script>
<style scoped>
.fidelity-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-3); }
.fidelity-check { display: inline-block; margin-right: var(--space-3); }
.fidelity-issue { border-top: 1px solid var(--line); margin-top: var(--space-4); padding-top: var(--space-3); }
.form-label { display: block; margin-top: var(--space-2); }
.fidelity-queue li { margin-bottom: var(--space-2); }
</style>
