<template>
  <main class="container page workspace-page own-submissions">
    <header class="page-heading">
      <div>
        <RouterLink :to="hallTarget" class="own-submissions__back back-link">
          <AppIcon name="back" />返回我的任务
        </RouterLink>
        <h1>本人提交记录</h1>
        <p v-if="project" class="own-submissions__project">
          <strong>{{ project.name }}</strong>
          <ProjectPurposeBadge :purpose="project.purpose" />
        </p>
        <p>
          这里展示当前可回看的本人提交，内容只读。条目重新开始校对后，会在你再次提交后出现在列表中。
        </p>
      </div>
    </header>

    <div v-if="practice || context?.taskProject" class="own-submissions__links">
      <RouterLink v-if="practice" :to="practiceGuideTarget(practice)" class="back-link">
        返回练习步骤
      </RouterLink>
      <RouterLink :to="{ path: '/tasks', query: { view: 'reviewed' } }" class="back-link">
        查看全部项目
      </RouterLink>
    </div>

    <section class="card own-submissions__card" aria-labelledby="own-submissions-results">
      <div class="own-submissions__section-heading">
        <h2 id="own-submissions-results">已提交条目</h2>
        <span v-if="result" class="section-count">{{ result.total }} 条</span>
      </div>
      <form
        v-if="!accessLost && context"
        class="own-submissions__filters"
        role="search"
        @submit.prevent="applyNumber"
      >
        <AppField label="条目号">
          <input
            v-model="numberInput"
            inputmode="numeric"
            autocomplete="off"
            class="form-control"
            placeholder="输入条目号"
            :aria-invalid="filterError ? 'true' : undefined"
            :aria-describedby="filterError ? 'submission-number-error' : undefined"
            @input="filterError = ''"
          />
        </AppField>
        <AppButton type="submit" variant="primary">定位条目</AppButton>
        <AppButton
          v-if="numberInput || context?.number || invalidNumber"
          variant="ghost"
          @click="clearNumber"
        >
          清除
        </AppButton>
        <AppField label="排序" class="own-submissions__sort">
          <select
            class="form-control"
            :value="context?.sort || 'recent'"
            @change="changeSort($event.target.value)"
          >
            <option value="recent">最近提交</option>
            <option value="number">条目号从小到大</option>
          </select>
        </AppField>
      </form>
      <p v-if="filterError" id="submission-number-error" class="alert alert-warning" role="alert">
        {{ filterError }}
      </p>

      <AppStatusPanel
        v-if="error"
        state="error"
        :message="error"
        :retry-label="accessLost ? '' : '重新读取'"
        :busy="loading"
        @retry="load"
      />
      <AppStatusPanel v-else-if="loading" state="pending" message="正在读取本人提交记录…" />
      <AppStatusPanel
        v-else-if="result && !result.items.length"
        state="empty"
        reason="none"
        :message="
          context?.number
            ? `没有找到第 ${context.number} 条的本人提交记录。`
            : '这个项目暂时没有可回看的本人提交记录。'
        "
      />
      <ul v-else-if="result" class="own-submissions__list" aria-label="本人提交记录列表">
        <li v-for="entry in result.items" :key="entry.id" class="own-submissions__row">
          <div>
            <strong>{{ entryLabel(entry) }}</strong>
            <p class="text-sm text-muted">
              <time v-if="submissionTime(entry.submitted_at)" :datetime="entry.submitted_at">
                提交于 {{ submissionTime(entry.submitted_at) }}
              </time>
              <span v-else>提交时间未记录</span>
            </p>
          </div>
          <RouterLink
            :to="reviewTarget(entry.id)"
            :aria-label="`回看 ${entryLabel(entry)}`"
            class="btn btn-secondary btn-sm"
            >回看 <AppIcon name="arrow"
          /></RouterLink>
        </li>
      </ul>
      <AppPagination
        v-if="result && result.totalPages > 1"
        :page="result.page"
        :total-pages="result.totalPages"
        :busy="loading"
        label="本人提交记录分页"
        @change="changePage"
      />
    </section>
  </main>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import AppButton from '@/components/AppButton.vue'
