<template>
  <section class="card project-section" aria-labelledby="project-process-title">
    <div class="section-heading">
      <div>
        <h2 id="project-process-title">来源与过程记录</h2>
        <p>按需要选择内容文件或完整过程，不将未完成记录当作成品。</p>
      </div>
    </div>
    <p class="text-sm text-muted mb-4">
      内容保留实际写法和合法空白；全量文件含状态，未完成时明确标记导入值回退。过程文件包含所有条目、原始提交及判断历史。
    </p>
    <div class="project-next-actions">
      <article class="project-next-action">
        <h3>内容 CSV</h3>
        <p>业务完成、来源复核与校对完成分别保留自己的判断条件。</p>
        <div class="project-subnav">
          <button class="btn btn-secondary" :disabled="busy" @click="download('all')">
            项目全量（含状态）
          </button>
          <button class="btn btn-primary" :disabled="busy" @click="download('completed')">
            业务已完成
          </button>
          <button class="btn btn-secondary" :disabled="busy" @click="download('source_reviewed')">
            全部字段已来源复核
          </button>
        </div>
      </article>
      <article class="project-next-action">
        <h3>过程 JSON</h3>
        <p>保留关联过程与研究记录，包含未完成、无提示和未记录状态。</p>
        <button class="btn btn-secondary" :disabled="busy" @click="download('all', true)">
          下载关联过程
        </button>
      </article>
    </div>
    <p v-if="busy" class="mt-4" role="status">正在准备导出文件…</p>
    <p v-if="operationError" class="alert alert-error mt-4" role="alert">{{ operationError }}</p>
    <p v-if="message" class="alert alert-success mt-4" role="status">{{ message }}</p>
  </section>
</template>
<script setup>
import { ref } from 'vue'
import { exportVerification } from '@/services/verificationService'
import { getPbMessage } from '@/utils/pbErrors'
import { downloadText } from '@/lib/downloadText'
const props = defineProps({ projectId: { type: String, required: true } })
const projectId = props.projectId
const busy = ref(false)
const operationError = ref('')
const message = ref('')
async function download(mode, process = false) {
  busy.value = true
  operationError.value = ''
  message.value = ''
  try {
    const result = await exportVerification(projectId, mode)
    if (process) {
      const { csv, ...bundle } = result
      void csv
      downloadText(
        JSON.stringify(bundle, null, 2),
        `${projectId}_过程记录.json`,
        'application/json'
      )
    } else downloadText(result.csv, `${projectId}_${mode}.csv`, 'text/csv;charset=utf-8')
    message.value = process
      ? '关联过程已导出，包含未完成、无提示及未记录状态。'
      : `已导出 ${result.selected_count} 条内容。`
  } catch (e) {
    operationError.value = getPbMessage(e, '导出失败')
  } finally {
    busy.value = false
  }
}
</script>
