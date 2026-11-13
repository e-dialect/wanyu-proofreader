<template>
  <section v-if="hints.length" class="proofread-findings" aria-label="本条疑点">
    <div class="proofread-findings__heading">
      <h2>本条疑点（{{ hints.length }}）</h2>
      <button
        v-if="overflow > 0"
        type="button"
        class="btn btn-quiet btn-sm"
        :aria-expanded="expanded"
        aria-controls="proofread-finding-list"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起其余疑点' : `展开其余 ${overflow} 个疑点` }}
      </button>
    </div>
    <ul id="proofread-finding-list" class="field-hint-list">
      <li v-for="hint in visibleHints" :key="hint.key">
        <div :data-finding-id="hint.id || undefined">
          <span class="field-hint-chip" :class="{ 'field-hint-chip--strong': hint.highlight }">
            <b aria-hidden="true">疑</b>{{ hintKindLabel(hint.kind) }}
          </span>
          <strong>{{ hint.field || '整条' }}</strong>
          <p>{{ hint.text }}</p>
          <p v-if="hint.inputStatus === 'different_input'" class="text-sm text-muted">
            导入文本已变化，请按字段对照原文。
          </p>
        </div>
        <div class="proofread-findings__actions">
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            :data-locate-finding="hint.id || undefined"
            @click="emit('locate', hint)"
          >
            定位原文
          </button>
          <button
            v-if="hint.id && canReport"
            type="button"
            class="btn btn-quiet btn-sm"
            @click="emit('report', hint)"
          >
            报告问题
          </button>
        </div>
      </li>
    </ul>
  </section>
  <p v-if="findingsTruncated" class="field-hint-truncated text-sm text-muted" role="status">
    本条疑点超出读取上限，请继续逐字段核对原文。
  </p>
  <p v-if="gatedNoticeText" class="field-hint-gated text-sm text-muted" role="status">
    {{ gatedNoticeText }}
  </p>
</template>

<script setup>
import { computed } from 'vue'
import { HINT_DISPLAY_LIMIT, hintKindLabel } from '@/lib/fieldHints'

const props = defineProps({
  hints: { type: Array, default: () => [] },
  canReport: Boolean,
  findingsTruncated: Boolean,
  gatedNoticeText: String
})
const emit = defineEmits(['locate', 'report'])
const expanded = defineModel('expanded', { type: Boolean, default: false })
const overflow = computed(() => props.hints.length - HINT_DISPLAY_LIMIT)
const visibleHints = computed(() =>
  expanded.value ? props.hints : props.hints.slice(0, HINT_DISPLAY_LIMIT)
)
</script>

<style scoped>
.proofread-findings {
  margin-block-end: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-raised);
}
.proofread-findings__heading,
.proofread-findings__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.proofread-findings__heading {
  justify-content: space-between;
}
.proofread-findings__heading h2 {
  margin: 0;
  font-family: var(--font-ui);
  font-size: var(--text-md);
}
.field-hint-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.field-hint-list li {
  padding-block: var(--space-2);
  border-top: 1px solid var(--line);
}
.field-hint-list strong {
  margin-inline-start: var(--space-2);
}
.field-hint-list p {
  margin-block: var(--space-1);
  font-size: var(--text-sm);
}
</style>
