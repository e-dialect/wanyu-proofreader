import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { pendingReportExport, reportId } from '@/lib/batchReport'
import {
  createBatchReportExport,
  downloadBatchReportArtifact,
  getBatchReportExport,
  listBatchReportExports
} from '@/services/batchReportService'
import { getPbMessage, getPbStatus } from '@/utils/pbErrors'

export function useBatchReportExports(projectId, batchId, scope) {
  const route = useRoute()
  const router = useRouter()
  const selectedId = computed(() => reportId(route.query.export))
  const selected = ref(null)
  const selectedLoading = ref(false)
  const selectedError = ref('')
  const history = ref(null)
  const historyPage = ref(1)
  const historyLoading = ref(false)
  const historyError = ref('')
  const actionError = ref('')
  const creating = ref(false)
  const downloading = ref('')
  let readRequest
  let historyRequest
  let timer

  const historyPending = computed(() => history.value?.items.find(pendingReportExport))
  const generationPending = computed(
    () => pendingReportExport(selected.value) || !!historyPending.value
  )

  function stopRead() {
    clearTimeout(timer)
    readRequest?.cancel()
  }
  onBeforeUnmount(stopRead)
  function clear() {
    stopRead()
    selected.value = history.value = null
    selectedLoading.value = historyLoading.value = creating.value = false
    downloading.value = ''
    selectedError.value = historyError.value = actionError.value = ''
  }

  async function loadHistory(page = historyPage.value) {
    if (scope.accessLost.value) return
    historyRequest?.cancel()
    const request = scope.capture()
    historyRequest = request
    historyLoading.value = true
    historyError.value = ''
    try {
      const result = await listBatchReportExports(projectId, batchId, page, request.signal)
      if (!request.isCurrent()) return
      history.value = result
      historyPage.value = page
    } catch (error) {
      if (request.isCurrent() && !scope.invalidate(error, request))
        historyError.value = getPbMessage(error, '历史报告暂时无法读取。')
    } finally {
      if (request.isCurrent()) historyLoading.value = false
      request.finish()
    }
  }

  function historyTarget(id) {
    return { path: route.path, query: { ...route.query, export: id }, hash: route.hash }
  }

  async function readSelected(showLoading = true) {
    stopRead()
    const id = selectedId.value
    if (!id || scope.accessLost.value) return
    const request = scope.capture()
    readRequest = request
    selectedLoading.value = showLoading
    selectedError.value = ''
    try {
      const item = await getBatchReportExport(id, request.signal)
      if (!request.isCurrent()) return
      if (item.id !== id || item.project_id !== projectId || item.import_job !== batchId) {
        selectedError.value = '这份历史报告不属于当前批次。'
        return
      }
      const wasPending = pendingReportExport(selected.value)
      selected.value = item
      if (pendingReportExport(item)) timer = setTimeout(() => readSelected(false), 1500)
      else if (wasPending) void loadHistory()
    } catch (error) {
      if (!request.isCurrent() || scope.invalidate(error, request)) return
      selectedError.value =
        getPbStatus(error) === 404
          ? '找不到这份历史报告，请从列表重新打开。'
          : getPbMessage(error, '暂时无法读取报告生成状态。')
    } finally {
      if (request.isCurrent()) selectedLoading.value = false
      request.finish()
    }
  }

  watch(
    () => route.query.export,
    (value) => {
      stopRead()
      selected.value = null
      selectedError.value = value !== undefined && !selectedId.value ? '历史报告链接无效。' : ''
      selectedLoading.value = false
      if (selectedId.value) void readSelected()
    },
    { immediate: true }
  )

  async function generate() {
    if (creating.value || generationPending.value || scope.accessLost.value) return
    creating.value = true
    actionError.value = ''
    const request = scope.capture()
    try {
      const item = await createBatchReportExport(projectId, batchId, request.signal)
      if (!request.isCurrent()) return
      if (!reportId(item?.id)) throw new Error('未收到报告记录，请先刷新历史列表。')
      await router.replace(historyTarget(item.id))
      if (!request.isCurrent()) return
      if (!selected.value && pendingReportExport(item)) selected.value = item
      void loadHistory(1)
    } catch (error) {
      if (!request.isCurrent() || scope.invalidate(error, request)) return
      actionError.value = getPbMessage(error, '无法生成报告，请刷新历史后重试。')
      void loadHistory(1)
    } finally {
      if (request.isCurrent()) creating.value = false
      request.finish()
    }
  }

  async function download(kind) {
    const item = selected.value
    const id = reportId(item?.artifacts?.[kind]?.id)
    if (item?.status !== 'completed' || !id || downloading.value || selectedError.value) return
    downloading.value = kind
    actionError.value = ''
    const request = scope.capture()
    try {
      await downloadBatchReportArtifact(id, `wanyu-batch-${batchId}-${item.id}.${kind}`, {
        signal: request.signal,
        isCurrent: () => request.isCurrent() && selectedId.value === item.id
      })
    } catch (error) {
      if (!request.isCurrent() || scope.invalidate(error, request)) return
      if (selectedId.value === item.id)
        actionError.value = getPbMessage(error, '下载失败，请重试。')
    } finally {
      if (request.isCurrent()) downloading.value = ''
      request.finish()
    }
  }

  return {
    selectedId,
    selected,
    selectedLoading,
    selectedError,
    history,
    historyPage,
    historyLoading,
    historyError,
    historyPending,
    generationPending,
    actionError,
    creating,
    downloading,
    clear,
    loadHistory,
    readSelected,
    historyTarget,
    generate,
    download
  }
}
