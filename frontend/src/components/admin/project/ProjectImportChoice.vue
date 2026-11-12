<template>
  <section aria-label="材料导入">
    <div class="project-import-methods">
      <button
        v-for="item in importMethods"
        :key="item.key"
        class="project-import-method"
        :aria-pressed="method === item.key"
        @click="$emit('select', item.key)"
      >
        <strong>{{ item.label }}</strong
        ><span>{{ item.description }}</span>
      </button>
    </div>
    <RouterLink
      :to="{
        path: '/admin/guide/project-files',
        query: projectId ? { project: projectId, method } : {}
      }"
      class="back-link"
      >查看材料格式与准备说明 →</RouterLink
    >
  </section>
</template>
<script setup>
import { RouterLink } from 'vue-router'
defineProps({
  projectId: { type: String, default: '' },
  method: { type: String, default: 'pdf' }
})
defineEmits(['select'])
const importMethods = [
  { key: 'pdf', label: '来源 PDF', description: '上传原始材料，供校对时逐页对照。' },
  { key: 'csv', label: '导入结构化文本', description: '预检 CSV、确认列与页码，再导入任务。' },
  { key: 'ocr', label: '从 PDF 提取文字', description: '读取受支持的单栏文字层；扫描页暂不支持。' },
  {
    key: 'bundle',
    label: '资料包（Review Bundle）',
    description: '校验跨产品资料包，保留来源、标识与批次。'
  }
]
</script>
