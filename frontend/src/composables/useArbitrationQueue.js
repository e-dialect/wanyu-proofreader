import { computed, ref } from 'vue'
import { getPbMessage } from '../utils/pbErrors.js'

export function useArbitrationQueue(load) {
  const state = ref('idle')
  const error = ref('')
  const data = ref(null)
  let version = 0
  async function refresh(project, anchor) {
    const current = ++version
    state.value = 'loading'; error.value = ''; data.value = null
    try {
      const result = await load(project, anchor)
      if (current !== version) return null
      data.value = result; state.value = 'ready'
      return result
    } catch (e) {
      if (current !== version) return null
      error.value = getPbMessage(e, '加载待仲裁队列失败，请重试。')
      state.value = 'error'
      return null
    }
  }
  const positionLabel = computed(() => {
    if (state.value === 'loading') return '正在加载待仲裁队列…'
    if (state.value === 'error') return '队列位置暂不可用'
    if (state.value !== 'ready') return '队列位置尚未加载'
    if (!data.value.totalItems) return '当前没有待仲裁条目'
    return data.value.position > 0
      ? `待仲裁第 ${data.value.position} / ${data.value.totalItems} 条`
      : `本条已离开待仲裁队列 · 剩余 ${data.value.totalItems} 条`
  })
  return { state, error, data, refresh, positionLabel }
}
