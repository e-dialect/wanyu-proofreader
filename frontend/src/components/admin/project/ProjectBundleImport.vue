<template>
  <section class="bundle-import" aria-label="资料包导入">
    <h3>从资料包导入条目</h3>
    <p class="text-muted">检查 Review Bundle 的内容与来源声明，确认后生成待校对条目。</p>
    <p class="text-sm text-muted">
      仅接受不超过 20MB 的 ZIP。检查不会写入项目，也不代表内容或用途权利已获批准。
    </p>
    <input
      ref="bundleInput"
      type="file"
      class="file-input-hidden"
      aria-label="选择资料包"
      accept=".zip,application/zip"
      :disabled="busy || uncertain"
      @change="chooseFile"
    />
    <button class="btn btn-secondary" :disabled="busy || uncertain" @click="bundleInput.click()">
      选择 ZIP 资料包
    </button>
    <p v-if="file" class="text-sm bundle-filename">{{ file.name }}</p>
    <button
      v-if="file && !report && !job"
      class="btn btn-primary"
      :disabled="busy"
      @click="inspect"
    >
      {{ busy ? '正在检查…' : '检查资料包' }}
    </button>
    <div v-if="report && !job" class="bundle-report">
      <h4>{{ report.ok ? '检查通过，等待确认' : '资料包未通过检查' }}</h4>
      <p>资料包包含 {{ report.entry_count }} 条条目。</p>
      <ul v-if="report.errors?.length" class="bundle-errors">
        <li v-for="(item, index) in report.errors" :key="index">{{ item.message }}</li>
      </ul>
      <template v-if="report.ok && declaration">
        <h4>包内来源声明</h4>
        <dl class="bundle-declaration">
          <div>
            <dt>来源系统</dt>
            <dd>{{ declaration.source_system }}</dd>
          </div>
          <div>
            <dt>来源资料</dt>
            <dd>{{ declaration.source_id }}</dd>
          </div>
          <div>
            <dt>资料版本</dt>
            <dd>{{ declaration.source_version }}</dd>
          </div>
          <div>
            <dt>来源登记</dt>
            <dd>{{ declaration.rights_ref }}</dd>
          </div>
          <div>
            <dt>待校字段</dt>
            <dd>{{ declaration.requested_fields?.join('、') }}</dd>
          </div>
        </dl>
      </template>
      <p v-else-if="report.ok" class="text-sm text-muted">
        本地未能展开来源声明。完整检查结果以上方服务端报告为准。
      </p>
      <p class="text-sm text-muted">
        来源登记必须已存在；系统会按包内声明关联来源，不会替换为未知来源。用途许可仍由来源库分别管理。
      </p>
      <details class="bundle-technical">
        <summary>查看检查详情</summary>
        <p>
          包标识：{{ report.bundle_id || '未读取' }}；格式：{{ report.schema_version || '未读取' }}
        </p>
        <p v-for="(item, index) in report.errors" :key="index">
          <code>{{ item.code }}</code
          >：{{ item.message }}
        </p>
      </details>
      <AppField v-if="report.ok" class="bundle-acknowledgment" layout="plain">
        <input v-model="acknowledged" type="checkbox" :disabled="busy || uncertain" />
        我已核对来源声明，确认将这些条目导入当前项目。
      </AppField>
      <button
        v-if="report.ok"
        class="btn btn-primary"
        :disabled="busy || !acknowledged"
        @click="submit"
      >
        {{ busy ? '正在提交…' : uncertain ? '重试原资料包并查询结果' : '确认导入资料包' }}
      </button>
    </div>
    <div v-if="uncertain" class="alert alert-warning" role="alert">
      尚未收到导入结果，资料包可能已被接收。请重试同一个文件，系统将返回同包已有作业，避免重复导入。
    </div>
    <div v-if="job" class="bundle-result" aria-live="polite">
      <h4>{{ jobLabel }}</h4>
      <p v-if="alreadyImported" class="text-sm">
        此资料包已有导入作业，已恢复其进度，没有新建一份。
      </p>
      <p>{{ csvJobProgressText(job) }}</p>
      <p v-if="job.source_link === 'linked'" class="text-sm">已按包内声明关联来源。</p>
      <p v-if="job.error_message" class="alert alert-warning" role="alert">
        {{ job.error_message }}
      </p>
      <button class="btn btn-secondary" :disabled="busy" @click="refreshJob">
        {{ bundleTerminal(job) ? '刷新导入结果' : '刷新导入进度' }}
      </button>
      <button
        v-if="job.status === 'failed'"
        class="btn btn-primary"
        :disabled="busy"
        @click="submit"
      >
        重试原资料包
      </button>
      <details class="bundle-technical">
        <summary>查看作业详情</summary>
        <p>
          作业：{{ job.id }}；包标识：{{ job.bundle_id }}；格式：{{ job.bundle_schema_version }}
        </p>
      </details>
    </div>
    <p v-if="error" class="alert alert-error preserve-line-breaks" role="alert">{{ error }}</p>
    <ImportErrorsPanel
      v-if="job?.id && (job.failed_count > 0 || job.status === 'failed')"
      :project-id="props.projectId"
      :job-id="job.id"
      :revision="`${job.status}:${job.updated || ''}`"
    />
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppField from '@/components/AppField.vue'
import ImportErrorsPanel from '@/components/admin/project/ImportErrorsPanel.vue'
import {
  createBundleImport,
  getImportJob,
  validateReviewBundle
} from '@/services/importJobsService'
import { bundleTerminal, MAX_BUNDLE_BYTES, readBundleDeclaration } from '@/lib/reviewBundle'
import { csvJobProgressText } from '@/lib/csvInspection'
import { getPbMessage } from '@/utils/pbErrors'

