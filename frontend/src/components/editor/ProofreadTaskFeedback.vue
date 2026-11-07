<template>
  <div v-if="saved" class="alert alert-success" role="status">{{ saved }}</div>
  <div v-if="claimNextFailure" class="alert alert-error" role="alert">
    <p>{{ claimNextFailureNotice }}</p>
    <div class="claim-next-actions">
      <RouterLink to="/tasks" class="btn btn-secondary btn-sm">返回大厅</RouterLink>
      <button
        type="button"
        class="btn btn-primary btn-sm"
        :disabled="retryingClaim"
        @click="emit('retry-claim')"
      >
        {{ retryingClaim ? '正在领取…' : '重试领取' }}
      </button>
    </div>
  </div>
  <div v-if="leaseLost" class="alert alert-error lease-lost-alert" role="alert">
    <span>{{ saveError || '任务租约已失效，本地草稿仍然保留。' }}</span>
    <button class="btn btn-secondary btn-sm" :disabled="reclaiming" @click="emit('reclaim')">
      {{ reclaiming ? '重新领取中…' : '重新领取任务' }}
    </button>
  </div>
  <div v-else-if="saveError" class="alert alert-error" role="alert">{{ saveError }}</div>

  <details v-if="staleLocalDrafts.length" class="alert" role="note">
    <summary>本人旧版／失配本机草稿（{{ staleLocalDrafts.length }}）</summary>
    <p>旧值未自动套用到新来源；请逐字段重新核对。</p>
    <dl v-for="(draft, index) in staleLocalDrafts" :key="index">
      <template v-for="(value, field) in draft.row" :key="field"
        ><dt>{{ field }}</dt>
        <dd><AppFieldValue :value="value" :font-notice="false" /></dd
      ></template>
    </dl>
  </details>

  <div class="field-progress-summary">
    <div>
      <span>结构化校对</span>
      <strong>{{ fieldCount }} 个字段，已修改 {{ changedCount }} 个</strong>
    </div>
    <span class="pass-badge">独立校对</span>
  </div>
</template>
<script setup>
import { RouterLink } from 'vue-router'
import AppFieldValue from '@/components/AppFieldValue.vue'
defineProps({
  saved: String,
  claimNextFailure: Boolean,
  claimNextFailureNotice: String,
  retryingClaim: Boolean,
  leaseLost: Boolean,
  saveError: String,
  reclaiming: Boolean,
  ownReview: Boolean,
  draftStatus: String,
  leaseStatus: String,
  staleLocalDrafts: { type: Array, default: () => [] },
  fieldCount: Number,
  changedCount: Number
})
const emit = defineEmits(['retry-claim', 'reclaim'])
</script>
