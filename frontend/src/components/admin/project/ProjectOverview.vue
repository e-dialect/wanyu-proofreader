<template>
  <section aria-label="项目概览">
    <AppStatusPanel
      v-if="overviewError"
      state="error"
      :message="overviewError"
      retry-label="重试统计"
      @retry="loadOverview"
    />
    <div class="project-overview-grid">
      <article class="project-overview-metric">
        <span>材料条目</span><strong>{{ overview?.total ?? '—' }}</strong
        ><small>项目中的全部条目</small>
      </article>
      <article class="project-overview-metric">
        <span>校对流程完成</span><strong>{{ overview?.approved ?? '—' }}</strong
        ><small>完成校对不代表来源与用途均已核验</small>
      </article>
      <article class="project-overview-metric">
        <span>等待仲裁</span><strong>{{ overview?.arbitration ?? '—' }}</strong
        ><small>需要逐字段处理独立结果的差异</small>
      </article>
    </div>
    <div class="project-next-actions">
      <article class="project-next-action">
        <h2>推进校勘</h2>
        <p>查看条目、处理仲裁及来源问题，或运行质量检查。</p>
        <RouterLink :to="link('work', 'entries')" class="btn btn-primary">打开条目</RouterLink>
        <RouterLink :to="link('work', 'queue')" class="btn btn-secondary">待办队列</RouterLink>
      </article>
      <article class="project-next-action">
        <h2>准备与交付</h2>
        <p>导入材料、核对批次来源，或按明确范围下载成果。</p>
        <RouterLink :to="link('materials', 'import')" class="btn btn-secondary"
          >准备材料</RouterLink
        >
        <RouterLink :to="link('delivery', 'exports')" class="btn btn-secondary"
          >成果与交付</RouterLink
        >
      </article>
    </div>
  </section>
</template>
<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { getAdminProjectPageStats } from '@/services/pagesService'
import { projectWorkspaceTarget } from '@/lib/projectWorkspace'
import { getPbMessage } from '@/utils/pbErrors'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
const props = defineProps({
  projectId: { type: String, required: true },
  query: { type: Object, default: () => ({}) }
})
const overview = ref(null)
const overviewError = ref('')
let disposed = false
let generation = 0
const link = (section, view) => projectWorkspaceTarget(props.projectId, section, view, props.query)
async function loadOverview() {
  const token = ++generation
  overviewError.value = ''
  try {
    const data = await getAdminProjectPageStats(props.projectId)
    if (!disposed && token === generation) overview.value = data
  } catch (error) {
    if (!disposed && token === generation)
      overviewError.value = getPbMessage(error, '项目统计暂不可用。')
  }
}
onMounted(loadOverview)
onBeforeUnmount(() => {
  disposed = true
  generation++
})
defineExpose({ reload: loadOverview })
</script>
