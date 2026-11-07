<template>
  <article
    class="proofread-field"
    :class="{ 'proofread-field--active': active, 'proofread-field--changed': changed }"
  >
    <header class="proofread-field__header">
      <button v-if="mobile && overview" class="btn btn-secondary" @click="emit('select')">
        修改此字段
      </button>
      <div>
        <span>字段 {{ index + 1 }}</span>
        <h2>{{ header }}</h2>
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
    <div class="source-value">
      <span>导入文本</span>
      <AppFieldValue
        as="p"
        :value="originalValue"
        :segments="segments"
        :lang="language"
        :font-notice="false"
      />
    </div>
    <ul
      v-if="hints.length || hintOverflow"
      class="field-hint-list"
      :aria-label="`${header} 机器疑点`"
    >
      <li v-for="(hint, hintIndex) in hints" :key="`${header}-hint-${hintIndex}`">
        <button
          type="button"
          class="field-hint-chip"
          :data-finding-id="hint.id"
          :class="{ 'field-hint-chip--strong': hint.highlight }"
          @click="emit('locate', hint)"
        >
          <b aria-hidden="true">疑</b>{{ hintLabel(hint.kind) }}
        </button>
        <span class="field-hint-reason">{{ hint.text }}</span>
        <small v-if="hint.inputStatus === 'different_input'"
          >提示分析输入与当前导入值不同，已撤去字符定位，请按字段重新核对。</small
        >
        <small v-else-if="hint.inputStatus === 'legacy_unrecorded'"
          >旧版提示，完整输入版本未记录。</small
        >
      </li>
      <li v-if="hintOverflow" class="field-hint-overflow">
        本字段疑点较多，已按密度折叠 {{ hintOverflow }} 条
      </li>
    </ul>
    <label class="sr-only" :for="`proofread-field-${index}`">{{ header }} 校对结果</label>
    <textarea
      :id="`proofread-field-${index}`"
      :ref="(el) => emit('textarea', el)"
      v-model="value"
      :lang="language"
      :inputmode="inputMode"
      :readonly="readOnly"
      class="form-control proofread-textarea"
      :placeholder="`输入${header}的校对结果`"
      @focus="emit('activate', $event)"
      @blur="emit('remember', $event)"
      @select="emit('remember', $event)"
      @keyup="emit('remember', $event)"
      @click="emit('remember', $event)"
      @input="emit('change')"
    ></textarea>
  </article>
</template>
<script setup>
import AppFieldValue from '@/components/AppFieldValue.vue'
import { hintKindLabel as hintLabel } from '@/lib/fieldHints'
defineProps({
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
  inputMode: String,
  hints: { type: Array, default: () => [] },
  hintOverflow: Number
})
const value = defineModel({ type: String, default: '' })
const emit = defineEmits([
  'select',
  'restore',
  'locate',
  'textarea',
  'activate',
  'remember',
  'change'
])
</script>
