<template>
  <AppModal
    :open="open"
    title-id="proofreader-onboarding-title"
    mark="导"
    @close="dismiss"
  >
    <div class="page-eyebrow">新手引导 · 第 {{ positionLabel }} 步</div>
    <h2 id="proofreader-onboarding-title">{{ step?.title }}</h2>
    <p class="text-sm text-muted">对应位置：{{ step?.target }}</p>
    <p>{{ step?.body }}</p>
    <template #actions>
      <button type="button" class="btn btn-quiet onboarding-skip" @click="dismiss">跳过</button>
      <button type="button" class="btn btn-secondary" :disabled="isFirst" @click="prev">上一步</button>
      <button type="button" class="btn btn-primary" autofocus @click="next">
        {{ isLast ? '完成' : '下一步' }}
      </button>
    </template>
  </AppModal>
</template>

<script setup>
import { toRef } from 'vue'
import AppModal from '@/components/AppModal.vue'
import { useProofreaderOnboarding } from '@/composables/useProofreaderOnboarding'

const props = defineProps({
  userId: { type: String, default: '' }
})

const {
  open,
  step,
  isFirst,
  isLast,
  positionLabel,
  startIfUnseen,
  reopen,
  dismiss,
  next,
  prev
} = useProofreaderOnboarding(toRef(props, 'userId'))

defineExpose({ startIfUnseen, reopen, open })
</script>
