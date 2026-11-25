<template>
  <ConfirmDialog
    :open="returnModalOpen && !ownReview"
    title-id="return-modal-title"
    mark="退"
    :close-on-esc="!returning"
    :close-on-backdrop="!returning"
    @close="emit('close')"
  >
    <div class="page-eyebrow">退回给资料接入</div>
    <h2 id="return-modal-title">退回第 {{ pageNumber }} 条</h2>
    <p class="text-sm text-muted">
      说明这条为什么需要资料接入重新处理。退回后它会从校对队列消失，进入「待返工」。
    </p>
    <label class="form-group">
      <span class="form-label">退回理由</span>
      <select v-model="returnReason" :disabled="returning" class="form-control">
        <option value="" disabled>请选择理由</option>
        <option v-for="r in RETURN_REASONS" :key="r.value" :value="r.value">{{ r.label }}</option>
      </select>
    </label>
    <label class="form-group mt-3">
      <span class="form-label">退回依据（必填）</span>
      <textarea
        v-model="returnBasis"
        :disabled="returning"
        class="form-control"
        rows="3"
        placeholder="一句话说明哪里对不上，例如：第三列释义和原书第 606 页对不上"
      ></textarea>
    </label>
    <label class="form-label mt-3"
      ><input
        v-model="queueMode"
        type="checkbox"
        :disabled="returning"
        @change="emit('queue-mode')"
      />
      队列模式（先攒着，稍后一键全部退回）</label
    >
    <p v-if="returnQueue.length" class="text-sm text-muted mt-2">
      退回队列里已有 {{ returnQueue.length }} 条。
      <button
        type="button"
        ref="batchButton"
        class="btn btn-quiet btn-sm"
        :disabled="returning"
        @click="emit('batch')"
      >
        全部退回
      </button>
    </p>
    <p v-if="returning" ref="pendingStatus" role="status" tabindex="0">
      正在退回，请等待处理结果。
    </p>
    <p v-if="saveError" class="alert alert-error" role="alert" data-return-error>
      {{ saveError }} 退回理由与依据已保留，请重试。
    </p>
    <template #actions>
      <button type="button" class="btn btn-secondary" :disabled="returning" @click="emit('close')">
        取消
      </button>
      <button
        type="button"
        ref="confirmButton"
        class="btn btn-danger"
        :disabled="returning || !returnReason || !returnBasis.trim()"
        @click="emit('confirm')"
      >
        {{ returning ? '退回中…' : queueMode ? '加入退回队列' : '立即退回' }}
      </button>
    </template>
  </ConfirmDialog>
</template>
<script setup>
import { ref, watch } from 'vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { RETURN_REASONS } from '@/lib/returnQueue'
const props = defineProps({
  returnModalOpen: Boolean,
  ownReview: Boolean,
  pageNumber: [String, Number],
  returnQueue: { type: Array, default: () => [] },
  saveError: String,
  returning: Boolean
})
const returnReason = defineModel('returnReason', { type: String, default: '' })
const returnBasis = defineModel('returnBasis', { type: String, default: '' })
const queueMode = defineModel('queueMode', { type: Boolean, default: false })
const confirmButton = ref(null)
const batchButton = ref(null)
const pendingStatus = ref(null)
watch(
  () => props.returning,
  (busy) => {
    if (busy) pendingStatus.value?.focus()
  },
  { flush: 'post' }
)
defineExpose({
  focus: () => confirmButton.value?.focus(),
  focusBatch: () => batchButton.value?.focus()
})
const emit = defineEmits(['close', 'queue-mode', 'batch', 'confirm'])
</script>
