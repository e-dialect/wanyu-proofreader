<template>
  <header class="editor-panel-header editor-panel-header--task">
    <div class="editor-context">
      <span>{{ projectName }} · {{ ownReview ? '回看已提交' : '独立校对' }}</span>
      <strong id="task-panel-title">当前第 {{ pageNumber || '—' }} 条</strong>
    </div>
    <div class="task-primary-actions">
      <div v-if="!mobile" class="task-inline-navigation" aria-label="校对任务导航">
        <button
          class="btn btn-quiet btn-sm"
          aria-label="上一条"
          :disabled="!canSwitchPrev"
          @click="emit('previous')"
        >
          ‹
        </button>
        <span class="task-position" aria-label="当前任务位置" aria-live="polite">{{
          navigationLabel
        }}</span>
        <button
          class="btn btn-quiet btn-sm"
          aria-label="下一条"
          :disabled="!canSwitchNext"
          @click="emit('next')"
        >
          ›
        </button>
      </div>
      <button
        v-if="sourceToggleVisible"
        class="btn btn-secondary btn-sm task-source-toggle"
        :aria-expanded="!sourceCollapsed"
        aria-controls="review-source"
        @click="emit('source-toggle')"
      >
        {{ sourceCollapsed ? '查看原文' : '收起原文' }}
      </button>
      <AppButton
        v-if="!ownReview && !mobile"
        variant="primary"
        size="sm"
        :loading="saving || (submittedHere && retryingClaim)"
        :disabled="submittedHere || saving || loadingPage || !hasPage || leaseLost || !leaseToken"
        @click="emit('submit')"
      >
        {{ submitLabel }}
      </AppButton>
      <details class="task-actions-menu">
        <summary>更多操作</summary>
        <div class="editor-toolbar task-secondary-actions">
          <div v-if="mobile" class="task-inline-navigation" aria-label="校对任务导航">
            <button
              class="btn btn-quiet btn-sm"
              aria-label="上一条"
              :disabled="!canSwitchPrev"
              @click="emit('previous')"
            >
              ‹</button
            ><span class="task-position" aria-label="当前任务位置">{{ navigationLabel }}</span
            ><button
              class="btn btn-quiet btn-sm"
              aria-label="下一条"
              :disabled="!canSwitchNext"
              @click="emit('next')"
            >
              ›
            </button>
          </div>
          <p v-if="leaseStatus" class="text-sm text-muted">{{ leaseStatus }}</p>
          <p v-if="shortcutHints.length" class="text-sm text-muted editor-shortcuts">
            {{ shortcutHints.join(' · ') }}
          </p>
          <RouterLink :to="returnTarget" class="btn btn-quiet btn-sm">返回任务</RouterLink>
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
        </div>
      </details>
    </div>
    <p
      class="editor-task-feedback"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      :data-task-feedback="feedback.kind"
    >
      <span class="editor-feedback-label">{{ feedback.label }}</span>
      <span
        :key="`${feedback.kind}:${feedback.label}`"
        class="editor-feedback-copy"
        :title="feedback.detail || feedback.text"
        >{{ feedback.text }}</span
      >
      <button
        type="button"
        class="editor-feedback-details"
        aria-label="查看任务状态详情"
        aria-haspopup="dialog"
        @click="feedbackOpen = true"
      >
        详情
      </button>
    </p>
    <p v-if="activeField" class="text-sm text-muted editor-active-field">
      当前字段：{{ activeField }}<span v-if="!ownReview"> · 字符键盘会插入这里</span>
    </p>
  </header>
  <AppModal :open="feedbackOpen" title-id="task-feedback-title" @close="feedbackOpen = false">
    <h2 id="task-feedback-title">{{ feedback.label }}</h2>
    <p class="editor-feedback-detail-copy">{{ feedback.detail || feedback.text }}</p>
    <template #actions>
      <AppButton @click="feedbackOpen = false">关闭详情</AppButton>
    </template>
  </AppModal>
</template>
<script setup>
import { RouterLink } from 'vue-router'
import { computed, inject, ref, watch } from 'vue'
import AppButton from '@/components/AppButton.vue'
import AppModal from '@/components/AppModal.vue'
const feedbackOpen = ref(false)
const returnTarget = inject('workReturnTarget', '/tasks')
const props = defineProps({
  projectName: String,
  ownReview: Boolean,
  pageNumber: [String, Number],
  mobile: Boolean,
  overview: Boolean,
  sourceToggleVisible: Boolean,
  sourceCollapsed: Boolean,
  leaseStatus: String,
  navigationLabel: String,
  navigationHint: String,
  neighborsState: String,
  submittedHere: Boolean,
  retryingClaim: Boolean,
  submitLabel: { type: String, default: '检查并提交' },
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
watch(
  () => [props.pageNumber, props.ownReview],
  () => {
    feedbackOpen.value = false
  }
)
const shortcutHints = computed(() => {
  const hints = []
  if (!props.ownReview && props.hasPage && !props.loadingPage && !props.submittedHere) {
    hints.push('⌘/Ctrl+S 本机草稿')
    if (!props.saving && !props.leaseLost && props.leaseToken) hints.push('⌘/Ctrl+Enter 检查并提交')
  }
  if (props.canSwitchPrev) hints.push('Alt+← 上一条')
  if (props.canSwitchNext) hints.push('Alt+→ 下一条')
  return hints
})
const emit = defineEmits([
  'previous',
  'next',
  'retry-position',
  'release',
  'return',
  'submit',
  'source-toggle'
])
</script>
<style scoped>
.editor-task-feedback {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-basis: 100%;
  min-width: 0;
  min-height: 1.75rem;
  margin: 0;
  font-size: var(--text-sm);
}
.editor-feedback-label {
  flex-shrink: 0;
  color: var(--ink);
  font-weight: 600;
  transition: color var(--motion-fast) var(--ease-out);
}
.editor-feedback-copy {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 400;
  animation: editor-feedback-reveal var(--motion-fast) var(--ease-out);
}
.editor-feedback-details {
  flex: 0 0 auto;
  min-height: var(--control-height-sm);
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--primary-dark);
  font: inherit;
  cursor: pointer;
}
.editor-feedback-details:hover {
  background: var(--primary-light);
}
.editor-feedback-details:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}
.editor-feedback-detail-copy {
  margin-top: var(--space-3);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.7;
}
@media (max-width: 640px) {
  .editor-feedback-details {
    min-height: var(--control-height-touch);
  }
}
[data-task-feedback='error'] .editor-feedback-label {
  color: var(--danger-ink);
}
[data-task-feedback='submitted'] .editor-feedback-label {
  color: var(--success-ink-deep);
}
@keyframes editor-feedback-reveal {
  from {
    opacity: 0.72;
  }
  to {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .editor-feedback-copy {
    animation: none;
  }
  .editor-feedback-label {
    transition: none;
  }
}
.editor-active-field {
  flex-basis: 100%;
  margin: 0;
}
</style>
