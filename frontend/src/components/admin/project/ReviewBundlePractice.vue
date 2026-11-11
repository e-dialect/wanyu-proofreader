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
    <div class="practice-downloads" aria-label="完整练习材料">
      <a href="/examples/review-bundle-practice-v1.zip" download class="btn btn-primary">
        下载虚构 Review Bundle（3 条）
      </a>
      <a href="/examples/review-bundle-practice-v1/source.pdf" download class="btn btn-secondary">
        下载配套原文 PDF（3 页）
      </a>
      <a href="/examples/review-bundle-practice-v1/README.txt" download class="practice-link">
        下载逐步练习说明
      </a>
    </div>

    <p class="practice-scope">
      请只在独立练习项目中使用这些材料。全程使用已有、获授权的练习账号。
      <template v-if="projectId">
        下方项目入口沿用打开指南时的项目，请先确认该项目专用于练习。
      </template>
      <template v-else>
        要在这里直达练习项目的各环节，请从该项目的「材料与导入」打开本指南。
      </template>
    </p>

    <div class="practice-roles" role="group" aria-label="选择练习角色">
      <button
        v-for="item in roles"
        :key="item.id"
        class="btn"
        :class="role === item.id ? 'btn-primary' : 'btn-secondary'"
        type="button"
        :aria-pressed="role === item.id"
        @click="chooseRole(item.id)"
      >
        {{ item.label }}
      </button>
    </div>

    <div
      class="practice-checklist"
      aria-labelledby="practice-checklist-title"
      aria-describedby="practice-progress-note"
    >
      <div class="practice-checklist-heading">
        <h3 id="practice-checklist-title">{{ selectedRole.label }}练习清单</h3>
        <span class="practice-count" role="status"
          >{{ completedCount }} / {{ steps.length }} 项已勾选</span
        >
      </div>
      <p class="practice-progress-note" id="practice-progress-note">
        勾选只帮你记住练习到哪一步，并保存在本浏览器。实际工作进度和许可结论以项目记录为准。
      </p>
      <p v-if="!storageAvailable" class="practice-progress-note" role="status">
        当前浏览器无法保存自记进度，本页关闭后勾选会丢失。
      </p>

      <ol class="practice-steps">
        <li
          v-for="step in steps"
          :key="step.id"
          :class="{ 'practice-step-current': step === nextStep }"
          :aria-current="step === nextStep ? 'step' : undefined"
        >
          <label class="practice-step-label">
            <input
              type="checkbox"
              :checked="completed.includes(step.id)"
              @change="setCompleted(step.id, $event.target.checked)"
            />
            <strong>{{ step.title }}</strong>
            <span v-if="step === nextStep" class="practice-next-label">下一项</span>
          </label>
          <div class="practice-step-content">
            <p>{{ step.detail }}</p>
            <RouterLink v-if="step.target" :to="step.target" class="practice-link">
              {{ step.link }} <AppIcon name="arrow" />
            </RouterLink>
          </div>
        </li>
      </ol>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import AppIcon from '@/components/AppIcon.vue'
import { projectWorkspaceTarget } from '@/lib/projectWorkspace'
import { useAuthStore } from '@/stores/auth'

const props = defineProps({
  projectId: { type: String, default: '' }
})
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const roles = [
  { id: 'manager', label: '项目管理员' },
  { id: 'proofreader', label: '校对者' },
  { id: 'platform', label: '平台管理员' }
]
const selectedRole = computed(
  () => roles.find((item) => item.id === route.query.practiceRole) || roles[0]
)
const role = computed(() => selectedRole.value.id)
function chooseRole(id) {
  router.replace({
    path: route.path,
    query: { ...route.query, practiceRole: id },
    hash: route.hash
  })
}

const projectPath = computed(() => props.projectId && `/admin/projects/${props.projectId}`)
const projectPage = (page, query) =>
  projectPath.value ? { path: `${projectPath.value}/${page}`, query } : undefined
const materials = (method) =>
  props.projectId
    ? projectWorkspaceTarget(props.projectId, 'materials', 'import', { method })
    : undefined
