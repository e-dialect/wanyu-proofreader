<template>
  <section id="project-entries" ref="entriesSection" class="project-section entry-list-experience">
    <header class="entry-list-heading">
      <div>
        <h2>条目管理</h2>
        <p class="entry-list-counts" :aria-busy="loadingPageStats">
          <span v-if="hasLoadedPageStats"
            >项目共 <strong>{{ pageStats.total }}</strong> 条</span
          >
          <span v-else>项目总数暂不可用</span>
          <span
            >项目校对完成 <strong>{{ hasLoadedPageStats ? pageStats.approved : '—' }}</strong
            ><template v-if="hasLoadedPageStats"> · {{ approvedPct }}%</template></span
          >
          <span
            >项目待仲裁
            <strong>{{ hasLoadedPageStats ? pageStats.arbitration : '—' }}</strong></span
          >
          <span v-if="hasActiveListFilter && hasLoadedPages"
            >当前条件 {{ totalFilteredItems }} 条</span
          >
        </p>
      </div>
      <AppButton
        v-if="hasLoadedPages"
        variant="ghost"
        size="sm"
        :loading="loadingPages"
        loading-label="正在刷新"
        @click="loadPages"
        >刷新条目</AppButton
      >
    </header>
    <div v-if="importJob" class="entry-batch-scope">
      <strong>{{ validImportJob(importJob) ? '仅查看本批次' : '批次链接无效' }}</strong>
      <div>
        <RouterLink
          v-if="validImportJob(importJob)"
          :to="{ name: 'ProjectBatchReport', params: { id: projectId, batchId: importJob } }"
          class="btn btn-quiet btn-sm"
          >返回批次报告</RouterLink
        >
        <RouterLink
          v-else
          :to="projectWorkspaceTarget(projectId, 'materials', 'batches')"
          class="btn btn-quiet btn-sm"
          >返回批次台账</RouterLink
        >
        <AppButton variant="ghost" size="sm" @click="clearImportJobFilter"
          >查看全项目条目</AppButton
        >
      </div>
    </div>
    <p v-if="pageStatsError" class="entry-list-error" role="alert">
      {{ pageStatsError }}
      <AppButton variant="ghost" size="sm" @click="loadPageStats">重试统计</AppButton>
    </p>
    <RareCharacterNotice :texts="fontTexts" />
    <p v-if="columnRolesError" class="entry-list-error" role="alert">
      列用途暂时无法读取，当前按原列名展示。
      <AppButton variant="ghost" size="sm" :loading="loadingColumnRoles" @click="loadColumnRoles"
        >重试列用途</AppButton
      >
    </p>
    <div v-if="mutationSuccess" class="alert alert-success" role="status">
      {{ mutationSuccess }}
    </div>
    <div v-if="mutationError" class="alert alert-error" role="alert">{{ mutationError }}</div>
    <div v-if="qualitySummaryError" class="alert alert-error" role="alert">
      {{ qualitySummaryError }}
      <AppButton variant="secondary" size="sm" @click="loadQualitySummary">重新加载</AppButton>
    </div>

    <div
      v-if="pageStats.total || totalFilteredItems || hasActiveListFilter"
      class="entry-list-toolbar"
    >
      <label class="entry-list-search">
        <span class="sr-only">搜索条目</span>
        <AppIcon name="search" />
        <input
          v-model="searchQuery"
          type="search"
          class="form-control"
          placeholder="搜索条号、PDF 页码、文本或校对员"
          @input="queueListQuery"
        />
      </label>
      <AppSelect
        v-model="selectedStatus"
        :options="entryStatusOptions"
        aria-label="状态"
        @update:model-value="queueListQuery"
      />
      <AppButton
        variant="ghost"
        size="sm"
        :aria-expanded="showAdvanced"
        aria-controls="entry-list-filters"
        @click="showAdvanced = !showAdvanced"
        >筛选<template v-if="advancedFilterCount"> · {{ advancedFilterCount }}</template></AppButton
      >
      <AppButton
        v-if="!importJob"
        variant="ghost"
        size="sm"
        :aria-pressed="batchMode"
        :disabled="mutatingRows"
        @click="toggleBatchMode"
        >{{ batchMode ? '退出批量' : '批量选择' }}</AppButton
      >
      <AppButton
        v-if="hasRefinements"
        class="entry-filter-reset"
        :aria-label="importJob ? '清除其他筛选' : '清除筛选'"
        variant="ghost"
        size="sm"
        @click="resetListFilters"
        >清除</AppButton
      >
    </div>
    <div
      v-if="showAdvanced"
      id="entry-list-filters"
      class="entry-list-filters"
      aria-label="更多条目筛选"
    >
      <div v-if="qualitySummary" class="entry-quality-summary" aria-label="项目质量状态汇总">
        <span>质量状态</span>
        <span
          v-for="row in qualitySummaryRows"
          :key="row.state"
          :class="qualityStateBadgeClass(row.state)"
          :title="QUALITY_STATE_HINTS[row.state] || '取值表外的状态，见迁移与代码的差异'"
          >{{ row.label }} · {{ row.count }}</span
        >
        <span>共 {{ qualitySummary.total }} 条</span>
      </div>
      <div class="entry-list-filter-fields">
        <AppField label="质量状态"
          ><AppSelect
            v-model="selectedQualityState"
            :options="entryQualityOptions"
            aria-label="质量状态"
            @update:model-value="queueListQuery"
        /></AppField>
        <AppField label="PDF 起始页"
          ><input
            v-model="minPdfPage"
            type="number"
            min="1"
            class="form-control"
            @input="queueListQuery"
        /></AppField>
        <AppField label="PDF 结束页"
          ><input
            v-model="maxPdfPage"
            type="number"
            min="1"
            class="form-control"
            @input="queueListQuery"
        /></AppField>
        <AppField label="每页显示"
          ><AppSelect
            :model-value="String(listPageSize)"
            :options="entryPageSizes"
            aria-label="每页显示"
            @update:model-value="changePageSize"
        /></AppField>
      </div>
    </div>
    <div v-if="batchMode && !importJob" class="entry-list-batch" aria-label="批量条目操作">
      <div class="entry-batch-heading">
        <strong>{{
          selectedPendingIds.length ? `已选 ${selectedPendingIds.length} 条` : '选择待校对条目'
        }}</strong>
        <span>仅待校对条目可批量调整；范围按完整列表条号计算。</span>
      </div>
      <div class="entry-batch-selection">
        <input
          v-model.trim="rangeSelectInput"
          class="form-control"
          placeholder="条号，如 1-33 或 1,3,5-8"
          aria-label="按完整列表范围选择条目"
          :disabled="mutatingRows"
        />
        <AppButton
          variant="secondary"
          size="sm"
          :disabled="mutatingRows || !rangeSelectInput"
          @click="selectByRange"
          >范围选中</AppButton
        >
        <AppButton
          variant="ghost"
          size="sm"
          :disabled="mutatingRows || !hasLoadedPageStats || pageStats.unstarted === 0"
          @click="toggleSelectAllPending"
          >{{ allPendingSelected ? '取消全选待校对' : '全选待校对' }}</AppButton
        >
      </div>
      <div v-if="selectedPendingIds.length" class="entry-batch-actions">
        <AppButton variant="ghost" size="sm" :disabled="mutatingRows" @click="clearSelection"
          >取消选择</AppButton
        >
        <AppButton
          variant="secondary"
          size="sm"
          :loading="mutatingRows"
          @click="moveSelectedRowsDown"
          >批量下移所选</AppButton
        >
        <AppButton variant="danger" size="sm" :disabled="mutatingRows" @click="deleteSelectedRows"
          >批量删除所选</AppButton
        >
      </div>
    </div>
    <div v-if="loadingPages && hasLoadedPages" class="admin-entry-updating" role="status">
      正在更新条目，当前内容仍可查看。
    </div>
    <div v-if="pagesError" class="alert alert-error" role="alert">
      {{ pagesError }}
      <AppButton variant="secondary" size="sm" @click="loadPages">重新加载</AppButton>
    </div>
    <div
      v-if="loadingPages && !hasLoadedPages"
      class="admin-entry-skeleton"
      aria-label="正在加载条目"
    >
      <div
        v-for="index in 4"
        :key="index"
        class="skeleton-card skeleton-line"
        aria-hidden="true"
      ></div>
    </div>
    <div
      v-else-if="
        hasLoadedPages &&
        !loadingPages &&
        !pagesError &&
        totalFilteredItems === 0 &&
        !hasActiveListFilter
      "
      class="empty-state"
    >
      <div class="empty-state-mark" aria-hidden="true">条</div>
      <div class="empty-state-text">暂无条目，请上传 CSV 文件</div>
    </div>
    <div
      v-else-if="hasLoadedPages && !loadingPages && !pagesError && filteredPages.length === 0"
      class="empty-state"
    >
      <div class="empty-state-mark" aria-hidden="true">筛</div>
      <div class="empty-state-text">没有符合当前条件的条目</div>
      <AppButton v-if="hasRefinements" variant="secondary" @click="resetListFilters">
        {{ importJob ? '清除其他筛选' : '清除筛选' }}
      </AppButton>
    </div>
    <div v-else-if="hasLoadedPages" :class="{ 'admin-entry-results--updating': loadingPages }">
      <AppDataTable
        label="项目条目表"
        table-class="entry-experience-table"
        :aria-busy="loadingPages"
      >
        <template #head
          ><tr>
            <th v-if="batchMode && !importJob" class="entry-select-cell">选择</th>
            <th>条目内容</th>
            <th class="entry-progress-cell">校对进度</th>
            <th class="entry-quality-cell">质量状态</th>
            <th class="entry-actions-cell"><span class="sr-only">操作</span></th>
          </tr></template
        >
        <tr
          v-for="({ page: pg, content, visibleFields }, idx) in presentedPages"
          :key="pg.id"
          :data-entry-id="pg.id"
        >
          <td v-if="batchMode && !importJob" class="entry-select-cell">
            <label class="entry-checkbox-hit"
              ><input
                type="checkbox"
                :checked="selectedPendingIds.includes(pg.id)"
                :disabled="!isPending(pg) || mutatingRows"
                :aria-label="`选择第 ${formatItemNo(pg.page_number, displayedPageOffset + idx)} 条`"
                @change="toggleRowSelection(pg.id, $event.target.checked)"
            /></label>
          </td>
          <td class="entry-content-cell">
            <div class="entry-content-layout">
              <div class="entry-content-location">
                <button
                  type="button"
                  class="entry-detail-link"
                  :disabled="mutatingRows"
                  :aria-label="`查看第 ${formatItemNo(pg.page_number, displayedPageOffset + idx)} 条详情与修正`"
                  @click="openContentEdit(pg)"
                >
                  第 {{ formatItemNo(pg.page_number, displayedPageOffset + idx) }} 条
                </button>
                <span v-if="pg.pdf_page">PDF 第 {{ pg.pdf_page }} 页</span>
              </div>
              <dl v-if="content.structured" class="entry-content-fields">
                <div
                  v-for="field in visibleFields"
                  :key="field.name"
                  :class="['entry-field', `entry-field--${field.role}`]"
                  :data-entry-field="field.name"
                >
                  <dt :class="{ 'sr-only': ['headword', 'reading'].includes(field.role) }">
                    {{ field.name }}
                  </dt>
                  <dd>
                    <AppFieldValue
                      class="entry-field-value"
                      :value="field.value"
                      :lang="fieldValueLanguage(field.name)"
                      :font-notice="false"
                    />
                  </dd>
                </div>
              </dl>
              <AppFieldValue
                v-else
                class="entry-content-text"
                :value="content.rawText"
                empty-label="—"
                :font-notice="false"
              />
              <AppDisclosure class="entry-original-values" lazy>
                <template #summary>查看原值</template>
                <dl v-if="content.structured">
                  <div v-for="field in content.fields" :key="field.name">
                    <dt>{{ field.name }}</dt>
                    <dd>
                      <AppFieldValue
                        :value="field.value"
                        :lang="fieldValueLanguage(field.name)"
                        :font-notice="false"
                      />
                    </dd>
                  </div>
                </dl>
                <p class="entry-original-text-label">完整导入文本</p>
                <AppFieldValue
                  class="entry-original-text"
                  :value="content.rawText"
                  empty-label="（空值）"
                  :font-notice="false"
                />
              </AppDisclosure>
              <small v-if="pg.ocr_cells_json" class="ocr-cell-summary"
                >识别时：<span
                  v-for="state in ocrCellSummary(pg.ocr_cells_json)"
                  :key="state.status"
                  >{{ state.label }} {{ state.count }} 格
                </span></small
              >
              <div class="entry-mobile-status">
                <span :class="statusBadgeClass(pg.status)" class="badge">{{
                  statusLabel(pg.status)
                }}</span>
                <span
                  >{{ pg.proofread_count || 0 }}/{{
                    project?.required_proofreads || 2
                  }}
                  份结果</span
                >
                <span :class="qualityStateBadgeClass(pg.quality_state)"
                  >质量{{ qualityStateLabel(pg.quality_state) }}</span
                >
                <span v-if="pg.expand?.proofreader">{{
                  pg.expand.proofreader.name || pg.expand.proofreader.email
                }}</span>
                <span v-if="pg.mismatch_count">不一致 {{ pg.mismatch_count }} 次</span>
              </div>
            </div>
          </td>
          <td class="entry-progress-cell">
            <span :class="statusBadgeClass(pg.status)" class="badge">{{
              statusLabel(pg.status)
            }}</span
            ><small
              >{{ pg.proofread_count || 0 }} /
              {{ project?.required_proofreads || 2 }} 份独立结果</small
            ><small v-if="pg.expand?.proofreader">{{
              pg.expand.proofreader.name || pg.expand.proofreader.email
            }}</small
            ><small v-if="pg.mismatch_count">不一致 {{ pg.mismatch_count }} 次</small>
          </td>
          <td class="entry-quality-cell">
            <span :class="qualityStateBadgeClass(pg.quality_state)">{{
              qualityStateLabel(pg.quality_state)
            }}</span>
          </td>
          <td class="entry-actions-cell">
            <RouterLink
              v-if="pg.status === PAGE_STATUS.ARBITRATION"
              :to="{
                name: 'Arbitration',
                params: { projectId, pageId: pg.id },
                query: importJob ? { importJob } : {}
              }"
              class="entry-arbitration-link"
              >仲裁 <AppIcon name="arrow" :size="14"
            /></RouterLink>
            <AppDropdown
              label="更多"
              :disabled="mutatingRows"
              :aria-label="`第 ${pg.page_number} 条的更多操作`"
              :items="rowActions(pg)"
              @select="handleRowAction(pg, $event)"
            />
          </td>
        </tr>
      </AppDataTable>
      <AppPagination
        v-if="listPagination.totalPages > 1"
        :page="listPagination.page"
        :total-pages="listPagination.totalPages"
        :busy="loadingPages"
        label="条目分页"
        button-class="btn btn-secondary btn-sm"
        @change="changeListPage"
      />
    </div>
  </section>
  <ConfirmDialog
    :open="Boolean(qualityTarget)"
    title-id="quality-state-dialog-title"
    @close="closeQualityDialog"
  >
    <h3 id="quality-state-dialog-title">设置条目质量状态</h3>
    <p class="text-sm text-muted">
      第 {{ qualityTarget?.page_number }} 条 · 当前「{{
        qualityStateLabel(qualityTarget?.quality_state)
      }}」
    </p>
    <AppField class="form-group"
      ><template #label>目标状态</template>
      <select v-model="qualityDraftState" :disabled="qualitySubmitting" class="form-control">
        <option v-for="option in qualityStateOptions" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
    </AppField>
    <p class="text-sm text-muted">{{ QUALITY_STATE_HINTS[qualityDraftState] }}</p>
    <AppField class="form-group"
      ><template #label>依据{{ qualityBasisRequired ? '（必填）' : '（可留空）' }}</template>
      <textarea
        v-model="qualityDraftBasis"
        :disabled="qualitySubmitting"
        class="form-control"
        rows="3"
        maxlength="500"
      ></textarea>
    </AppField>
    <div v-if="qualityDialogError" class="alert alert-error" role="alert">
      {{ qualityDialogError }}
    </div>
    <template #actions>
      <button
        type="button"
        class="btn btn-secondary"
        :disabled="qualitySubmitting"
        @click="closeQualityDialog"
      >
        取消
      </button>
      <button
        type="button"
        class="btn btn-primary"
        :disabled="qualitySubmitDisabled"
        @click="submitQualityChange"
      >
        {{ qualitySubmitting ? '保存中...' : '保存' }}
      </button>
    </template>
  </ConfirmDialog>
  <PageContentEditModal
    :open="Boolean(contentEditTarget)"
    :page="contentEditTarget"
    :project-id="projectId"
    @close="closeContentEdit"
    @busy="contentEditBusy = $event"
    @saved="onContentSaved"
  />
