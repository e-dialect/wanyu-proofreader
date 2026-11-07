import { nextTick, toValue, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { browserSessionStorage, takeQueuePosition } from '@/lib/queueReturn'

// Restore only after the current list has rendered, so a slow request cannot
// clamp the saved position against an empty loading page.
export function useQueueReturnPosition(ready) {
  const route = useRoute(),
    auth = useAuthStore()
  watch(
    () => [route.fullPath, Boolean(toValue(ready))],
    async ([path, loaded]) => {
      if (!loaded) return
      const userId = auth.user?.id
      await nextTick()
      if (route.fullPath !== path || auth.user?.id !== userId) return
      const position = takeQueuePosition(browserSessionStorage(), userId, path)
      if (position) window.scrollTo({ ...position, behavior: 'instant' })
    },
    { immediate: true, flush: 'post' }
  )
}
