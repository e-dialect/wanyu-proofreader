import pb from '@/lib/pocketbase'
import { shouldClearAuthAfterRefreshError } from '@/lib/authRefresh'

export function currentUserId(fallbackUser = null) {
  return pb.authStore.model?.id || fallbackUser?.id || null
}

export function currentUserRole(fallbackUser = null) {
  return pb.authStore.model?.role || fallbackUser?.role || null
}

export async function loginWithPassword(identity, password) {
  return pb.collection('users').authWithPassword(identity, password)
}

export async function listExternalProviders() {
  const response = await pb.send('/api/fangji/auth/providers', {
    method: 'GET',
    requestKey: null
  })
  return Array.isArray(response?.providers) ? response.providers : []
}

export async function loginWithExternalProvider(provider, identity, password) {
  const authData = await pb.send(`/api/fangji/auth/external/${encodeURIComponent(provider)}/login`, {
    method: 'POST',
    body: { identity, password },
    requestKey: null
  })
  pb.authStore.save(authData.token, authData.record)
  return authData
}

export async function bindExternalIdentity(provider, identity, password) {
  const result = await pb.send(`/api/fangji/auth/external/${encodeURIComponent(provider)}/bind`, {
    method: 'POST',
    body: { identity, password },
    requestKey: null
  })
  if (result.token && result.record) pb.authStore.save(result.token, result.record)
  return result
}

export async function refreshStoredAuth() {
  if (!pb.authStore.isValid) return null
  try {
    return await pb.collection('users').authRefresh({ requestKey: null })
  } catch (error) {
    if (shouldClearAuthAfterRefreshError(error)) pb.authStore.clear()
    return null
  }
}

export async function registerProofreader({ email, password, passwordConfirm, name }) {
  return pb.collection('users').create({
    email,
    password,
    passwordConfirm,
    name: name.trim(),
    role: 'user'
  }, { requestKey: null })
}

export async function checkNicknameAvailable(name) {
  return pb.send('/api/fangji/auth/nickname-available', {
    method: 'GET', query: { name: name.trim() }, requestKey: null
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
  const { record, token } = await pb.send('/api/fangji/profile', {
    method: 'PATCH', body: { name, email }, requestKey: null
  })
  // Never restore a session that was logged out or replaced during the request.
  if (pb.authStore.isValid && pb.authStore.model?.id === record.id) {
    pb.authStore.save(token, record)
  }
  return record
}
