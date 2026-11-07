<template>
  <main class="container page workbench-home">
    <header class="page-heading">
      <div>
        <div class="page-eyebrow">万语校坊 / 我的工作</div>
        <h1>{{ greeting }}，继续手边的校勘</h1>
        <p>从当前任务开始，或处理一项需要你判断的工作。</p>
      </div>
      <button class="btn btn-quiet" :disabled="loading" @click="refresh">
        <AppIcon name="refresh" />{{ loading ? '正在更新' : '刷新' }}
      </button>
    </header>
    <AppStatusPanel
      v-if="accessError"
      state="error"
      :message="accessError"
      retry-label="重新加载"
      @retry="refresh"
    />
    <AppStatusPanel v-if="actionError" state="error" :message="actionError" />
    <AppStatusPanel v-if="loading && !accessReady" state="pending" message="正在准备你的工作台…" />
    <template v-if="accessReady">
      <section class="workbench-start" aria-labelledby="workbench-start-title">
        <div class="workbench-start__copy">
          <span class="page-eyebrow">{{
            resume ? '继续工作' : available ? '开始校对' : '欢迎来到校坊'
          }}</span>
          <h2 id="workbench-start-title">
            {{ resumeProjectName || available?.project.name || '让下一份材料有据可查' }}
          </h2>
          <p>
            {{
              resume?.detail ||
              (available
                ? '对照来源，独立完成下一条材料。草稿会保留在当前设备。'
                : '进入项目查看待办，或找到一项可以参与的工作。')
            }}
          </p>
        </div>
        <RouterLink v-if="resume" :to="resume.path" class="btn btn-primary btn-lg"
          >{{ resume.label }}<AppIcon name="arrow"
        /></RouterLink>
        <button
          v-else-if="available"
          class="btn btn-primary btn-lg"
          :disabled="Boolean(opening)"
          @click="startProject(available)"
        >
          {{ opening ? '正在打开…' : '开始校对' }}<AppIcon name="arrow" />
        </button>
        <RouterLink v-else :to="canManage ? '/admin' : '/projects'" class="btn btn-primary"
          >{{ canManage ? '查看项目待办' : '浏览可加入项目' }}<AppIcon name="arrow"
        /></RouterLink>
      </section>
      <div class="workbench-columns">
        <section
          v-if="auth.hasProofreadingProjects || !canManage"
          class="workbench-section"
          aria-labelledby="my-work-title"
        >
          <div class="section-heading">
            <div>
              <h2 id="my-work-title">我的校对</h2>
              <p>{{ queues.length ? '进行中的工作优先显示' : '从一条材料开始' }}</p>
            </div>
            <RouterLink to="/tasks">全部任务 →</RouterLink>
          </div>
          <AppStatusPanel
            v-if="queueError"
            state="error"
            :message="queueError"
            retry-label="重试任务"
            @retry="reloadQueues"
          />
          <AppStatusPanel
            v-if="queuePending && !queueData"
            state="pending"
            message="正在读取任务…"
          />
          <div v-else-if="queues.length" class="workbench-list">
            <article
              v-for="queue in queues.slice(0, 5)"
              :key="queue.project.id"
              class="workbench-row"
            >
              <span class="workbench-row__icon"><AppIcon name="task" /></span>
              <div class="workbench-row__body">
                <h3>{{ queue.project.name }}</h3>
                <p>
                  {{
                    queue.activeMine
                      ? `正在处理第 ${queue.activePage?.page_number || '—'} 条`
                      : `${queue.claimable} 条可领取`
                  }}
                </p>
              </div>
              <RouterLink
                v-if="queue.activeMine && queue.activePage"
                :to="`/tasks/${queue.activePage.id}/edit`"
                class="btn btn-secondary"
                >继续</RouterLink
              ><button
                v-else
                class="btn btn-secondary"
                :disabled="Boolean(opening) || !queue.nextPage"
                @click="startProject(queue)"
              >
                {{ opening === queue.project.id ? '正在打开…' : queue.nextPage ? '开始' : '查看' }}
              </button>
            </article>
          </div>
          <div v-else-if="!queueError && !queuePending" class="workbench-empty">
            <AppIcon name="source" />
            <p>目前没有进行中的校对任务。</p>
            <RouterLink to="/projects">找到可以参与的项目 →</RouterLink>
          </div>
          <RouterLink to="/tasks/problems" class="workbench-secondary-link"
            >查看我的问题与未完成工作 →</RouterLink
          >
        </section>
        <section v-else class="workbench-section" aria-labelledby="managed-progress-title">
          <div class="section-heading">
            <div>
              <h2 id="managed-progress-title">项目进展</h2>
              <p>从材料准备到校勘成果，查看当前工作</p>
            </div>
            <RouterLink to="/admin">全部项目 →</RouterLink>
          </div>
          <AppStatusPanel
            v-if="managedError"
            state="error"
            :message="managedError"
            retry-label="重试项目"
            @retry="reloadManaged"
          />
          <AppStatusPanel
            v-if="managedPending && !managedData"
            state="pending"
            message="正在读取项目进展…"
          />
          <div v-else-if="managedData?.items?.length" class="workbench-list">
            <article
              v-for="item in managedData.items.slice(0, 5)"
              :key="item.project.id"
              class="workbench-row"
            >
              <span class="workbench-row__icon"><AppIcon name="project" /></span>
              <div class="workbench-row__body">
                <h3>{{ item.project.name }}</h3>
                <p>{{ item.summary.approved }} / {{ item.summary.total }} 条完成校对流程</p>
              </div>
              <RouterLink
                :to="`/admin/projects/${item.project.id}?section=overview`"
                class="btn btn-secondary"
                >查看</RouterLink
              >
            </article>
          </div>
          <div v-else-if="!managedPending && !managedError" class="workbench-empty">
            <AppIcon name="project" />
            <p>还没有需要管理的项目。</p>
            <RouterLink v-if="auth.canCreateProjects" to="/admin/projects/new"
              >创建第一个项目 →</RouterLink
            >
          </div>
        </section>
        <section v-if="canManage" class="workbench-section" aria-labelledby="attention-title">
          <div class="section-heading">
            <div>
              <h2 id="attention-title">需要你的判断</h2>
              <p>待仲裁条目按项目汇总</p>
            </div>
            <RouterLink to="/admin?filter=attention">全部待办 →</RouterLink>
          </div>
          <AppStatusPanel
            v-if="managedError"
            state="error"
            :message="managedError"
            retry-label="重试项目"
            @retry="reloadManaged"
          />
          <AppStatusPanel
            v-if="managedPending && !managedData"
            state="pending"
            message="正在读取项目待办…"
          />
          <div v-else-if="attention.length" class="workbench-list">
            <article v-for="item in attention" :key="item.project.id" class="workbench-row">
              <span class="workbench-attention-count">{{ item.summary.arbitration }}</span>
              <div class="workbench-row__body">
                <h3>{{ item.project.name }}</h3>
                <p>{{ item.summary.arbitration }} 条需要逐字段仲裁</p>
              </div>
              <RouterLink
                :to="`/admin/projects/${item.project.id}?section=work&status=arbitration`"
                class="btn btn-secondary"
                >处理</RouterLink
              >
            </article>
          </div>
          <div v-else-if="!managedError && !managedPending" class="workbench-empty">
            <AppIcon name="check" />
            <p>当前没有待仲裁条目。</p>
            <RouterLink to="/admin">查看项目进展 →</RouterLink>
          </div>
        </section>
        <section
          v-else
          class="workbench-section workbench-guide"
          aria-labelledby="workbench-guide-title"
        >
          <span class="page-eyebrow">校勘小记</span>
          <h2 id="workbench-guide-title">每次只判断眼前这一份材料</h2>
          <p>
            先读来源，再核对字段。看不清、无法输入或需要管理员帮助时，可以保留未完成工作并报告问题。
          </p>
          <RouterLink to="/tasks/profile?guide=1">查看使用引导 →</RouterLink>
        </section>
      </div>
      <section class="workbench-section workbench-recent" aria-labelledby="recent-projects-title">
        <div class="section-heading">
          <h2 id="recent-projects-title">项目</h2>
          <div class="workbench-inline-actions">
            <RouterLink to="/projects?view=mine">查看全部 →</RouterLink
            ><RouterLink
              v-if="auth.canCreateProjects"
              to="/admin/projects/new"
              class="btn btn-secondary btn-sm"
              ><AppIcon name="plus" />创建项目</RouterLink
            >
          </div>
        </div>
        <div v-if="recentProjects.length" class="workbench-projects">
          <RouterLink
            v-for="project in recentProjects"
            :key="project.id"
            :to="project.managed ? `/admin/projects/${project.id}` : `/tasks?project=${project.id}`"
            class="workbench-project"
            ><AppIcon name="project" /><span
              ><strong>{{ project.name }}</strong
              ><small>{{ project.managed ? '项目管理' : '独立校对' }}</small></span
            ><AppIcon name="arrow"
          /></RouterLink>
        </div>
        <p v-else class="text-muted">加入或创建项目后，会在这里显示工作入口。</p>
      </section>
    </template>
  </main>
