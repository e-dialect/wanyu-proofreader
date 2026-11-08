<template>
  <CollapsibleRoot
    v-model:open="open"
    class="app-disclosure"
    :disabled="disabled"
    :unmount-on-hide="false"
  >
    <CollapsibleTrigger ref="trigger" class="app-disclosure__trigger">
      <AppIcon name="chevron" class="app-disclosure__chevron" />
      <span class="app-disclosure__summary"
        ><slot name="summary">{{ label }}</slot></span
      >
    </CollapsibleTrigger>
    <CollapsibleContent
      ref="content"
      class="app-disclosure__content"
      :inert="!open || undefined"
      :aria-hidden="!open || undefined"
    >
      <div v-if="contentVisited" class="app-disclosure__body"><slot /></div>
    </CollapsibleContent>
  </CollapsibleRoot>
</template>
<script setup>
import { computed, ref, watch } from 'vue'
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from 'reka-ui'
import AppIcon from '@/components/AppIcon.vue'
import '@/styles/ui-components.css'

const props = defineProps({
  label: { type: String, default: '' },
  modelValue: { type: Boolean, default: undefined },
  defaultOpen: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  lazy: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue'])
const localOpen = ref(props.defaultOpen)
const trigger = ref(null)
const content = ref(null)
const open = computed({
  get: () => props.modelValue ?? localOpen.value,
  set: (value) => {
    localOpen.value = value
    emit('update:modelValue', value)
  }
})
const contentVisited = ref(!props.lazy || open.value)
watch(
  [open, () => props.lazy],
  ([value, lazy]) => {
    if (value || !lazy) contentVisited.value = true
  },
  { flush: 'sync' }
)
watch(open, (value) => {
  if (!value && content.value?.$el?.contains(document.activeElement)) trigger.value?.$el?.focus()
})
</script>
