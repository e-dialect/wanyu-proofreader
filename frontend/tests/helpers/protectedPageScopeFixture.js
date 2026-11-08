import { readFileSync } from 'node:fs'
import { createProtectedPageScope } from '../../src/lib/protectedPageScope.js'

const composable = readFileSync(
  new URL('../../src/composables/useProtectedPageScope.js', import.meta.url),
  'utf8'
)
  .replace(/^import .*\n/gm, '')
  .replace('export function useProtectedPageScope', 'function useProtectedPageScope')

// Execute the production composable and controller; mock only Vue lifecycle
// registration and PocketBase's synchronous auth-store change notification.
export function protectedPageScopeFixture(registerDispose = () => {}) {
  const listeners = new Set()
  const authStore = {
    model: { id: 'account-a', role: 'user' },
    token: 'token-a',
    get isValid() {
      return Boolean(this.model?.id && this.token)
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const useProtectedPageScope = new Function(
    'onBeforeUnmount',
    'ref',
    'pb',
    'createProtectedPageScope',
    `${composable}\nreturn useProtectedPageScope`
  )(registerDispose, (value) => ({ value }), { authStore }, createProtectedPageScope)
  return {
    useProtectedPageScope,
    authStore,
    changeIdentity(model, token = model ? 'next-token' : '') {
      authStore.model = model
      authStore.token = token
      for (const listener of listeners) listener(token, model)
    },
    listenerCount: () => listeners.size
  }
}