const tasks = (view) => ({
  path: '/tasks',
  query: props.projectId ? { project: props.projectId, view } : { view }
})

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
        detail:
          '用逻辑 ID practice-wanyu-reviewbundle-v1 核对本版虚构材料。若已有同 ID 但资料不同，停止并保留原登记。',
        target: auth.isPlatformAdmin ? '/admin/sources' : undefined,
        link: '打开来源库'
      },
      {
        id: 'permissions',
        title: '核对用途和原始材料转交许可',
        detail:
          '分别记录本次用途与原始材料转交第三方的判断和依据。未知或禁止时，把阻断原因告知项目管理员。',
        target: auth.isPlatformAdmin ? '/admin/sources' : undefined,
        link: '打开来源库'
      }
    ]
  }

  return [
    {
      id: 'prepare',
      title: '准备独立项目和原文',
      detail: '新建名称含「练习」的项目，上传配套 PDF，等待校验完成并确认 3 页均可读。',
      target: materials('pdf') || (auth.canCreateProjects ? '/admin/projects/new' : undefined),
      link: props.projectId ? '打开项目来源 PDF' : '创建独立练习项目'
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
      target: props.projectId
        ? projectWorkspaceTarget(props.projectId, 'work', 'queue')
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

const completed = ref([])
const storageAvailable = ref(true)
const progressKey = computed(() =>
  auth.user?.id
    ? `wanyu.practice.review-bundle-v1:${auth.user.id}:${props.projectId || 'general'}`
    : ''
)
watch(
  progressKey,
  (key) => {
    completed.value = []
    storageAvailable.value = Boolean(key)
    if (!key) return
    try {
      const saved = JSON.parse(localStorage.getItem(key))
      if (Array.isArray(saved)) completed.value = saved.filter((id) => typeof id === 'string')
    } catch {
      storageAvailable.value = false
    }
  },
  { immediate: true }
)
const completedCount = computed(
  () => steps.value.filter((step) => completed.value.includes(step.id)).length
)
const nextStep = computed(() => steps.value.find((step) => !completed.value.includes(step.id)))
function setCompleted(id, checked) {
  const next = new Set(completed.value)
  if (checked) next.add(id)
  else next.delete(id)
  completed.value = [...next]
  if (!progressKey.value) return
  try {
    localStorage.setItem(progressKey.value, JSON.stringify(completed.value))
    storageAvailable.value = true
  } catch {
    storageAvailable.value = false
  }
}
</script>

<style scoped>
.practice-heading h2 {
  font-size: var(--text-xl);
  line-height: 1.4;
}
.practice-heading p {
  margin-top: var(--space-2);
  color: var(--ink-muted);
}
.practice-downloads,
.practice-roles {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
.practice-downloads .btn {
  white-space: normal;
  text-align: center;
}
.practice-scope {
  margin-top: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-panel);
  background: var(--paper);
  font-size: var(--text-sm);
}
.practice-checklist {
  margin-top: var(--space-5);
}
.practice-checklist-heading {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--space-2);
}
.practice-checklist-heading h3 {
  font-size: var(--text-lg);
}
.practice-count,
.practice-progress-note {
  color: var(--ink-muted);
  font-size: var(--text-sm);
}
.practice-count {
  font-variant-numeric: tabular-nums;
}
.practice-progress-note {
  margin-top: var(--space-2);
}
.practice-steps {
  display: grid;
  gap: var(--space-2);
  list-style: none;
  padding: 0;
  margin: var(--space-4) 0 0;
}
.practice-steps li {
  padding: 0 var(--space-3) var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
}
.practice-steps .practice-step-current {
  border-color: var(--primary);
  background: var(--primary-glow-soft);
}
.practice-step-label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-height);
  padding-block: var(--space-1);
  cursor: pointer;
}
.practice-step-label input {
  flex: none;
  margin: 0;
  accent-color: var(--primary);
}
.practice-next-label {
  color: var(--primary);
  font-size: var(--text-xs);
  margin-inline-start: auto;
  white-space: nowrap;
}
.practice-step-content {
  padding-inline-start: var(--space-5);
}
.practice-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-height);
  color: var(--primary);
}
@media (max-width: 768px) {
  .practice-heading h2 {
    font-size: var(--text-lg);
  }
  .practice-downloads {
    align-items: stretch;
    flex-direction: column;
  }
  .practice-step-label,
  .practice-link {
    min-height: var(--control-height-touch);
  }
}
</style>
