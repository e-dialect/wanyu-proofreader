<template>
  <AppModal
    :open="researchOpen"
    title-id="research-notice-title"
    mark="研"
    :close-on-backdrop="false"
    :close-on-esc="false"
  >
    <div class="page-eyebrow">提交之前</div>
    <h2 id="research-notice-title">{{ researchCopy.title }}</h2>
    <p>{{ researchCopy.body }}</p>
    <p v-if="researchError" class="alert alert-error" role="alert">{{ researchError }}</p>
    <template #actions>
      <button
        type="button"
        class="btn btn-secondary"
        :disabled="researchSaving"
        @click="emit('choose', 'opt_out')"
      >
        {{ researchCopy.optOutLabel }}
      </button>
      <button
        type="button"
        class="btn btn-primary"
        :disabled="researchSaving"
        @click="emit('choose', 'participate')"
      >
        {{ researchSaving ? '正在记录…' : researchCopy.participateLabel }}
      </button>
    </template>
  </AppModal>
</template>
<script setup>
import AppModal from '@/components/AppModal.vue'
defineProps({
  researchOpen: Boolean,
  researchCopy: { type: Object, required: true },
  researchError: String,
  researchSaving: Boolean
})
const emit = defineEmits(['choose'])
</script>
