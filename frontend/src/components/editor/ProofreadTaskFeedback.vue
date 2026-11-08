<template>
  <AppDisclosure
    v-if="saved && !claimNextFailure"
    class="editor-result-note"
    role="note"
    label="最近一次操作结果"
  >
    <p>{{ saved }}</p>
  </AppDisclosure>
  <div v-if="claimNextFailure" class="editor-recovery-note" role="alert">
    <p>{{ claimNextFailureNotice }}</p>
    <div class="claim-next-actions">
      <RouterLink to="/tasks" class="btn btn-secondary btn-sm">返回大厅</RouterLink>
      <AppButton size="sm" variant="primary" :loading="retryingClaim" @click="emit('retry-claim')">
        {{ retryingClaim ? '正在领取…' : '重试领取' }}
      </AppButton>
    </div>
  </div>
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
import { RouterLink } from 'vue-router'
import AppFieldValue from '@/components/AppFieldValue.vue'
import AppButton from '@/components/AppButton.vue'
import AppDisclosure from '@/components/AppDisclosure.vue'
defineProps({
  saved: String,
  claimNextFailure: Boolean,
  claimNextFailureNotice: String,
  retryingClaim: Boolean,
  leaseLost: Boolean,
  saveError: String,
  reclaiming: Boolean,
  staleLocalDrafts: { type: Array, default: () => [] }
})
const emit = defineEmits(['retry-claim', 'reclaim'])
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
</style>