</template>

<script setup>
import '@/entry-list-experience.css'
import AppButton from '@/components/AppButton.vue'
import AppDisclosure from '@/components/AppDisclosure.vue'
import AppDropdown from '@/components/AppDropdown.vue'
import AppSelect from '@/components/AppSelect.vue'
import AppIcon from '@/components/AppIcon.vue'
import RareCharacterNotice from '@/components/editor/RareCharacterNotice.vue'
import { ocrCellSummary } from '@/lib/ocrJob'
import { entryListPresentation } from '@/lib/entryListPresentation'
import { fieldValueLanguage } from '@/lib/fieldValue'
import { getColumnRoles } from '@/services/projectsService'
import { useAsyncResource } from '@/composables/useAsyncResource'
import AppFieldValue from '@/components/AppFieldValue.vue'
import AppPagination from '@/components/AppPagination.vue'
import AppField from '@/components/AppField.vue'
import AppDataTable from '@/components/AppDataTable.vue'
import { RouterLink } from 'vue-router'
import { validImportJob } from '@/lib/adminPageList'
import { projectWorkspaceTarget } from '@/lib/projectWorkspace'
import { PAGE_STATUS, statusBadgeClass, statusLabel } from '@/constants/pageStatus'
import { QUALITY_STATE_HINTS } from '@/constants/qualityState'
import { qualityStateBadgeClass, qualityStateLabel } from '@/lib/qualityState'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import PageContentEditModal from '@/components/admin/PageContentEditModal.vue'
import { useProjectEntries } from '@/composables/project/useProjectEntries'
import { computed, ref, toRef, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
const props = defineProps({
  projectId: { type: String, required: true },
  project: { type: Object, required: true },
  refreshLedger: { type: Function, required: true }
})
const projectId = props.projectId
const project = toRef(props, 'project')
const {
  jumpToPdfPage,
  ACTIVE_STATUS_FILTER,
  allPendingSelected,
  applyListQuery,
  approvedPct,
  canMoveDown,
  canMoveUp,
  changeListPage,
  closeQualityDialog,
  contentEditTarget,
  contentEditBusy,
  closeContentEdit,
  clearImportJobFilter,
  deleteSelectedRows,
  displayedPageOffset,
  displayedPages,
  entriesSection,
  filteredPages,
  formatItemNo,
  hasActiveListFilter,
  hasRefinements,
  hasLoadedPageStats,
  hasLoadedPages,
  importJob,
  isPending,
  listPageSize,
  listPagination,
  loadPageStats,
  loadPages,
  loadQualitySummary,
  loadingPageStats,
  loadingPages,
  maxPdfPage,
  minPdfPage,
  movePendingRow,
  moveSelectedRowsDown,
  mutatingRows,
  mutationError,
  mutationSuccess,
  onContentSaved,
  openContentEdit,
  openQualityDialog,
  pageStats,
  pageStatsError,
  pagesError,
  qualityBasisRequired,
  qualityDialogError,
  qualityDraftBasis,
  qualityDraftState,
  qualityStateOptions,
  qualitySubmitDisabled,
  qualitySubmitting,
  qualitySummary,
  qualitySummaryError,
  qualitySummaryRows,
  qualityTarget,
  queueListQuery,
  rangeSelectInput,
  resetListFilters,
  scrollToEntries,
  searchQuery,
  selectByRange,
  selectedPendingIds,
  selectedQualityState,
  selectedStatus,
  statusOptions,
  submitQualityChange,
  toggleRowSelection,
  toggleSelectAllPending,
  totalFilteredItems
} = useProjectEntries(projectId, project, props.refreshLedger)

const {
  data: columnRoleView,
  pending: loadingColumnRoles,
  error: columnRolesError,
  reload: reloadColumnRoles
} = useAsyncResource(async (_context, scope) => ({
  ...scope,
  roles: (await getColumnRoles(scope.projectId)).roles
}))
const auth = useAuthStore()
function loadColumnRoles() {
  return reloadColumnRoles({ projectId: props.projectId, actorId: auth.user?.id })
}
watch([() => props.projectId, () => auth.user?.id], loadColumnRoles, { immediate: true })
const hasCurrentColumnRoles = computed(
  () =>
    columnRoleView.value?.projectId === props.projectId &&
    columnRoleView.value?.actorId === auth.user?.id
)
const entryPresentationOptions = computed(() => {
  const available = hasCurrentColumnRoles.value && !columnRolesError.value
  return {
    roles: available ? columnRoleView.value.roles : {},
    inferFromHeaders: available
  }
})
const presentedPages = computed(() =>
  displayedPages.value.map((page) => {
    const content = entryListPresentation(page, undefined, entryPresentationOptions.value)
    const core = [...content.primary, ...content.meanings]
    const notes = content.secondary.filter((field) => field.role === 'note' && field.value !== '')
    const visibleFields = core.length
      ? [...core.slice(0, 4), ...notes.slice(0, 1)]
      : content.fields.slice(0, 3)
    return {
      page,
      content,
      visibleFields
    }
  })
)

const fontTexts = computed(() =>
  presentedPages.value.flatMap(({ content }) => [
    content.rawText,
    ...content.fields.map((field) => field.value)
  ])
)

const showAdvanced = ref(false)
const batchMode = ref(false)
watch(importJob, () => {
  batchMode.value = false
})
const advancedFilterCount = computed(
  () => [selectedQualityState.value, minPdfPage.value, maxPdfPage.value].filter(Boolean).length
)
watch(
  advancedFilterCount,
  (count) => {
    if (count) showAdvanced.value = true
  },
  { immediate: true }
)
const entryStatusOptions = [
  { value: '', label: '全部状态' },
  { value: ACTIVE_STATUS_FILTER, label: '处理中（已认领/校对中）' },
  ...statusOptions
]
const entryQualityOptions = [{ value: '', label: '全部质量状态' }, ...qualityStateOptions]
const entryPageSizes = [10, 25, 50, 100].map((value) => ({
  value: String(value),
  label: `${value} 条`
}))
function changePageSize(value) {
  listPageSize.value = Number(value)
  queueListQuery()
}
function toggleBatchMode() {
  if (mutatingRows.value || importJob.value) return
  if (batchMode.value) clearSelection()
  batchMode.value = !batchMode.value
}
function rowActions(page) {
  const actions = [
    { label: '修正导入值', action: 'edit', disabled: mutatingRows.value },
    { label: '设置质量状态', action: 'quality', disabled: mutatingRows.value }
  ]
  if (!importJob.value) {
    actions.push(
      { label: '上移', action: 'up', disabled: !canMoveUp(page.id) || mutatingRows.value },
      { label: '下移', action: 'down', disabled: !canMoveDown(page.id) || mutatingRows.value }
    )
  }
  return actions
}
function handleRowAction(page, action) {
  if (mutatingRows.value) return
  if (action === 'edit') openContentEdit(page)
  if (action === 'quality') openQualityDialog(page)
  if (action === 'up' && canMoveUp(page.id)) movePendingRow(page.id, -1)
  if (action === 'down' && canMoveDown(page.id)) movePendingRow(page.id, 1)
}

function clearSelection() {
  selectedPendingIds.value = []
}
defineExpose({
  clearSelection,
  pageStats,
  hasLoadedPageStats,
  hasLoadedPages,
  loadPages,
  loadPageStats,
  loadQualitySummary,
  displayedPages,
  displayedPageOffset,
  applyListQuery,
  scrollToEntries,
  hasActiveListFilter,
  jumpToPdfPage
})
</script>

<style scoped>
.entry-batch-scope,
.entry-batch-scope > div {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.entry-batch-scope {
  justify-content: space-between;
  background: var(--primary-glow-soft);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  padding: var(--space-2) var(--space-3);
  margin-block: var(--space-3);
}
</style>
