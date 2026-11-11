<template>
  <main class="container page workspace-page project-workspace-page">
    <header class="page-heading project-detail-heading">
      <div>
        <RouterLink :to="`/admin/projects/${projectId}?section=work&view=queue`" class="back-link"
          >← 待办队列</RouterLink
        >
        <h1>
          {{
            view === 'review'
              ? '来源复核'
              : view === 'policy'
                ? '来源核验约定'
                : view === 'export'
                  ? '来源与过程记录'
                  : '问题处理'
          }}
        </h1>
        <p v-if="view === 'problems'">
          处理成员报告，记录原因与反馈；工具问题解决后，内容仍须逐字段核对。
        </p>
      </div>
    </header>
    <ProjectWorkspaceNav
      :project-id="projectId"
      :active="view === 'policy' ? 'settings' : view === 'export' ? 'delivery' : 'work'"
    />
    <nav v-if="['problems', 'review'].includes(view)" class="project-subnav" aria-label="校勘待办">
      <RouterLink
        :to="{ query: { view: 'problems' } }"
        :class="{ 'is-active': view === 'problems' }"
        :aria-current="view === 'problems' ? 'page' : undefined"
        >问题处理</RouterLink
      >
      <RouterLink
        :to="{ query: { view: 'review' } }"
        :class="{ 'is-active': view === 'review' }"
        :aria-current="view === 'review' ? 'page' : undefined"
        >来源复核</RouterLink
      >
    </nav>
    <template v-if="view === 'policy'">
      <p class="mb-4">
        <RouterLink :to="`/admin/projects/${projectId}/settings?view=rules`"
          >核验约定现位于项目设置 →</RouterLink
        >
      </p>
      <ProjectVerificationPolicy :project-id="projectId" />
    </template>
    <ProjectProcessExport v-else-if="view === 'export'" :project-id="projectId" />
    <template v-else>
      <AppStatusPanel v-if="loading && !loaded" state="pending" message="正在加载待办…" />
      <AppStatusPanel
        v-if="loadError"
        state="error"
        :message="loadError"
        retry-label="重试"
        :busy="loading"
        @retry="load"
      />
      <p v-if="operationError" class="alert alert-error" role="alert">{{ operationError }}</p>
      <p v-if="message" class="alert alert-success" role="status">{{ message }}</p>
      <template v-if="loaded && view === 'problems'">
        <div class="project-entry-filterbar">
          <AppField label="显示范围"
            ><select v-model="problemScope" class="form-control" :disabled="busy">
              <option value="todo">未处理完成</option>
              <option value="all">全部事项（含已处理）</option>
            </select></AppField
          ><button class="btn btn-secondary" :disabled="loading || busy" @click="load">
            刷新事项
          </button>
        </div>
        <AppStatusPanel
          v-if="!activeIssues.length"
          state="empty"
          reason="none"
          :message="
            problemScope === 'todo'
              ? '暂无未处理事项，可切换范围查看已处理历史。'
              : '暂无成员报告。'
          "
        />
        <template v-else>
          <section v-if="selection.length" class="card mb-4" aria-label="报告批量处理">
            <div class="section-heading">
              <h2>{{ selection.length }} 份报告已选择</h2>
              <button class="btn btn-quiet" :disabled="busy" @click="selection = []">
                取消选择
              </button>
            </div>
            <AppField label="合并／拆分依据"
              ><input v-model="groupReason" class="form-control" maxlength="2000"
            /></AppField>
            <div class="fidelity-actions">
              <button
                class="btn btn-secondary"
                :disabled="busy || selection.length < 2 || !groupReason.trim()"
                @click="group(false)"
              >
                合并到所选第一份报告的事项</button
              ><button
                class="btn btn-secondary"
                :disabled="busy || !groupReason.trim()"
                @click="group(true)"
              >
                拆分为新事项
              </button>
            </div>
          </section>
          <AppField label="选择问题事项" class="project-mobile-issue-picker"
            ><select v-model="selectedIssueId" class="form-control" aria-label="选择问题事项">
              <option v-for="issue in activeIssues" :key="issue.id" :value="issue.id">
                {{ issue.cause || reportsFor(issue.id)[0]?.description || '待确认问题' }} ·
                {{ PROBLEM_STATES[issue.status] }}
              </option>
            </select></AppField
          >
          <div class="project-issue-layout">
            <ul class="project-issue-list" aria-label="问题事项">
              <li v-for="issue in activeIssues" :key="issue.id">
                <button
                  :aria-pressed="selectedIssueId === issue.id"
                  @click="selectedIssueId = issue.id"
                >
                  <strong>{{
                    issue.cause || reportsFor(issue.id)[0]?.description || '待确认问题'
                  }}</strong
                  ><span>{{ PROBLEM_STATES[issue.status] }} · {{ issue.report_count }} 份报告</span>
                </button>
              </li>
            </ul>
            <article v-if="selectedIssue" class="card">
              <div class="section-heading">
                <h2>{{ PROBLEM_STATES[selectedIssue.status] }}</h2>
                <span class="text-sm text-muted">{{ selectedIssue.report_count }} 份报告</span>
              </div>
              <ul class="fidelity-report-list">
                <li v-for="report in reportsFor(selectedIssue.id)" :key="report.id">
                  <label
                    ><input v-model="selection" type="checkbox" :value="report.id" /> 第
                    {{ report.page_number }} 条 · {{ report.field || '整条' }} ·
                    {{ PROBLEM_TYPES[report.category]
                    }}<strong v-if="report.blocking"> · 阻塞</strong></label
                  >
                  <p>{{ report.description }}</p>
                  <p v-if="report.stale" class="text-sm text-muted">
                    来源或配置已变更，须复核适用性。
                  </p>
                </li>
              </ul>
              <div v-if="issueConflicts[selectedIssue.id]" class="alert alert-warning" role="alert">
                <p>
                  此事项已被其他人更新。你的未保存修改已保留，请先保留需要的文字，再采用最新记录重新编辑。
                </p>
                <button
                  class="btn btn-secondary"
                  :disabled="busy"
                  @click="adoptLatestIssue(selectedIssue.id)"
                >
                  采用最新记录
                </button>
              </div>
              <form @submit.prevent="saveIssue(selectedIssue.id)">
                <AppField label="状态"
                  ><select v-model="issueEdits[selectedIssue.id].status" class="form-control">
                    <option v-for="(label, key) in PROBLEM_STATES" :key="key" :value="key">
                      {{ label }}
                    </option>
                  </select></AppField
                >
                <AppField label="具体共同原因"
                  ><input
                    v-model="issueEdits[selectedIssue.id].cause"
                    class="form-control"
                    maxlength="2000"
                /></AppField>
                <AppField label="负责人"
                  ><input
                    v-model="issueEdits[selectedIssue.id].owner"
                    class="form-control"
                    maxlength="500"
                /></AppField>
                <AppField label="受理反馈／实际处理">
                  <textarea
                    v-model="issueEdits[selectedIssue.id].feedback"
                    class="form-control"
                    required
                    maxlength="4000"
                    placeholder="记录实际处理，或说明无需修改的原因"
                  ></textarea>
                </AppField>
                <AppField label="影响范围"
                  ><input
                    v-model="issueEdits[selectedIssue.id].impact"
                    class="form-control"
                    maxlength="2000"
                /></AppField>
                <details class="mb-4">
                  <summary>技术跟进与公共说明</summary>
                  <AppField label="技术跟进位置（可选）"
                    ><input
                      v-model="issueEdits[selectedIssue.id].external_ref"
                      class="form-control"
                      maxlength="1000" /></AppField
                  ><AppField label="给项目成员的公共说明（可选）">
                    <textarea
                      v-model="issueEdits[selectedIssue.id].public_note"
                      class="form-control"
                      maxlength="4000"
                      placeholder="仅包含可公开的工具说明，不包含他人的独立答案"
                    ></textarea>
                  </AppField>
                </details>
                <button
                  class="btn btn-primary"
                  :disabled="busy || loading || issueConflicts[selectedIssue.id]"
                >
                  {{ busy ? '正在保存…' : '保存处理与反馈' }}
                </button>
              </form>
            </article>
          </div>
        </template>
      </template>
      <section v-if="loaded && view === 'review'" aria-label="来源复核条目">
        <div class="project-entry-filterbar">
          <AppField label="显示范围"
            ><select v-model="reviewScope" class="form-control">
              <option value="todo">待完成或需复核</option>
              <option value="all">全部条目</option>
            </select></AppField
          ><button class="btn btn-secondary" :disabled="loading" @click="load">刷新队列</button>
        </div>
        <p class="text-sm text-muted mb-4">
          已有提交或一致通过的条目可直接补录来源判断；只核验部分字段时，其余保留未核实。
        </p>
        <AppStatusPanel
          v-if="!reviewItems.length"
          state="empty"
          reason="none"
          :message="summary.length ? '当前范围没有待复核条目，可切换查看全部。' : '暂无条目。'"
        />
        <ul v-else class="project-review-list">
          <li v-for="item in reviewItems" :key="item.id">
            <div class="project-review-context">
              <strong>第 {{ item.page_number }} 条</strong
              ><span
                >{{
                  item.source_empty
                    ? '空记录／不适用'
                    : item.business_complete
                      ? '业务已完成'
                      : '业务未完成'
                }}
                · 来源判断 {{ item.field_denominator }}/{{ item.required_fields }} 字段</span
              ><span v-if="item.needs_review">依据变更需复核</span
              ><span v-if="item.pending_review">判断暂缓</span>
            </div>
            <RouterLink
              v-if="['approved', 'proofread', 'arbitration'].includes(item.status)"
              class="btn btn-secondary btn-sm"
              :to="sourceReviewTarget(projectId, item, reviewScope)"
              >{{ item.status === 'arbitration' ? '仲裁' : '来源核验' }}</RouterLink
            >
            <button class="btn btn-quiet btn-sm" :disabled="busy" @click="openEmpty(item)">
              {{ item.source_empty ? '撤回空记录确认' : '整条为空／不适用' }}
            </button>
          </li>
        </ul>
      </section>
    </template>
    <AppModal
      :open="Boolean(emptyTarget)"
      title-id="empty-source-title"
      :close-on-backdrop="!busy"
      :close-on-esc="!busy"
      @close="emptyTarget = null"
    >
      <h2 id="empty-source-title">
        {{ emptyTarget?.source_empty ? '撤回空记录确认' : '确认整条空记录／不适用' }}
      </h2>
      <p>第 {{ emptyTarget?.page_number }} 条。保留依据和历史，不计为已校对成品。</p>
      <form id="empty-source-form" @submit.prevent="markEmpty">
        <AppField label="来源 PDF 位置及确认依据">
          <textarea v-model="emptyReason" class="form-control" required maxlength="2000"></textarea>
        </AppField>
      </form>
      <template #actions
        ><button class="btn btn-secondary" :disabled="busy" @click="emptyTarget = null">取消</button
        ><button
          class="btn btn-primary"
          form="empty-source-form"
          type="submit"
          :disabled="busy || !emptyReason.trim()"
        >
          {{ busy ? '正在保存…' : '保存空记录处理' }}
        </button></template
      >
    </AppModal>
    <WorkspaceLeaveGuard :dirty="problemsDirty" />
  </main>
