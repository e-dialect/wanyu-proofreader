<template>
  <main class="container page">
    <h1>我的问题与草稿</h1>
    <p>草稿与问题报告不计入完整校对人数。恢复后继续逐字段对照最新来源。</p>
    <RouterLink to="/tasks" class="btn btn-secondary">返回大厅</RouterLink>
    <button class="btn btn-secondary" :disabled="loading" @click="load">刷新</button>
    <p v-if="loading" role="status">正在加载…</p>
    <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>
    <section v-if="data" class="card mt-4">
      <h2>未完成草稿</h2>
      <p v-if="!data.drafts.length" class="empty-state-text">暂无服务端草稿。</p>
      <ul><li v-for="draft in data.drafts" :key="draft.id">第 {{ draft.page_number }} 条 <span v-if="draft.stale">· 来源或约定已变化，恢复时须重新核对</span> <button class="btn btn-secondary btn-sm" :disabled="busy" @click="resume(draft.page)">恢复任务</button></li></ul>
    </section>
    <section v-if="data" class="card mt-4">
      <h2>我的问题</h2>
      <p v-if="!data.items.length" class="empty-state-text">尚未提交问题。</p>
      <article v-for="report in data.items" :key="report.id" class="problem-item">
        <strong>第 {{ report.page_number }} 条 · {{ report.field || '整条' }} · {{ PROBLEM_STATES[report.issue.status] }}</strong>
        <p>{{ PROBLEM_TYPES[report.category] }}：{{ report.description }}</p>
        <p>{{ report.issue.feedback || '等待管理员受理。' }}</p>
        <p v-if="report.issue.impact">影响范围：{{ report.issue.impact }}</p>
        <p v-if="report.stale">来源、约定或配置已变更，旧处理意见需确认是否仍适用。</p>
        <button class="btn btn-secondary btn-sm" :disabled="busy" @click="resume(report.page)">回到对应任务</button>
      </article>
    </section>
  </main>
</template>
<script setup>
import { onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { getMyProblems, resumeProblemTask, PROBLEM_STATES, PROBLEM_TYPES } from '@/services/verificationService'
import { saveTaskLease } from '@/lib/taskLease'
import { currentUserId } from '@/services/authService'
import { getPbMessage } from '@/utils/pbErrors'
const router = useRouter()
const data = ref(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
onMounted(load)
async function load() {
  loading.value = true; error.value = ''
  try { data.value = await getMyProblems() } catch (e) { error.value = getPbMessage(e, '问题加载失败') } finally { loading.value = false }
}
async function resume(pageId) {
  busy.value = true; error.value = ''
  try {
    const result = await resumeProblemTask(pageId)
    saveTaskLease(window.sessionStorage, { userId: currentUserId(), pageId, token: result.leaseToken, expiresAt: result.leaseExpiresAt })
    await router.push(`/tasks/${pageId}/edit`)
  } catch (e) { error.value = getPbMessage(e, '恢复任务失败，请稍后重试') } finally { busy.value = false }
}
</script>
<style scoped>
.problem-item { border-top: 1px solid var(--line); padding: var(--space-3) 0; }
</style>
