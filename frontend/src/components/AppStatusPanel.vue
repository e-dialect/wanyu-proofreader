<template>
  <div
    :class="presentation.className"
    :role="presentation.role"
    :aria-label="state === 'pending' ? presentation.message : undefined"
  >
    <template v-if="state === 'pending'">
      <div class="skeleton-card app-status-skeleton" aria-hidden="true">
        <span class="skeleton-line skeleton-line--short"></span>
        <span class="skeleton-line app-status-line"></span>
      </div>
      <span class="sr-only">{{ presentation.message }}</span>
    </template>
    <template v-else>
      <div v-if="state === 'empty'" class="empty-state-text">
        <slot>{{ presentation.message }}</slot>
      </div>
      <slot v-else>{{ presentation.message }}</slot>
      <AppButton
        v-if="retryLabel"
        type="button"
        class="ml-2"
        size="sm"
        :loading="busy"
        @click="$emit('retry')"
      >
        {{ retryLabel }}
      </AppButton>
    </template>
  </div>
</template>
<script setup>
import { computed } from 'vue'
import AppButton from '@/components/AppButton.vue'
import { statusPresentation } from '@/lib/asyncResource'
const props = defineProps({
  state: { type: String, required: true },
  reason: { type: String, default: '' },
  message: { type: String, default: '' },
  retryLabel: { type: String, default: '' },
  busy: Boolean
})
defineEmits(['retry'])
const presentation = computed(() => statusPresentation(props.state, props.reason, props.message))
</script>
<style scoped>
.app-status-skeleton {
  padding: var(--space-4);
}
.app-status-line {
  margin-top: var(--space-2);
}
</style>