</template>
<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import AppModal from '@/components/AppModal.vue'
import AppField from '@/components/AppField.vue'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import ProjectWorkspaceNav from '@/components/admin/project/ProjectWorkspaceNav.vue'
import WorkspaceLeaveGuard from '@/components/admin/project/WorkspaceLeaveGuard.vue'
import ProjectVerificationPolicy from '@/components/admin/project/ProjectVerificationPolicy.vue'
import ProjectProcessExport from '@/components/admin/project/ProjectProcessExport.vue'
import {
  getProjectProblems,
  updateProblem,
  groupProblems,
  getVerificationSummary,
  getVerification,
  confirmEmptySource,
  PROBLEM_STATES,
  PROBLEM_TYPES
} from '@/services/verificationService'
import { getPbMessage } from '@/utils/pbErrors'
import { useQueueReturnPosition } from '@/composables/useQueueReturnPosition'
import { sourceReviewItems, sourceReviewTarget } from '@/lib/sourceReviewQueue'
import { projectProblemItems } from '@/lib/projectWorkflow'
const route = useRoute()
const router = useRouter()
const projectId = String(route.params.id)
const view = computed(() =>
  ['problems', 'review', 'policy', 'export'].includes(route.query.view)
    ? route.query.view
    : 'problems'
)
const loading = ref(false)
const loaded = ref(false)
const busy = ref(false)
const loadError = ref('')
const operationError = ref('')
const message = ref('')
const problems = ref({ items: [], issues: [] })
const issueEdits = reactive({})
const issueBaselines = reactive({})
const issueConflicts = reactive({})
const summary = ref([])
const selection = ref([])
const groupReason = ref('')
const selectedIssueId = ref('')
const reviewScope = computed({
  get: () => (route.query.reviewScope === 'all' ? 'all' : 'todo'),
  set: (value) =>
    router.replace({ query: { ...route.query, reviewScope: value === 'all' ? 'all' : undefined } })
})
const problemScope = computed({
  get: () => (route.query.problemScope === 'todo' ? 'todo' : 'all'),
  set: (value) =>
    router.replace({ query: { ...route.query, problemScope: value === 'todo' ? 'todo' : 'all' } })
})
const emptyTarget = ref(null)
const emptyReason = ref('')
const activeIssues = computed(() => projectProblemItems(problems.value.issues, problemScope.value))
const selectedIssue = computed(() =>
  activeIssues.value.find((issue) => issue.id === selectedIssueId.value)
)
watch(activeIssues, (issues) => {
  const visible = new Set(issues.map((issue) => issue.id))
  if (!visible.has(selectedIssueId.value)) selectedIssueId.value = issues[0]?.id || ''
  selection.value = selection.value.filter((id) =>
    problems.value.items.some((report) => report.id === id && visible.has(report.issue.id))
  )
})
const reviewItems = computed(() => sourceReviewItems(summary.value, reviewScope.value))
const reportsFor = (id) => problems.value.items.filter((report) => report.issue.id === id)
const issueSignature = (item) =>
  JSON.stringify(
    ['status', 'cause', 'owner', 'external_ref', 'feedback', 'impact', 'public_note'].map(
      (key) => item?.[key] || ''
    )
  )
