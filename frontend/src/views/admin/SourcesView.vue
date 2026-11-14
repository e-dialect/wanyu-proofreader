<template>
  <main class="container page workspace-page">
    <header class="page-heading">
      <div>
        <RouterLink v-if="practiceReturn" :to="practiceReturn" class="back-link"
          >← 返回练习步骤</RouterLink
        >
        <RouterLink v-else to="/admin" class="back-link">← 返回项目管理</RouterLink>
        <div class="page-eyebrow">权利登记</div>
        <h1>来源登记</h1>
        <p>
          一份来源是一份可以单独谈权利的材料。这里只记录人填的结论，不托管授权文件，也不自动放行下游用途。
        </p>
      </div>
    </header>
    <section v-if="requestedSourceRef" class="card mb-6" aria-label="资料包来源登记提示">
      <h2>登记资料包所需的来源</h2>
      <p class="source-request-reference">
        资料包要求的登记标识：<strong>{{ requestedSourceRef }}</strong>
      </p>
      <p>
        {{
          auth.isPlatformAdmin
            ? '下方已预填登记标识，请按真实材料填写标题等信息。登记标识须与资料包完全一致。'
            : '你可以查看来源清单；新增来源需要联系平台管理员，并提供此登记标识。'
        }}
      </p>
      <p>
        登记后请切回原来的项目页面，点击“重新检查来源登记”。请保留原页面，已选资料包会留在那里。
      </p>
    </section>
    <SourcePermissionPanel
      v-if="focusedSourceId && focusedPurpose"
      :key="focusedSourceId + ':' + focusedPurpose"
      :source-id="focusedSourceId"
      :purpose="focusedPurpose"
      @updated="load"
    />
    <AppStatusPanel
      v-if="loadError"
      state="error"
      :message="loadError"
      retry-label="重新加载"
      :busy="loading"
      @retry="load"
    />
    <AppStatusPanel v-if="success" state="success" :message="success" />
    <section class="card mb-6">
      <div class="section-heading">
        <div>
          <h2>来源清单</h2>
          <p>
            未允许用途指还没登记、结论仍是未知，或已明确禁止的用途。任何未允许的用途都会被下游读成阻断，不会当成允许。
          </p>
        </div>
        <button class="btn btn-secondary" :disabled="loading" @click="load">刷新</button>
      </div>
      <AppStatusPanel v-if="loading" state="pending" message="正在加载来源…" />
      <div v-else-if="loadError" class="text-muted">
        来源清单暂时无法读取，请用上方「重新加载」重试。
      </div>
      <AppStatusPanel v-else-if="!items.length" state="empty" reason="none">
        <div class="empty-state-text">还没有登记来源</div>
        <p>CSV 导入可以暂不关联来源；资料包导入须先登记包内声明的来源，才能继续。</p>
      </AppStatusPanel>
      <AppDataTable v-else label="来源清单表">
        <template #head>
          <tr>
            <th>来源</th>
            <th>权利主体</th>
            <th>状态</th>
            <th>未允许用途</th>
          </tr>
        </template>

        <tr v-for="item in items" :key="item.id">
          <td>
            <strong>{{ item.title }}</strong>
            <div class="text-sm text-muted">
              <code>{{ item.logical_id }}</code> · {{ originLabel(item.original_vs_derived) }} ·
              {{ item.format || '未填格式' }}
            </div>
          </td>
          <td>{{ item.holder || '未填' }}</td>
          <td>
            <span class="badge" :class="sourceStatusClass(item.status)">{{
              statusLabel(item.status)
            }}</span>
          </td>
          <td>{{ undecidedLabel(item) }}</td>
        </tr>
      </AppDataTable>
    </section>

    <section v-if="auth.isPlatformAdmin" class="card">
      <div class="section-heading">
        <div>
          <h2>登记一条来源</h2>
          <p>
            登记标识可留空，系统会按标题和格式生成；从资料包进入时，请保留预填标识。证据只记仓外位置，不要把授权文件贴进来。
          </p>
        </div>
      </div>
      <form class="settings-form" @submit.prevent="submitSource">
        <div v-if="operationError" class="alert alert-error" role="alert">{{ operationError }}</div>
        <AppField
          ><template #label>标题</template
          ><input v-model.trim="form.title" class="form-control" required maxlength="200"
        /></AppField>
        <AppField
          ><template #label>权利主体</template
          ><input v-model.trim="form.holder" class="form-control" maxlength="200"
        /></AppField>
        <AppField
          ><template #label>方言或地区范围</template
          ><input v-model.trim="form.scope" class="form-control" maxlength="200"
        /></AppField>
        <AppField
          ><template #label>格式</template
          ><input
            v-model.trim="form.format"
            class="form-control"
            maxlength="80"
            placeholder="例如 csv"
        /></AppField>
        <AppField
          ><template #label>登记标识</template
          ><input
            v-model.trim="form.logical_id"
            class="form-control"
            maxlength="80"
            placeholder="留空则自动生成"
        /></AppField>
        <AppField
          ><template #label>原始或派生</template>
          <select v-model="form.original_vs_derived" class="form-control">
            <option v-for="(label, value) in SOURCE_ORIGIN_LABELS" :key="value" :value="value">
              {{ label }}
            </option>
          </select>
        </AppField>
        <AppField
          ><template #label>处理状态</template>
          <select v-model="form.status" class="form-control">
            <option v-for="(label, value) in SOURCE_STATUS_LABELS" :key="value" :value="value">
              {{ label }}
            </option>
          </select>
        </AppField>
        <button class="btn btn-primary" :disabled="saving">
          {{ saving ? '正在登记…' : '登记来源' }}
        </button>
      </form>
    </section>
  </main>
