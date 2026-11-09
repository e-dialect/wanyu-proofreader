<template>
  <div>
    <fieldset class="import-batch-picker">
      <legend>导入批次（可选）</legend>
      <p class="text-sm text-muted">不选择时使用整个项目；选择后只从这些批次取条目。</p>
      <p v-if="pending" role="status">正在读取导入批次…</p>
      <p v-else-if="error" class="text-sm text-muted" role="status">
        暂时无法读取批次，已选范围仍保留。
        <button class="btn btn-quiet btn-sm" type="button" @click="load">重试</button>
      </p>
      <p v-else-if="!batches.length" class="text-sm text-muted">还没有可选导入批次。</p>
      <div class="import-batch-options" role="group" aria-label="选择导入批次">
        <label v-for="batch in batches" :key="batch.id" class="import-batch-option">
          <input
            type="checkbox"
            :checked="selected.includes(batch.id)"
            :disabled="disabled"
            @change="toggle(batch.id, $event.target.checked)"
          />
          <span
            ><strong>{{ batch.original_filename || '未命名导入批次' }}</strong
            ><small
              >{{ batch.created }} · {{ batch.inserted_count || 0 }} 条入册{{
                batch.source_logical_id ? ` · ${batch.source_logical_id}` : ''
              }}</small
            ></span
          >
        </label>
      </div>
    </fieldset>
    <details class="mt-2">
      <summary class="text-sm text-muted">填写已有批次标识</summary>
      <AppField
        ><template #label>导入批次标识</template
        ><input
          :value="modelValue"
          class="form-control"
          :disabled="disabled"
          placeholder="多个批次以逗号分隔；留空表示整个项目"
          @input="$emit('update:modelValue', $event.target.value)"
      /></AppField>
    </details>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import AppField from '@/components/AppField.vue'
import { useAsyncResource } from '@/composables/useAsyncResource'
import { listImportLedger } from '@/services/importJobsService'
import { getPbMessage, getPbStatus } from '@/utils/pbErrors'
const props = defineProps({
  projectId: { type: String, required: true },
  modelValue: { type: String, default: '' },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'access-error'])
const { data, pending, error, reload } = useAsyncResource(() => listImportLedger(props.projectId), {
  initialData: { batches: [] },
  formatError: (cause) => getPbMessage(cause, '导入批次加载失败')
})
const batches = computed(() => data.value?.batches || [])
const selected = computed(() => props.modelValue.split(/[,，\s]+/).filter(Boolean))
function toggle(id, checked) {
  const ids = new Set(selected.value)
  if (checked) ids.add(id)
  else ids.delete(id)
  emit('update:modelValue', [...ids].join(','))
}
const load = async () => {
  const result = await reload()
  if (!result.ok && [401, 403].includes(getPbStatus(result.error)))
    emit('access-error', result.error)
}
onMounted(load)
</script>

<style scoped>
.import-batch-picker {
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.import-batch-options {
  max-height: 16rem;
  overflow-y: auto;
}
.import-batch-option {
  display: flex;
  align-items: start;
  gap: var(--space-2);
  padding: var(--space-2) 0;
}
.import-batch-option input {
  margin-top: var(--space-1);
}
.import-batch-option span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.import-batch-option small {
  display: block;
  color: var(--gray-600);
}
</style>
