import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { createPdfPreviewCache } from '@/lib/pdfPreviewCache'
import { createPageImageCache } from '@/lib/pageImageCache'
import { matchingSourceRegion, parseSourceRegion } from '@/lib/sourceRegion'
import { missingPdfPageNotice } from '@/lib/proofreadNotices'
import pb from '@/lib/pocketbase'

const MAX_TIMER_DELAY = 2 ** 31 - 1

export function useProjectPdf(page) {
  const pdfError = ref('')
  const pdfLoading = ref(false)
  const currentPdfPage = ref(1)
  const firstPage = ref(1)
  const lastPage = ref(1)
  const totalPdfPages = ref(0)
  const pdfUrl = ref(null)
  const pdfViewerKey = ref('')
  const cache = createPdfPreviewCache()
  const imageCache = createPageImageCache()
  const pageImage = ref(null)
  const entryRegion = ref(null)
  const assetRegion = ref(null)
  const imageMode = ref(false)
  let imageGeneration = 0
  let displayedImagePage = 0
  let expiryTimer = null
  let displayedExpiry = 0
  let previewKey = ''
  let displayedEntryId = ''
  let currentUser = pb.authStore.record?.id || pb.authStore.model?.id || ''
  const unsubscribe = pb.authStore.onChange((_token, record) => {
    if (!record || record.id !== currentUser) resetPdf()
    currentUser = record?.id || ''
  })
  onBeforeUnmount(() => {
    unsubscribe()
    resetPdf()
  })
  let generation = 0
  let controller = null
  const basePdfPage = computed(
    () => Number(page.value?.pdf_page) || Number(page.value?.page_number) || 1
  )
  const pdfPageWarning = computed(() => missingPdfPageNotice(page.value))
  const allowedPdfPages = computed(() => [firstPage.value, lastPage.value])
  const localPdfPage = computed(() => currentPdfPage.value - firstPage.value + 1)

  function discardPreview() {
    cache.clear()
    imageCache.clear()
    displayedExpiry = 0
    previewKey = ''
    pdfViewerKey.value = ''
    imageMode.value = false
    displayedImagePage = 0
    displayedEntryId = ''
    entryRegion.value = assetRegion.value = null
    pageImage.value = null
    pdfUrl.value = null
  }
  function resetPdf() {
    generation++
    controller?.abort()
    imageGeneration++
    clearTimeout(expiryTimer)
    discardPreview()
    pdfError.value = ''
    pdfLoading.value = false
    firstPage.value = lastPage.value = basePdfPage.value
    totalPdfPages.value = 0
    currentPdfPage.value = basePdfPage.value
  }
  function applyDescriptor(descriptor, number) {
    if (previewKey !== descriptor.key) pdfViewerKey.value = descriptor.key
    previewKey = descriptor.key
    firstPage.value = descriptor.start
    lastPage.value = descriptor.end
    totalPdfPages.value = descriptor.total
    currentPdfPage.value = clampPdfPage(number)
  }
  async function resolveProjectPdf(forcePdf = false) {
    const pageId = page.value?.id
    if (!pageId) {
      resetPdf()
      return
    }
    const request = ++generation
    const isCurrent = () => request === generation && page.value?.id === pageId
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal
    const userId = currentUser
    pdfLoading.value = true
    pdfError.value = ''
    imageMode.value = false
    imageGeneration++
    clearTimeout(expiryTimer)
    if (displayedExpiry && displayedExpiry <= Date.now()) {
      // Keep the hidden viewer mounted for its reading position. Expired
      // URLs must not be reusable while the new authorization is in flight.
      cache.clear()
      imageCache.clear()
    }
    try {
      const base = pb.buildURL(`/api/fangji/pages/${encodeURIComponent(pageId)}/pdf`)
      const options = { headers: { Authorization: pb.authStore.token }, signal, cache: 'no-store' }
      const info = await fetch(`${base}/descriptor`, options)
      if (!info.ok) {
        const body = await info.json().catch(() => ({}))
        throw new Error(body.message || '加载任务 PDF 失败')
      }
      let descriptor = assertValidDescriptor(await info.json())
      if (!isCurrent()) return
      if (previewKey && previewKey !== descriptor.key) discardPreview()
      const descriptorRegion = matchingSourceRegion(
        descriptor.sourceRegion,
        pageId,
        descriptor.start,
        descriptor.key
      )
      const previousPage = previewKey === descriptor.key ? currentPdfPage.value : descriptor.start
      const openEntryRegion = descriptorRegion && displayedEntryId !== pageId
      let shown = openEntryRegion ? descriptor.start : previousPage
      if (!forcePdf) {
        try {
          const imagesBase = base.replace(/\/pdf$/, '')
          let result = await imageCache.load(imagesBase, shown, options)
          if (!isCurrent()) return
          const region =
            shown === descriptor.start
              ? matchingSourceRegion(result.sourceRegion, pageId, shown, result.image.assetId)
              : null
          if (openEntryRegion && !region && shown !== previousPage) {
            shown = previousPage
            result = await imageCache.load(imagesBase, shown, options)
            if (!isCurrent()) return
          }
          const { image: entry } = result
          // A file can change between the PDF and image descriptor reads.
          // The image asset ID is stable for the same source and physical page.
          if (pageImage.value && pageImage.value.assetId !== entry.assetId) {
            pdfViewerKey.value = `${descriptor.key}:${entry.assetId}`
          }
          applyDescriptor(descriptor, shown)
          cache.clear()
          displayedImagePage = shown
          displayedEntryId = pageId
          entryRegion.value = shown === descriptor.start ? region : descriptorRegion
          assetRegion.value = region
          imageMode.value = true
          pageImage.value = entry
          pdfUrl.value = entry.url
          armExpiry(entry)
          preloadNeighbors(shown, options)
          return
        } catch (error) {
          if (error.name === 'AbortError') throw error
          if (!isCurrent()) return
          // Image URLs can expire at a bucket boundary. Recheck the protected
          // PDF endpoint before displaying fallback bytes after a denial.
          if (error.status === 401 || error.status === 403) cache.clear()
          // Image absence, expiry or rendering failure uses the existing PDF.
        }
      }
      let entry = cache.get(userId, descriptor)
      if (!entry) {
        const response = await fetch(base, options)
        if (!response.ok) {
          const body = await response.json().catch(() => ({}))
          throw new Error(body.message || '加载任务 PDF 失败')
        }
        const blob = await response.blob()
        if (!isCurrent()) return
        // The five-minute window or primary source can change between requests.
        descriptor = assertValidDescriptor({
          key: response.headers.get('X-PDF-Preview-Key'),
          expiresAt: response.headers.get('X-PDF-Expires-At'),
          start: Number(response.headers.get('X-PDF-Start-Page')),
          end: Number(response.headers.get('X-PDF-End-Page')),
          total: Number(response.headers.get('X-PDF-Total-Pages')),
          sourceRegion: parseSourceRegion(response.headers.get('X-PDF-Source-Region'))
        })
        entry = cache.put(userId, descriptor, blob)
      }
      const region = matchingSourceRegion(
        descriptor.sourceRegion,
        pageId,
        descriptor.start,
        descriptor.key
      )
      const targetPage =
        previewKey !== descriptor.key || (region && displayedEntryId !== pageId)
          ? descriptor.start
          : previousPage
      applyDescriptor(descriptor, targetPage)
      displayedEntryId = pageId
      entryRegion.value = assetRegion.value = region
      imageCache.clear()
      pageImage.value = null
      pdfUrl.value = entry.url
      armExpiry(entry)
    } catch (error) {
      if (isCurrent() && error.name !== 'AbortError') {
        discardPreview()
        pdfError.value = error.message || '加载任务 PDF 失败'
      }
    } finally {
      if (isCurrent()) pdfLoading.value = false
    }
  }
  function assertValidDescriptor(descriptor) {
    const { key, start, end, total, expiresAt } = descriptor || {}
    if (
      !key ||
      ![start, end, total].every(Number.isInteger) ||
      start < 1 ||
      end < start ||
      total < end ||
      !(Date.parse(expiresAt) > Date.now())
    )
      throw new Error('PDF 预览信息无效，请刷新后重试')
    return descriptor
  }
  function clampPdfPage(value) {
    return Math.max(firstPage.value, Math.min(lastPage.value, Number(value) || firstPage.value))
  }
  function switchPdfPage(delta) {
    currentPdfPage.value = clampPdfPage(currentPdfPage.value + delta)
  }
  function imageBase() {
    return pb.buildURL(`/api/fangji/pages/${encodeURIComponent(page.value.id)}`)
  }
  function armExpiry(entry) {
    clearTimeout(expiryTimer)
    displayedExpiry = entry.expires
    expiryTimer = setTimeout(
      () => {
        if (entry.expires > Date.now()) armExpiry(entry)
        else resolveProjectPdf(!imageMode.value)
      },
      Math.min(MAX_TIMER_DELAY, Math.max(0, entry.expires - Date.now()))
    )
  }
  function preloadNeighbors(number, options) {
    for (const adjacent of [number - 1, number + 1]) {
      if (adjacent >= firstPage.value && adjacent <= lastPage.value) {
        imageCache.load(imageBase(), adjacent, options).catch(() => {})
      }
    }
  }
  watch(currentPdfPage, async (number) => {
    if (!imageMode.value || number === displayedImagePage) return
    const request = generation
    const pageId = page.value?.id
    const imageRequest = ++imageGeneration
    const isCurrent = () =>
      request === generation && imageRequest === imageGeneration && page.value?.id === pageId
    pdfLoading.value = true
    displayedImagePage = 0
    assetRegion.value = null
    pageImage.value = null
    pdfUrl.value = null
    const options = {
      headers: { Authorization: pb.authStore.token },
      signal: controller.signal,
      cache: 'no-store'
    }
    try {
      const { image: entry, sourceRegion } = await imageCache.load(imageBase(), number, options)
      if (!isCurrent()) return
      displayedImagePage = number
      if (number === firstPage.value) {
        const region = matchingSourceRegion(sourceRegion, pageId, number, entry.assetId)
        entryRegion.value = assetRegion.value = region
      }
      pageImage.value = entry
      pdfUrl.value = entry.url
      armExpiry(entry)
      preloadNeighbors(number, options)
    } catch (error) {
      if (isCurrent() && error.name !== 'AbortError') await resolveProjectPdf(true)
    } finally {
      if (isCurrent()) pdfLoading.value = false
    }
  })
  function fallbackToPdf() {
    return resolveProjectPdf(true)
  }
  return {
    pdfLoading,
    pdfError,
    currentPdfPage,
    basePdfPage,
    pdfPageWarning,
    allowedPdfPages,
    pdfUrl,
    pdfViewerKey,
    localPdfPage,
    totalPdfPages,
    pageImage,
    entryRegion,
    assetRegion,
    fallbackToPdf,
    resetPdf,
    resolveProjectPdf,
    clampPdfPage,
    switchPdfPage
  }
}