import AppField from '@/components/AppField.vue'
import AppIcon from '@/components/AppIcon.vue'
import AppPagination from '@/components/AppPagination.vue'
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import ProjectPurposeBadge from '@/components/ProjectPurposeBadge.vue'
import { useProtectedPageScope } from '@/composables/useProtectedPageScope'
import { useQueueReturnPosition } from '@/composables/useQueueReturnPosition'
import {
  ownSubmissionNavigationQuery,
  ownSubmissionReturnTarget,
  readOwnSubmissionContext
} from '@/lib/ownSubmissionContext'
import {
  practiceGuideTarget,
  practiceNavigationQuery,
  readPracticeContext
} from '@/lib/practiceContext'
import { listReviewedProofreads } from '@/services/pagesService'
import { getPbStatus } from '@/utils/pbErrors'

const route = useRoute()
const router = useRouter()
const projectId = computed(() =>
  typeof route.params.projectId === 'string' ? route.params.projectId : ''
)
const context = computed(() =>
  readOwnSubmissionContext(
    {
      reviewProject: projectId.value,
      reviewPage: route.query.page,
      reviewNumber: route.query.number,
      reviewSort: route.query.sort,
      taskView: route.query.taskView,
      taskPage: route.query.taskPage,
      taskProject: route.query.taskProject
    },
    projectId.value
  )
)
const result = ref(null)
const project = ref(null)
const error = ref('')
const loading = ref(false)
useQueueReturnPosition(computed(() => !loading.value && Boolean(result.value)))
let loadedContext = null
const numberInput = ref('')
const filterError = ref('')
const invalidNumber = computed(() => route.query.number !== undefined && !context.value?.number)
const scope = useProtectedPageScope((status) => {
  result.value = project.value = null
  loadedContext = null
  loading.value = false
  error.value =
    status === 401 ? '登录状态已变化，请重新登录后查看。' : '你当前无法查看这个项目的提交记录。'
})
const { accessLost } = scope
const practiceCandidate = computed(() => {
  const value = readPracticeContext(route.query, projectId.value)
  return value?.role === 'proofreader' ? { ...value, step: 'reviewed' } : null
})
const practice = computed(() =>
  project.value?.id === projectId.value && project.value?.purpose === 'practice'
    ? practiceCandidate.value
    : null
)
const practiceQuery = computed(() =>
  practice.value ? practiceNavigationQuery(practice.value) : {}
)
const hallTarget = computed(() => {
  const value = context.value
  if (!value) return { path: '/tasks', query: { view: 'reviewed' } }
  return {
    path: '/tasks',
    query: {
      view: value.taskView,
      ...(value.taskPage > 1 ? { page: String(value.taskPage) } : {}),
      ...(value.taskProject ? { project: value.taskProject } : {}),
      ...practiceQuery.value
    }
  }
})
function entryLabel(entry) {
  return entry.page_number > 0 ? `第 ${entry.page_number} 条` : '条目号未记录'
}
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
function submissionTime(value) {
  const stamp = Date.parse(value)
  return Number.isFinite(stamp) ? dateFormat.format(stamp) : ''
}
function listTarget(patch) {
  const target = ownSubmissionReturnTarget({ ...context.value, ...patch })
  return { ...target, query: { ...target.query, ...practiceQuery.value } }
}
function reviewTarget(id) {
  return {
    path: `/tasks/${id}/edit`,
    query: {
      mode: 'review',
      ...ownSubmissionNavigationQuery(context.value),
      ...practiceQuery.value
    }
  }
}
function changePage(page) {
  return router.push(listTarget({ page }))
}
function changeSort(sort) {
  return router.push(listTarget({ page: 1, sort }))
}
function applyNumber() {
  const value = numberInput.value.trim()
  if (value && (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) {
    filterError.value = '请输入正整数条目号。'
    return
  }
  filterError.value = ''
  return router.push(listTarget({ number: value ? Number(value) : null, page: 1 }))
}
function clearNumber() {
  numberInput.value = filterError.value = ''
  return router.push(listTarget({ number: null, page: 1 }))
}

async function load() {
  if (accessLost.value) return
  scope.cancel()
  result.value = null
  loadedContext = null
  if (project.value?.id !== projectId.value) project.value = null
  loading.value = false
  error.value = ''
  const selected = context.value
  if (!selected) {
    error.value = '此项目链接无效，请返回我的任务。'
    return
  }
  if (invalidNumber.value) return
  const request = scope.capture()
  loading.value = true
  try {
    const data = await listReviewedProofreads(selected.projectId, {
      signal: request.signal,
      page: selected.page,
      perPage: 20,
      sort: selected.sort,
      number: selected.number || undefined
    })
    if (!request.isCurrent()) return
    if (data.project?.id !== selected.projectId) throw new Error('项目提交记录与当前项目不一致。')
    project.value = data.project
    result.value = data
    const page = Number.isSafeInteger(data.page) && data.page > 0 ? data.page : selected.page
    loadedContext = { ...selected, page }
    const canonical = listTarget({ page })
    if (router.resolve(canonical).fullPath !== route.fullPath) await router.replace(canonical)
  } catch (cause) {
    if (!request.isCurrent() || scope.invalidate(cause, request)) return
    if (getPbStatus(cause) === 404) {
      project.value = null
      error.value = '找不到这个项目的提交记录，请返回我的任务。'
    } else {
      error.value = '暂时无法读取提交记录，请重试。'
    }
  } finally {
    if (request.isCurrent()) loading.value = false
    request.finish()
  }
}
watch(
  [
    projectId,
    () => context.value?.page,
    () => context.value?.number,
    () => context.value?.sort,
    invalidNumber
  ],
  ([id, page, number, sort]) => {
    numberInput.value = typeof route.query.number === 'string' ? route.query.number : ''
    filterError.value = invalidNumber.value ? '链接中的条目号无效，请重新输入或清除。' : ''
    if (
      !invalidNumber.value &&
      result.value &&
      loadedContext?.projectId === id &&
      loadedContext.page === page &&
      loadedContext.number === number &&
      loadedContext.sort === sort
    )
      return
    void load()
  },
  { immediate: true }
)
</script>

<style scoped>
.own-submissions__back,
.own-submissions__project,
.own-submissions__links,
.own-submissions__section-heading,
.own-submissions__filters,
.own-submissions__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}
.own-submissions__back {
  width: fit-content;
  min-height: var(--control-height);
}
.own-submissions__project {
  color: var(--ink);
  overflow-wrap: anywhere;
}
.own-submissions__links {
  margin-bottom: var(--space-3);
}
.own-submissions__section-heading,
.own-submissions__row {
  justify-content: space-between;
}
.own-submissions__section-heading h2 {
  margin: 0;
  font-size: var(--text-lg);
}
.own-submissions__filters {
  align-items: flex-end;
  margin-block: var(--space-3);
}
.own-submissions__filters :deep(.form-group) {
  min-width: 0;
  margin: 0;
}
.own-submissions__sort {
  margin-inline-start: auto;
}
.own-submissions__list {
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--line);
}
.own-submissions__row {
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--line);
}
.own-submissions__row p {
  margin: 0;
}
@media (max-width: 600px) {
  .own-submissions__filters {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .own-submissions__filters .own-submissions__sort {
    grid-column: 1 / -1;
    margin-inline-start: 0;
  }
  .own-submissions__back,
  .own-submissions__links a,
  .own-submissions__row .btn,
  .own-submissions__filters .btn {
    min-height: var(--control-height-touch);
  }
}
</style>
