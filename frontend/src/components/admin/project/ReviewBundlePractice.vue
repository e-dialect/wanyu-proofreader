<template>
  <section
    id="review-bundle-practice"
    class="guide-section practice"
    tabindex="-1"
    aria-labelledby="bundle-practice-title"
  >
    <header class="practice-heading">
      <h2 id="bundle-practice-title">完整资料包练习</h2>
      <p>用 3 条虚构材料和 3 页原文，演练管理员与两位校对者之间的交接。</p>
    </header>

    <div class="practice-roles" role="group" aria-label="选择练习角色">
      <button
        v-for="item in roles"
        :key="item.id"
        class="btn"
        :class="role === item.id ? 'btn-primary' : 'btn-secondary'"
        type="button"
        :aria-pressed="role === item.id"
        @click="changeContext({ role: item.id, step: null })"
      >
        {{ item.label }}
      </button>
    </div>

    <div class="practice-scope">
      <div>
        <h3>
          {{ project ? project.name : projectPending ? '正在核对练习项目' : '先选择练习项目' }}
        </h3>
        <p v-if="project" class="text-sm text-muted">练习项目 · 使用虚构材料</p>
        <p v-else-if="!projectPending" class="text-sm text-muted">{{ projectHint }}</p>
      </div>
      <div class="practice-project-actions">
        <AppSelect
          v-if="projectOptions.length"
          :model-value="project?.id || ''"
          :options="projectOptions"
          aria-label="选择练习项目"
          placeholder="选择练习项目"
          @update:model-value="changeContext({ projectId: $event })"
        />
        <RouterLink
          v-if="role === 'manager' && auth.canCreateProjects"
          :to="createTarget"
          class="btn"
          :class="project ? 'btn-secondary' : 'btn-primary'"
          >{{ project ? '创建另一个练习项目' : '创建练习项目' }}</RouterLink
        >
      </div>
      <p v-if="!projectPending && requestedId && projectError" class="text-sm" role="alert">
        {{ projectError }}
        <AppButton variant="ghost" size="sm" @click="loadProject(requestedId, role, auth.user?.id)"
          >重试</AppButton
        >
      </p>
      <p v-if="choicesError" class="text-sm" role="alert">
        暂时无法读取练习项目。
        <AppButton variant="ghost" size="sm" @click="loadChoices">重试</AppButton>
      </p>
    </div>

    <details class="practice-materials">
      <summary>下载虚构练习材料</summary>
      <div class="practice-downloads" aria-label="完整练习材料">
        <a href="/examples/review-bundle-practice-v1.zip" download class="btn btn-secondary">
          完整练习包（3 条）
        </a>
        <a href="/examples/review-bundle-practice-v1/source.pdf" download class="btn btn-secondary">
          配套原文 PDF（3 页）
        </a>
        <a href="/examples/review-bundle-practice-v1/README.txt" download class="practice-link">
          逐步练习说明
        </a>
      </div>
    </details>

    <nav class="practice-checklist" :aria-label="`${selectedRole.label}练习步骤`">
      <h3>{{ selectedRole.label }}练习步骤</h3>
      <ol class="practice-steps">
        <li
          v-for="step in steps"
          :key="step.id"
          :class="{ 'practice-step-current': step.id === stepId }"
        >
          <button
            class="practice-step-label"
            type="button"
            :aria-expanded="step.id === stepId"
            :id="`practice-heading-${step.id}`"
            :aria-controls="`practice-step-${step.id}`"
            @click="changeContext({ step: step.id })"
          >
            <strong>{{ step.title }}</strong>
            <span v-if="step.id === stepId" class="practice-current-label">当前查看</span>
            <AppIcon v-else name="chevron" />
          </button>
          <div
            v-show="step.id === stepId"
            :id="`practice-step-${step.id}`"
            class="practice-step-content"
          >
            <p>{{ step.detail }}</p>
            <details v-if="step.id === 'register'" class="practice-technical">
              <summary>核对来源标识</summary>
              <p>练习包的来源标识为 <code>practice-wanyu-reviewbundle-v1</code>。</p>
            </details>
            <dl v-if="stepFacts.length && project" class="practice-facts" aria-label="项目记录">
              <div v-for="item in stepFacts" :key="item.key">
                <dt>{{ item.label }}</dt>
                <dd>{{ item.value }}</dd>
              </div>
            </dl>
            <p v-if="project && factsPending" class="text-sm text-muted" role="status">
              正在读取项目记录…
            </p>
            <p v-else-if="project && factsError" class="text-sm" role="alert">
              项目记录未更新。
              <AppButton variant="ghost" size="sm" @click="refreshFacts">重新读取</AppButton>
            </p>
            <div class="practice-step-actions">
              <RouterLink v-if="step.target" :to="step.target" class="btn btn-primary btn-sm">
                {{ step.link }} <AppIcon name="arrow" />
              </RouterLink>
              <AppButton
                v-if="step.id === 'coordinate' && project"
                variant="secondary"
                size="sm"
                @click="copyProofreaderLink"
                >复制校对者练习链接</AppButton
              >
              <button v-if="nextStep" class="practice-link" type="button" @click="goToNextStep">
                查看下一步
              </button>
            </div>
            <p v-if="step.id === 'coordinate' && shareMessage" class="text-sm" role="status">
              {{ shareMessage }}
            </p>
            <input
              v-if="step.id === 'coordinate' && shareUrl"
              :value="shareUrl"
              class="form-control practice-share-url"
              aria-label="校对者练习链接"
              readonly
              @focus="$event.target.select()"
            />
          </div>
        </li>
      </ol>
    </nav>

    <div class="practice-exit">
      <div>
        <h3>转入正式工作</h3>
        <p>在列表选择正式项目。练习记录留在本练习项目。</p>
      </div>
      <RouterLink :to="role === 'proofreader' ? '/tasks' : '/admin'" class="btn btn-secondary">
        {{ role === 'proofreader' ? '返回我的任务' : '返回管理项目' }}
      </RouterLink>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import AppButton from '@/components/AppButton.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppSelect from '@/components/AppSelect.vue'
