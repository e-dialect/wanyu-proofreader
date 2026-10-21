<template>
  <a class="skip-link" href="#main-content">跳到主要内容</a>
  <AppErrorBoundary>
    <RouterView />
  </AppErrorBoundary>
</template>

<script setup>
import { RouterView } from 'vue-router'
import AppErrorBoundary from '@/components/AppErrorBoundary.vue'
</script>
