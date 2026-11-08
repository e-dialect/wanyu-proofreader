<template>
  <Teleport :to="target || 'body'" :disabled="!target">
    <details
      v-if="open"
      ref="tip"
      class="onboarding-tip"
      :class="{ 'onboarding-tip--header': target }"
      @keydown.esc.prevent="closeTip"
    >
      <summary :aria-label="`校对小贴士 · ${positionLabel}`">
        校对提示 <small>{{ positionLabel }}</small>
      </summary>
      <div class="onboarding-tip__body">
        <h2>{{ step?.title }}</h2>
        <p>{{ step?.body }}</p>
        <div class="onboarding-tip__actions">
          <button type="button" class="btn btn-quiet btn-sm" @click="dismiss">跳过</button
          ><button type="button" class="btn btn-secondary btn-sm" :disabled="isFirst" @click="prev">
            上一步</button
          ><button type="button" class="btn btn-primary btn-sm" @click="next">
            {{ isLast ? '完成' : '下一步' }}
          </button>
        </div>
      </div>
    </details>
  </Teleport>
</template>
<script setup>
import { onMounted, ref, toRef } from 'vue'
import { useProofreaderOnboarding } from '@/composables/useProofreaderOnboarding'
const props = defineProps({ userId: { type: String, default: '' } })
const { open, step, isFirst, isLast, positionLabel, startIfUnseen, reopen, dismiss, next, prev } =
  useProofreaderOnboarding(toRef(props, 'userId'))
// This optional, non-modal hint never takes focus or disables editor shortcuts.
const target = ref(null),
  tip = ref(null)
onMounted(() => {
  target.value = document.getElementById('workbench-guidance')
})
function closeTip() {
  if (tip.value) {
    tip.value.open = false
    tip.value.querySelector('summary')?.focus()
  }
}
const blocking = false
defineExpose({ startIfUnseen, reopen, open, blocking })
</script>
