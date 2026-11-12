<template>
  <main class="container page workspace-page project-hub work-catalog">
    <header class="page-heading">
      <div>
        <h1>项目</h1>
        <p>
          {{
            view === 'mine'
              ? '在不同项目承担不同职责，从这里回到具体工作。'
              : '公开项目可直接加入；口令项目验证后会保留你的成员身份。'
          }}
        </p>
      </div>
      <div class="page-heading-actions">
        <AppButton variant="ghost" :loading="loading" @click="loadProjects">
          <AppIcon name="refresh" />刷新</AppButton
        ><RouterLink v-if="auth.canCreateProjects" to="/admin/projects/new" class="btn btn-primary"
          ><AppIcon name="plus" />创建项目</RouterLink
        >
      </div>
    </header>
    <ProjectHubTabs :active="view" />
    <AppStatusPanel
      v-if="loadError"
      state="error"
      :message="loadError"
      retry-label="重新加载"
      @retry="loadProjects"
    />
    <div v-if="joinedProject && view === 'discover'" class="project-joined-banner">
      <div ref="joinStatus" role="status" tabindex="-1">
        <strong>已加入 {{ joinedProject.name }}</strong>
      </div>
      <div class="project-joined-actions">
        <RouterLink to="/projects?view=mine" class="btn btn-secondary">查看我的项目</RouterLink>
        <RouterLink
          v-if="joinedProject.capabilities.canProofread"
          :to="{ path: '/tasks', query: { project: joinedProject.id, view: 'available' } }"
          class="btn btn-primary"
          >开始校对<AppIcon name="arrow"
        /></RouterLink>
      </div>
    </div>
    <AppStatusPanel v-if="loading && !hasValue" state="pending" message="正在加载项目…" />
    <div v-else-if="hasValue && projects.length === 0" class="empty-state card">
      <AppIcon name="project" />
      <div class="empty-state-text">
        {{ view === 'mine' ? '还没有参与的项目' : '目前没有可加入的项目' }}
      </div>
      <p>
        {{
          view === 'mine'
            ? '浏览可加入项目，或请项目管理员把你添加为成员。'
            : '指定成员项目不出现在目录中，请联系项目管理员添加。'
        }}
      </p>
      <RouterLink v-if="view === 'mine'" to="/projects?view=discover" class="btn btn-primary"
        >浏览项目</RouterLink
      >
    </div>
    <section v-else class="project-card-grid" aria-label="项目列表">
      <form
        v-for="project in projects"
        :key="project.id"
        class="project-work-card"
        :aria-label="project.name"
        :aria-busy="joining === project.id"
        @submit.prevent="join(project, $event.currentTarget)"
      >
        <header class="project-work-card__header">
          <div>
            <span class="work-state">{{
              project.capabilities.isMember
                ? roleLabel(project.capabilities.projectRole)
                : accessLabel(project)
            }}</span>
            <h2>{{ project.name }}</h2>
            <ProjectPurposeBadge :purpose="project.purpose" />
          </div>
        </header>
        <p v-if="project.description" class="project-description">{{ project.description }}</p>
        <label
          v-if="
            !project.capabilities.isMember &&
            !project.capabilities.isPlatformAdmin &&
            project.access_mode === 'password'
          "
          class="form-group"
          ><span class="form-label">项目口令</span
          ><input
            v-model="passwords[project.id]"
            type="password"
            class="form-control"
            maxlength="72"
            autocomplete="off"
            placeholder="输入管理员提供的口令"
            :readonly="Boolean(joining)"
        /></label>
        <p v-if="joinErrorProjectId === project.id" class="alert alert-error" role="alert">
          {{ joinError }}
        </p>
        <footer class="project-work-card__footer">
          <span>{{
            project.capabilities.isMember
              ? '已加入此项目'
              : project.access_mode === 'members_only'
                ? '由管理员指定成员'
                : '加入后成为项目校对员'
          }}</span
          ><RouterLink
            v-if="project.capabilities.canManage"
            :to="`/admin/projects/${project.id}`"
            class="btn btn-secondary"
            >管理项目</RouterLink
          ><RouterLink
            v-else-if="project.capabilities.canProofread"
            :to="`/tasks?project=${project.id}`"
            class="btn btn-primary"
            >进入校对</RouterLink
          ><AppButton
            v-else
            type="submit"
            variant="primary"
            :loading="joining === project.id"
            :disabled="Boolean(joining)"
          >
            {{ joining === project.id ? '正在加入…' : '加入项目' }}
          </AppButton>
        </footer>
      </form>
    </section>
  </main>
