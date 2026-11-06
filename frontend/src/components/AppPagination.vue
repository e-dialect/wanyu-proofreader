<template>
  <nav class="admin-pagination" :aria-label="label">
    <button
      type="button"
      :class="buttonClass"
      :disabled="busy || page <= 1"
      @click="$emit('change', page - 1)"
    >
      上一页
    </button>
    <span aria-live="polite"
      ><slot name="position"
        >第 {{ page }}<template v-if="totalPages"> / {{ totalPages }}</template> 页</slot
      ></span
    >
    <button
      type="button"
      :class="buttonClass"
      :disabled="busy || (totalPages ? page >= totalPages : !hasNext)"
      @click="$emit('change', page + 1)"
    >
      下一页
    </button>
  </nav>
</template>
<script setup>
defineProps({
  page: { type: Number, required: true },
  totalPages: { type: Number, default: 0 },
  hasNext: Boolean,
  busy: Boolean,
  label: { type: String, default: '列表分页' },
  buttonClass: { type: String, default: 'btn btn-secondary' }
})
defineEmits(['change'])
</script>
