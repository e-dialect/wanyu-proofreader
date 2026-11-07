<template>
  <div class="project-entry-summary" :aria-busy="loadingPageStats">
    <span
      >全部条目 <strong>{{ hasLoadedPageStats ? pageStats.total : '—' }}</strong></span
    >
    <span
      >校对完成 <strong>{{ hasLoadedPageStats ? pageStats.approved : '—' }}</strong
      ><template v-if="hasLoadedPageStats"> · {{ approvedPct }}%</template></span
    >
    <span
      >待仲裁 <strong>{{ hasLoadedPageStats ? pageStats.arbitration : '—' }}</strong></span
    >
    <span v-if="pageStatsError" role="alert"
      >{{ pageStatsError }}
      <button class="btn btn-quiet btn-sm" @click="loadPageStats">重试统计</button></span
    >
  </div>

  <!-- Pages list -->
  <section id="project-entries" ref="entriesSection" class="card project-section">
    <div class="section-heading admin-entry-heading">
      <div>
        <h2>条目管理</h2>
        <p v-if="hasLoadedPageStats">
          共 {{ pageStats.total }} 条<span v-if="hasActiveListFilter"
            >，当前条件显示 {{ totalFilteredItems }} 条</span
          >。
        </p>
        <p v-else-if="hasLoadedPages">
          当前条件显示 {{ totalFilteredItems }} 条；项目总数暂不可用。
        </p>
        <p v-else>条目总数暂不可用。</p>
      </div>
      <button
        v-if="hasActiveListFilter"
        type="button"
        class="btn btn-quiet btn-sm"
        @click="resetListFilters"
      >
        查看全部条目
      </button>
    </div>
    <RareCharacterNotice :texts="displayedPages.map((page) => page.ocr_text || '')" />
    <div v-if="mutationSuccess" class="alert alert-success" role="status">
      {{ mutationSuccess }}
    </div>
    <div v-if="mutationError" class="alert alert-error" role="alert">{{ mutationError }}</div>
    <!-- 质量状态汇总：#172 要求管理端能回答「还有多少未收口」。计数走服务端的
             COUNT(*) GROUP BY（quality-summary），不是把当前这页的条目数一遍——
             后者会把「本页有 2 条暂缓」说成「项目有 2 条暂缓」。 -->
    <div v-if="qualitySummaryError" class="alert alert-error mb-2" role="alert">
      {{ qualitySummaryError }}
      <button type="button" class="btn btn-secondary btn-sm ml-2" @click="loadQualitySummary">
        重新加载
      </button>
    </div>

    <div
      v-if="pageStats.total || totalFilteredItems || hasActiveListFilter"
      class="project-entry-filterbar"
    >
      <AppField class="project-entry-search"
        ><template #label>搜索条目</template>
        <input
          v-model="searchQuery"
          type="search"
          class="form-control"
          placeholder="条号、PDF页码、文本或当前校对员"
          @input="queueListQuery"
        />
      </AppField>
      <AppField class="admin-filter-field"
        ><template #label>状态</template>
        <select v-model="selectedStatus" class="form-control" @change="queueListQuery">
          <option value="">全部状态</option>
          <option :value="ACTIVE_STATUS_FILTER">处理中（已认领/校对中）</option>
          <option v-for="option in statusOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </AppField>
      <button
        v-if="hasActiveListFilter"
        type="button"
        class="btn btn-quiet"
        @click="resetListFilters"
      >
        清除筛选
      </button>
    </div>
    <details
      class="project-entry-advanced"
      :open="Boolean(selectedQualityState || minPdfPage || maxPdfPage)"
    >
      <summary>更多筛选与批量选择</summary>
      <div v-if="qualitySummary" class="mb-4">
        <div class="flex flex-wrap gap-2 items-center">
          <span class="text-sm text-muted">质量状态：</span>
          <span
            v-for="row in qualitySummaryRows"
            :key="row.state"
            :class="qualityStateBadgeClass(row.state)"
            :title="QUALITY_STATE_HINTS[row.state] || '取值表外的状态，见迁移与代码的差异'"
            >{{ row.label }} · {{ row.count }}</span
          >
          <span class="text-sm text-muted">共 {{ qualitySummary.total }} 条</span>
        </div>
      </div>
      <div class="admin-list-filters">
        <AppField class="admin-filter-field"
          ><template #label>质量状态</template>
          <select v-model="selectedQualityState" class="form-control" @change="queueListQuery">
            <option value="">全部质量状态</option>
            <option v-for="option in qualityStateOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </AppField>
        <AppField class="admin-filter-field"
          ><template #label>PDF 起始页</template
          ><input
            v-model="minPdfPage"
            type="number"
            min="1"
            class="form-control"
            @input="queueListQuery"
        /></AppField>
        <AppField class="admin-filter-field"
          ><template #label>PDF 结束页</template
          ><input
            v-model="maxPdfPage"
            type="number"
            min="1"
            class="form-control"
            @input="queueListQuery"
        /></AppField>
        <AppField class="admin-filter-field admin-filter-size"
          ><template #label>每页显示</template>
          <select v-model.number="listPageSize" class="form-control" @change="queueListQuery">
            <option :value="10">10 条</option>
            <option :value="25">25 条</option>
            <option :value="50">50 条</option>
            <option :value="100">100 条</option>
          </select>
        </AppField>
        <button
          v-if="hasActiveListFilter"
          type="button"
          class="btn btn-secondary btn-sm"
          @click="resetListFilters"
        >
          清除筛选
        </button>
      </div>
      <div class="mt-4">
        <h3 class="text-sm">按范围选择待校对条目</h3>
        <div class="project-entry-selection">
          <input
            v-model.trim="rangeSelectInput"
            class="form-control"
            placeholder="如 1-33 或 1,3,5-8"
            aria-label="按完整列表范围选择条目"
            :disabled="mutatingRows"
          />
          <button
            class="btn btn-secondary btn-sm"
            :disabled="mutatingRows || !rangeSelectInput"
            @click="selectByRange"
          >
            范围选中
          </button>
          <button
            class="btn btn-quiet btn-sm"
            :disabled="mutatingRows || !hasLoadedPageStats || pageStats.unstarted === 0"
            @click="toggleSelectAllPending"
          >
            {{ allPendingSelected ? '取消全选待校对' : '全选待校对' }}
          </button>
          <span class="text-sm text-muted">范围按完整列表条号计算。</span>
        </div>
      </div>
    </details>
    <div v-if="loadingPages && hasLoadedPages" class="admin-entry-updating" role="status">
      正在更新条目，当前内容仍可查看。
    </div>
    <div v-if="pagesError" class="alert alert-error" role="alert">
      {{ pagesError }}
      <button type="button" class="btn btn-secondary btn-sm ml-2" @click="loadPages">
        重新加载
      </button>
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
      v-else-if="hasLoadedPages && totalFilteredItems === 0 && !hasActiveListFilter"
      class="empty-state"
    >
      <div class="empty-state-mark" aria-hidden="true">条</div>
      <div class="empty-state-text">暂无条目，请上传 CSV 文件</div>
    </div>
    <div v-else-if="hasLoadedPages && filteredPages.length === 0" class="empty-state">
      <div class="empty-state-mark" aria-hidden="true">筛</div>
      <div class="empty-state-text">没有符合当前条件的条目</div>
      <button type="button" class="btn btn-secondary mt-3" @click="resetListFilters">
        清除筛选
      </button>
    </div>
    <div v-else-if="hasLoadedPages" :class="{ 'admin-entry-results--updating': loadingPages }">
      <div
        v-if="selectedPendingIds.length"
        class="admin-table-actions mb-3"
        :class="{ 'admin-table-actions--selected': selectedPendingIds.length > 0 }"
      >
        <div class="selection-summary">
          <strong>{{ selectedPendingIds.length }}</strong>
          <span>条待校对条目已选择<br /><small>范围始终按完整列表条号计算</small></span>
        </div>
        <div class="admin-bulk-actions">
          <button class="btn btn-quiet btn-sm" :disabled="mutatingRows" @click="clearSelection">
            取消选择
          </button>
          <button
            class="btn btn-secondary btn-sm"
            @click="moveSelectedRowsDown"
            :disabled="mutatingRows || selectedPendingIds.length === 0"
          >
            {{ mutatingRows ? '处理中...' : '批量下移所选' }}
          </button>
          <button
            class="btn btn-danger btn-sm"
            @click="deleteSelectedRows"
            :disabled="mutatingRows || selectedPendingIds.length === 0"
          >
            {{ mutatingRows ? '处理中...' : '批量删除所选' }}
          </button>
        </div>
      </div>
      <AppDataTable label="项目条目表" table-class="project-entry-table" :aria-busy="loadingPages">
        <template #head
          ><tr>
            <th class="entry-column-select">选择</th>
            <th>条目</th>
            <th>导入文本</th>
            <th>校对进度</th>
            <th>质量状态</th>
            <th>操作</th>
          </tr></template
        >
        <tr v-for="(pg, idx) in displayedPages" :key="pg.id">
          <td>
            <input
              type="checkbox"
              :checked="selectedPendingIds.includes(pg.id)"
              :disabled="!isPending(pg) || mutatingRows"
              :aria-label="`选择第 ${formatItemNo(pg.page_number, displayedPageOffset + idx)} 条`"
              @change="toggleRowSelection(pg.id, $event.target.checked)"
            />
          </td>
          <td class="project-entry-identity">
            <strong>第 {{ formatItemNo(pg.page_number, displayedPageOffset + idx) }} 条</strong
            ><small v-if="pg.pdf_page">PDF 第 {{ pg.pdf_page }} 页</small>
          </td>
          <td class="entry-preview">
            <AppFieldValue
              :value="
                Array.from(pg.ocr_text || '')
                  .slice(0, 120)
                  .join('')
              "
              empty-label="—"
              :font-notice="false"
            /><small v-if="pg.ocr_cells_json" class="ocr-cell-summary"
              >识别时：<span v-for="state in ocrCellSummary(pg.ocr_cells_json)" :key="state.status"
                >{{ state.label }} {{ state.count }} 格
              </span></small
            >
          </td>
          <td class="project-entry-progress">
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
          <td>
            <span :class="qualityStateBadgeClass(pg.quality_state)">{{
              qualityStateLabel(pg.quality_state)
            }}</span>
          </td>
          <td class="project-entry-operations">
            <RouterLink
              v-if="pg.status === PAGE_STATUS.ARBITRATION"
              :to="`/admin/projects/${projectId}/arbitration/${pg.id}`"
              class="btn btn-warn btn-sm"
              >仲裁</RouterLink
            >
            <button
              v-else
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="mutatingRows"
              @click="openContentEdit(pg)"
            >
              修正
            </button>
            <details class="project-entry-actions">
              <summary :aria-label="`第 ${pg.page_number} 条的更多操作`">更多</summary>
              <div>
                <button
                  v-if="pg.status === PAGE_STATUS.ARBITRATION"
                  type="button"
                  class="btn btn-quiet btn-sm"
                  :disabled="mutatingRows"
                  @click="openContentEdit(pg)"
                >
                  修正导入值
                </button>
                <button
                  type="button"
                  class="btn btn-quiet btn-sm"
                  :disabled="mutatingRows"
                  :aria-label="`设置第 ${pg.page_number} 条的质量状态`"
                  @click="openQualityDialog(pg)"
                >
                  标注质量
                </button>
                <button
                  class="btn btn-quiet btn-sm"
                  :disabled="!canMoveUp(pg.id) || mutatingRows"
                  @click="movePendingRow(pg.id, -1)"
                >
                  上移
                </button>
                <button
                  class="btn btn-quiet btn-sm"
                  :disabled="!canMoveDown(pg.id) || mutatingRows"
                  @click="movePendingRow(pg.id, 1)"
                >
                  下移
                </button>
              </div>
            </details>
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
import RareCharacterNotice from '@/components/editor/RareCharacterNotice.vue'
import { ocrCellSummary } from '@/lib/ocrJob'
import AppFieldValue from '@/components/AppFieldValue.vue'
import AppPagination from '@/components/AppPagination.vue'
import AppField from '@/components/AppField.vue'
import AppDataTable from '@/components/AppDataTable.vue'
import { RouterLink } from 'vue-router'
import { PAGE_STATUS, statusBadgeClass, statusLabel } from '@/constants/pageStatus'
import { QUALITY_STATE_HINTS } from '@/constants/qualityState'
import { qualityStateBadgeClass, qualityStateLabel } from '@/lib/qualityState'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import PageContentEditModal from '@/components/admin/PageContentEditModal.vue'
import { useProjectEntries } from '@/composables/project/useProjectEntries'
import { toRef } from 'vue'
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
  deleteSelectedRows,
  displayedPageOffset,
  displayedPages,
  entriesSection,
  filteredPages,
  formatItemNo,
  hasActiveListFilter,
  hasLoadedPageStats,
  hasLoadedPages,
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