</template>
<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import AppIcon from '@/components/AppIcon.vue'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import { useAsyncResource } from '@/composables/useAsyncResource'
import { useAuthStore } from '@/stores/auth'
import { listProjectInsights } from '@/services/projectsService'
import { claimNextProjectPage, listProjectQueueSummaries } from '@/services/pagesService'
import { currentUserId } from '@/services/authService'
import { loadRecentWork, resumeWork } from '@/lib/workbenchNavigation'
import { browserLocalStorage } from '@/lib/onboarding'
import { saveTaskLease, saveGlyphQueue } from '@/lib/taskLease'
import { getPbMessage } from '@/utils/pbErrors'
const auth = useAuthStore()
const router = useRouter()
const opening = ref('')
const actionError = ref('')
const accessReady = ref(false)
const recent = loadRecentWork(browserLocalStorage(), auth.user?.id)
let active = true
onBeforeUnmount(() => {
  active = false
})
const {
  pending: accessPending,
  error: accessError,
  reload: reloadAccess
} = useAsyncResource(({ signal }) => auth.loadAccessContext({ force: true, signal }), {
  formatError: (cause) => getPbMessage(cause, '暂时无法读取项目权限。')
})
const {
  data: queueData,
  pending: queuePending,
  error: queueError,
  reload: reloadQueues
} = useAsyncResource(({ signal }) => listProjectQueueSummaries(1, 6, { signal }), {
  formatError: (cause) => getPbMessage(cause, '暂时无法读取校对任务。')
})
const {
  data: managedData,
  pending: managedPending,
  error: managedError,
  reload: reloadManaged
} = useAsyncResource(({ signal }) => listProjectInsights({ perPage: 6 }, { signal }), {
  formatError: (cause) => getPbMessage(cause, '暂时无法读取项目待办。')
})
const loading = computed(() => accessPending.value || queuePending.value || managedPending.value)
const canManage = computed(() => auth.isPlatformAdmin || auth.hasManagedProjects)
const greeting = computed(() => auth.user?.name || auth.user?.username || '你好')
const queues = computed(() => queueData.value?.items || [])
const attention = computed(() =>
  (managedData.value?.items || []).filter((item) => item.summary.arbitration > 0)
)
const resume = computed(() =>
  resumeWork(recent, queues.value, auth.accessContext, auth.isPlatformAdmin)
)
const available = computed(() => queues.value.find((queue) => queue.nextPage))
const recentProjects = computed(() => {
  const items = new Map(queues.value.map((queue) => [queue.project.id, queue.project]))
  for (const item of managedData.value?.items || [])
    items.set(item.project.id, { ...item.project, managed: true })
  const order = recent.map((item) => item.projectId)
  return [...items.values()]
    .sort(
      (a, b) =>
        (order.indexOf(a.id) < 0 ? 100 : order.indexOf(a.id)) -
        (order.indexOf(b.id) < 0 ? 100 : order.indexOf(b.id))
    )
    .slice(0, 6)
})
const resumeProjectName = computed(() =>
  resume.value
    ? resume.value.project.name ||
      recentProjects.value.find((project) => project.id === resume.value.project.id)?.name ||
      '回到上次的项目'
    : ''
)
onMounted(refresh)
async function refresh() {
  const access = await reloadAccess()
  if (!access.ok) return
  accessReady.value = true
  const reads = [reloadQueues()]
  // A concurrent shell refresh may own the store's publication generation.
  // This successful response still tells this page which readers it needs.
  if (auth.isPlatformAdmin || access.data?.managedProjectIds?.length) reads.push(reloadManaged())
  await Promise.allSettled(reads)
}
async function startProject(queue) {
  if (!queue?.nextPage || opening.value) return
  const userId = currentUserId(auth.user),
    requestToken = auth.token
  opening.value = queue.project.id
  actionError.value = ''
  try {
    const page = await claimNextProjectPage(queue.project.id, userId)
    if (!active || currentUserId(auth.user) !== userId || auth.token !== requestToken) return
    if (!page?.id) {
      actionError.value = '这条任务已被领取，请刷新任务后重试。'
      await reloadQueues()
      return
    }
    saveTaskLease(window.sessionStorage, {
      userId,
      pageId: page.id,
      token: page.leaseToken,
      expiresAt: page.leaseExpiresAt
    })
    saveGlyphQueue(window.sessionStorage, { userId, projectId: queue.project.id, glyph: false })
    await router.push(`/tasks/${page.id}/edit`)
  } catch (cause) {
    if (!active || currentUserId(auth.user) !== userId || auth.token !== requestToken) return
    actionError.value = getPbMessage(cause, '暂时无法领取任务，输入和现有草稿不会受影响。')
  } finally {
    if (active) opening.value = ''
  }
}
</script>
