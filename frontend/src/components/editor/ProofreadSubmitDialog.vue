<template>
  <ConfirmDialog
    :open="reviewingSubmission"
    title-id="submit-review-title"
    mark="校"
    @close="emit('close')"
  >
    <div class="page-eyebrow">提交前确认</div>
    <h2 id="submit-review-title">确认第 {{ pageNumber }} 条校对结果</h2>
    <p v-if="changedFields.length">
      你修改了 {{ changedFields.length }} 个字段：{{ changedFields.join('、') }}。
    </p>
    <p v-else>本条没有修改字段。请确认每个字段均已对照来源 PDF，空白字段也已核对。</p>
    <label class="form-label"
      ><input v-model="sourceChecked" type="checkbox" /> 我已逐字段对照本条来源 PDF</label
    >
    <p class="text-sm text-muted">
      这是本次校对的完整核对声明；机器提示及操作记录不作为独立来源参照。
    </p>
    <p class="alert alert-error confirmation-dialog__irreversible" role="alert">
      {{ irreversibleSubmitNotice }}
    </p>
    <p class="text-sm text-muted">
      字写错了改文字字段，记音不对改读音字段。这两类都要在确认前改完。
    </p>
    <p class="text-sm text-muted">确认后，系统会自动流转并尝试领取本项目下一条。</p>
    <p v-if="saveError" class="alert alert-error" role="alert" data-submit-error>
      {{ saveError }} 输入已保留；可以继续检查或再次确认提交。
    </p>
    <p v-if="saving" role="status">正在提交，请等待结果，当前输入会保留。</p>
    <template #actions>
      <button type="button" class="btn btn-secondary" @click="emit('close')">继续检查</button>
      <button
        ref="submitConfirmButton"
        type="button"
        class="btn btn-success"
        autofocus
        :disabled="saving || leaseLost || !leaseToken || !sourceChecked"
        @click="emit('submit')"
      >
        {{ saving ? '正在提交…' : '确认提交' }}
      </button>
    </template>
  </ConfirmDialog>
</template>
<script setup>
import { ref } from 'vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
defineProps({
  reviewingSubmission: Boolean,
  pageNumber: [String, Number],
  changedFields: { type: Array, default: () => [] },
  irreversibleSubmitNotice: String,
  saving: Boolean,
  leaseLost: Boolean,
  leaseToken: String,
  saveError: String
})
const sourceChecked = defineModel('sourceChecked', { type: Boolean, default: false })
const emit = defineEmits(['close', 'submit'])
const submitConfirmButton = ref(null)
defineExpose({ focus: () => submitConfirmButton.value?.focus() })
</script>
