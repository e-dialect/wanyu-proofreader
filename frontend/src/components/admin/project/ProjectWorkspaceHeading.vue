<template>
  <header class="page-heading project-detail-heading">
    <div class="project-heading-main">
      <RouterLink to="/admin" class="btn btn-quiet project-heading-return">
        <AppIcon name="back" /><span class="sr-only">所有项目</span>
      </RouterLink>
      <div class="project-heading-title">
        <h1>{{ project?.name || '项目工作区' }}</h1>
        <ProjectPurposeBadge :purpose="project?.purpose" />
        <details v-if="project?.description" class="project-heading-description">
          <summary>项目简介</summary>
          <p>{{ project.description }}</p>
        </details>
      </div>
    </div>
  </header>
</template>
<script setup>
import ProjectPurposeBadge from '@/components/ProjectPurposeBadge.vue'
import { RouterLink } from 'vue-router'
import AppIcon from '@/components/AppIcon.vue'
defineProps({
  project: { type: Object, default: null }
})
</script>
