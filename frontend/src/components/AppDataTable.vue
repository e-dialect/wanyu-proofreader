<template>
  <div class="table-wrapper" role="region" tabindex="0" :aria-label="label">
    <table :class="tableClass">
      <thead v-if="$slots.head">
        <slot name="head" />
      </thead>
      <tbody>
        <slot />
      </tbody>
    </table>
  </div>
</template>
<script setup>
defineProps({
  label: { type: String, required: true },
  tableClass: { type: [String, Array, Object], default: '' }
})
</script>
