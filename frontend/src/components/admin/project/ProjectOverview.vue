<template>
  <section class="project-flow" aria-label="项目概览">
    <header class="project-flow__heading">
      <div>
        <h2>项目推进清单</h2>
        <p>管理员准备材料与处理差异，校对者独立核对，最后按用途交付。</p>
      </div>
      <AppButton
        variant="ghost"
        size="sm"
        :loading="pending"
        loading-label="正在刷新…"
        @click="loadOverview"
      >
        <AppIcon name="refresh" />刷新统计
      </AppButton>
    </header>
    <AppStatusPanel
      v-if="error"
      state="error"
      :message="error"
      retry-label="重试统计"
      :busy="pending"
      @retry="loadOverview"
    />
    <p v-if="pending && !overview" class="project-flow__read-status" role="status">
      正在读取项目进度…
    </p>
    <dl class="project-flow__metrics" aria-label="全项目校对进度">
      <div>
        <dt>材料条目</dt>
        <dd>
          {{ count(overview?.total) ?? '未读取'
          }}<span v-if="count(overview?.total) !== null"> 条</span>
        </dd>
      </div>
      <div>
        <dt>校对流程完成</dt>
        <dd>
          {{ count(overview?.approved) ?? '未读取'
          }}<span v-if="count(overview?.approved) !== null"> 条</span>
        </dd>
      </div>
      <div>
        <dt>等待仲裁</dt>
        <dd>
          {{ count(overview?.arbitration) ?? '未读取'
          }}<span v-if="count(overview?.arbitration) !== null"> 条</span>
        </dd>
      </div>
    </dl>
    <p v-if="error && overview" class="project-flow__read-status">以上为上次成功读取的统计。</p>
    <div class="project-flow__next">
      <div>
        <span class="project-flow__eyebrow">建议下一步</span>
        <h3>{{ next.title }}</h3>
        <p>{{ next.detail }}</p>
      </div>
      <RouterLink :to="link(next.action)" class="btn btn-primary"
        >{{ next.label }}<AppIcon name="arrow"
      /></RouterLink>
    </div>
    <ol class="project-flow__steps" aria-label="项目流程与分工">
      <li
        v-for="(step, index) in steps"
        :key="step.key"
        :aria-current="next.step === step.key ? 'step' : undefined"
      >
        <span class="project-flow__number" aria-hidden="true">0{{ index + 1 }}</span>
        <div class="project-flow__step-body">
          <div class="project-flow__step-title">
            <h3>{{ step.title }}</h3>
            <span>{{ step.role }}</span>
          </div>
          <p>{{ step.detail }}</p>
        </div>
        <div class="project-flow__links">
          <RouterLink v-for="action in step.actions" :key="action.key" :to="link(action.key)"
            >{{ action.label }}<AppIcon name="arrow"
          /></RouterLink>
        </div>
      </li>
    </ol>
    <p class="project-flow__note">完成校对不代表来源、用途或交付均已核验；各环节可随时返回检查。</p>
  </section>
