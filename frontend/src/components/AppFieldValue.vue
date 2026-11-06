<template>
  <component
    :is="as"
    v-bind="$attrs"
    class="app-field-value"
    :lang="lang || undefined"
    data-field-value-text
  >
    <template v-if="parts"
      ><span
        v-for="(part, index) in parts"
        :key="index"
        :class="{ 'source-value__hit': part.hit }"
        >{{ part.text }}</span
      ></template
    ><template v-else>{{ text || emptyLabel }}</template>
  </component>
  <span
    v-if="fontNotice && fontState === 'loading'"
    class="field-font-status"
    role="status"
    data-font-state="loading"
    >字形正在加载，请稍候核对。</span
  >
  <span
    v-else-if="fontNotice && fontState === 'error'"
    class="field-font-status alert-error"
    role="alert"
    data-font-state="error"
    >补充字体未加载：{{ unavailable.map(codePointLabel).join('、') }}；原字符已保留。<button
      type="button"
      class="btn btn-quiet btn-sm"
      @click="retry"
    >
      重试字体
    </button></span
  >
</template>

<script setup>
import { computed } from 'vue'
import { codePointLabel } from '@/lib/rareCharacters'
import { exactFieldSegments } from '@/lib/fieldValue'
import { useFontAvailability } from '@/composables/useFontAvailability'

defineOptions({ inheritAttrs: false })
const props = defineProps({
  value: { type: [String, Number], default: '' },
  lang: { type: String, default: '' },
  segments: { type: Array, default: null },
  as: { type: String, default: 'span' },
  emptyLabel: { type: String, default: '（空白）' },
  fontNotice: { type: Boolean, default: true }
})
const text = computed(() => String(props.value ?? ''))
const parts = computed(() => exactFieldSegments(text.value, props.segments))
const {
  state: fontState,
  unavailable,
  retry
} = useFontAvailability(computed(() => (props.fontNotice ? [text.value] : [])))
</script>

<style scoped>
.app-field-value {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--font-rare), var(--font-ui);
}
.field-font-status {
  display: block;
  font-size: var(--text-xs);
  user-select: none;
}
</style>
