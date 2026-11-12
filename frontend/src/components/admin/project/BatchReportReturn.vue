<template>
  <div v-if="context" class="batch-report-return">
    <RouterLink :to="target" class="back-link"> <AppIcon name="back" />返回批次报告 </RouterLink>
    <span v-if="context.exportId" class="text-sm text-muted">
      返回后保留所选历史文件；当前业务状态仍按最新记录显示。
    </span>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import AppIcon from '@/components/AppIcon.vue'
import { batchReportReturnTarget, readBatchReportContext } from '@/lib/batchReportContext'

const props = defineProps({
  projectId: { type: String, required: true }
})
const route = useRoute()
const context = computed(() => readBatchReportContext(route.query, props.projectId))
const target = computed(() => batchReportReturnTarget(context.value))
</script>

<style scoped>
.batch-report-return {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}
.batch-report-return .back-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-height);
}
@media (max-width: 768px) {
  .batch-report-return .back-link {
    min-height: var(--control-height-touch);
  }
}
</style>
