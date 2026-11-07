<template>
  <section class="card project-settings-section" aria-labelledby="verification-policy-title">
    <div class="section-heading">
      <div>
        <h2 id="verification-policy-title">来源核验约定</h2>
        <p>指定核对方式与允许的记音等价形式。更改会保留旧版，使基于旧依据的判断显示需复核。</p>
      </div>
    </div>
    <AppStatusPanel v-if="loading && !loaded" state="pending" message="正在读取核验约定…" />
    <AppStatusPanel
      v-if="loadError"
      state="error"
      :message="loadError"
      retry-label="重新读取"
      :busy="loading"
      @retry="load"
    />
    <template v-if="loaded">
      <p class="text-sm text-muted mb-4">当前版本：{{ policy?.id || '旧版／尚未记录' }}</p>
      <form class="settings-form" @submit.prevent="savePolicy">
        <AppField label="核验说明">
          <textarea
            v-model="form.instructions"
            class="form-control"
            maxlength="10000"
            required
            :disabled="saving"
          ></textarea>
        </AppField>
        <label class="toggle-field mb-4"
          ><input
            v-model="form.tone_equivalence"
            type="checkbox"
            :disabled="saving"
          />允许指定记音字段的声调普通数字与右上标等价（数字、顺序及所属音节须相同）</label
        >
        <button
          type="button"
          class="btn btn-quiet btn-sm mb-4"
          :disabled="saving || loading"
          @click="refreshFields"
        >
          刷新可选字段
        </button>
        <fieldset class="settings-fieldset mb-4">
          <legend class="form-label">适用的明确记音字段</legend>
          <p v-if="!readingFields.length" class="text-sm text-muted">
            请先在列角色中把适用字段标为“记音”，保存后刷新可选字段。
          </p>
          <label v-for="field in availableReadingFields" :key="field" class="toggle-field mr-3"
            ><input
              v-model="form.reading_fields"
              type="checkbox"
              :value="field"
              :disabled="saving"
            />{{ field
            }}<span v-if="!readingFields.includes(field)">（当前未标为记音，请复核）</span></label
          >
        </fieldset>
        <AppField label="设置／变更依据"
          ><input
            v-model="form.reason"
            class="form-control"
            required
            maxlength="2000"
            :disabled="saving"
        /></AppField>
        <p v-if="operationError" class="alert alert-error" role="alert">{{ operationError }}</p>
        <p v-if="message" class="alert alert-success" role="status">{{ message }}</p>
        <button class="btn btn-primary" :disabled="saving">
          {{ saving ? '正在保存…' : '保存新版本约定' }}
        </button>
      </form>
      <details class="mt-4">
        <summary>约定历史（{{ policyHistory.length }}）</summary>
        <ul>
          <li v-for="item in policyHistory" :key="item.id">
            {{ item.id }} · {{ item.at }} · {{ item.reason }}
          </li>
        </ul>
      </details>
    </template>
    <WorkspaceLeaveGuard v-if="guardLeave" :dirty="dirty" :preserve-query="false" />
  </section>
</template>
<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import AppField from '@/components/AppField.vue'
import WorkspaceLeaveGuard from '@/components/admin/project/WorkspaceLeaveGuard.vue'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import { getColumnRoles } from '@/services/projectsService'
import { getVerificationPolicy, saveVerificationPolicy } from '@/services/verificationService'
import { getPbMessage } from '@/utils/pbErrors'
const props = defineProps({
  projectId: { type: String, required: true },
  guardLeave: { type: Boolean, default: true }
})
const emit = defineEmits(['dirty-change'])
const loading = ref(false)
const loaded = ref(false)
const saving = ref(false)
const loadError = ref('')
const operationError = ref('')
const message = ref('')
const policy = ref(null)
const policyHistory = ref([])
const readingFields = ref([])
const form = reactive({ instructions: '', tone_equivalence: false, reading_fields: [], reason: '' })
const availableReadingFields = computed(() => [
  ...new Set([...readingFields.value, ...form.reading_fields])
])
const baseline = ref('')
const dirty = computed(() => loaded.value && JSON.stringify(form) !== baseline.value)
watch(dirty, (value) => emit('dirty-change', value))
let generation = 0
let disposed = false
watch(
  () => props.projectId,
  () => {
    loaded.value = false
    load()
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  disposed = true
  generation++
})
async function load() {
  const token = ++generation
  const projectId = props.projectId
  loading.value = true
  loadError.value = ''
  try {
    const [data, roles] = await Promise.all([
      getVerificationPolicy(projectId),
      getColumnRoles(projectId)
    ])
    if (disposed || token !== generation) return
    policy.value = data.current
    policyHistory.value = data.history || []
    readingFields.value = (roles.columns || [])
      .filter((item) => item.role === 'reading' && item.present)
      .map((item) => item.name)
    form.instructions = data.current?.instructions || data.default_instructions
    form.tone_equivalence = data.current?.tone_equivalence || false
    form.reading_fields = [...(data.current?.reading_fields || [])]
    baseline.value = JSON.stringify(form)
    loaded.value = true
  } catch (error) {
    if (!disposed && token === generation)
      loadError.value = getPbMessage(error, '核验约定读取失败。')
  } finally {
    if (!disposed && token === generation) loading.value = false
  }
}
async function refreshFields() {
  const projectId = props.projectId
  operationError.value = ''
  try {
    const roles = await getColumnRoles(projectId)
    if (!disposed && projectId === props.projectId)
      readingFields.value = (roles.columns || [])
        .filter((item) => item.role === 'reading' && item.present)
        .map((item) => item.name)
  } catch (error) {
    if (!disposed && projectId === props.projectId)
      operationError.value = getPbMessage(error, '可选记音字段读取失败。')
  }
}
async function savePolicy() {
  if (saving.value) return
  const projectId = props.projectId
  saving.value = true
  operationError.value = ''
  message.value = ''
  try {
    await saveVerificationPolicy(projectId, { ...form, reading_fields: [...form.reading_fields] })
    if (disposed || projectId !== props.projectId) return
    message.value = '新约定版本已保存，旧依据仍保留。'
    form.reason = ''
    await load()
  } catch (error) {
    if (!disposed && projectId === props.projectId)
      operationError.value = getPbMessage(error, '核验约定保存失败。')
  } finally {
    if (!disposed && projectId === props.projectId) saving.value = false
  }
}
</script>
