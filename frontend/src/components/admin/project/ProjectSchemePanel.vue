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
          机器判不出来的条目会进入下面的复核队列。
        </p>
      </div>
    </div>

    <div v-if="!schemeLoaded" class="skeleton-card" aria-label="正在加载拼音归一">
      <span class="skeleton-line skeleton-line--short" aria-hidden="true"></span>
      <span class="skeleton-line" aria-hidden="true"></span>
    </div>
    <p v-else-if="schemeNotice" class="alert alert-warning" role="alert">{{ schemeNotice }}</p>

    <template v-else>
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
        <button
          type="button"
          class="btn btn-primary"
          :disabled="schemeBusy || !schemeSourceId"
          @click="runConversion"
        >
          {{ schemeBusy ? '转换中…' : '生成统一拼音' }}
        </button>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="schemeBusy"
          @click="loadSchemeState"
        >
          刷新
        </button>
      </div>
      <!-- 规则文件自己声明了能不能跑真实作业。合成夹具在目录里是合法的一等公民
               （引擎需要它），但它建不出真实作业——这句话必须在按钮旁边说。 -->
      <p v-if="testOnlySchemes.length" class="text-sm text-muted">
        {{ testOnlySchemes.join('、') }}
        声明为「仅测试」（rule_status=test）：可以选中，但服务端会拒绝用它创建真实转换作业。
        依据不足的登记保持 decline，不会猜成生产规则。
      </p>
      <p v-if="schemeError" class="alert alert-error" role="alert">{{ schemeError }}</p>
      <p v-if="schemeSuccess" class="alert alert-success" role="status">{{ schemeSuccess }}</p>

      <h3>最近一次转换</h3>
      <p v-if="!schemeJob" class="text-muted">还没有跑过转换。</p>
      <template v-else>
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

      <h3>复核队列（机器判不出来）</h3>
      <p class="text-muted">
        这些条目机器判不出来——要么规则给出多个候选（需人工确认），要么规则根本接不住（暂未支持）——
        需要人给出统一方案的写法。结论会记下判定人与依据，重跑时保留，不会被下一次批处理推回机器判断。
      </p>
      <div class="flex gap-2 items-center mb-2" role="group" aria-label="复核队列状态筛选">
        <button
          type="button"
          class="btn btn-sm"
          :class="reviewStatusFilter === 'all' ? 'btn-primary' : 'btn-secondary'"
          @click="setReviewFilter('all')"
        >
          全部待复核
        </button>
        <button
          type="button"
          class="btn btn-sm"
          :class="reviewStatusFilter === 'AMBIGUOUS' ? 'btn-primary' : 'btn-secondary'"
          @click="setReviewFilter('AMBIGUOUS')"
        >
          需人工确认
        </button>
        <button
          type="button"
          class="btn btn-sm"
          :class="reviewStatusFilter === 'UNSUPPORTED' ? 'btn-primary' : 'btn-secondary'"
          @click="setReviewFilter('UNSUPPORTED')"
        >
          暂未支持
        </button>
      </div>
      <p v-if="!reviewRows.length" class="text-muted">{{ reviewEmptyMessage }}</p>
      <template v-else>
        <p class="text-sm text-muted">共 {{ reviewTotalItems }} 条待复核。</p>
        <ul class="assist-list">
          <li v-for="row in reviewRows" :key="row.id" class="assist-row">
            <div>
              <strong>第 {{ row.page_number }} 条</strong>
              <span :class="normalizationBadgeClass(row.normalization_status)">
                {{ normalizationStatusLabel(row.normalization_status) }}
              </span>
              <p class="text-sm">
                原值（转换时）：<code>{{ row.source_pronunciation || '（空）' }}</code>
              </p>
              <p v-if="row.normalization_trace.length" class="text-sm text-muted">
                经过规则：{{ row.normalization_trace.join(' → ') }}
              </p>
              <p v-if="row.candidates.length" class="text-sm text-muted">
                候选：{{ row.candidates.join(' / ') }}
              </p>
              <AppField class="admin-filter-field"
                ><template #label>统一方案的写法</template>
                <input v-model="reviewDraft[row.id].canonical" class="form-control" />
              </AppField>
              <AppField class="admin-filter-field"
                ><template #label>依据（必填）</template>
                <input v-model="reviewDraft[row.id].basis" class="form-control" maxlength="500" />
              </AppField>
              <button
                type="button"
                class="btn btn-primary btn-sm"
                :disabled="
                  reviewBusy ||
                  !reviewDraft[row.id].canonical.trim() ||
                  !reviewDraft[row.id].basis.trim()
                "
                @click="saveReview(row)"
              >
                确认结论
              </button>
            </div>
          </li>
        </ul>
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
    </template>
  </section>
