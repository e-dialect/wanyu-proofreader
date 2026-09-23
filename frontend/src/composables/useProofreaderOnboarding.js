import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  browserLocalStorage,
  hasCompletedOnboarding,
  markOnboardingSeen,
  resetOnboarding
} from '@/lib/onboarding'
import { ONBOARDING_MOBILE_MAX, onboardingSteps } from '@/lib/onboardingSteps'

export function useProofreaderOnboarding(userIdRef) {
  const open = ref(false)
  const stepIndex = ref(0)
  const mobile = ref(false)
  const steps = computed(() => onboardingSteps(mobile.value))
  const step = computed(() => steps.value[Math.min(stepIndex.value, steps.value.length - 1)] || null)
  const isFirst = computed(() => stepIndex.value <= 0)
  const isLast = computed(() => stepIndex.value >= steps.value.length - 1)
  const positionLabel = computed(() => `${stepIndex.value + 1} / ${steps.value.length}`)

  function currentUserId() {
    return String(userIdRef?.value || '')
  }

  function measure() {
    mobile.value = typeof window !== 'undefined' && window.innerWidth <= ONBOARDING_MOBILE_MAX
  }

  function startIfUnseen() {
    if (open.value) return true
    const userId = currentUserId()
    if (!userId || hasCompletedOnboarding(browserLocalStorage(), userId)) return false
    stepIndex.value = 0
    measure()
    open.value = true
    return true
  }

  function reopen() {
    const userId = currentUserId()
    if (!userId) return false
    resetOnboarding(browserLocalStorage(), userId)
    stepIndex.value = 0
    measure()
    open.value = true
    return true
  }

  function dismiss() {
    markOnboardingSeen(browserLocalStorage(), currentUserId())
    open.value = false
  }

  function next() {
    if (isLast.value) {
      dismiss()
      return
    }
    stepIndex.value += 1
  }

  function prev() {
    if (isFirst.value) return
    stepIndex.value -= 1
  }

  onMounted(() => {
    measure()
    if (typeof window !== 'undefined') window.addEventListener('resize', measure)
  })

  onBeforeUnmount(() => {
    if (typeof window !== 'undefined') window.removeEventListener('resize', measure)
  })

  return {
    open,
    step,
    stepIndex,
    steps,
    isFirst,
    isLast,
    positionLabel,
    startIfUnseen,
    reopen,
    dismiss,
    next,
    prev
  }
}
