<template>
  <!-- #190 拼音归一：机器判不出来的进复核队列，人工结论写在条目上 -->
  <section
    id="project-scheme"
    ref="schemeSection"
    class="card project-section mb-6"
    :aria-busy="schemeLoading"
  >
    <div class="section-heading">
      <div>
        <h2>拼音归一</h2>
        <p class="text-sm text-muted">
          按<strong>声明的</strong>方案把校对后的记音转换成统一方案；系统不会替你判断某批资料用的是哪一套。
          转换作业与人工复核分别处理，原始写法继续保留。
        </p>
      </div>
    </div>

    <div v-if="!schemeLoaded" class="skeleton-card" aria-label="正在加载拼音归一">
      <span class="skeleton-line skeleton-line--short" aria-hidden="true"></span>
      <span class="skeleton-line" aria-hidden="true"></span>
    </div>
    <p v-else-if="schemeNotice" class="alert alert-warning" role="alert">{{ schemeNotice }}</p>

    <template v-else>
      <div class="scheme-view-controls">
        <nav class="scheme-tabs" aria-label="记音整理工作">
          <AppButton
            type="button"
            :aria-current="schemeView === 'jobs' ? 'page' : undefined"
            @click="setView('jobs')"
          >
            转换作业</AppButton
          ><AppButton
            type="button"
            :aria-current="schemeView === 'review' ? 'page' : undefined"
            @click="setView('review')"
          >
            人工复核 <span v-if="reviewTotalItems">{{ reviewTotalItems }}</span>
          </AppButton>
        </nav>
        <AppButton
          type="button"
          variant="secondary"
          size="sm"
          :disabled="schemeBusy || schemeLoading"
          @click="loadSchemeState"
        >
          刷新
        </AppButton>
      </div>
      <p v-if="schemeError" class="alert alert-error" role="alert">{{ schemeError }}</p>
      <p v-if="schemeSuccess" class="alert alert-success" role="status">{{ schemeSuccess }}</p>
      <section v-show="schemeView === 'jobs'" aria-label="转换作业">
        <div class="admin-list-filters mb-4">
          <AppField class="admin-filter-field"
            ><template #label>本批资料用的是哪套方案</template>
            <select v-model="schemeSourceId" class="form-control">
              <option value="">请选择</option>
              <option
                v-for="item in schemeOptions"
                :key="item.source_scheme_id"
                :value="item.source_scheme_id"
              >
                {{ schemeOptionLabel(item) }}
              </option>
            </select>
          </AppField>
          <AppButton
            type="button"
            variant="primary"
            :disabled="schemeBusy || !schemeSourceId"
            @click="runConversion"
          >
            {{ schemeBusy ? '转换中…' : '生成统一拼音' }}
          </AppButton>
        </div>
        <!-- 规则文件自己声明了能不能跑真实作业。合成夹具在目录里是合法的一等公民
               （引擎需要它），但它建不出真实作业——这句话必须在按钮旁边说。 -->
        <p v-if="testOnlySchemes.length" class="text-sm text-muted">
          {{ testOnlySchemes.join('、') }}
          声明为「仅测试」：可以选中，但系统会拒绝用它创建真实转换作业。
          依据不足的方案不能用于正式转换。
        </p>
        <details v-if="testOnlySchemes.length" class="text-sm text-muted mb-3">
          <summary>查看规则状态说明</summary>
          <p>
            仅测试方案的原始状态为 <code>rule_status=test</code>；依据不足的登记保持
            <code>decline</code>，不会猜成生产规则。
          </p>
        </details>
        <h3>最近一次转换</h3>
        <JobStatusPanel
          v-if="schemeJobTarget"
          label="拼音转换"
          kind="conversion"
          :observation="schemeObservation"
          @retry="retrySchemeJob"
        />
        <p v-else class="text-muted">还没有跑过转换。</p>
        <template v-if="schemeJob">
          <p class="text-sm text-muted">
            状态：{{ conversionJobStatusLabel(schemeJob.status) }} · 规则版本
            {{ schemeJob.rule_version }} · 方案 {{ schemeJob.source_scheme }} →
            {{ schemeJob.canonical_scheme }}
          </p>
          <div class="flex gap-2 items-center mb-2">
            <span v-for="line in schemeSummary" :key="line.key" class="badge"
              >{{ line.label }} · {{ line.count }}</span
            >
          </div>
          <p v-if="schemeJob.error_message" class="alert alert-error" role="alert">
            {{ schemeJob.error_message }}
          </p>
        </template>

        <AppButton
          v-if="reviewTotalItems"
          type="button"
          variant="secondary"
          class="mt-3"
          @click="setView('review')"
        >
          处理 {{ reviewTotalItems }} 条待复核记音
        </AppButton>
      </section>
      <section v-show="schemeView === 'review'" aria-label="归一复核工作区">
        <h3>复核队列</h3>
        <p class="text-muted">
          这些条目机器判不出来——要么规则给出多个候选（需人工确认），要么规则根本接不住（暂未支持）——
          需要人给出统一方案的写法。结论会记下判定人与依据，重跑时保留，不会被下一次批处理推回机器判断。
        </p>
        <div class="flex gap-2 items-center mb-2" role="group" aria-label="复核队列状态筛选">
          <AppButton
            type="button"
            size="sm"
            :variant="reviewStatusFilter === 'all' ? 'primary' : 'secondary'"
            @click="setReviewFilter('all')"
          >
            全部待复核
          </AppButton>
          <AppButton
            type="button"
            size="sm"
            :variant="reviewStatusFilter === 'AMBIGUOUS' ? 'primary' : 'secondary'"
            @click="setReviewFilter('AMBIGUOUS')"
          >
            需人工确认
          </AppButton>
          <AppButton
            type="button"
            size="sm"
            :variant="reviewStatusFilter === 'UNSUPPORTED' ? 'primary' : 'secondary'"
            @click="setReviewFilter('UNSUPPORTED')"
          >
            暂未支持
          </AppButton>
        </div>
        <details v-if="offPageDrafts.length" class="mb-3">
          <summary>查看暂不在本页的工作区草稿（{{ offPageDrafts.length }}）</summary>
          <div v-for="old in offPageDrafts" :key="old.id">
            <p>
              原值：{{ old.context?.source }} · {{ old.context?.sourceScheme }} →
              {{ old.context?.targetScheme }} · 规则 {{ old.context?.ruleVersion }} / schema
              {{ old.context?.schemaVersion }}
            </p>
            <p>旧写法：{{ old.canonical }}；旧依据：{{ old.basis }}</p>
            <p v-for="(entry, index) in old.history" :key="index">
              此前草稿 {{ entry.context?.source }}：{{ entry.canonical }}；{{ entry.basis }}
            </p>
            <p>
              草稿只供查看；返回对应条目并核对当前依据后才能提交。关闭此工作区前请自行保留需要的文字。
            </p>
          </div>
        </details>
        <p v-if="!reviewRows.length" class="text-muted">{{ reviewEmptyMessage }}</p>
        <template v-else>
          <p class="text-sm text-muted">共 {{ reviewTotalItems }} 条待复核。</p>
          <div class="scheme-queue-layout">
            <nav class="scheme-queue" aria-label="选择复核条目">
              <AppButton
                v-for="row in reviewRows"
                :key="row.id"
                type="button"
                :aria-current="selectedReviewRows[0]?.id === row.id ? 'page' : undefined"
                @click="selectedReviewId = row.id"
              >
                <strong>第 {{ row.page_number }} 条</strong
                ><span>{{ normalizationStatusLabel(row.normalization_status) }}</span
                ><small>{{ row.source_pronunciation || '（空）' }}</small>
              </AppButton>
            </nav>
            <ul class="assist-list scheme-active-review">
              <li v-for="row in selectedReviewRows" :key="row.id" class="assist-row">
                <div>
                  <strong>第 {{ row.page_number }} 条</strong>
                  <span :class="normalizationBadgeClass(row.normalization_status)">
                    {{ normalizationStatusLabel(row.normalization_status) }}
                  </span>
                  <p class="text-sm">
                    原值（转换时）：<code>{{ row.source_pronunciation || '（空）' }}</code>
                  </p>
                  <p class="text-sm text-muted">
                    当前依据：{{ row.normalization_source_column || '记音' }}字段 · 规则版本
                    {{ row.normalization_rule_version || '未记录' }}
                  </p>
                  <details class="scheme-rule-details">
                    <summary>查看方案与规则依据</summary>
                    <p class="text-sm">
                      {{ row.source_scheme_id || '未记录来源方案' }} →
                      {{ row.canonical_scheme_id || '未记录目标方案' }}
                    </p>
                    <p v-if="row.normalization_trace.length" class="text-sm text-muted">
                      经过规则：{{ row.normalization_trace.join(' → ') }}
                    </p>
                  </details>
                  <p v-if="row.candidates.length" class="text-sm text-muted">
                    候选：{{ row.candidates.join(' / ') }}
                  </p>
                  <div v-if="reviewDraft[row.id].stale" class="alert alert-warning" role="alert">
                    <strong>复核依据已变化，旧草稿不能直接提交。</strong>
                    <p>
                      来源、方案或规则版本变化后，须重新核对并填写当前结论与依据；旧稿只供查看，不会自动套用。
                    </p>
                    <p v-if="row.source_changed">
                      当前来源读音或记音列已变化，请先重跑转换，再刷新本队列。
                    </p>
                    <p v-if="reviewDraft[row.id].requiresReload">
                      当前依据尚未重新加载成功，请先刷新队列；旧稿保留，只供查看。
                    </p>
                    <AppButton
                      type="button"
                      variant="secondary"
                      size="sm"
                      :disabled="
                        reviewBusy ||
                        reviewDraft[row.id].requiresReload ||
                        row.source_changed ||
                        !row.expected_basis
                      "
                      @click="restartReview(row)"
                    >
                      按当前依据重新填写
                    </AppButton>
                  </div>
                  <details v-if="reviewDraft[row.id].history.length" class="mb-3">
                    <summary>查看旧草稿（{{ reviewDraft[row.id].history.length }}）</summary>
                    <div v-for="(old, index) in reviewDraft[row.id].history" :key="index">
                      <p>
                        原值：{{ old.context?.source }} · {{ old.context?.sourceScheme }} →
                        {{ old.context?.targetScheme }} · 规则 {{ old.context?.ruleVersion }} /
                        schema
                        {{ old.context?.schemaVersion }}
                      </p>
                      <p>旧写法：{{ old.canonical }}；旧依据：{{ old.basis }}</p>
                    </div>
                  </details>
                  <AppField class="admin-filter-field"
                    ><template #label>统一方案的写法</template>
                    <input
                      v-model="reviewDraft[row.id].canonical"
                      class="form-control"
                      :disabled="reviewBusy || reviewDraft[row.id].stale"
                    />
                  </AppField>
                  <AppField class="admin-filter-field"
                    ><template #label>依据（必填）</template>
                    <input
                      v-model="reviewDraft[row.id].basis"
                      class="form-control"
                      maxlength="500"
                      :disabled="reviewBusy || reviewDraft[row.id].stale"
                    />
                  </AppField>
                  <AppButton
                    type="button"
                    variant="primary"
                    size="sm"
                    :disabled="reviewBusy || !canSubmitNormalizationDraft(reviewDraft[row.id], row)"
                    @click="saveReview(row)"
                  >
                    确认结论
                  </AppButton>
                </div>
              </li>
            </ul>
          </div>
          <!-- 队列也要能翻页：一次转换动辄留下几十上百条待复核，只给前 10 条会让
               管理员以为「队列就这么长」，而剩下的那些没有任何入口能看到。 -->
          <AppPagination
            v-if="reviewTotalPages > 1"
            :page="reviewPage"
            :total-pages="reviewTotalPages"
            label="复核队列分页"
            button-class="btn btn-secondary btn-sm"
            @change="gotoReviewPage"
          />
        </template>
      </section>
    </template>
  </section>