</template>

<script setup>
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import { useAsyncResource } from '@/composables/useAsyncResource'
import AppDataTable from '@/components/AppDataTable.vue'
import AppField from '@/components/AppField.vue'
import SourcePermissionPanel from '@/components/admin/SourcePermissionPanel.vue'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import {
  canUsePracticeProject,
  practiceGuideTarget,
  readPracticeContext
} from '@/lib/practiceContext'
import { getProject } from '@/services/projectsService'
import {
  SOURCE_ORIGIN_LABELS,
  SOURCE_STATUS_LABELS,
  USAGE_PURPOSE_LABELS,
  sourceStatusClass
} from '@/constants/sourceRegistry'
import { createSource, listSources } from '@/services/sourcesService'
import { useAuthStore } from '@/stores/auth'
import { getPbMessage } from '@/utils/pbErrors'

const auth = useAuthStore()
const route = useRoute()
const focusedSourceId = computed(() => {
  const id = route.query.sourceId
  return typeof id === 'string' && /^[a-z0-9]{15}$/.test(id) ? id : ''
})
const focusedPurpose = computed(() => {
  const purpose = route.query.purpose
  return typeof purpose === 'string' && Object.hasOwn(USAGE_PURPOSE_LABELS, purpose) ? purpose : ''
})
const practiceContext = computed(() => {
  const context = readPracticeContext(route.query)
  return auth.isPlatformAdmin && context?.role === 'platform' ? context : null
})
const {
  data: practiceProject,
  pending: practicePending,
  error: practiceError,
  reload: loadPracticeProject,
  cancel: cancelPracticeProject
} = useAsyncResource(async ({ signal }, id, userId) => {
  const project = await getProject(id, { signal })
  return { project, userId }
})
watch(
  [() => practiceContext.value?.projectId, () => auth.user?.id],
  ([id, userId]) => {
    if (id && userId) void loadPracticeProject(id, userId)
    else cancelPracticeProject()
  },
  { immediate: true }
)
const practiceReturn = computed(() => {
  const context = practiceContext.value
  const entry = practiceProject.value
  return context &&
    !practicePending.value &&
    !practiceError.value &&
    entry?.userId === auth.user?.id &&
    entry?.project.id === context.projectId &&
    canUsePracticeProject(entry.project, 'platform', auth.isPlatformAdmin)
    ? practiceGuideTarget(context)
    : null
})
const requestedSourceRef =
  typeof route.query.sourceRef === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(route.query.sourceRef)
    ? route.query.sourceRef
    : ''
const items = ref([])
const {
  pending: loading,
  error: loadError,
  reload
} = useAsyncResource(({ signal }) => listSources({ signal }), {
  initialData: { items: [] },
  isEmpty: (value) => !value.items?.length,
  formatError: (cause) => getPbMessage(cause, '来源清单加载失败')
})
const saving = ref(false)
const operationError = ref('')
const success = ref('')
const form = reactive({
  title: '',
  holder: '',
  scope: '',
  format: '',
  logical_id: requestedSourceRef,
  original_vs_derived: 'original',
  status: 'unregistered'
})

function statusLabel(status) {
  return SOURCE_STATUS_LABELS[status] || status
}

function originLabel(origin) {
  return SOURCE_ORIGIN_LABELS[origin] || origin
}

function undecidedLabel(item) {
  const names = (item.undecided_purposes || []).map(
    (purpose) => USAGE_PURPOSE_LABELS[purpose] || purpose
  )
  return names.length ? names.join('、') : '没有未允许用途'
}

async function load() {
  operationError.value = ''
  const result = await reload()
  if (!result.ok) return
  items.value = result.data.items || []
}

async function submitSource() {
  saving.value = true
  operationError.value = ''
  success.value = ''
  try {
    await createSource({ ...form, record_count: 0 })
    form.title = ''
    form.holder = ''
    form.scope = ''
    form.format = ''
    form.logical_id = ''
    form.status = 'unregistered'
    success.value = '来源已登记。用途结论仍是未知，下游会读到阻断，直到逐项写明允许或禁止。'
    await load()
  } catch (cause) {
    operationError.value = getPbMessage(cause, '登记来源失败')
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.source-request-reference {
  overflow-wrap: anywhere;
}
</style>