import { useAsyncResource } from '@/composables/useAsyncResource'
import { projectWorkspaceTarget } from '@/lib/projectWorkspace'
import {
  canUsePracticeProject,
  practiceGuideTarget,
  practiceNavigationQuery,
  practiceProjectId,
  practiceRole,
  practiceStep
} from '@/lib/practiceContext'
import { getPracticeProgress, getProject, listProjects } from '@/services/projectsService'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const roles = [
  { id: 'manager', label: '项目管理员' },
  { id: 'proofreader', label: '校对者' },
  { id: 'platform', label: '平台管理员' }
]
const role = computed(() => practiceRole(route.query.practiceRole))
const selectedRole = computed(() => roles.find((item) => item.id === role.value))
const stepId = computed(() => practiceStep(role.value, route.query.practiceStep))
const requestedId = computed(() => practiceProjectId(route.query.practiceProject))
const mayUseProject = (item) => canUsePracticeProject(item, role.value, auth.isPlatformAdmin)

const {
  data: projectResult,
  pending: projectPending,
  error: projectError,
  reload: loadProject,
  cancel: cancelProject
} = useAsyncResource(
  async ({ signal }, id, roleAtRead, userId) => {
    const item = await getProject(id, { signal })
    if (item?.id !== id || !canUsePracticeProject(item, roleAtRead, auth.isPlatformAdmin))
      throw new Error('该链接未指向你当前可用的练习项目，请重新选择。')
    return { item, role: roleAtRead, userId }
  },
  {
    formatError: (cause) =>
      cause?.message === '该链接未指向你当前可用的练习项目，请重新选择。'
        ? cause.message
        : '无法核对这个练习项目，请重新选择或请管理员检查成员权限。'
  }
)

