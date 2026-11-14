<template>
  <section class="card mb-6" aria-labelledby="delivery-source-permission">
    <h2 id="delivery-source-permission">核对交付所需的来源许可</h2>
    <AppStatusPanel v-if="loading" state="pending" message="正在加载这份来源…" />
    <AppStatusPanel v-else-if="accessLost" state="error" message="当前账号无法读取这份来源。" />
    <AppStatusPanel
      v-else-if="loadError"
      state="error"
      :message="loadError"
      retry-label="重新加载"
      @retry="load"
    />
    <template v-else-if="source">
      <h3>{{ source.title }}</h3>
      <p class="text-sm text-muted">
        {{ source.logical_id }} · {{ source.holder || '未填权利主体' }}
      </p>
      <p>来源状态 {{ SOURCE_STATUS_LABELS[source.status] }}</p>
      <p>
        {{ USAGE_PURPOSE_LABELS[purpose] }} ·
        {{ usage ? USAGE_DECISION_LABELS[usage.decision] : '未登记' }}
      </p>
      <p v-if="usage?.evidence_ref" class="text-sm source-permission-evidence">
        证据位置 {{ usage.evidence_ref }}
      </p>
      <template v-if="auth.isPlatformAdmin">
        <form class="settings-form mt-3" @submit.prevent="save('usage')">
          <AppField>
            <template #label>用途结论</template>
            <select v-model="decision" class="form-control" :disabled="saving">
              <option v-for="(label, value) in USAGE_DECISION_LABELS" :key="value" :value="value">
                {{ label }}
              </option>
            </select>
          </AppField>
          <AppField>
            <template #label>授权证据位置</template>
            <input
              v-model.trim="evidence"
              class="form-control"
              maxlength="500"
              :disabled="saving"
            />
          </AppField>
          <AppButton type="submit" variant="primary" :disabled="saving || !usageChanged">
            保存用途结论
          </AppButton>
        </form>
        <form
          v-if="source.status !== 'confirmed'"
          class="settings-form mt-3"
          @submit.prevent="save('status')"
        >
          <AppField>
            <template #label>来源状态</template>
            <select v-model="status" class="form-control" :disabled="saving">
              <option v-for="(label, value) in SOURCE_STATUS_LABELS" :key="value" :value="value">
                {{ label }}
              </option>
            </select>
          </AppField>
          <AppButton type="submit" :disabled="saving || status === source.status"
            >保存来源状态</AppButton
          >
        </form>
      </template>
      <p v-else class="text-sm text-muted">
        修改许可需要联系平台管理员，请提供此来源的登记标识和用途。
      </p>
      <p class="text-sm text-muted">核对后切回交付页，重新检查本批范围。</p>
      <AppStatusPanel v-if="saveError" state="error" :message="saveError" />
      <AppStatusPanel v-if="message" state="success" :message="message" />
    </template>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import AppButton from '@/components/AppButton.vue'
import AppField from '@/components/AppField.vue'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import { useProtectedPageScope } from '@/composables/useProtectedPageScope'
import {
  SOURCE_STATUS_LABELS,
  USAGE_DECISION_LABELS,
  USAGE_PURPOSE_LABELS
} from '@/constants/sourceRegistry'
import { getSource, saveSourceUsage, updateSource } from '@/services/sourcesService'
import { useAuthStore } from '@/stores/auth'
import { getPbMessage } from '@/utils/pbErrors'

const props = defineProps({
  sourceId: { type: String, required: true },
  purpose: { type: String, required: true }
})
const emit = defineEmits(['updated'])
const auth = useAuthStore()
const source = ref(null)
const decision = ref('unknown')
const evidence = ref('')
const status = ref('')
const loading = ref(true)
const saving = ref(false)
const loadError = ref('')
const saveError = ref('')
const message = ref('')
const usage = computed(() => source.value?.usages.find((item) => item.purpose === props.purpose))
const usageChanged = computed(
  () =>
    decision.value !== (usage.value?.decision || 'unknown') ||
    evidence.value !== (usage.value?.evidence_ref || '')
)
const { accessLost, capture, cancel, invalidate } = useProtectedPageScope(() => {
  source.value = null
  decision.value = 'unknown'
  evidence.value = status.value = ''
  loading.value = saving.value = false
})

async function load() {
  cancel()
  const request = capture()
  loading.value = true
  loadError.value = ''
  try {
    const record = await getSource(props.sourceId, { signal: request.signal })
    if (!request.isCurrent()) return
    if (record.id !== props.sourceId) throw new Error('该来源已不可用。')
    source.value = record
    decision.value = usage.value?.decision || 'unknown'
    evidence.value = usage.value?.evidence_ref || ''
    status.value = record.status
  } catch (error) {
    if (request.isCurrent() && !invalidate(error, request))
      loadError.value = getPbMessage(error, '无法读取交付所需的来源。')
  } finally {
    if (request.isCurrent()) loading.value = false
    request.finish()
  }
}

async function save(kind) {
  if (!auth.isPlatformAdmin || !source.value || saving.value || accessLost.value) return
  const request = capture()
  saving.value = true
  saveError.value = message.value = ''
  try {
    const options = { signal: request.signal }
    if (kind === 'usage') {
      const saved = await saveSourceUsage(
        props.sourceId,
        props.purpose,
        { decision: decision.value, evidence_ref: evidence.value },
        options
      )
      if (!request.isCurrent()) return
      source.value.usages = [
        ...source.value.usages.filter((item) => item.purpose !== props.purpose),
        saved
      ]
    } else {
      const saved = await updateSource(props.sourceId, { status: status.value }, options)
      if (!request.isCurrent()) return
      source.value.status = saved.status
    }
    message.value = kind === 'usage' ? '用途结论已保存。' : '来源状态已保存。'
    emit('updated')
  } catch (error) {
    if (request.isCurrent() && !invalidate(error, request))
      saveError.value = getPbMessage(error, '保存来源登记失败，请重试。')
  } finally {
    if (request.isCurrent()) saving.value = false
    request.finish()
  }
}

onMounted(load)
</script>

<style scoped>
.source-permission-evidence {
  overflow-wrap: anywhere;
}
</style>
