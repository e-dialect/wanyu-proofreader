<template>
  <p v-if="state === 'loading'" class="alert" role="status" data-font-state="loading">
    字形正在加载；字体就绪前请勿据此确认音标、上标或生僻字形。
  </p>
  <p v-else-if="state === 'error'" class="alert alert-error" role="alert" data-font-state="error">
    补充字体暂不可用；当前字形可能来自回退字体，请按码位核对：
    <span v-for="char in unavailable" :key="char">{{ char }}（{{ codePointLabel(char) }}） </span>
    。原文仍完整保留。
    <button type="button" class="btn btn-secondary btn-sm" @click="retry">重试加载字体</button>
  </p>
</template>

<script setup>
import { computed } from 'vue'
import { codePointLabel } from '@/lib/rareCharacters'
import { useFontAvailability } from '@/composables/useFontAvailability'

const props = defineProps({ texts: { type: Array, default: () => [] } })
const { state, unavailable, retry } = useFontAvailability(computed(() => props.texts))
</script>
