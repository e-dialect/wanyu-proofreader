<template>
  <header class="editor-panel-header editor-panel-header--task">
    <div class="editor-context">
      <span>{{ projectName }} · {{ ownReview ? '回看已提交' : '独立校对' }}</span>
      <strong id="task-panel-title">第 {{ pageNumber || '—' }} 条</strong>
    </div>
    <details class="task-actions-menu" :open="!mobile">
      <summary>任务操作</summary>
      <RouterLink v-if="mobile" to="/tasks" class="btn btn-quiet">返回大厅</RouterLink>
      <div class="editor-toolbar" aria-label="校对任务导航">
        <span class="task-position" aria-label="当前任务位置" aria-live="polite">{{
          navigationLabel
        }}</span>
        <span v-if="navigationHint" class="text-sm text-muted" role="status">{{
          navigationHint
        }}</span>
        <button
          v-if="neighborsState === 'error' && !submittedHere"
          class="btn btn-quiet btn-sm"
          @click="emit('retry-position')"
        >
          重试获取位置
        </button>
        <button
          class="btn btn-secondary btn-sm"
          @click="emit('previous')"
          :disabled="!canSwitchPrev"
        >
          上一条
        </button>
        <button class="btn btn-secondary btn-sm" @click="emit('next')" :disabled="!canSwitchNext">
          下一条
        </button>
        <button
          v-if="hasPage && !leaseLost && !ownReview"
          class="btn btn-quiet btn-sm"
          :disabled="saving || releasing || !leaseToken"
          @click="emit('release')"
        >
          {{ releasing ? '释放中…' : '释放任务' }}
        </button>
        <button
          v-if="hasPage && !submittedHere && !leaseLost && !ownReview"
          class="btn btn-quiet btn-sm"
          :disabled="saving || !leaseToken"
          @click="emit('return')"
        >
          退回
        </button>
        <button
          v-if="!ownReview"
          class="btn btn-success btn-sm"
          @click="emit('submit')"
          :disabled="saving || loadingPage || !hasPage || leaseLost || !leaseToken"
        >
          {{ saving ? '提交中…' : '检查并提交' }}
        </button>
      </div>
    </details>
    <p
      class="editor-task-feedback"
      role="status"
      aria-live="polite"
      :data-task-feedback="feedback.kind"
    >
      {{ feedback.text }}
    </p>
    <p v-if="activeField" class="text-sm text-muted editor-active-field">
      当前字段：{{ activeField }}<span v-if="!ownReview"> · 字符键盘会插入这里</span>
    </p>
  </header>
</template>
<script setup>
import { RouterLink } from 'vue-router'
defineProps({
  projectName: String,
  ownReview: Boolean,
  pageNumber: [String, Number],
  mobile: Boolean,
  navigationLabel: String,
  navigationHint: String,
  neighborsState: String,
  submittedHere: Boolean,
  canSwitchPrev: Boolean,
  canSwitchNext: Boolean,
  hasPage: Boolean,
  leaseLost: Boolean,
  saving: Boolean,
  releasing: Boolean,
  leaseToken: String,
  loadingPage: Boolean,
  activeField: String,
  feedback: { type: Object, required: true }
})
const emit = defineEmits(['previous', 'next', 'retry-position', 'release', 'return', 'submit'])
</script>
<style scoped>
.editor-task-feedback {
  flex-basis: 100%;
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 600;
}
.editor-active-field {
  flex-basis: 100%;
  margin: 0;
}
</style>