</template>
<script setup>
import ProjectPurposeBadge from '@/components/ProjectPurposeBadge.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import ProjectHubTabs from '@/components/ProjectHubTabs.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppButton from '@/components/AppButton.vue'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import '@/styles/work-catalog.css'
import { useAsyncResource } from '@/composables/useAsyncResource'
import { joinProject, listProjects } from '@/services/projectsService'
import { useAuthStore } from '@/stores/auth'
import { getPbMessage } from '@/utils/pbErrors'
const auth = useAuthStore(),
  route = useRoute()
const view = computed(() => (route.query.view === 'mine' ? 'mine' : 'discover'))
const passwords = ref({}),
  joining = ref(''),
  joinError = ref(''),
  joinErrorProjectId = ref(''),
  lastJoinedProjectId = ref(''),
  joinStatus = ref(null)
const confirmedJoins = shallowRef(new Map())
const {
  data,
  hasValue,
  pending: loading,
  error: loadError,
  reload
} = useAsyncResource(({ signal }) => listProjects({ scope: 'discoverable', signal }), {
  formatError: (cause) => getPbMessage(cause, '项目目录加载失败。')
})
const directory = computed(() => {
  const latest = new Map((data.value || []).map((project) => [project.id, project]))
  for (const [id, project] of confirmedJoins.value) latest.set(id, project)
  return latest
})
const joinedProject = computed(() => {
  const project = directory.value.get(lastJoinedProjectId.value)
  return project?.capabilities.isMember ? project : null
})
const projects = computed(() =>
  [...directory.value.values()].filter((project) =>
    view.value === 'mine'
      ? project.capabilities.isMember
      : !project.capabilities.isMember && ['public', 'password'].includes(project.access_mode)
  )
)
async function loadProjects() {
  // Keep successful join responses until a fresh directory snapshot replaces them.
  const knownJoins = confirmedJoins.value
  const result = await reload()
  if (result.ok && knownJoins.size && confirmedJoins.value === knownJoins) {
    confirmedJoins.value = new Map()
  }
}
let active = true
onBeforeUnmount(() => {
  active = false
})
onMounted(loadProjects)
async function join(project, form) {
  if (joining.value) return
  const userId = auth.user?.id
  const hadFocus = form.contains(document.activeElement)
  joining.value = project.id
  joinError.value = ''
  joinErrorProjectId.value = ''
  try {
    const joined = await joinProject(project.id, passwords.value[project.id] || '')
    if (!active || auth.user?.id !== userId) return
    const restoreFocus =
      hadFocus &&
      (form.contains(document.activeElement) || document.activeElement === document.body)
    passwords.value[project.id] = ''
    confirmedJoins.value = new Map(confirmedJoins.value).set(joined.id, joined)
    lastJoinedProjectId.value = joined.id
    void Promise.allSettled([loadProjects(), auth.loadAccessContext({ force: true })])
    if (restoreFocus) {
      await nextTick()
      joinStatus.value?.focus()
    }
  } catch (cause) {
    if (active && auth.user?.id === userId) {
      joinError.value = getPbMessage(cause, '加入项目失败。')
      joinErrorProjectId.value = project.id
    }
  } finally {
    joining.value = ''
  }
}
function accessLabel(project) {
  return (
    { public: '公开加入', password: '口令加入', members_only: '指定成员' }[project.access_mode] ||
    '指定成员'
  )
}
function roleLabel(role) {
  return { owner: '项目所有者', manager: '项目管理员', proofreader: '校对员' }[role] || '平台管理'
}
</script>

<style scoped>
.project-joined-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
