<template>
  <section
    class="job-status-panel"
    :aria-label="`${label}状态`"
    :aria-busy="observation.refreshing"
  >
    <div class="job-status-heading">
      <strong>{{ title }}</strong>
      <AppButton
        v-if="canRetry"
        variant="secondary"
        size="sm"
        :loading="observation.refreshing"
        loading-label="正在读取"
        @click="$emit('retry')"
        >重新读取状态</AppButton
      >
    </div>
    <p v-if="observation.state === 'offline'" role="status">
      设备当前离线，已暂停状态读取。后台作业仍可能继续，联网后会自动核对。
    </p>
    <p v-else-if="observation.error" role="alert">{{ observation.error }}</p>
    <template v-if="progress">
      <p class="text-sm">
        已处理 {{ progress.processed
        }}<template v-if="progress.total !== null"> / {{ progress.total }}</template>
        {{ progress.unit }}<span v-if="progress.total === null"> · 总量尚未确定</span>
      </p>
      <progress
        v-if="progress.percent !== null"
        :value="progress.percent"
        max="100"
        :aria-label="`${label}已处理进度`"
      ></progress>
    </template>
    <p v-if="observation.lastSuccessAt" class="text-sm text-muted">
      上次成功读取：<time :datetime="new Date(observation.lastSuccessAt).toISOString()">{{
        updated
      }}</time>
    </p>
    <p v-if="observation.snapshot?.status === 'validated'" class="text-sm" role="status">
      检查完成，等待你确认导入；尚未写入校对条目。
    </p>
    <slot />
  </section>
</template>
<script setup>
import { computed } from 'vue'
import AppButton from '@/components/AppButton.vue'
import { jobProgress } from '@/lib/jobObserver'
const props = defineProps({
  label: { type: String, required: true },
  kind: { type: String, required: true },
  observation: { type: Object, required: true }
})
defineEmits(['retry'])
const canRetry = computed(
  () => !['unauthorized', 'unavailable', 'offline', 'idle'].includes(props.observation.state)
)
const progress = computed(() => jobProgress(props.kind, props.observation.snapshot))
const updated = computed(() =>
  new Date(props.observation.lastSuccessAt).toLocaleTimeString('zh-CN', { hour12: false })
)
const title = computed(() => {
  if (props.observation.state === 'unauthorized') return '访问权限已变化'
  if (props.observation.state === 'unavailable') return '作业不可用'
  if (props.observation.state === 'stale') return '暂时无法更新状态'
  if (props.observation.state === 'offline') return '设备离线，等待联网'
  if (props.observation.state === 'loading') return '正在读取作业状态'
  const labels = {
    inspecting: '正在检查',
    validated: '检查完成，待确认',
    ready: '文件校验完成',
    queued: '等待处理',
    processing: '正在处理',
    completed: '处理完成',
    completed_with_errors: '处理完成，部分失败',
    failed: '处理失败',
    cancelled: '已取消'
  }
  return labels[props.observation.snapshot?.status] || `${props.label}状态`
})
</script>
<style scoped>
.job-status-panel {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  margin-block: var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}
.job-status-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.job-status-panel progress {
  width: 100%;
  accent-color: var(--primary);
}
.job-status-panel p {
  overflow-wrap: anywhere;
  margin: 0;
}
</style>
