<template>
  <span v-if="purpose === 'practice'" class="project-purpose-tag">练习项目</span>
</template>

<script setup>
defineProps({ purpose: { type: String, default: '' } })
</script>

<style scoped>
.project-purpose-tag {
  display: inline-flex;
  align-items: center;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--ink-muted);
  font-size: var(--text-xs);
  font-weight: 500;
  line-height: 1.4;
  white-space: nowrap;
}
</style>