</template>
<script setup>
import { computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { getAdminProjectPageStats } from '@/services/pagesService'
import { useAsyncResource } from '@/composables/useAsyncResource'
import {
  projectWorkflowNext,
  projectWorkflowTarget,
  workflowCount as count
} from '@/lib/projectWorkflow'
import { getPbMessage } from '@/utils/pbErrors'
import AppButton from '@/components/AppButton.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
const props = defineProps({
  projectId: { type: String, required: true },
  query: { type: Object, default: () => ({}) }
})
const {
  data: overview,
  pending,
  error,
  reload: loadOverview
} = useAsyncResource(({ signal }) => getAdminProjectPageStats(props.projectId, { signal }), {
  formatError: (error) => getPbMessage(error, '项目统计暂不可用。')
})
const next = computed(() => projectWorkflowNext(error.value ? null : overview.value))
const link = (action) => projectWorkflowTarget(props.projectId, action, props.query)
const steps = [
  {
    key: 'materials',
    title: '准备材料',
    role: '管理员',
    detail: '导入资料，检查条目与原文是否对应。',
    actions: [{ key: 'materials', label: '准备材料' }]
  },
  {
    key: 'members',
    title: '安排成员与规则',
    role: '管理员',
    detail: '确认谁来校对、需要几份独立结果，以及使用的输入工具。',
    actions: [
      { key: 'members', label: '安排成员' },
      { key: 'rules', label: '校勘规则' }
    ]
  },
  {
    key: 'work',
    title: '校对与处理差异',
    role: '校对者 · 管理员',
    detail: '校对者独立提交；管理员处理仲裁、来源与写法问题。',
    actions: [
      { key: 'entries', label: '打开条目' },
      { key: 'queue', label: '待办队列' }
    ]
  },
  {
    key: 'delivery',
    title: '核对范围与交付',
    role: '管理员',
    detail: '检查来源和用途，下载工作文件或准备交付包。',
    actions: [{ key: 'delivery', label: '成果与交付' }]
  }
]
onMounted(loadOverview)
defineExpose({ reload: loadOverview })
</script>
<style scoped>
.project-flow {
  display: grid;
  gap: var(--space-5);
}
.project-flow__heading,
.project-flow__next {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}
.project-flow__heading h2 {
  font-size: var(--text-xl);
}
.project-flow p {
  color: var(--ink-muted);
  font-size: var(--text-sm);
  line-height: 1.7;
}
.project-flow__heading p {
  margin-top: var(--space-1);
}
.project-flow__heading > .app-button {
  flex-shrink: 0;
}
.project-flow__metrics {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4) var(--space-6);
}
.project-flow__metrics > div {
  min-width: 8em;
}
.project-flow__metrics dt {
  color: var(--ink-muted);
  font-size: var(--text-sm);
  margin-bottom: var(--space-1);
}
.project-flow__metrics dd {
  color: var(--ink);
  font-size: var(--text-xl);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.project-flow__metrics dd span {
  font-size: var(--text-sm);
  font-weight: 400;
}
.project-flow__next {
  padding: var(--space-5);
  background: var(--primary-glow-soft);
  border: 1px solid var(--primary-line);
  border-radius: var(--radius-card);
}
.project-flow__eyebrow {
  color: var(--primary);
  font-size: var(--text-xs);
  font-weight: 600;
}
.project-flow__next h3 {
  margin: var(--space-1) 0;
  font-size: var(--text-lg);
}
.project-flow__next .btn {
  flex-shrink: 0;
}
.project-flow__steps {
  list-style: none;
  border-top: 1px solid var(--line);
}
.project-flow__steps li {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-5) 0;
  border-bottom: 1px solid var(--line);
}
.project-flow__number {
  color: var(--ink-muted);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  align-self: flex-start;
  padding-top: var(--space-1);
}
.project-flow__steps li[aria-current='step'] .project-flow__number {
  color: var(--primary);
  font-weight: 700;
}
.project-flow__step-body {
  flex: 1;
  min-width: 0;
}
.project-flow__step-title {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
}
.project-flow__step-title h3 {
  font-size: var(--text-md);
}
.project-flow__step-title span {
  font-size: var(--text-xs);
  color: var(--ink-muted);
}
.project-flow__step-body p {
  margin-top: var(--space-1);
  max-width: 52ch;
}
.project-flow__links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
}
.project-flow__links a {
  display: inline-flex;
  gap: var(--space-2);
  align-items: center;
  min-height: var(--control-height);
  font-size: var(--text-sm);
  white-space: nowrap;
}
.project-flow__links .app-icon {
  width: 16px;
  height: 16px;
}
.project-flow__note {
  max-width: 70ch;
}
@media (max-width: 640px) {
  .project-flow__heading {
    align-items: flex-start;
  }
  .project-flow__next {
    align-items: stretch;
    flex-direction: column;
    padding: var(--space-4);
  }
  .project-flow__steps li {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-4) 0;
  }
  .project-flow__step-body {
    flex-basis: calc(100% - 3em);
  }
  .project-flow__links {
    margin-left: calc(2ch + var(--space-3));
  }
  .project-flow__links a {
    min-height: var(--control-height-touch);
  }
  .project-flow__metrics {
    gap: var(--space-4);
  }
  .project-flow__metrics > div {
    min-width: 0;
    flex: 1;
  }
  .project-flow__metrics dd {
    font-size: var(--text-lg);
  }
}
</style>
