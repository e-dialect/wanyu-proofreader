<template>
  <div class="source-picker">
    <AppField>
      <template #label>{{ label }}</template>
      <select
        :value="modelValue"
        class="form-control"
        :disabled="disabled || pending"
        @change="$emit('update:modelValue', $event.target.value)"
      >
        <option value="">{{ emptyLabel }}</option>
        <option
          v-if="modelValue && !items.some((item) => item.logical_id === modelValue)"
          :value="modelValue"
        >
          已填写的来源：{{ modelValue }}
        </option>
        <option v-for="item in items" :key="item.id" :value="item.logical_id">
          {{ item.title }}{{ item.holder ? ` · ${item.holder}` : '' }}
        </option>
      </select>
    </AppField>
    <p v-if="pending" class="text-sm text-muted" role="status">正在读取可用来源…</p>
    <p v-else-if="error" class="text-sm text-muted" role="status">
      来源清单暂时不可用。可以重试或填写已有来源标识。
      <button type="button" class="btn btn-quiet btn-sm" :disabled="disabled" @click="load">
        重试
      </button>
    </p>
    <p v-else-if="!items.length" class="text-sm text-muted" role="note">
      {{ emptyHint }}
    </p>
    <details class="source-picker-advanced">
      <summary>填写已有来源标识</summary>
      <AppField>
        <template #label>来源标识</template>
        <input
          :value="modelValue"
          class="form-control"
          :disabled="disabled"
          placeholder="填写已有来源的登记标识"
          @input="$emit('update:modelValue', $event.target.value.trim())"
        />
      </AppField>
      <p class="text-sm text-muted" role="note">
        只填写你已获授权使用的来源；选择来源不会改变用途许可。
      </p>
    </details>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import AppField from '@/components/AppField.vue'
import { useAsyncResource } from '@/composables/useAsyncResource'
import { listSources } from '@/services/sourcesService'
import { getPbMessage, getPbStatus } from '@/utils/pbErrors'

defineProps({
  modelValue: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  emptyLabel: { type: String, default: '暂不关联来源' },
  emptyHint: {
    type: String,
    default: '当前没有可选来源。未关联的批次仍可导入，并明确保留未知来源状态。'
  },
  label: { type: String, default: '本批来源（可稍后关联）' }
})
const emit = defineEmits(['update:modelValue', 'access-error'])
const { data, pending, error, reload } = useAsyncResource(({ signal }) => listSources({ signal }), {
  initialData: { items: [] },
  formatError: (cause) => getPbMessage(cause, '来源清单加载失败')
})
const items = computed(() => data.value?.items || [])
const load = async () => {
  const result = await reload()
  if (!result.ok && [401, 403].includes(getPbStatus(result.error)))
    emit('access-error', result.error)
}
onMounted(load)
</script>

<style scoped>
.source-picker-advanced {
  margin-top: var(--space-2);
}
.source-picker-advanced summary {
  color: var(--gray-600);
  font-size: var(--text-sm);
  cursor: pointer;
}
.source-picker-advanced[open] {
  padding-bottom: var(--space-2);
}
</style>
