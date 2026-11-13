<template>
  <article
    class="proofread-field"
    tabindex="-1"
    :aria-labelledby="`proofread-field-title-${index}`"
    :class="{
      'proofread-field--active': active,
      'proofread-field--changed': changed,
      'proofread-field--wide': wide
    }"
  >
    <header class="proofread-field__header">
      <button v-if="mobile && overview" class="btn btn-secondary" @click="emit('select')">
        {{ ownReview ? '查看此字段' : '修改此字段' }}
      </button>
      <div>
        <span class="sr-only">字段 {{ index + 1 }}</span>
        <h2 :id="`proofread-field-title-${index}`">{{ header }}</h2>
      </div>
      <div class="proofread-field__actions">
        <span v-if="changed" class="field-change-label">已修改</span>
        <button
          v-if="!ownReview && changed"
          type="button"
          class="btn btn-quiet btn-sm"
          :disabled="restoreDisabled"
          @click="emit('restore')"
        >
          恢复导入值
        </button>
      </div>
    </header>
    <label class="sr-only" :for="`proofread-field-${index}`">{{ header }} 校对结果</label>
    <textarea
      :id="`proofread-field-${index}`"
      :ref="setInput"
      v-model="value"
      :lang="language"
      :inputmode="inputMode"
      :readonly="readOnly"
      rows="1"
      class="form-control proofread-textarea"
      :placeholder="`输入${header}的校对结果`"
      @focus="emit('activate', $event)"
      @blur="emit('remember', $event)"
      @select="emit('remember', $event)"
      @keyup="emit('remember', $event)"
      @click="emit('remember', $event)"
      @input="onInput"
    ></textarea>
    <div class="source-value source-value--compact">
      <span>导入文本</span>
      <AppFieldValue
        as="p"
        :value="originalValue"
        :segments="segments"
        :lang="language"
        :font-notice="false"
      />
    </div>
  </article>
</template>
<script setup>
import AppFieldValue from '@/components/AppFieldValue.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
const props = defineProps({
  header: String,
  index: Number,
  originalValue: String,
  segments: Array,
  language: String,
  active: Boolean,
  changed: Boolean,
  mobile: Boolean,
  overview: Boolean,
  ownReview: Boolean,
  restoreDisabled: Boolean,
  readOnly: Boolean,
  inputMode: String
})
const value = defineModel({ type: String, default: '' })
const input = ref(null)
const wide = computed(
  () =>
    /\n/.test(value.value) || Math.max(value.value.length, props.originalValue?.length || 0) > 100
)
let observer
let alive = true
let composing = false
function setInput(element) {
  input.value = element
  emit('textarea', element)
}
function fit() {
  const element = input.value
  if (!alive || !element?.getClientRects().length) return
  const styles = getComputedStyle(element)
  const minimum = Number.parseFloat(styles.minHeight) || 48
  const maximum = Number.parseFloat(styles.maxHeight) || 176
  const border =
    (Number.parseFloat(styles.borderTopWidth) || 0) +
    (Number.parseFloat(styles.borderBottomWidth) || 0)
  element.style.height = 'auto'
  element.style.height = `${Math.min(maximum, Math.max(minimum, element.scrollHeight + border))}px`
}
function onInput(event) {
  // v-model updates immediately; the post-render value watcher fits once after
  // the DOM update. IME preedit has no model update until composition ends, so
  // keep its visible textarea growing without committing the composing value.
  const preedit = event.isComposing || event.target?.composing
  // The final input also fits when composition is cancelled back to the same
  // model value, which would not trigger the value watcher.
  if (preedit || composing) fit()
  composing = Boolean(preedit)
  emit('change')
}
watch([value, () => props.mobile, () => props.overview], () => nextTick(fit), { flush: 'post' })
onMounted(() => {
  fit()
  if (typeof ResizeObserver !== 'undefined') {
    let width = 0
    observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width !== width) {
        width = entry.contentRect.width
        fit()
      }
    })
    observer.observe(input.value)
  }
  document.fonts?.addEventListener('loadingdone', fit)
})
onBeforeUnmount(() => {
  alive = false
  observer?.disconnect()
  document.fonts?.removeEventListener('loadingdone', fit)
})
const emit = defineEmits(['select', 'restore', 'textarea', 'activate', 'remember', 'change'])
</script>
