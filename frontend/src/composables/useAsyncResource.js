import { onBeforeUnmount, ref, shallowRef } from 'vue'
import { createAsyncResource } from '@/lib/asyncResource'

export function useAsyncResource(loader, options = {}) {
  const data = shallowRef(options.initialData ?? null)
  const pending = ref(false)
  const error = ref('')
  const hasValue = ref(false)
  const isEmpty = ref(true)
  const resource = createAsyncResource(loader, {
    ...options,
    onChange: (state) => {
      data.value = state.data
      pending.value = state.pending
      error.value = state.error
      hasValue.value = state.hasValue
      isEmpty.value = state.isEmpty
      options.onChange?.(state)
    }
  })
  isEmpty.value = resource.state.isEmpty
  onBeforeUnmount(resource.dispose)
  return {
    data,
    pending,
    error,
    hasValue,
    isEmpty,
    reload: resource.reload,
    cancel: resource.cancel
  }
}
