<template>
  <section class="project-next-actions" aria-label="选择待办队列">
    <article class="project-next-action">
      <h2>待仲裁</h2>
      <p>独立结果有差异的条目，逐字段决定最终内容。</p>
      <RouterLink
        :to="{
          ...link('work', 'entries'),
          query: { ...link('work', 'entries').query, status: 'arbitration', page: undefined }
        }"
        class="btn btn-primary"
        >处理仲裁</RouterLink
      >
    </article>
    <article class="project-next-action">
      <h2>来源复核</h2>
      <p>补录来源判断，处理暂缓与依据变化后的复核。</p>
      <RouterLink
        :to="`/admin/projects/${projectId}/verification?view=review`"
        class="btn btn-secondary"
        >打开复核队列</RouterLink
      >
    </article>
    <article class="project-next-action">
      <h2>成员报告的问题</h2>
      <p>集中处理来源、工具与内容问题，并向成员反馈。</p>
      <RouterLink
        :to="`/admin/projects/${projectId}/verification?view=problems`"
        class="btn btn-secondary"
        >处理问题</RouterLink
      >
    </article>
    <article class="project-next-action">
      <h2>拼音归一复核</h2>
      <p>为机器无法判断的条目给出统一写法与依据。</p>
      <RouterLink
        :to="{
          ...link('work', 'normalization'),
          query: { ...link('work', 'normalization').query, schemeView: 'review' }
        }"
        class="btn btn-secondary"
        >打开归一复核</RouterLink
      >
    </article>
  </section>
</template>
<script setup>
import { RouterLink } from 'vue-router'
import { projectWorkspaceTarget } from '@/lib/projectWorkspace'
const props = defineProps({
  projectId: { type: String, required: true },
  query: { type: Object, default: () => ({}) }
})
const link = (section, view) => projectWorkspaceTarget(props.projectId, section, view, props.query)
</script>
