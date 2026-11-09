import { readFileSync } from 'node:fs'
import { ref, shallowRef, computed, watch, toValue, reactive, nextTick } from 'vue'
const vue = { ref, shallowRef, computed, watch, toValue, reactive, nextTick }
import * as observer from '../../src/lib/jobObserver.js'

// Evaluate the production composable with a deterministic host. Components use
// real Vue refs/watchers and the real registry; no timer or network survives a test.
export function jobObserverScope(cleanup = []) {
  let authChange
  const authStore = {
    isValid: true,
    model: { id: 'test-user' },
    onChange: (fn) => {
      authChange = fn
    }
  }
  const scope = {
    ...vue,
    ...observer,
    createJobObserverRegistry: () =>
      observer.createJobObserverRegistry({
        setTimer: () => 1,
        clearTimer: () => {}
      }),
    pb: { authStore },
    onMounted: (fn) => fn(),
    onBeforeUnmount: (fn) => cleanup.push(fn),
    navigator: { onLine: true },
    window: { addEventListener() {}, removeEventListener() {} },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  }
  const script = readFileSync(
    new URL('../../src/composables/useJobObserver.js', import.meta.url),
    'utf8'
  )
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\n/gm, '')
    .replace(/^export /gm, '')
  const useJobObserver = new Function(...Object.keys(scope), `${script};return useJobObserver`)(
    ...Object.values(scope)
  )
  return {
    ...vue,
    useJobObserver,
    watch(...args) {
      const stop = vue.watch(...args)
      cleanup.push(stop)
      return stop
    },
    onBeforeUnmount: (fn) => cleanup.push(fn),
    onMounted: () => {},
    changeAuth(userId) {
      authStore.isValid = Boolean(userId)
      authStore.model = userId ? { id: userId } : null
      authChange(userId ? 'token' : '', authStore.model)
    }
  }
}
