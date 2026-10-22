<template>
  <fieldset class="source-judgment" :disabled="disabled">
    <legend>{{ label }}的来源判断</legend>
    <p v-if="modelValue.stale" class="text-sm">旧判断依据已变化，请重新核实；历史仍保留。</p>
    <label class="form-label" :for="`${id}-state`">正误</label>
      <select :id="`${id}-state`" class="form-control" :value="modelValue.state" @change="update('state', $event.target.value)">
        <option value="">未记录</option><option value="correct">正确</option><option value="incorrect">错误</option><option value="pending">待核实／看不清</option><option value="withdrawn">撤回原判断，恢复待核实</option>
      </select>
    <template v-if="modelValue.state">
      <label class="form-label">来源页内位置<input class="form-control" :value="modelValue.location" maxlength="1000" @input="update('location', $event.target.value)"></label>
      <label class="form-label">依据／待处理原因<input class="form-control" :value="modelValue.reason" maxlength="2000" placeholder="按来源判断；未采用的合法形式也可以正确" @input="update('reason', $event.target.value)"></label>
    </template>
  </fieldset>
</template>
<script setup>
import { useId } from 'vue'
const id = useId()
const props = defineProps({ modelValue: { type: Object, required: true }, label: String, disabled: Boolean })
const emit = defineEmits(['update:modelValue'])
function update(key, value) { emit('update:modelValue', { ...props.modelValue, [key]: value, stale: false, dirty: true }) }
</script>
<style scoped>
.source-judgment { margin-top: var(--space-2); border: 1px solid var(--line); padding: var(--space-2); border-radius: var(--radius-sm); }
.source-judgment legend { font-size: var(--text-sm); }
.source-judgment .form-label { font-size: var(--text-sm); display: block; margin-top: var(--space-1); }
</style>
