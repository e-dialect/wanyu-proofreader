import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'

const source = readFileSync(new URL('../src/components/editor/PdfSinglePageViewer.vue', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')
const script = source.match(/<script setup>\n([\s\S]*?)\n<\/script>/)[1]
  .replace(/^import .* from 'vue'\n/m, '')

// Run the actual component setup with Vue reactivity; the browser suite covers
// DOM retention for both the image and canvas paths.
function fixture(t) {
  const props = reactive({ src: '', pageImage: null, watermarkUserId: '', watermarkProjectId: '', pageNumber: 1 })
  const document = { fullscreenElement: null, addEventListener() {}, removeEventListener() {} }
  const scope = effectScope()
  let unmount
  const bindings = {
    computed, nextTick, ref, watch, document, window: {},
    onMounted: callback => callback(),
    onBeforeUnmount: callback => { unmount = callback },
    defineProps: () => props,
    defineEmits: () => () => {},
    ResizeObserver: class { observe() {} disconnect() {} }
  }
  const state = scope.run(() => new Function(...Object.keys(bindings), `${script}\nreturn { viewerRef, wrapRef, error, fullscreenError, zoom, rotation, isFullscreen, toggleFullscreen, syncFullscreenState }`)(...Object.values(bindings)))
  const viewer = {}
  state.viewerRef.value = viewer
  t.after(async () => { await unmount(); scope.stop() })
  return { ...state, props, document, viewer }
}

test('denied entry keeps the fatal error channel and reading state intact', async t => {
  const ui = fixture(t)
  ui.viewer.requestFullscreen = async () => { throw new Error('denied') }
  ui.zoom.value = 1.5
  ui.rotation.value = 90
  const originalWrap = { scrollTop: 90, scrollLeft: 12 }
  ui.wrapRef.value = originalWrap
  await ui.toggleFullscreen()
  assert.match(ui.fullscreenError.value, /未允许进入全屏.*重试/)
  assert.equal(ui.error.value, '')
  assert.equal(ui.zoom.value, 1.5)
  assert.equal(ui.rotation.value, 90)
  assert.equal(ui.wrapRef.value.scrollTop, 90)
  assert.equal(ui.wrapRef.value.scrollLeft, 12)
})

test('unavailable fullscreen API reports a recoverable notice', async t => {
  const ui = fixture(t)
  await ui.toggleFullscreen()
  assert.match(ui.fullscreenError.value, /未允许进入全屏/)
  assert.equal(ui.error.value, '')
})

test('entry and exit retries clear the notice without clearing a fatal PDF error', async t => {
  const ui = fixture(t)
  ui.error.value = 'PDF 加载失败'
  ui.fullscreenError.value = 'previous attempt'
  ui.viewer.requestFullscreen = async () => {
    assert.equal(ui.fullscreenError.value, '')
    ui.document.fullscreenElement = ui.viewerRef.value
    ui.syncFullscreenState()
  }
  await ui.toggleFullscreen()
  assert.equal(ui.isFullscreen.value, true)
  assert.equal(ui.fullscreenError.value, '')
  ui.document.exitFullscreen = async () => { throw new Error('denied') }
  await ui.toggleFullscreen()
  assert.match(ui.fullscreenError.value, /未允许退出全屏.*重试/)
  assert.equal(ui.isFullscreen.value, true)
  ui.document.exitFullscreen = async () => {
    assert.equal(ui.fullscreenError.value, '')
    ui.document.fullscreenElement = null
    ui.syncFullscreenState()
  }
  await ui.toggleFullscreen()
  assert.equal(ui.isFullscreen.value, false)
  assert.equal(ui.fullscreenError.value, '')
  assert.equal(ui.error.value, 'PDF 加载失败')
})

test('loading a new source clears the fullscreen notice', async t => {
  const ui = fixture(t)
  ui.fullscreenError.value = 'previous attempt'
  ui.props.pageImage = { width: 100, height: 200 }
  ui.props.src = 'blob:new-source'
  await nextTick()
  assert.equal(ui.fullscreenError.value, '')
})

test('a late rejection from the previous source cannot restore its notice', async t => {
  const ui = fixture(t)
  let reject
  ui.viewer.requestFullscreen = () => new Promise((_resolve, rejectRequest) => { reject = rejectRequest })
  const pending = ui.toggleFullscreen()
  ui.props.pageImage = { width: 100, height: 200 }
  ui.props.src = 'blob:new-source'
  await nextTick()
  reject(new Error('old fullscreen request'))
  await pending
  assert.equal(ui.fullscreenError.value, '')
  assert.equal(ui.error.value, '')
})
