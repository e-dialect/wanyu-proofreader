export const ONBOARDING_PREFIX = 'fangji:onboarding:v1'

export function onboardingKey(userId) {
  return `${ONBOARDING_PREFIX}:${String(userId || '')}`
}

function readRaw(storage, userId) {
  if (!storage || !userId) return null
  try {
    const raw = storage.getItem(onboardingKey(userId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

export function hasCompletedOnboarding(storage, userId) {
  const parsed = readRaw(storage, userId)
  return Boolean(parsed?.completed)
}

export function markOnboardingSeen(storage, userId, completedAt = new Date().toISOString()) {
  if (!storage || !userId) return false
  try {
    storage.setItem(onboardingKey(userId), JSON.stringify({
      version: 1,
      completed: true,
      completedAt
    }))
    return true
  } catch {
    return false
  }
}

export function resetOnboarding(storage, userId) {
  if (!storage || !userId) return
  try {
    storage.removeItem(onboardingKey(userId))
  } catch {
    return
  }
}

export function browserLocalStorage() {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function shouldIgnoreEditorShortcut(event, onboardingApi) {
  return Boolean(event?.defaultPrevented || onboardingApi?.open)
}
