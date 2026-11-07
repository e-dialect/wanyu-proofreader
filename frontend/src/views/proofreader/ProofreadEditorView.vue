<template>
  <DocumentReviewWorkspace
    :page="page"
    :keyboard-available="keyboardAvailable"
    :suspended="(mobile && overview) || reviewingSubmission"
    :loading="loadingPage"
    :pdf-enabled="ownReview || (!leaseLost && (!!leaseToken || saving || loadingPage))"
    :watermark-user-id="currentUserId"
    return-to="/tasks"
    return-label="返回大厅"
    content-labelled-by="task-panel-title"
    empty-pdf-description="请保存草稿并提交来源问题，待来源 PDF 可用后继续核对。"
  >
    <template #panel-header>
      <ProofreadTaskHeader
        v-bind="taskHeaderProps"
        :overview="overview"
        :lease-status="leaseStatus"
        @previous="gotoPrevTask"
        @next="gotoNextTask"
        @retry-position="loadNeighbors"
        @release="releaseCurrentTask"
        @return="openReturnModal"
        @submit="openSubmitReview"
      />
    </template>
    <template #default="{ inputMode }">
      <div v-if="loadingPage" class="panel-loading" aria-live="polite">正在准备校对字段…</div>
      <div v-else-if="!page" class="empty-state">
        <AppStatusPanel
          v-if="saveError"
          state="error"
          :message="saveError"
          retry-label="重试加载任务"
          @retry="loadPage"
        />
        <div v-else class="empty-state-text">页面不存在</div>
        <RouterLink to="/tasks" class="btn btn-secondary mt-3">返回项目大厅</RouterLink>
      </div>
      <template v-else>
        <ProofreadTaskFeedback
          :saved="saved"
          :claim-next-failure="claimNextFailure"
          :claim-next-failure-notice="claimNextFailureNotice"
          :retrying-claim="retryingClaim"
          :lease-lost="leaseLost"
          :save-error="saveError"
          :reclaiming="reclaiming"
          :own-review="ownReview"
          :draft-status="draftStatus"
          :lease-status="leaseStatus"
          :stale-local-drafts="staleLocalDrafts"
          :field-count="rowHeaders.length"
          :changed-count="changedFields.length"
          @retry-claim="retryClaimNext"
          @reclaim="reclaimTask"
        />
        <RareCharacterNotice
          :texts="[...Object.values(originalRow), ...Object.values(editedRow)]"
        />
        <p v-if="ownReview" class="alert" role="note">{{ OWN_REVIEW_NOTICE }}</p>
        <TaskVerificationPanel
          v-if="!ownReview"
          ref="verificationPanel"
          :page="page"
          :row="editedRow"
          :lease-token="leaseToken"
          :hints="rawFindings"
          :routing-help="researchSession?.presentation?.display?.routing_help !== false"
          :active="!!leaseToken && !leaseLost && !submittedHere && !saving"
          @restore="replaceEditedRow"
          @context="receiveVerificationContext"
        />
        <ResearchTelemetry
          v-if="!ownReview"
          ref="researchTelemetry"
          :session="researchSession"
          :submitted="submittedHere"
          :density-collapsed-ids="densityCollapsedIds"
        />
        <ProofreadPageHints
          :page-hint-list="pageHintList"
          :page-hint-overflow="pageHintOverflow"
          :findings-truncated="findingsTruncated"
          :gated-notice-text="gatedNoticeText"
        />
        <details v-if="!ownReview" class="editor-correction-help">
          <summary>校对与提交说明</summary>
          <p class="correction-paths text-sm text-muted" role="note">
            字写错了，改对应的文字字段。记音或说法不对，改读音字段，特殊字符用下方字符键盘。还没提交时，用这一栏的「恢复导入值」。提交之后不能撤回，系统会尝试打开下一条，不会停在这一条上再改。
          </p>
        </details>
        <div class="proofread-fields">
          <ProofreadFieldCard
            v-for="(header, index) in rowHeaders"
            v-show="!mobile || overview || currentField === header"
            :key="header"
            v-model="editedRow[header]"
            :header="header"
            :index="index"
            :original-value="String(originalRow[header] ?? '')"
            :segments="sourceSegments(header)"
            :language="fieldValueLanguage(header)"
            :active="activeField === header"
            :changed="isFieldChanged(header)"
            :mobile="mobile"
            :overview="overview"
            :own-review="ownReview"
            :restore-disabled="
              !isFieldChanged(header) || saving || submittedHere || leaseLost || !leaseToken
            "
            :read-only="readOnly || (mobile && overview)"
            :input-mode="inputMode"
            :hints="fieldHintList(header)"
            :hint-overflow="fieldHintOverflow(header)"
            @select="selectField(index)"
            @restore="restoreField(header)"
            @locate="locateHint(header, $event)"
            @textarea="setTextareaRef(header, $event)"
            @activate="activateField(header, $event)"
            @remember="rememberSelection(header, $event)"
            @change="onTextChange"
          />
        </div>
      </template>
    </template>
    <template #navigation
      ><FieldNavigation
        :headers="rowHeaders"
        :index="fieldIndex"
        :overview="overview"
        @select="selectField"
        @next="nextField"
        ><template v-if="!ownReview" #submit
          ><button class="btn btn-success" @click="openSubmitReview">检查并提交</button></template
        ></FieldNavigation
      ></template
    >
    <template #keyboard
      ><ProjectKeyboard
        v-if="page && !ownReview"
        :project-id="page.project"
        @availability="keyboardAvailable = $event"
        @insert="insertText"
    /></template>
  </DocumentReviewWorkspace>
  <ProofreadSubmitDialog
    ref="submitConfirmButton"
    v-model:source-checked="sourceChecked"
    :reviewing-submission="reviewingSubmission"
    :page-number="page?.page_number"
    :changed-fields="changedFields"
    :irreversible-submit-notice="irreversibleSubmitNotice"
    :saving="saving"
    :lease-lost="leaseLost"
    :lease-token="leaseToken"
    :save-error="saveError"
    @close="closeSubmitReview"
    @submit="submitProofread"
  />
  <ProofreadResearchDialog
    :research-open="researchOpen"
    :research-copy="researchCopy"
    :research-error="researchError"
    :research-saving="researchSaving"
    @choose="chooseResearchNotice"
  />
  <ProofreadReturnDialog
    ref="returnConfirmButton"
    :save-error="saveError"
    v-model:return-reason="returnReason"
    v-model:return-basis="returnBasis"
    v-model:queue-mode="queueMode"
    :return-modal-open="returnModalOpen"
    :own-review="ownReview"
    :page-number="page?.page_number"
    :return-queue="returnQueue"
    :returning="returning"
    @close="closeReturnModal"
    @queue-mode="persistQueueMode"
    @batch="batchReturn"
    @confirm="confirmReturn"
  />
