<template>
  <div data-main-landmark><RouterView :key="adminRouteKey(route)" /></div>
</template>
<script setup>
import { useRoute, RouterView } from 'vue-router'
import { adminRouteKey } from '@/lib/adminRouteKey'
const route = useRoute()
</script>