const project = computed(() => {
  const current = projectResult.value
  return !projectError.value &&
    !projectPending.value &&
    current?.item.id === requestedId.value &&
    current.role === role.value &&
    current.userId === auth.user?.id &&
    mayUseProject(current.item)
    ? current.item
    : null
})
defineExpose({ project })
const {
  data: choices,
  error: choicesError,
  reload: readChoices
} = useAsyncResource(async ({ signal }, currentRole, userId) => ({
  currentRole,
  userId,
  items: await listProjects({
    scope: currentRole === 'proofreader' ? 'proofreading' : 'managed',
    signal
  })
}))
const loadChoices = () => readChoices(role.value, auth.user?.id)
const projectOptions = computed(() =>
  choices.value?.currentRole === role.value && choices.value.userId === auth.user?.id
    ? choices.value.items
        .filter(mayUseProject)
        .map((item) => ({ value: item.id, label: item.name }))
    : []
)
const {
  data: factsResult,
  pending: factsPending,
  error: factsError,
  reload: loadFacts,
  cancel: cancelFacts
} = useAsyncResource(async ({ signal }, id, userId) => {
  const data = await getPracticeProgress(id, { signal })
  if (data?.project_id !== id || data.purpose !== 'practice') throw new Error('练习记录不可用')
  return { ...data, userId }
})
const refreshFacts = () => project.value && loadFacts(project.value.id, auth.user?.id)
watch(
  [requestedId, role, () => auth.user?.id, () => auth.isPlatformAdmin],
  ([id, currentRole, userId], [, lastRole, lastUserId, lastPlatform]) => {
    if (!userId) {
      cancelProject()
      return
    }
    if (currentRole !== lastRole || userId !== lastUserId || auth.isPlatformAdmin !== lastPlatform)
      void loadChoices()
    if (id) void loadProject(id, currentRole, userId)
    else cancelProject()
  },
  { immediate: true }
)
watch([() => project.value?.id, () => auth.user?.id], ([id]) => {
  if (id) void refreshFacts()
  else cancelFacts()
})
const projectHint = computed(() => {
  if (role.value === 'proofreader')
    return '请管理员把你加入练习项目，再打开对方发来的练习链接或从这里选择。'
  if (role.value === 'platform') return '选择练习项目后，再核对这版虚构材料的来源与用途许可。'
  return '选择已有练习项目，或单独创建一个。正式项目用于日常材料与校勘。'
})
const createTarget = computed(() => ({
  path: '/admin/projects/new',
  query: {
    ...practiceGuideTarget({ role: 'manager', step: stepId.value }, route.query).query,
    purpose: 'practice'
  }
}))
const shareMessage = ref('')
const shareUrl = ref('')
async function copyProofreaderLink() {
  if (!project.value) return
  const target = practiceGuideTarget({
    projectId: project.value.id,
    role: 'proofreader',
    step: 'claim'
  })
  const url = new URL(router.resolve(target).href, window.location.origin).href
  shareUrl.value = ''
  try {
    await navigator.clipboard.writeText(url)
    shareMessage.value = '练习链接已复制。请发给已加入项目的校对者。'
  } catch {
    shareUrl.value = url
    shareMessage.value = '请选择并复制下方链接。'
  }
}
function changeContext(patch) {
  shareMessage.value = ''
  shareUrl.value = ''
  return router.replace(
    practiceGuideTarget(
      {
        projectId: requestedId.value,
        role: role.value,
        step: stepId.value,
        ...patch
      },
      route.query
    )
  )
}

const contextQuery = () =>
  practiceNavigationQuery({
    projectId: project.value?.id,
    role: role.value,
    step: stepId.value
  })
const projectPage = (page, query = {}) =>
  project.value
    ? {
        path: `/admin/projects/${project.value.id}/${page}`,
        query: { ...query, ...contextQuery() }
      }
    : undefined
const materials = (method) =>
  project.value
    ? projectWorkspaceTarget(project.value.id, 'materials', 'import', { method, ...contextQuery() })
    : undefined
const tasks = (view) =>
  project.value
    ? { path: '/tasks', query: { project: project.value.id, view, ...contextQuery() } }
    : undefined

