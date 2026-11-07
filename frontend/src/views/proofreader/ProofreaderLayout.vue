<template>
  <div data-main-landmark><RouterView /></div>
  <ProofreaderOnboarding ref="onboardingRef" :user-id="auth.user?.id || ''" />
</template>
<script setup>
import { provide, ref } from 'vue'
import { RouterView } from 'vue-router'
import ProofreaderOnboarding from '@/components/ProofreaderOnboarding.vue'
import { useAuthStore } from '@/stores/auth'
const auth = useAuthStore()
const onboardingRef = ref(null)
provide('proofreaderOnboarding', onboardingRef)
</script>
