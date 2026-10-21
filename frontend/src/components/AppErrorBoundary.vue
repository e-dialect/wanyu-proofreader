<template>
  <slot v-if="!error" />
  <main v-else id="main-content" tabindex="-1" class="fatal-error">
    <div class="card fatal-error-card" role="alert">
      <div class="empty-state-icon">⚠️</div>
      <h1 class="font-bold">页面暂时无法显示</h1>
      <p class="text-muted">
        页面运行时发生了异常。你可以先重试；若问题持续，请记录当前操作并查看浏览器控制台。
      </p>
      <p v-if="errorMessage" class="fatal-error-detail">{{ errorMessage }}</p>
      <div class="flex gap-2">
        <button type="button" class="btn btn-primary" @click="reload">重新加载</button>
        <button type="button" class="btn btn-secondary" @click="clearError">返回当前页面</button>
      </div>
    </div>
  </main>
</template>

<script setup>
import { computed, nextTick, onErrorCaptured, ref, watch } from 'vue'
import { prepareMainLandmark } from '@/lib/mainLandmark'

const error = ref(null)
const errorMessage = computed(() => import.meta.env.DEV ? (error.value?.message || '') : '')

watch(error, async () => {
  await nextTick()
  prepareMainLandmark()
})

onErrorCaptured((capturedError, instance, info) => {
  error.value = capturedError
  console.error('Unhandled Vue render error:', capturedError, info, instance)
  return false
})

function clearError() {
  error.value = null
}

function reload() {
  window.location.reload()
}
</script>