const issueVersion = (item) => JSON.stringify([item?.updated || '', issueSignature(item)])
const problemsDirty = computed(
  () =>
    Object.entries(issueEdits).some(
      ([id, edit]) => issueSignature(edit) !== issueSignature(issueBaselines[id])
    ) || !!(emptyTarget.value && emptyReason.value.trim())
)
function syncIssue(issue) {
  const id = issue.id
  const baseline = issueBaselines[id]
  const edit = issueEdits[id]
  if (
    !baseline ||
    issueSignature(edit) === issueSignature(baseline) ||
    issueSignature(edit) === issueSignature(issue)
  ) {
    issueEdits[id] = { ...issue }
    issueBaselines[id] = { ...issue }
    delete issueConflicts[id]
  } else if (issueVersion(issue) !== issueVersion(baseline)) {
    issueConflicts[id] = true
  }
}
function adoptLatestIssue(id) {
  const issue = problems.value.issues.find((item) => item.id === id)
  if (!issue || busy.value) return
  issueEdits[id] = { ...issue }
  issueBaselines[id] = { ...issue }
  delete issueConflicts[id]
}
useQueueReturnPosition(loaded)
let generation = 0
let disposed = false
watch(
  view,
  () => {
    loaded.value = false
    load()
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  disposed = true
  generation++
})
async function load() {
  const token = ++generation
  const requested = view.value
  if (!['problems', 'review'].includes(requested)) return
  loading.value = true
  loadError.value = ''
  try {
    const result =
      requested === 'problems'
        ? await getProjectProblems(projectId)
        : await getVerificationSummary(projectId)
    if (disposed || token !== generation) return
    if (requested === 'problems') {
      problems.value = result
      for (const issue of result.issues) syncIssue(issue)
    } else summary.value = result.items
    loaded.value = true
  } catch (error) {
    if (!disposed && token === generation) loadError.value = getPbMessage(error, '加载待办失败。')
  } finally {
    if (!disposed && token === generation) loading.value = false
  }
}
async function act(fn, success) {
  if (busy.value) return
  busy.value = true
  operationError.value = ''
  message.value = ''
  try {
    await fn()
    if (disposed) return
    message.value = success
    await load()
  } catch (error) {
    if (!disposed) operationError.value = getPbMessage(error, '保存失败，请重试。')
  } finally {
    if (!disposed) busy.value = false
  }
}
async function saveIssue(id) {
  if (busy.value || loading.value || issueConflicts[id] || !issueEdits[id]) return
  const submitted = { ...issueEdits[id] }
  await act(async () => {
    const saved = await updateProblem(projectId, id, submitted)
    if (disposed) return
    issueBaselines[id] = { ...saved }
    if (issueSignature(issueEdits[id]) === issueSignature(submitted)) issueEdits[id] = { ...saved }
    delete issueConflicts[id]
  }, '处理与反馈已保存；词条内容状态未自动变更。')
}
async function group(split) {
  const target = split
    ? ''
    : problems.value.items.find((report) => report.id === selection.value[0])?.issue.id
  await act(
    () =>
      groupProblems(projectId, {
        reports: [...selection.value],
        issue: target,
        reason: groupReason.value
      }),
    '报告关联已更新，原报告与历史保留。'
  )
  if (!operationError.value) selection.value = []
}
function openEmpty(item) {
  emptyTarget.value = item
  emptyReason.value = ''
}
async function markEmpty() {
  const item = emptyTarget.value
  const reason = emptyReason.value.trim()
  if (!item || !reason) return
  await act(async () => {
    const data = await getVerification(item.id)
    await confirmEmptySource(item.id, {
      basis: data.context.basis,
      empty: !item.source_empty,
      reason
    })
  }, '空记录处理已保存；不计为已校对成品。')
  if (!operationError.value) emptyTarget.value = null
}
</script>
<style scoped>
.fidelity-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.fidelity-report-list {
  list-style: none;
  display: grid;
  gap: var(--space-3);
  margin-bottom: var(--space-5);
}
.fidelity-report-list li {
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--line);
}
.fidelity-report-list p {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  margin-top: var(--space-2);
  line-height: 1.6;
}
</style>