</template>

<script setup>
import AppPagination from '@/components/AppPagination.vue'
import AppField from '@/components/AppField.vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import {
  decideNormalization,
  listConversions,
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
const props = defineProps({ projectId: { type: String, required: true } })
const projectId = props.projectId
const schemeSection = ref(null)

const schemeOptions = ref([])

const schemeNotice = ref('')

const schemeSourceId = ref('')

const schemeJob = ref(null)

const schemeBusy = ref(false)

const schemeError = ref('')

const schemeSuccess = ref('')

const schemeLoading = ref(false)

const schemeLoaded = ref(false)

let schemeObserver

const reviewRows = ref([])

const reviewDraft = ref({})

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

let schemePollGeneration = 0
let reviewGeneration = 0
let disposed = false

const schemeSummary = computed(() => conversionSummaryLines(schemeJob.value))

const testOnlySchemes = computed(() => testOnlySchemeIds(schemeOptions.value))

async function loadReviews() {
  const generation = ++reviewGeneration
  const status =
    reviewStatusFilter.value === 'all' ? 'AMBIGUOUS,UNSUPPORTED' : reviewStatusFilter.value
  const queue = await listNormalizations(projectId, { status, perPage: 10, page: reviewPage.value })
  if (disposed || generation !== reviewGeneration) return
  reviewRows.value = queue.items || []
  reviewTotalItems.value = queue.totalItems || 0
  reviewTotalPages.value = queue.totalPages || 1
  // 服务端会把越界的 page 夹回最后一页，这里跟回去：不复写的话，界面上写的是
  // 「第 3 / 2 页」而列表是第 2 页的内容——复核一条少一条时很容易走到这里。
  reviewPage.value = queue.page || 1
  // 草稿按条目 id 存：刷新后原来的输入不该串到别的条目上。
  reviewDraft.value = Object.fromEntries(
    reviewRows.value.map((row) => [
      row.id,
      reviewDraft.value[row.id] || { canonical: '', basis: '' }
    ])
  )
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
      listConversions(projectId),
      loadReviews()
    ])
    schemeOptions.value = adapters.schemes || []
    schemeNotice.value = adapterNotice(adapters)
    schemeJob.value = (conversions.items || [])[0] || null
  } catch (e) {
    schemeError.value = getPbMessage(e, '拼音归一状态加载失败。')
  } finally {
    schemeLoaded.value = true
    schemeLoading.value = false
  }
}

function setupSchemeObserver() {
  if (!schemeSection.value) return
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
    schemeJob.value = job
    // 新作业会把队列重造一遍，退回第一页：留在第三页看一份已经被换掉的清单，
    // 翻页控件上的「第 3 / 5 页」就成了一句没人能核对的话。
    reviewPage.value = 1
    schemeSuccess.value = '转换作业已排队，完成后这里会显示汇总。'
    pollConversion()
  } catch (e) {
    schemeError.value = getPbMessage(e, '发起转换失败，请稍后重试。')
  } finally {
    schemeBusy.value = false
  }
}

function pollConversion() {
  const generation = ++schemePollGeneration
  const tick = async () => {
    if (generation !== schemePollGeneration) return
    try {
      const conversions = await listConversions(projectId)
      if (disposed || generation !== schemePollGeneration) return
      const latest = (conversions.items || [])[0]
      if (latest) schemeJob.value = latest
      if (latest && ['queued', 'processing'].includes(latest.status)) {
        setTimeout(tick, 1500)
        return
      }
      await loadReviews()
    } catch {
      // 轮询失败不打扰用户：手动刷新能补上，报错反而会盖住上一次的成功提示。
    }
  }
  setTimeout(tick, 1500)
}

async function saveReview(row) {
  const draft = reviewDraft.value[row.id]
  if (!draft) return
  reviewBusy.value = true
  schemeError.value = ''
  schemeSuccess.value = ''
  try {
    await decideNormalization(row.id, {
      canonical: draft.canonical.trim(),
      basis: draft.basis.trim()
    })
    schemeSuccess.value = `第 ${row.page_number} 条已记为「已复核」，重跑时不会被推回机器判断。`
    await loadReviews()
  } catch (e) {
    schemeError.value = getPbMessage(e, '保存人工结论失败。')
  } finally {
    reviewBusy.value = false
  }
}
onBeforeUnmount(() => {
  disposed = true
  reviewGeneration += 1
  schemeObserver?.disconnect()
  schemePollGeneration += 1
})
defineExpose({ setupSchemeObserver })
</script>
