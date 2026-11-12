<template>
  <section aria-label="批次统计" class="report-metric-grid">
    <section v-for="group in groups" :key="group.key" class="card report-metric-group">
      <h2>{{ group.title }}</h2>
      <p class="text-sm text-muted">{{ group.description }}</p>
      <dl class="report-metrics">
        <div v-for="[key, label] in group.metrics" :key="key">
          <dt>{{ metricLabel(key, label) }}</dt>
          <dd :class="{ 'text-muted': !Number.isFinite(metrics[group.key]?.[key]?.value) }">
            {{ reportMetricValue(metrics[group.key]?.[key], !totalMetrics.includes(key)) }}
          </dd>
        </div>
      </dl>
      <AppDisclosure label="查看统计口径" lazy>
        <dl class="report-method">
          <div v-for="[key, label] in group.metrics" :key="key">
            <dt>{{ metricLabel(key, label) }}</dt>
            <dd>
              {{ metrics[group.key]?.[key]?.note || '暂未记录统计说明。' }}
              <template
                v-if="
                  Number.isFinite(metrics[group.key]?.[key]?.denominator) &&
                  (metrics[group.key]?.[key]?.unit === 'seconds' || totalMetrics.includes(key))
                "
              >
                （{{ reportNumber(metrics[group.key][key].denominator) }} 为统计分母）
              </template>
              <code v-if="metrics[group.key]?.[key]?.basis">{{
                metrics[group.key][key].basis
              }}</code>
            </dd>
          </div>
        </dl>
      </AppDisclosure>
    </section>
  </section>
</template>

<script setup>
import AppDisclosure from '@/components/AppDisclosure.vue'
import { reportMetricValue, reportNumber } from '@/lib/batchReport'

const props = defineProps({
  metrics: { type: Object, required: true },
  importComplete: Boolean
})
const totalMetrics = ['declared', 'retained']
function metricLabel(key, label) {
  if (key === 'succeeded' && !props.importComplete) return '当前成功计数'
  return label
}
const groups = [
  {
    key: 'import',
    title: '导入对账',
    description: '声明、成功和失败沿用导入单位。保留量统计当前条目。',
    metrics: [
      ['declared', '声明输入'],
      ['succeeded', '导入成功'],
      ['failed', '导入失败'],
      ['excluded', '重复跳过'],
      ['retained', '当前保留']
    ]
  },
  {
    key: 'proofreading',
    title: '校对进度',
    description: '按当前轮次统计不同校对者的提交覆盖。',
    metrics: [
      ['submitted_coverage', '有提交'],
      ['independent_coverage', '两人独立提交'],
      ['completed', '校对完成'],
      ['pending_arbitration', '待仲裁']
    ]
  },
  {
    key: 'quality',
    title: '质量核验',
    description: '字段统计来自历史提交的最新来源判断。核验覆盖不等于随机抽检或最终条目正确率。',
    metrics: [
      ['correct', '来源判断正确'],
      ['incorrect', '来源判断有误'],
      ['unverified', '未核实'],
      ['evaluated_fields', '有明确判断'],
      ['sampled_entries', '来源判断覆盖条目'],
      ['validated_entries', '已确认质量的条目'],
      ['withheld_entries', '暂缓外发条目']
    ]
  },
  {
    key: 'efficiency',
    title: '周转与等待',
    description: '按已记录的完成事件和等待起点统计。',
    metrics: [
      ['completed_7d', '近 7 天完成'],
      ['arbitration_wait_seconds', '最长待仲裁'],
      ['receipt_wait_seconds', '最长待回执']
    ]
  }
]
</script>

<style scoped>
.report-metric-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}
.report-metric-group {
  min-width: 0;
}
.report-metric-group h2 {
  font-size: var(--text-lg);
  margin-bottom: var(--space-1);
}
.report-metrics {
  margin: var(--space-3) 0 var(--space-2);
}
.report-metrics > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  padding-block: var(--space-2);
  border-bottom: 1px solid var(--line);
}
.report-metrics dd {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  white-space: nowrap;
}
.report-method dt {
  font-weight: 600;
}
.report-method dd {
  margin: var(--space-1) 0 var(--space-3);
  font-size: var(--text-sm);
  color: var(--ink-muted);
  overflow-wrap: anywhere;
}
.report-method code {
  display: block;
  font-size: var(--text-xs);
}
@media (max-width: 768px) {
  .report-metric-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
