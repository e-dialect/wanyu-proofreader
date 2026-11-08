<template>
  <div
    :class="presentation.className"
    class="app-status-panel"
    :data-status-state="state"
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
      <AppIcon
        v-if="title && state !== 'empty'"
        :name="state === 'error' ? 'alert' : 'help'"
        class="app-status-panel__icon"
      />
      <div class="app-status-panel__body">
        <strong v-if="title" class="app-status-panel__title">{{ title }}</strong>
        <slot
          ><span :class="{ 'empty-state-text': state === 'empty' }">{{
            presentation.message
          }}</span></slot
        >
      </div>
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
import AppIcon from '@/components/AppIcon.vue'
import { statusPresentation } from '@/lib/asyncResource'
const props = defineProps({
  state: { type: String, required: true },
  reason: { type: String, default: '' },
  message: { type: String, default: '' },
  title: { type: String, default: '' },
  retryLabel: { type: String, default: '' },
  busy: Boolean
})
defineEmits(['retry'])
const presentation = computed(() => statusPresentation(props.state, props.reason, props.message))
</script>
<style scoped>
.app-status-panel:not([data-status-state='pending']):not([data-status-state='empty']) {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
}
.app-status-panel__body {
  min-width: 0;
  flex: 1 1 20ch;
  line-height: 1.7;
}
.app-status-panel__body p + p {
  margin-top: var(--space-1);
}
.app-status-panel__icon {
  margin-top: var(--space-1);
}
.app-status-panel__title {
  display: block;
  margin-bottom: var(--space-1);
  font-size: var(--text-md);
  line-height: 1.5;
}
.app-status-panel > .app-button {
  margin: 0;
  flex-shrink: 0;
  align-self: center;
}
.app-status-skeleton {
  padding: var(--space-4);
}
.app-status-line {
  margin-top: var(--space-2);
}
</style>