</template>

<script setup>
import AppButton from '@/components/AppButton.vue'
import AppPagination from '@/components/AppPagination.vue'
import AppField from '@/components/AppField.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import JobStatusPanel from '@/components/admin/project/JobStatusPanel.vue'
import { useJobObserver } from '@/composables/useJobObserver'
import {
  decideNormalization,
  listConversions,
  getConversion,
  listNormalizations,
  listSchemeAdapters,
  startConversion
} from '@/services/schemeConversionService'
import {
  adapterNotice,
  conversionJobStatusLabel,
  conversionSummaryLines,
  normalizationBadgeClass,
  normalizationStatusLabel,
  schemeOptionLabel,
  testOnlySchemeIds
} from '@/lib/schemeConversion'
import { getPbMessage } from '@/utils/pbErrors'
import {
  reconcileNormalizationDraft,
  canSubmitNormalizationDraft,
  restartNormalizationDraft
} from '@/lib/normalizationDraft'
const props = defineProps({
  projectId: { type: String, required: true },
  initialView: { type: String, default: 'jobs' }
})
const projectId = props.projectId
const schemeSection = ref(null)
const schemeView = ref(props.initialView || 'jobs')
const selectedReviewId = ref('')
function setView(value) {
  if (['jobs', 'review'].includes(value)) schemeView.value = value
}

