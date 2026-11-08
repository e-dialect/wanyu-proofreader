<template>
  <button
    ref="element"
    :type="type"
    class="btn app-button"
    :class="[variants[variant], { 'btn-sm': size === 'sm', 'app-button--busy': loading }]"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <span
      class="app-button__content"
      :class="{
        'app-button__content--hidden': loading && loadingLabel,
        'app-button__content--busy': loading && !loadingLabel
      }"
      :aria-hidden="loading && loadingLabel ? true : undefined"
      ><slot
    /></span>
    <span
      v-if="loadingLabel"
      class="app-button__loading-content"
      :class="{ 'app-button__loading-content--visible': loading }"
      :aria-hidden="!loading || undefined"
      ><span class="app-button__spinner" aria-hidden="true"></span>{{ loadingLabel }}</span
    >
    <span v-else-if="loading" class="app-button__busy-indicator" aria-hidden="true">
      <span class="app-button__spinner"></span>
    </span>
  </button>
</template>
<script setup>
import { ref } from 'vue'
import '@/styles/ui-components.css'
defineProps({
  type: { type: String, default: 'button' },
  variant: {
    type: String,
    default: 'secondary',
    validator: (value) => ['primary', 'secondary', 'ghost', 'danger'].includes(value)
  },
  size: { type: String, default: 'md', validator: (value) => ['sm', 'md'].includes(value) },
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  loadingLabel: { type: String, default: '' }
})
const variants = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-quiet',
  danger: 'btn-danger'
}
const element = ref(null)
defineExpose({ focus: (options) => element.value?.focus(options) })
</script>
<style scoped>
.app-button {
  position: relative;
  display: inline-grid;
  justify-items: center;
  max-width: 100%;
}
.app-button__content,
.app-button__loading-content {
  grid-area: 1 / 1;
  display: inline-flex;
  justify-content: center;
  align-items: center;
  gap: inherit;
  min-width: 0;
}
.app-button__loading-content {
  visibility: hidden;
}
.app-button__loading-content--visible {
  visibility: visible;
}
.app-button__content--hidden {
  visibility: hidden;
}
.app-button__content--busy {
  opacity: 0;
}
.app-button__busy-indicator {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
}
</style>
