<template>
  <ul
    v-if="pageHintList.length || pageHintOverflow"
    class="field-hint-list field-hint-list--page"
    aria-label="本条整条级机器疑点"
  >
    <li v-for="(hint, hintIndex) in pageHintList" :key="`page-hint-${hintIndex}`">
      <span
        class="field-hint-chip"
        :data-finding-id="hint.id"
        :class="{ 'field-hint-chip--strong': hint.highlight }"
        ><b aria-hidden="true">疑</b>{{ hintLabel(hint.kind) }}</span
      ><span class="field-hint-reason">{{ hint.text }}</span>
    </li>
    <li v-if="pageHintOverflow" class="field-hint-overflow">
      本条疑点较多，已按密度折叠 {{ pageHintOverflow }} 条
    </li>
  </ul>
  <p v-if="findingsTruncated" class="field-hint-truncated text-sm text-muted" role="status">
    本条疑点数量超出单次读取上限，以上标注不完整，请勿以“无标记”当作已核对通过。
  </p>
  <p v-if="gatedNoticeText" class="field-hint-gated text-sm text-muted" role="status">
    {{ gatedNoticeText }}
  </p>
</template>
<script setup>
import { hintKindLabel as hintLabel } from '@/lib/fieldHints'
defineProps({
  pageHintList: { type: Array, default: () => [] },
  pageHintOverflow: Number,
  findingsTruncated: Boolean,
  gatedNoticeText: String
})
</script>
