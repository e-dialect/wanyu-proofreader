<template>
  <AppDisclosure
    v-if="saved && !claimNextFailure && !noNextTask"
    class="editor-result-note"
    role="note"
    label="最近一次操作结果"
  >
    <p>{{ saved }}</p>
  </AppDisclosure>
  <section
    v-if="submittedHere && noNextTask"
    ref="continuationStatus"
    class="editor-completion-note"
    role="status"
    tabindex="-1"
  >
    <strong>这一条已提交</strong>
    <p>{{ saved }}</p>
    <p class="text-sm text-muted">当前暂时没有下一条可由你处理；这不表示项目全部完成。</p>
    <div class="claim-next-actions">
      <RouterLink :to="ownSubmissionsTarget" class="btn btn-secondary btn-sm">
        查看本人本项目提交
      </RouterLink>
      <RouterLink :to="availableTasksTarget" class="btn btn-primary btn-sm">
        查看本项目可领取任务
      </RouterLink>
      <RouterLink v-if="practiceGuide" :to="practiceGuide" class="btn btn-quiet btn-sm">
        返回本步骤练习
      </RouterLink>
    </div>
  </section>
  <div
    v-if="claimNextFailure"
    ref="continuationStatus"
    class="editor-recovery-note"
    role="alert"
    tabindex="-1"
  >
    <p>{{ claimNextFailureNotice }}</p>
    <div class="claim-next-actions">
      <RouterLink :to="returnTarget" class="btn btn-secondary btn-sm">返回原任务列表</RouterLink>
      <RouterLink v-if="practiceGuide" :to="practiceGuide" class="btn btn-quiet btn-sm">
        返回本步骤练习
      </RouterLink>
      <AppButton size="sm" variant="primary" :loading="retryingClaim" @click="emit('retry-claim')">
        {{ retryingClaim ? '正在领取…' : '重试领取' }}
      </AppButton>
    </div>
  </div>
  <RouterLink
    v-if="practiceGuide && !noNextTask && !claimNextFailure"
    :to="practiceGuide"
    class="practice-return-link"
  >
    返回本步骤练习
  </RouterLink>
  <div v-if="leaseLost" class="editor-recovery-note lease-lost-alert" role="alert">
    <span>{{ saveError || '任务租约已失效，请保留本页输入。' }}</span>
    <AppButton size="sm" :loading="reclaiming" @click="emit('reclaim')">
      {{ reclaiming ? '重新领取中…' : '重新领取任务' }}
    </AppButton>
  </div>
  <div v-else-if="saveError" class="editor-recovery-note" role="alert">
    <p>{{ saveError }}</p>
    <p class="text-sm text-muted">输入仍在本页，请核对原因后按原操作重试。</p>
  </div>

  <AppDisclosure
    v-if="staleLocalDrafts.length"
    class="alert"
    role="note"
    :label="`本人旧版／失配本机草稿（${staleLocalDrafts.length}）`"
  >
    <p>旧值未自动套用到新来源；请逐字段重新核对。</p>
    <dl v-for="(draft, index) in staleLocalDrafts" :key="index">
      <template v-for="(value, field) in draft.row" :key="field"
        ><dt>{{ field }}</dt>
        <dd><AppFieldValue :value="value" :font-notice="false" /></dd
      ></template>
    </dl>
  </AppDisclosure>
</template>
<script setup>
import { inject, nextTick, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import AppFieldValue from '@/components/AppFieldValue.vue'
import AppButton from '@/components/AppButton.vue'
import AppDisclosure from '@/components/AppDisclosure.vue'
const props = defineProps({
  saved: String,
  submittedHere: Boolean,
  noNextTask: Boolean,
  ownSubmissionsTarget: {
    type: Object,
    default: () => ({ path: '/tasks', query: { view: 'reviewed' } })
  },
  availableTasksTarget: {
    type: Object,
    default: () => ({ path: '/tasks', query: { view: 'available' } })
  },
  practiceGuide: { type: Object, default: null },
  claimNextFailure: Boolean,
  claimNextFailureNotice: String,
  retryingClaim: Boolean,
  leaseLost: Boolean,
  saveError: String,
  reclaiming: Boolean,
  staleLocalDrafts: { type: Array, default: () => [] }
})
const continuationStatus = ref(null)
const returnTarget = inject('workReturnTarget', '/tasks')
const emit = defineEmits(['retry-claim', 'reclaim'])
watch(
  () => [props.submittedHere && props.noNextTask, props.claimNextFailure],
  ([submittedWithoutNext, claimFailed], [previousSubmittedWithoutNext, previousClaimFailed]) => {
    if (
      (!submittedWithoutNext || previousSubmittedWithoutNext) &&
      (!claimFailed || previousClaimFailed)
    )
      return
    void nextTick(() => {
      const node = continuationStatus.value
      if (!node) return
      node.focus({ preventScroll: true })
      node.scrollIntoView?.({ block: 'nearest' })
    })
  },
  { flush: 'post' }
)
</script>
<style scoped>
.editor-recovery-note {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-left: 2px solid var(--danger-ink);
  color: var(--ink);
  background: var(--surface);
}
.editor-recovery-note p {
  margin: 0;
}
.editor-result-note {
  margin-bottom: var(--space-3);
  color: var(--ink-muted);
  font-size: var(--text-sm);
}
.editor-completion-note {
  display: grid;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--primary-line);
  border-radius: var(--radius-card);
  background: var(--primary-glow-soft);
}
.practice-return-link {
  justify-self: start;
  min-height: var(--control-height-sm);
  display: inline-flex;
  align-items: center;
  color: var(--ink-muted);
  font-size: var(--text-sm);
}
.editor-completion-note p {
  margin: 0;
}
</style>
