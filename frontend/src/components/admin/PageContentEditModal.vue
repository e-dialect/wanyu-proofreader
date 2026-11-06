<template>
  <ConfirmDialog :open="open" title-id="page-content-edit-title" @close="requestClose">
    <h3 id="page-content-edit-title">修正识别结果</h3>
    <p class="text-sm text-muted">
      第 {{ page?.page_number }} 条 · 修正「导入文本」内容，不涉及校对结果
    </p>

    <div v-if="marks.length" class="alert alert-warning" role="status">
      <div class="font-semibold mb-1">发现 {{ marks.length }} 处可疑格</div>
      <ul class="text-sm">
        <li v-for="(m, i) in marks" :key="i">
          <template v-if="m.field">列「{{ m.field }}」：</template
          >{{ renderFindingMessage(m.message) }}
        </li>
      </ul>
    </div>

    <details v-if="recognitionCells.length" class="mb-3">
      <summary>识别时的状态与原始文本（修正后仍保留）</summary>
      <p class="text-sm text-muted">
        「确定」仅描述识别输出，仍需对照来源。这里的原始记录不随下方修正改写。
      </p>
      <div v-for="(cell, index) in recognitionCells" :key="index" class="mb-2">
        <strong>{{ cell.field }} · {{ OCR_CELL_LABELS[cell.status] }}</strong>
        <AppFieldValue
          as="p"
          :value="cell.text"
          :lang="fieldValueLanguage(cell.field)"
          :font-notice="false"
        />
      </div>
    </details>
    <RareCharacterNotice
      :texts="[...Object.values(editedRow), ...recognitionCells.map((cell) => cell.text)]"
    />
    <div class="edit-fields">
      <AppField v-for="header in rowHeaders" :key="header" :label="header">
        <textarea
          v-model="editedRow[header]"
          :lang="fieldValueLanguage(header) || undefined"
          class="form-control"
          rows="2"
          :disabled="submitting"
        ></textarea>
      </AppField>
    </div>

    <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>

    <template #actions>
      <button type="button" class="btn btn-secondary" :disabled="submitting" @click="requestClose">
        取消
      </button>
      <button
        ref="saveButton"
        type="button"
        class="btn btn-primary"
        :disabled="submitting"
        @click="save"
      >
        {{ submitting ? '保存中...' : '保存' }}
      </button>
    </template>
  </ConfirmDialog>
</template>

<script setup>
import RareCharacterNotice from '@/components/editor/RareCharacterNotice.vue'
import AppField from '@/components/AppField.vue'
import AppFieldValue from '@/components/AppFieldValue.vue'
import { fieldValueLanguage } from '@/lib/fieldValue'
import { ocrCells, OCR_CELL_LABELS } from '@/lib/ocrJob'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useStructuredRow } from '@/composables/useStructuredRow'
import { inspectRow } from '@/lib/rowInspection'
import { renderFindingMessage } from '@/lib/findingMessages'
import { updatePageContent } from '@/services/pagesService'

const props = defineProps({
  open: { type: Boolean, default: false },
  page: { type: Object, default: null },
  projectId: { type: String, required: true }
})

const emit = defineEmits(['close', 'saved', 'busy'])

const { rowHeaders, editedRow, hydrateForProofread, stringifyEditedRow } = useStructuredRow()
const submitting = ref(false)
const error = ref('')
const recognitionCells = computed(() => ocrCells(props.page?.ocr_cells_json))

let caseVersion = 0
const saveButton = ref(null)
const isCurrent = (version, projectId, pageId) =>
  version === caseVersion &&
  props.open &&
  props.projectId === projectId &&
  props.page?.id === pageId
watch(
  [() => props.open, () => props.projectId, () => props.page?.id],
  ([isOpen]) => {
    caseVersion++
    submitting.value = false
    emit('busy', false)
    if (isOpen && props.page) {
      error.value = ''
      hydrateForProofread(props.page)
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  caseVersion++
  emit('busy', false)
})
function requestClose() {
  if (submitting.value) return
  emit('close')
}

// 对当前编辑内容现算可疑格（而非读未修改的 props.page），编辑过程中实时更新。
const marks = computed(() => inspectRow(rowHeaders.value, editedRow.value))

async function save() {
  if (!props.open || !props.page || submitting.value) return
  const version = caseVersion
  const projectId = props.projectId
  const pageId = props.page.id
  const payload = {
    rowJson: stringifyEditedRow(),
    headersJson: JSON.stringify(rowHeaders.value),
    expectedUpdated: props.page.updated || ''
  }
  submitting.value = true
  emit('busy', true)
  error.value = ''
  try {
    await updatePageContent(projectId, pageId, payload)
    if (!isCurrent(version, projectId, pageId)) return
    submitting.value = false
    emit('busy', false)
    emit('saved', pageId)
    emit('close')
  } catch (e) {
    if (!isCurrent(version, projectId, pageId)) return
    error.value =
      e?.response?.status === 409
        ? '内容已被他人修改，请刷新后重试。'
        : e?.message || '保存失败，请重试。'
  } finally {
    if (isCurrent(version, projectId, pageId)) {
      submitting.value = false
      emit('busy', false)
      if (error.value) {
        await nextTick()
        if (isCurrent(version, projectId, pageId)) saveButton.value?.focus()
      }
    }
  }
}
</script>
