<template>
  <AppModal
    :open="open"
    :title-id="titleId"
    :mark="mark"
    :close-on-backdrop="closeOnBackdrop"
    :close-on-esc="closeOnEsc"
    @close="$emit('close')"
  >
    <slot />
    <template #actions>
      <slot name="actions">
        <button type="button" class="btn btn-secondary" :disabled="busy" @click="$emit('close')">
          {{ cancelLabel }}
        </button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="busy || disabled"
          @click="$emit('confirm')"
        >
          {{ confirmLabel }}
        </button>
      </slot>
    </template>
  </AppModal>
</template>
<script setup>
import AppModal from '@/components/AppModal.vue'
defineProps({
  open: Boolean,
  titleId: { type: String, required: true },
  mark: { type: String, default: '' },
  busy: Boolean,
  disabled: Boolean,
  cancelLabel: { type: String, default: '取消' },
  confirmLabel: { type: String, default: '确认' },
  closeOnBackdrop: { type: Boolean, default: true },
  closeOnEsc: { type: Boolean, default: true }
})
defineEmits(['close', 'confirm'])
</script>
