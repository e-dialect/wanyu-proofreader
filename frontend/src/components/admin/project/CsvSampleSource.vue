<template>
  <section class="csv-sample-source" aria-labelledby="csv-source-sample-heading">
    <div class="csv-sample-heading">
      <h5 id="csv-source-sample-heading" ref="heading" tabindex="-1">
        原 CSV 第 {{ location.csvLine }} 行 · PDF 物理第 {{ location.pdfPage }} 页
      </h5>
      <AppButton size="sm" @click="emit('close')">关闭对照</AppButton>
    </div>
    <p v-if="accessLost" class="alert alert-error" role="alert">
      当前账号无法读取本次检查绑定的 PDF。
    </p>
    <div v-else class="csv-sample-columns">
      <div class="csv-sample-values">
        <AppField v-if="sampleOptions.length > 1">
          <template #label>对照样本</template>
          <select
            class="form-control"
            :value="sampleIndex"
            @change="emit('select', Number($event.target.value))"
          >
            <option v-for="option in sampleOptions" :key="option.index" :value="option.index">
              CSV 第 {{ option.location.csvLine }} 行 · PDF 第 {{ option.location.pdfPage }} 页
            </option>
          </select>
        </AppField>
        <dl aria-label="所选 CSV 样本">
          <div v-for="header in headers" :key="header">
            <dt>{{ header }}</dt>
            <dd>
              <AppFieldValue :value="row[header]" :lang="fieldValueLanguage(header)" />
            </dd>
          </div>
        </dl>
      </div>
      <div class="csv-sample-preview">
        <p v-if="loading" role="status">正在读取绑定的 PDF…</p>
        <div v-else-if="error" class="alert alert-error" role="alert">
          <p>{{ error }}</p>
          <AppButton size="sm" @click="load">重试读取</AppButton>
        </div>
        <template v-else-if="url">
          <p
            v-if="pageCount && location.pdfPage > pageCount"
            class="alert alert-warning"
            role="alert"
          >
            样本指向物理第 {{ location.pdfPage }} 页，但这份 PDF 只有 {{ pageCount }} 页。
          </p>
          <div v-show="!pageCount || location.pdfPage <= pageCount" class="csv-sample-viewer">
            <PdfSinglePageViewer
              :src="url"
              :page-number="location.pdfPage"
              :watermark-user-id="userId"
              :watermark-project-id="file.project"
              retry-enabled
              @retry="load"
              @document-loaded="pageCount = $event"
            />
          </div>
        </template>
      </div>
    </div>
  </section>
</template>

<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import AppButton from '@/components/AppButton.vue'
import AppField from '@/components/AppField.vue'
import AppFieldValue from '@/components/AppFieldValue.vue'
import PdfSinglePageViewer from '@/components/editor/PdfSinglePageViewer.vue'
import { useProtectedPageScope } from '@/composables/useProtectedPageScope'
import { fieldValueLanguage } from '@/lib/fieldValue'
import { currentUserId } from '@/services/authService'
import { fetchProjectPdfPreview } from '@/services/projectFilesService'

const props = defineProps({
  row: { type: Object, required: true },
  headers: { type: Array, required: true },
  location: { type: Object, required: true },
  file: { type: Object, required: true },
  sampleOptions: { type: Array, required: true },
  sampleIndex: { type: Number, required: true }
})
const emit = defineEmits(['close', 'select'])
const heading = ref(null)
const userId = currentUserId()
const url = ref('')
const loading = ref(false)
const error = ref('')
const pageCount = ref(0)

function clear() {
  if (url.value) URL.revokeObjectURL(url.value)
  url.value = ''
  pageCount.value = 0
  loading.value = false
}
const { capture, cancel, invalidate, accessLost } = useProtectedPageScope(clear)

async function load() {
  if (accessLost.value) return
  cancel()
  clear()
  const request = capture()
  loading.value = true
  error.value = ''
  try {
    const blob = await fetchProjectPdfPreview(props.file, { signal: request.signal })
    if (request.isCurrent()) url.value = URL.createObjectURL(blob)
  } catch (cause) {
    if (request.isCurrent() && !invalidate(cause, request))
      error.value = '暂时无法读取绑定的 PDF，请重试。'
  } finally {
    if (request.isCurrent()) loading.value = false
    request.finish()
  }
}
watch(() => props.file.id, load, { immediate: true })
defineExpose({ focus: () => heading.value?.focus() })
onBeforeUnmount(clear)
</script>

<style scoped>
.csv-sample-source {
  margin-top: var(--space-3);
  border-top: 1px solid var(--line);
  padding-top: var(--space-3);
}
.csv-sample-heading {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-3);
}
.csv-sample-columns {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
  gap: var(--space-4);
}
.csv-sample-columns dl {
  max-height: 36rem;
  overflow: auto;
}
.csv-sample-columns dt {
  font-size: var(--text-sm);
  color: var(--ink-muted);
}
.csv-sample-columns dd {
  margin: 0 0 var(--space-3);
}
.csv-sample-viewer {
  height: min(65vh, 36rem);
  min-height: 20rem;
}
@media (max-width: 768px) {
  .csv-sample-columns {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