const schemeOptions = ref([])

const schemeNotice = ref('')

const schemeSourceId = ref('')

const schemeJobTarget = ref(null)
const {
  snapshot: schemeJob,
  observation: schemeObservation,
  retry: retrySchemeJob,
  seed: seedSchemeJob
} = useJobObserver({
  projectId: () => props.projectId,
  kind: 'conversion',
  job: schemeJobTarget,
  panel: schemeSection,
  read: (jobId, options) => getConversion(props.projectId, jobId, options)
})

const schemeBusy = ref(false)

const schemeError = ref('')

const schemeSuccess = ref('')

const schemeLoading = ref(false)

const schemeLoaded = ref(false)

let schemeObserver

const reviewRows = ref([])
const selectedReviewRows = computed(() => {
  const current =
    reviewRows.value.find((row) => row.id === selectedReviewId.value) || reviewRows.value[0]
  return current ? [current] : []
})

const reviewDraft = ref({})

const offPageDrafts = computed(() =>
  Object.entries(reviewDraft.value)
    .filter(
      ([id, draft]) =>
        !reviewRows.value.some((row) => row.id === id) &&
        (draft.canonical || draft.basis || draft.history?.length)
    )
    .map(([id, draft]) => ({ id, ...draft }))
)
const reviewBusy = ref(false)

