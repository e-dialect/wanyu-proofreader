<template>
  <DropdownMenuRoot v-model:open="open" :modal="false">
    <DropdownMenuTrigger
      ref="trigger"
      v-bind="$attrs"
      class="btn btn-quiet btn-sm app-dropdown-trigger"
      :disabled="disabled"
      :aria-label="$attrs['aria-label'] || label"
    >
      <slot name="trigger">{{ label }}<AppIcon name="chevron" /></slot>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        class="app-menu"
        :align="align"
        :side-offset="6"
        :collision-padding="12"
        @close-auto-focus="returnFocus"
      >
        <template v-for="item in items" :key="item.action || item.to || item.label">
          <DropdownMenuSeparator v-if="item.separator" class="app-menu__separator" />
          <DropdownMenuItem
            v-if="item.to && !item.disabled"
            as-child
            class="app-menu__item"
            @select="emit('select', item.action)"
          >
            <RouterLink :to="item.to">{{ item.label }}</RouterLink>
          </DropdownMenuItem>
          <DropdownMenuItem
            v-else
            class="app-menu__item"
            :class="{ 'app-menu__item--danger': item.danger }"
            :disabled="item.disabled"
            @select="choose(item)"
          >
            {{ item.label }}
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator
} from 'reka-ui'
import AppIcon from '@/components/AppIcon.vue'
import '@/styles/ui-components.css'
defineOptions({ inheritAttrs: false })
const props = defineProps({
  items: { type: Array, required: true },
  label: { type: String, default: '更多操作' },
  align: { type: String, default: 'end' },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['select'])
const open = ref(false)
const trigger = ref(null)
let disposed = false
let actionSelected = false
onBeforeUnmount(() => {
  disposed = true
})
watch(open, (isOpen) => {
  if (isOpen) actionSelected = false
})
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) open.value = false
  }
)
async function choose(item) {
  if (item.disabled || props.disabled) return
  actionSelected = true
  open.value = false
  // Unmount the portal and return focus before a consumer opens a dialog.
  // AppModal can then remember the stable trigger instead of a removed item.
  await nextTick()
  if (disposed || props.disabled || item.disabled || !props.items.includes(item)) return
  const element = trigger.value?.$el || trigger.value
  element?.focus?.()
  emit('select', item.action)
}
function returnFocus(event) {
  // A menu action may have already moved focus into an AppModal.
  if (actionSelected || document.activeElement?.closest('[role="dialog"]')) event.preventDefault()
}
</script>
