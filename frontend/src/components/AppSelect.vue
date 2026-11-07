<template>
  <SelectRoot
    v-model:open="open"
    :model-value="selectedKey"
    :disabled="disabled"
    @update:model-value="select"
  >
    <SelectTrigger v-bind="$attrs" class="form-control app-select-trigger">
      <SelectValue :placeholder="placeholder" />
      <SelectIcon as-child><AppIcon name="chevron" /></SelectIcon>
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        class="app-menu app-select-menu"
        position="popper"
        :side-offset="6"
        :collision-padding="12"
      >
        <SelectScrollUpButton class="app-select-scroll" aria-label="向上滚动选项"
          ><AppIcon name="chevron-up"
        /></SelectScrollUpButton>
        <SelectViewport class="app-select-viewport">
          <SelectItem
            v-for="option in options"
            :key="optionKey(option.value)"
            class="app-menu__item app-select-item"
            :value="optionKey(option.value)"
            :disabled="disabled || option.disabled"
          >
            <SelectItemText>{{ option.label }}</SelectItemText>
            <SelectItemIndicator class="app-select-check"
              ><AppIcon name="check"
            /></SelectItemIndicator>
          </SelectItem>
        </SelectViewport>
        <SelectScrollDownButton class="app-select-scroll" aria-label="向下滚动选项"
          ><AppIcon name="chevron"
        /></SelectScrollDownButton>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
<script setup>
import { computed, ref, watch } from 'vue'
import {
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectPortal,
  SelectContent,
  SelectViewport,
  SelectItem,
  SelectItemText,
  SelectItemIndicator,
  SelectScrollUpButton,
  SelectScrollDownButton
} from 'reka-ui'
import AppIcon from '@/components/AppIcon.vue'
import '@/styles/ui-components.css'
defineOptions({ inheritAttrs: false })
const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  options: { type: Array, required: true },
  placeholder: { type: String, default: '请选择' },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue'])
const open = ref(false)
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) open.value = false
  }
)
// Non-empty, type-tagged keys preserve empty strings and numeric values while
// keeping an option's identity stable if an async refresh reorders the list.
const optionKey = (value) => `${typeof value}:${value}`
const selectedKey = computed(() => {
  return props.options.some((option) => option.value === props.modelValue)
    ? optionKey(props.modelValue)
    : undefined
})
function select(key) {
  if (props.disabled || typeof key !== 'string') return
  const option = props.options.find((option) => optionKey(option.value) === key)
  if (option && !option.disabled) emit('update:modelValue', option.value)
}
</script>