const reviewPage = ref(1)

const reviewTotalItems = ref(0)

const reviewTotalPages = ref(1)

const reviewStatusFilter = ref('all')

const reviewEmptyMessage = computed(() => {
  if (reviewStatusFilter.value === 'UNSUPPORTED') return '当前没有「暂未支持」的条目。'
  if (reviewStatusFilter.value === 'AMBIGUOUS') return '当前没有「需人工确认」的条目。'
  return '当前没有待复核的条目。'
})

let reviewGeneration = 0
let disposed = false

const schemeSummary = computed(() => conversionSummaryLines(schemeJob.value))

const testOnlySchemes = computed(() => testOnlySchemeIds(schemeOptions.value))

watch(
  () => [schemeJob.value?.id, schemeJob.value?.status],
  ([id, status], previous) => {
    if (
      id &&
      ['completed', 'completed_with_errors'].includes(status) &&
      (id !== previous?.[0] || status !== previous?.[1])
    ) {
      void loadReviews().catch((error) => {
        if (!disposed)
          schemeError.value = getPbMessage(error, '转换已完成，复核队列暂时无法读取，请刷新重试。')
      })
    }
  }
)

async function loadReviews() {
  const generation = ++reviewGeneration
  const status =
    reviewStatusFilter.value === 'all' ? 'AMBIGUOUS,UNSUPPORTED' : reviewStatusFilter.value
  const queue = await listNormalizations(projectId, { status, perPage: 10, page: reviewPage.value })
  if (disposed || generation !== reviewGeneration) return
  reviewRows.value = queue.items || []
  if (!reviewRows.value.some((row) => row.id === selectedReviewId.value))
    selectedReviewId.value = reviewRows.value[0]?.id || ''
  reviewTotalItems.value = queue.totalItems || 0
  reviewTotalPages.value = queue.totalPages || 1
  // 服务端会把越界的 page 夹回最后一页，这里跟回去：不复写的话，界面上写的是
  // 「第 3 / 2 页」而列表是第 2 页的内容——复核一条少一条时很容易走到这里。
  reviewPage.value = queue.page || 1
  // 草稿按条目 id 存：刷新后原来的输入不该串到别的条目上。
  for (const row of reviewRows.value)
    reviewDraft.value[row.id] = reconcileNormalizationDraft(reviewDraft.value[row.id], row)
}

