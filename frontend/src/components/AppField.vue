<template>
  <label :class="layout === 'plain' ? 'form-label' : 'form-group'">
    <template v-if="layout === 'plain'"
      ><slot name="label">{{ label }}</slot></template
    >
    <span v-else class="form-label"
      ><slot name="label">{{ label }}</slot></span
    >
    <slot />
  </label>
</template>
<script setup>
defineProps({ label: { type: String, default: '' }, layout: { type: String, default: 'group' } })
</script>