const steps = computed(() => {
  if (role.value === 'proofreader') {
    return [
      {
        id: 'claim',
        title: '确认练习项目，领取任务',
        detail: '等项目管理员通知条目已导入并安排成员，再用你的练习账号领取。',
        target: tasks('available'),
        link: '查看可领取任务'
      },
      {
        id: 'proofread',
        title: '对照 PDF，独立校对并提交',
        detail:
          '先读来源核验约定，再核对同号原文的每个字段。保留疑点，不查看另一位校对者未公开的结果。',
        target: tasks('active'),
        link: '查看进行中的任务'
      },
      {
        id: 'reviewed',
        title: '回看自己的提交',
        detail: '核对提交记录，告知项目管理员你已完成的条目；发现分歧后由管理员处理。',
        target: tasks('reviewed'),
        link: '查看本人提交记录'
      }
    ]
  }

  if (role.value === 'platform') {
    return [
      {
        id: 'register',
        title: '核对来源登记，再通知项目管理员',
        detail: '在来源库核对这版虚构材料。若已有登记但资料不同，停止并保留原登记。',
        target:
          project.value && auth.isPlatformAdmin
            ? { path: '/admin/sources', query: contextQuery() }
            : undefined,
        link: '打开来源库'
      },
      {
        id: 'permissions',
        title: '核对用途和原始材料转交许可',
        detail:
          '分别记录本次用途与原始材料转交第三方的判断和依据。未知或禁止时，把阻断原因告知项目管理员。',
        target:
          project.value && auth.isPlatformAdmin
            ? { path: '/admin/sources', query: contextQuery() }
            : undefined,
        link: '打开来源库'
      }
    ]
  }

  return [
    {
      id: 'prepare',
      title: '准备独立项目和原文',
      detail: '在练习项目上传配套 PDF，等待校验完成并确认 3 页均可读。',
      target: materials('pdf'),
      link: '上传练习原文'
    },
    {
      id: 'import',
      title: '预检资料包，再确认导入',
      detail:
        '核对 3 条、页码和来源声明。请平台管理员核对来源登记，人工确认后导入并记下完整成功的批次。',
      target: materials('bundle'),
      link: '打开项目资料包导入'
    },
    {
      id: 'coordinate',
      title: '安排两位校对者',
      detail: '保存来源核验约定，在成员设置安排两名不同账号的校对者，再通知他们领取。',
      target: projectPage('settings', { view: 'members' }),
      link: '打开项目成员设置'
    },
    {
      id: 'resolve',
      title: '处理分歧并核验来源',
      detail: '收齐独立提交后，从待办队列处理分歧并补录来源判断、依据和页内位置。',
      target: project.value
        ? projectWorkspaceTarget(project.value.id, 'work', 'queue', contextQuery())
        : undefined,
      link: '打开项目待办队列'
    },
    {
      id: 'select',
      title: '核对许可和编选范围',
      detail:
        '请平台管理员分别核对用途及转交许可；未知或禁止时保留阻断。若可继续，只选本练习批次，核对采用、排除、待处理合计为 3。',
      target: projectPage('adoption'),
      link: '打开项目用途编选'
    },
    {
      id: 'deliver',
      title: '核查交付和回执状态',
      detail:
        '核对接收方、用途、范围和正文数后，由实际操作者判断是否出包。仅本地下载时保持待回执。',
      target: projectPage('deliveries'),
      link: '打开项目交付与回执'
    }
  ]
})

const nextStep = computed(
  () => steps.value[steps.value.findIndex((step) => step.id === stepId.value) + 1]
)
async function goToNextStep() {
  const id = nextStep.value?.id
  if (!id) return
  await changeContext({ step: id })
  await nextTick()
  if (stepId.value === id) document.getElementById(`practice-heading-${id}`)?.focus()
}
const factsByStep = {
  prepare: [['pdf_ready', '可读原文', '份']],
  import: [
    ['imported_batches', '已导入批次', '批'],
    ['entries', '已入册条目', '条']
  ],
  coordinate: [
    ['proofreader_members', '已安排校对者', '人'],
    ['independent_submitted', '达到独立提交人数', '条']
  ],
  resolve: [['arbitration_recorded', '本轮仲裁记录', '条']],
  select: [['confirmed_adoptions', '已确认编选', '批']],
  deliver: [['delivery_packages', '已生成交付包', '包']],
  claim: [
    ['entries', '练习项目条目', '条'],
    ['own_active_claims', '本人正在处理', '条']
  ],
  proofread: [
    ['own_active_claims', '本人正在处理', '条'],
    ['own_submitted', '本人本轮已提交', '条']
  ],
  reviewed: [['own_submitted', '本人本轮已提交', '条']]
}
const stepFacts = computed(() => {
  const current = factsResult.value
  if (
    factsError.value ||
    factsPending.value ||
    !project.value ||
    current?.project_id !== project.value.id ||
    current.userId !== auth.user?.id
  )
    return []
  return (factsByStep[stepId.value] || []).map(([key, label, unit]) => {
    const count = current.facts?.[key]?.count
    const required = current.required_proofreads
    return {
      key,
      label:
        key === 'independent_submitted' && Number.isSafeInteger(required)
          ? `本轮已达 ${required} 人独立提交`
          : label,
      value: Number.isSafeInteger(count) && count >= 0 ? `${count} ${unit}` : '未读取'
    }
  })
})
</script>