async function setReviewFilter(value) {
  if (reviewStatusFilter.value === value) return
  reviewStatusFilter.value = value
  // 换了筛选条件就是换了一份清单，页码必须从头开始。
  reviewPage.value = 1
  try {
    await loadReviews()
  } catch (e) {
    schemeError.value = getPbMessage(e, '复核队列加载失败。')
  }
}

async function gotoReviewPage(page) {
  if (page < 1 || page > reviewTotalPages.value) return
  reviewPage.value = page
  try {
    await loadReviews()
  } catch (e) {
    schemeError.value = getPbMessage(e, '复核队列加载失败。')
  }
}

async function loadSchemeState() {
  if (schemeLoading.value) return
  schemeLoading.value = true
  schemeError.value = ''
  try {
    const [adapters, conversions] = await Promise.all([
      listSchemeAdapters(),
      schemeJobTarget.value?.id
        ? getConversion(projectId, schemeJobTarget.value.id).then((job) => ({ items: [job] }))
        : listConversions(projectId),
      loadReviews()
    ])
    schemeOptions.value = adapters.schemes || []
    schemeNotice.value = adapterNotice(adapters)
    if (disposed) return
    schemeJobTarget.value = (conversions.items || [])[0] || null
    if (schemeJobTarget.value) seedSchemeJob(schemeJobTarget.value)
  } catch (e) {
    schemeError.value = getPbMessage(e, '拼音归一状态加载失败。')
  } finally {
    schemeLoaded.value = true
    schemeLoading.value = false
  }
}

function setupSchemeObserver() {
  if (!schemeSection.value || schemeObserver || schemeLoaded.value || schemeLoading.value) return
  if (typeof IntersectionObserver === 'undefined') {
    loadSchemeState()
    return
  }
  schemeObserver = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      schemeObserver?.disconnect()
      if (!schemeLoaded.value) loadSchemeState()
    },
    { rootMargin: '240px' }
  )
  schemeObserver.observe(schemeSection.value)
}

async function runConversion() {
  schemeBusy.value = true
  schemeError.value = ''
  schemeSuccess.value = ''
  try {
    const job = await startConversion(projectId, schemeSourceId.value)
    if (disposed) return
    schemeJobTarget.value = job
    seedSchemeJob(job)
    // 新作业会把队列重造一遍，退回第一页：留在第三页看一份已经被换掉的清单，
    // 翻页控件上的「第 3 / 5 页」就成了一句没人能核对的话。
    reviewPage.value = 1
    schemeSuccess.value = '转换作业已排队，完成后这里会显示汇总。'
  } catch (e) {
    schemeError.value = getPbMessage(e, '发起转换失败，请稍后重试。')
  } finally {
    schemeBusy.value = false
  }
}

