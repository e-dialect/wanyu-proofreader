<template>
  <main class="container page page-form">
    <div class="flex items-center gap-3 mb-6">
      <RouterLink to="/admin" class="btn btn-secondary btn-sm">← 返回</RouterLink>
      <h1 class="compact-page-title">创建新项目</h1>
    </div>

    <div class="alert mb-4" role="note">
      <strong>创建后如何准备文件？</strong>
      <p class="text-sm mt-2">
        可仅上传 PDF（原文预览；启用本地文字层提取后可另行提取；不支持扫描页）、仅导入
        CSV（可校对但没有原文预览）， 或先上传 PDF 再预检 CSV（推荐，条目会固定关联预检时的 PDF）。
      </p>
      <RouterLink class="text-sm" to="/admin/guide/project-files">
        查看完整的 PDF、CSV 和校对页面说明
      </RouterLink>
    </div>

    <div class="card">
      <div v-if="checkingPermission" class="text-muted">正在检查创建权限…</div>
      <div
        v-else-if="!auth.canCreateProjects && !createdProject"
        class="alert alert-error"
        role="alert"
      >
        你当前没有可用的项目创建额度。请联系平台管理员授权或调整额度。
      </div>
      <form v-else @submit.prevent="handleSubmit">
        <fieldset :disabled="loading || Boolean(createdProject)" class="creation-fields">
          <div v-if="auth.accessContext?.projectLimit != null" class="alert mb-4" role="status">
            当前拥有 {{ auth.accessContext.ownedProjectCount }} 个项目，还可创建
            {{ auth.accessContext.remainingProjects }} 个。
          </div>
          <AppField
            ><template #label
              >项目名称 <span class="required-mark" aria-hidden="true">*</span></template
            >
            <input
              id="new-project-name"
              v-model="form.name"
              type="text"
              class="form-control"
              placeholder="如：《莆田方言词典》校对项目"
              required
            />
          </AppField>
          <fieldset class="access-mode-grid mb-4">
            <legend class="form-label">访问方式</legend>
            <label
              v-for="mode in accessModes"
              :key="mode.value"
              class="access-mode-option"
              :class="{ 'is-selected': form.accessMode === mode.value }"
            >
              <input v-model="form.accessMode" type="radio" :value="mode.value" />
              <span
                ><strong>{{ mode.label }}</strong
                ><small>{{ mode.description }}</small></span
              >
            </label>
          </fieldset>
          <div v-if="form.accessMode === 'password'" class="form-group">
            <label for="new-project-password" class="form-label">项目口令</label>
            <input
              id="new-project-password"
              v-model="form.password"
              type="password"
              class="form-control"
              minlength="8"
              maxlength="72"
              required
              autocomplete="new-password"
              placeholder="至少 8 个字符，UTF-8 编码最多 72 字节"
            />
          </div>
          <AppField
            ><template #label>项目简介</template>
            <textarea
              id="new-project-description"
              v-model="form.description"
              class="form-control"
              placeholder="简要介绍本项目的背景、目标等（可选）"
            ></textarea>
          </AppField>
        </fieldset>
        <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>
        <div v-if="success" class="alert alert-success" role="status">
          项目已创建，正在打开材料工作区。
        </div>

        <div class="flex gap-3">
          <button type="submit" class="btn btn-primary" :disabled="loading">
            {{
              loading
                ? createdProject
                  ? '正在打开…'
                  : '创建中…'
                : createdProject
                  ? '打开材料工作区'
                  : '创建项目'
            }}
          </button>
          <RouterLink to="/admin" class="btn btn-secondary">取消</RouterLink>
        </div>
      </form>
    </div>
  </main>
</template>

<script setup>
import AppField from '@/components/AppField.vue'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { createProject } from '@/services/projectsService'
import { getPbMessage } from '@/utils/pbErrors'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const loading = ref(false)
const checkingPermission = ref(true)
const error = ref('')
const success = ref(false)
const createdProject = ref(null)
const createdOwnerId = ref('')
let active = true
let submission = 0
const permissionController = new AbortController()
function currentSession() {
  const id = auth.user?.id
  const token = auth.token
  const path = route.fullPath
  return () => active && auth.user?.id === id && auth.token === token && route.fullPath === path
}
onBeforeUnmount(() => {
  active = false
  submission++
  permissionController.abort()
})

const form = ref({ name: '', description: '', accessMode: 'members_only', password: '' })
const accessModes = [
  {
    value: 'members_only',
    label: '指定成员',
    description: '默认选项，只有管理员指定的成员可以进入。'
  },
  { value: 'public', label: '公开加入', description: '任意已登录用户可以加入并成为校对员。' },
  { value: 'password', label: '口令加入', description: '输入正确项目口令后成为持久成员。' }
]

onMounted(async () => {
  const isCurrent = currentSession()
  try {
    await auth.loadAccessContext({ force: true, signal: permissionController.signal })
  } catch (e) {
    if (isCurrent()) error.value = getPbMessage(e, '无法检查项目创建权限。')
  } finally {
    if (isCurrent()) checkingPermission.value = false
  }
})

async function handleSubmit() {
  if (
    loading.value ||
    checkingPermission.value ||
    (!createdProject.value && !auth.canCreateProjects)
  )
    return
  if (createdProject.value && createdOwnerId.value !== auth.user?.id) return
  const generation = ++submission
  const sessionCurrent = currentSession()
  const isCurrent = () => generation === submission && sessionCurrent()
  loading.value = true
  error.value = ''
  try {
    if (!createdProject.value) {
      const project = await createProject({ ...form.value })
      if (!isCurrent()) return
      createdProject.value = project
      createdOwnerId.value = auth.user?.id
      success.value = true
      // Store-owned publication already checks the originating session. A
      // failed permission refresh must not turn a created project into a
      // failed creation or delay entry to its material workspace.
      void auth.loadAccessContext({ force: true }).catch(() => {})
    }
    if (!isCurrent()) return
    await router.replace({
      path: `/admin/projects/${createdProject.value.id}`,
      query: { section: 'materials', view: 'import' }
    })
  } catch (e) {
    if (!isCurrent()) return
    error.value = createdProject.value
      ? '项目已创建，但材料工作区尚未打开。请重试打开，无需重新创建。'
      : getPbMessage(e, '创建失败，请重试')
  } finally {
    if (isCurrent()) loading.value = false
  }
}
</script>

<style scoped>
.creation-fields {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
</style>