<style scoped>
.practice-heading h2 {
  font-size: var(--text-xl);
  line-height: 1.4;
}
.practice-heading p,
.practice-exit p {
  color: var(--ink-muted);
}
.practice-roles,
.practice-downloads,
.practice-project-actions,
.practice-step-actions,
.practice-facts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.practice-roles,
.practice-downloads,
.practice-scope,
.practice-materials,
.practice-checklist,
.practice-exit {
  margin-top: var(--space-3);
}
.practice-scope,
.practice-exit {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-4);
  padding: var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--paper);
}
.practice-scope h3,
.practice-checklist h3,
.practice-exit h3 {
  margin: 0;
  font-size: var(--text-md);
}
.practice-scope p,
.practice-exit p {
  margin: 0;
  overflow-wrap: anywhere;
}
.practice-project-actions {
  max-width: 100%;
}
.practice-scope > div:first-child {
  min-width: 0;
  overflow-wrap: anywhere;
}
.practice-project-actions :deep(.app-select-trigger) {
  width: min(100%, 18rem);
}
.practice-materials summary,
.practice-technical summary {
  width: fit-content;
  min-height: var(--control-height-sm);
  padding-block: var(--space-2);
  color: var(--primary);
  cursor: pointer;
  font-size: var(--text-sm);
}
.practice-downloads .btn {
  white-space: normal;
  text-align: center;
}
.practice-steps {
  display: grid;
  gap: var(--space-2);
  list-style: none;
  padding: 0;
  margin: var(--space-2) 0 0;
}
.practice-steps li {
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
}
.practice-steps .practice-step-current {
  border-color: var(--primary-line);
  background: var(--primary-glow-soft);
}
.practice-step-label {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: var(--control-height);
  padding: var(--space-1) var(--space-3);
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: var(--ink);
  text-align: left;
  cursor: pointer;
}
.practice-step-label:hover,
.practice-current-label {
  color: var(--primary);
}
.practice-current-label {
  font-size: var(--text-xs);
  flex-shrink: 0;
}
.practice-step-content {
  padding: 0 var(--space-3) var(--space-3);
}
.practice-step-content p {
  margin: 0 0 var(--space-1);
}
.practice-facts {
  margin: var(--space-2) 0;
  gap: var(--space-1) var(--space-3);
  color: var(--ink-muted);
  font-size: var(--text-sm);
}
.practice-facts > div {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
}
.practice-facts dd {
  margin: 0;
  color: var(--ink);
  font-weight: 600;
}
.practice-step-actions {
  margin-top: var(--space-2);
}
.practice-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-height);
  color: var(--primary);
}
button.practice-link {
  padding: 0 var(--space-2);
  border: 0;
  background: transparent;
  cursor: pointer;
}
.practice-share-url {
  max-width: 100%;
}
@media (max-width: 768px) {
  .practice-heading h2 {
    font-size: var(--text-lg);
  }
  .practice-scope,
  .practice-project-actions,
  .practice-downloads,
  .practice-exit {
    align-items: stretch;
    flex-direction: column;
  }
  .practice-step-label,
  .practice-step-actions .btn,
  .practice-materials summary,
  .practice-technical summary,
  .practice-link {
    min-height: var(--control-height-touch);
  }
}
</style>
