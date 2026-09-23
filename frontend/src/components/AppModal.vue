<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="modal-backdrop"
      role="presentation"
      @click.self="onBackdrop"
    >
      <section
        ref="dialogRef"
        class="confirmation-dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <div v-if="mark" class="confirmation-dialog__mark" aria-hidden="true">{{ mark }}</div>
        <div>
          <slot />
        </div>
        <div class="confirmation-dialog__actions">
          <slot name="actions" />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { initialFocusTarget, wrapFocus } from '@/lib/modalFocus'

const props = defineProps({
  open: { type: Boolean, default: false },
  titleId: { type: String, required: true },
  mark: { type: String, default: '' },
  closeOnBackdrop: { type: Boolean, default: true },
  closeOnEsc: { type: Boolean, default: true }
})

const emit = defineEmits(['close'])
const dialogRef = ref(null)
let previousFocus = null
let previousOverflow = ''

watch(() => props.open, async (isOpen) => {
  if (typeof document === 'undefined') return
  if (isOpen) {
    previousFocus = document.activeElement
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    await nextTick()
    initialFocusTarget(dialogRef.value)?.focus?.()
    return
  }
  if (!previousFocus) return
  restorePage()
}, { immediate: true })

onBeforeUnmount(restorePage)

function restorePage() {
  if (typeof document === 'undefined') return
  document.body.style.overflow = previousOverflow
  if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus()
  previousFocus = null
}

function onBackdrop() {
  if (props.closeOnBackdrop) emit('close')
}

function onKeydown(event) {
  if (event.key === 'Escape' && props.closeOnEsc) {
    event.preventDefault()
    emit('close')
    return
  }
  wrapFocus(event, dialogRef.value)
}
</script>
