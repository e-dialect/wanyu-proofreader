<template>
  <nav
    class="mobile-field-navigation"
    aria-label="字段导航"
    :aria-description="`${workflowLabel}：逐字段查看，再进入整条总览${readOnly ? '' : '检查提交'}。`"
  >
    <template v-if="overview">
      <strong class="field-navigation-stage" aria-current="step"
        >总览<span>{{ headers.length }} 个字段</span></strong
      >
      <AppButton class="field-overview-return" @click="$emit('select', index)">{{
        readOnly ? '返回查看' : '返回编辑'
      }}</AppButton>
      <slot name="submit" />
    </template>
    <template v-else>
      <label
        ><span class="sr-only">选择字段</span
        ><select
          class="form-control"
          :value="index"
          @change="$emit('select', Number($event.target.value))"
        >
          <option v-for="(header, i) in headers" :key="header" :value="i">
            {{ i + 1 }}/{{ headers.length }} · {{ header }}
          </option>
        </select></label
      >
      <AppButton
        v-if="index < headers.length - 1"
        variant="ghost"
        class="field-overview-entry"
        @click="$emit('overview')"
        >{{ readOnly ? '整条总览' : '总览/提交' }}</AppButton
      >
      <AppButton variant="primary" class="field-step" @click="$emit('next')">
        {{ index >= headers.length - 1 ? (readOnly ? '整条总览' : '总览/提交') : '下一字段' }}
      </AppButton>
    </template>
  </nav>
</template>
<script setup>
import AppButton from '@/components/AppButton.vue'
defineProps({
  headers: { type: Array, required: true },
  index: Number,
  overview: Boolean,
  readOnly: Boolean,
  workflowLabel: { type: String, default: '校对' }
})
defineEmits(['select', 'next', 'overview'])
</script>