let reviewSaveGeneration = 0
function restartReview(row) {
  restartNormalizationDraft(reviewDraft.value[row.id], row)
}
async function saveReview(row) {
  const draft = reviewDraft.value[row.id]
  if (reviewBusy.value || !canSubmitNormalizationDraft(draft, row)) return
  const generation = ++reviewSaveGeneration
  const expectedBasis = draft.expectedBasis
  const isCurrent = () =>
    !disposed &&
    generation === reviewSaveGeneration &&
    reviewDraft.value[row.id] === draft &&
    draft.expectedBasis === expectedBasis &&
    reviewRows.value.some((item) => item.id === row.id && item.expected_basis === expectedBasis)
  reviewBusy.value = true
  schemeError.value = ''
  schemeSuccess.value = ''
  try {
    await decideNormalization(row.id, {
      canonical: draft.canonical.trim(),
      basis: draft.basis.trim(),
      expectedBasis
    })
    if (!isCurrent()) return
    schemeSuccess.value = `第 ${row.page_number} 条已记为「已复核」，重跑时不会被推回机器判断。`
    await loadReviews()
  } catch (e) {
    if (!isCurrent()) return
    schemeError.value = getPbMessage(e, '保存人工结论失败。')
    if (Number(e?.status || e?.response?.status) === 409) {
      draft.stale = true
      draft.requiresReload = true
      // Keep the draft visible in history even if the server's new context
      // cannot currently be fetched. A failed refresh never makes it writable.
      try {
        await loadReviews()
      } catch {
        /* explicit refresh remains available */
      }
    }
  } finally {
    if (!disposed && generation === reviewSaveGeneration) reviewBusy.value = false
  }
}

onBeforeUnmount(() => {
  disposed = true
  reviewGeneration += 1
  schemeObserver?.disconnect()
})
onMounted(setupSchemeObserver)
defineExpose({ setupSchemeObserver, setView })
</script>

<style scoped>
.scheme-view-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}
.scheme-tabs {
  display: flex;
  gap: var(--space-2);
}
.scheme-tabs button {
  min-height: 44px;
  padding: var(--space-2) var(--space-3);
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--gray-600);
  background: transparent;
  cursor: pointer;
  font: inherit;
}
.scheme-tabs [aria-current='page'] {
  color: var(--primary);
  border-bottom-color: var(--primary);
  font-weight: 600;
}
.scheme-queue-layout {
  display: grid;
  grid-template-columns: minmax(180px, 230px) minmax(0, 1fr);
  gap: var(--space-4);
  margin: var(--space-3) 0;
}
.scheme-queue {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  max-height: 36rem;
  overflow-y: auto;
}
.scheme-queue button {
  display: grid;
  gap: var(--space-1);
  text-align: left;
  padding: var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--ink);
  cursor: pointer;
  font: inherit;
}
.scheme-queue button[aria-current='page'] {
  border-color: var(--primary);
  background: var(--primary-light);
}
.scheme-queue span,
.scheme-queue small {
  color: var(--gray-600);
  overflow-wrap: anywhere;
}
.scheme-active-review {
  margin: 0;
  min-width: 0;
}
.scheme-active-review .assist-row {
  margin: 0;
  padding: var(--space-3);
}
.scheme-active-review .form-control {
  font-family: var(--font-rare), var(--font-ui);
  font-size: var(--text-lg);
  line-height: 1.6;
}
.scheme-rule-details {
  margin: var(--space-2) 0;
  font-size: var(--text-sm);
  color: var(--gray-600);
}
@media (max-width: 768px) {
  .scheme-queue-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .scheme-queue {
    flex-direction: row;
    max-height: none;
    overflow-x: auto;
  }
  .scheme-queue button {
    min-width: 140px;
  }
}
</style>
