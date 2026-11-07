<template>
  <button
    ref="element"
    :type="type"
    class="btn app-button"
    :class="[variants[variant], { 'btn-sm': size === 'sm' }]"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <span v-if="loading" class="app-button__spinner" aria-hidden="true"></span>
    <slot />
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
  loading: { type: Boolean, default: false }
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
