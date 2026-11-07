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
        :loading="saving"
        :disabled="saving || loadingPage || !hasPage || leaseLost || !leaseToken"
        @click="emit('submit')"
      >
        {{ saving ? '提交中…' : '检查并提交' }}
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
          <p class="text-sm text-muted">⌘/Ctrl+S 草稿 · ⌘/Ctrl+Enter 提交 · Alt+←/→ 切换</p>
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
      v-if="feedback.kind !== 'editing'"
      class="editor-task-feedback"
      :class="{ 'draft-indicator': feedback.kind === 'draft' }"
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
import { inject } from 'vue'
import AppButton from '@/components/AppButton.vue'
const returnTarget = inject('workReturnTarget', '/tasks')
defineProps({
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
