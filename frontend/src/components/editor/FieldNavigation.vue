<template>
  <nav class="mobile-field-navigation" aria-label="字段导航">
    <template v-if="overview">
      <strong>整条总览 · {{ headers.length }} 个字段</strong>
      <button class="btn btn-secondary" @click="$emit('select', index)">返回编辑</button>
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
            {{ i + 1 }} / {{ headers.length }} · {{ header }}
          </option>
        </select></label
      >
      <button
        class="btn btn-secondary field-step"
        :disabled="index === 0"
        aria-label="上一个"
        title="上一字段"
        @click="$emit('select', index - 1)"
      >
        <AppIcon name="back" />
      </button>
      <button
        class="btn btn-primary field-step"
        :aria-label="index >= headers.length - 1 ? '整条总览' : '下一个'"
        :title="index >= headers.length - 1 ? '整条总览' : '下一字段'"
        @click="$emit('next')"
      >
        <AppIcon :name="index >= headers.length - 1 ? 'check' : 'arrow'" />
      </button>
    </template>
  </nav>
</template>
<script setup>
import AppIcon from '@/components/AppIcon.vue'
defineProps({ headers: { type: Array, required: true }, index: Number, overview: Boolean })
defineEmits(['select', 'next'])
</script>