const props = defineProps({ projectId: { type: String, required: true } })
const emit = defineEmits(['changed'])
const bundleInput = ref(null)
const file = ref(null),
  report = ref(null),
  declaration = ref(null),
  job = ref(null)
const busy = ref(false),
  error = ref(''),
  acknowledged = ref(false),
  uncertain = ref(false)
const alreadyImported = ref(false)
let generation = 0,
  disposed = false,
  timer
const current = (value) => !disposed && generation === value
const hasPendingWork = computed(
  () => busy.value || uncertain.value || (!!file.value && !bundleTerminal(job.value))
)
const jobLabel = computed(
  () =>
    ({
      queued: '等待导入',
      processing: '正在导入',
      completed: '导入完成',
      completed_with_errors: '导入完成，部分条目未导入',
      failed: '导入失败'
    })[job.value?.status] || '正在读取导入状态'
)

function reset() {
  generation++
  clearTimeout(timer)
  file.value = report.value = declaration.value = job.value = null
  busy.value = acknowledged.value = uncertain.value = alreadyImported.value = false
  error.value = ''
}
function chooseFile(event) {
  reset()
  const selected = event.target.files?.[0]
  if (!selected) return
  event.target.value = ''
  if (selected.size > MAX_BUNDLE_BYTES) {
    error.value = '资料包超过 20MB，请缩小后重新选择。'
    return
  }
  file.value = selected
}
async function inspect() {
  if (!file.value || busy.value) return
  const version = ++generation
  busy.value = true
  error.value = ''
  const results = await Promise.allSettled([
    validateReviewBundle({ file: file.value }),
    readBundleDeclaration(file.value)
  ])
  if (!current(version)) return
  if (results[0].status === 'fulfilled') report.value = results[0].value
  else error.value = getPbMessage(results[0].reason, '资料包检查失败，文件已保留，可以重试。')
  declaration.value = results[1].status === 'fulfilled' ? results[1].value : null
  busy.value = false
}
async function publishJob(value, version) {
  if (!current(version)) return
  job.value = value
  if (bundleTerminal(value)) {
    emit('changed')
  } else timer = setTimeout(refreshJob, 1000)
}
async function submit() {
  if (!file.value || !report.value?.ok || !acknowledged.value || busy.value) return
  clearTimeout(timer)
  const version = ++generation
  busy.value = true
  error.value = ''
  try {
    const result = await createBundleImport({ projectId: props.projectId, file: file.value })
    if (!current(version)) return
    const accepted = result.status === 'already_imported' ? result.job : result
    if (!accepted?.id) throw new Error('未收到作业标识，请重试原资料包。')
    uncertain.value = false
    alreadyImported.value = result.status === 'already_imported'
    await publishJob(accepted, version)
  } catch (cause) {
    if (!current(version)) return
    if (cause.status === 422 && typeof cause.response?.ok === 'boolean')
      report.value = cause.response
    uncertain.value = !cause.status || cause.status === 408 || cause.status >= 500
    error.value = getPbMessage(cause, '提交失败，原文件已保留。')
  } finally {
    if (current(version)) busy.value = false
  }
}
async function refreshJob() {
  if (!job.value || busy.value) return
  clearTimeout(timer)
  const version = ++generation
  busy.value = true
  error.value = ''
  try {
    const value = await getImportJob(job.value.id)
    await publishJob(value, version)
  } catch (cause) {
    if (current(version))
      error.value = getPbMessage(cause, '进度读取失败，已有作业已保留，请刷新重试。')
  } finally {
    if (current(version)) busy.value = false
  }
}
watch(() => props.projectId, reset)
onBeforeUnmount(() => {
  disposed = true
  generation++
  clearTimeout(timer)
})
defineExpose({ hasPendingWork })
</script>

<style scoped>
.bundle-import h3,
.bundle-import h4 {
  margin-bottom: var(--space-2);
}
.bundle-import > p {
  margin-bottom: var(--space-3);
}
.bundle-import input[type='file'] {
  max-width: 100%;
}
.bundle-report,
.bundle-result,
.bundle-row-errors {
  margin-top: var(--space-5);
  padding-top: var(--space-4);
  border-top: 1px solid var(--gray-200);
}
.bundle-declaration {
  display: grid;
  gap: var(--space-2);
  margin-block: var(--space-3);
}
.bundle-declaration > div {
  display: grid;
  grid-template-columns: 6em minmax(0, 1fr);
  gap: var(--space-3);
}
.bundle-declaration dt {
  color: var(--gray-600);
}
.bundle-declaration dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.bundle-technical {
  margin-block: var(--space-3);
  color: var(--gray-600);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.bundle-technical summary {
  cursor: pointer;
}
.bundle-errors {
  padding-left: var(--space-5);
}
.bundle-filename {
  overflow-wrap: anywhere;
}
.bundle-acknowledgment {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 44px;
  margin-block: var(--space-3);
}
</style>