</template>
<script setup>
import { RouterLink } from 'vue-router'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import DocumentReviewWorkspace from '@/components/editor/DocumentReviewWorkspace.vue'
import FieldNavigation from '@/components/editor/FieldNavigation.vue'
import ProjectKeyboard from '@/components/editor/ProjectKeyboard.vue'
import RareCharacterNotice from '@/components/editor/RareCharacterNotice.vue'
import TaskVerificationPanel from '@/components/editor/TaskVerificationPanel.vue'
import ResearchTelemetry from '@/components/editor/ResearchTelemetry.vue'
import ProofreadPageHints from '@/components/editor/ProofreadPageHints.vue'
import ProofreadTaskHeader from '@/components/editor/ProofreadTaskHeader.vue'
import ProofreadTaskFeedback from '@/components/editor/ProofreadTaskFeedback.vue'
import ProofreadFieldCard from '@/components/editor/ProofreadFieldCard.vue'
import ProofreadSubmitDialog from '@/components/editor/ProofreadSubmitDialog.vue'
import ProofreadResearchDialog from '@/components/editor/ProofreadResearchDialog.vue'
import ProofreadReturnDialog from '@/components/editor/ProofreadReturnDialog.vue'
import { fieldValueLanguage } from '@/lib/fieldValue'
import { useProofreadEditor } from '@/composables/proofread/useProofreadEditor'
const {
  page,
  loadPage,
  taskHeaderProps,
  readOnly,
  keyboardAvailable,
  mobile,
  overview,
  reviewingSubmission,
  loadingPage,
  ownReview,
  leaseLost,
  leaseToken,
  saving,
  currentUserId,
  submittedHere,
  activeField,
  gotoPrevTask,
  gotoNextTask,
  loadNeighbors,
  releaseCurrentTask,
  openReturnModal,
  openSubmitReview,
  saved,
  claimNextFailure,
  claimNextFailureNotice,
  retryingClaim,
  saveError,
  reclaiming,
  draftStatus,
  leaseStatus,
  staleLocalDrafts,
  rowHeaders,
  changedFields,
  retryClaimNext,
  reclaimTask,
  originalRow,
  editedRow,
  OWN_REVIEW_NOTICE,
  verificationPanel,
  rawFindings,
  researchSession,
  replaceEditedRow,
  receiveVerificationContext,
  researchTelemetry,
  densityCollapsedIds,
  pageHintList,
  pageHintOverflow,
  findingsTruncated,
  gatedNoticeText,
  currentField,
  sourceSegments,
  isFieldChanged,
  fieldHintList,
  fieldHintOverflow,
  selectField,
  restoreField,
  locateHint,
  setTextareaRef,
  activateField,
  rememberSelection,
  onTextChange,
  fieldIndex,
  nextField,
  insertText,
  submitConfirmButton,
  sourceChecked,
  irreversibleSubmitNotice,
  closeSubmitReview,
  submitProofread,
  researchOpen,
  researchCopy,
  researchError,
  researchSaving,
  chooseResearchNotice,
  returnReason,
  returnBasis,
  queueMode,
  returnModalOpen,
  returnQueue,
  returning,
  closeReturnModal,
  persistQueueMode,
  batchReturn,
  confirmReturn,
  returnConfirmButton
} = useProofreadEditor()
</script>
