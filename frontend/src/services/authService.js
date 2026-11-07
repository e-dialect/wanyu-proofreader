import pb from '@/lib/pocketbase'
import { shouldClearAuthAfterRefreshError } from '@/lib/authRefresh'

export function currentUserId(fallbackUser = null) {
  return pb.authStore.model?.id || fallbackUser?.id || null
}

export function currentUserRole(fallbackUser = null) {
  return pb.authStore.model?.role || fallbackUser?.role || null
}

// Auth SDK helpers save tokens before resolving. Use the same REST endpoints
// with a scoped publication step, so a late response cannot restore a session
// after logout or replace a different account selected in another tab.
async function withCurrentSession(operation, accept) {
  const store = pb.authStore
  let unchanged = true
  const unsubscribe = store.onChange(() => {
    unchanged = false
  })
  try {
    const result = await operation()
    if (!unchanged || store !== pb.authStore)
      throw new DOMException('登录会话已变化，请重试。', 'AbortError')
    accept(result, store)
    return result
  } finally {
    unsubscribe()
  }
}

export async function loginWithPassword(identity, password) {
  return withCurrentSession(
    () =>
      pb.send('/api/collections/users/auth-with-password', {
        method: 'POST',
        body: { identity, password },
        requestKey: null
      }),
    (result, store) => store.save(result.token, result.record)
  )
}

export async function listExternalProviders() {
  const response = await pb.send('/api/fangji/auth/providers', {
    method: 'GET',
    requestKey: null
  })
  return Array.isArray(response?.providers) ? response.providers : []
}

export async function loginWithExternalProvider(provider, identity, password) {
  return withCurrentSession(
    () =>
      pb.send(`/api/fangji/auth/external/${encodeURIComponent(provider)}/login`, {
        method: 'POST',
        body: { identity, password },
        requestKey: null
      }),
    (result, store) => store.save(result.token, result.record)
  )
}

export async function bindExternalIdentity(provider, identity, password) {
  return withCurrentSession(
    () =>
      pb.send(`/api/fangji/auth/external/${encodeURIComponent(provider)}/bind`, {
        method: 'POST',
        body: { identity, password },
        requestKey: null
      }),
    (result, store) => {
      if (result.token && result.record) store.save(result.token, result.record)
    }
  )
}

export async function refreshStoredAuth() {
  if (!pb.authStore.isValid) return null
  try {
    return await withCurrentSession(
      async () => {
        try {
          return await pb.send('/api/collections/users/auth-refresh', {
            method: 'POST',
            requestKey: null
          })
        } catch (error) {
          return { refreshError: error }
        }
      },
      (result, store) => {
        if (result.refreshError) {
          if (shouldClearAuthAfterRefreshError(result.refreshError)) store.clear()
        } else store.save(result.token, result.record)
      }
    ).then((result) => (result.refreshError ? null : result))
  } catch {
    return null
  }
}

export async function registerProofreader({ email, password, passwordConfirm, name }) {
  return pb.collection('users').create(
    {
      email,
      password,
      passwordConfirm,
      name: name.trim(),
      role: 'user'
    },
    { requestKey: null }
  )
}

export async function checkNicknameAvailable(name) {
  return pb.send('/api/fangji/auth/nickname-available', {
    method: 'GET',
    query: { name: name.trim() },
    requestKey: null
  })
}

export async function changeInitialPassword({ currentPassword, newPassword, newPasswordConfirm }) {
  return pb.send('/api/fangji/auth/change-initial-password', {
    method: 'POST',
    body: { currentPassword, newPassword, newPasswordConfirm },
    requestKey: null
  })
}

export function clearAuth() {
  pb.authStore.clear()
}

export async function updateProfile({ name, email }) {
  const result = await withCurrentSession(
    () =>
      pb.send('/api/fangji/profile', {
        method: 'PATCH',
        body: { name, email },
        requestKey: null
      }),
    ({ token, record }, store) => {
      if (store.isValid && store.model?.id === record.id) store.save(token, record)
    }
  )
  return result.record
}
