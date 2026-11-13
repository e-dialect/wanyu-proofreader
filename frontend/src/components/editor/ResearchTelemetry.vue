<template>
  <p v-if="session" ref="notice" class="text-sm text-muted" role="status">
    研究过程记录已启用。呈现不代表已阅读，工作时间不从租约推算。<span v-if="error"
      >记录中断：{{ error }}；缺失过程和用时将保持未知。</span
    >
  </p>
</template>
<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import pb from '@/lib/pocketbase'
import { getPbMessage } from '@/utils/pbErrors'
const props = defineProps({
  session: Object,
  submitted: Boolean,
  densityCollapsedIds: { type: Array, default: () => [] }
})
const error = ref('')
const notice = ref(null)
let current = null
const sequences = new Map()
let queue = Promise.resolve()
let paused = false
let timer
let lastRender = ''

watch(
  () => props.session?.id,
  async () => {
    if (current && !props.submitted) record('interruption', { reason: 'task_changed' })
    current = props.session
    if (current)
      sequences.set(
        current.id,
        Math.max(sequences.get(current.id) || 0, current.last_sequence || 0)
      )
    queue = Promise.resolve()
    error.value = ''
    lastRender = ''
    if (!current) return
    paused = false
    record(
      current.state === 'paused' ? 'resume' : current.state === 'assigned' ? 'start' : 'render',
      {}
    )
    if (document.visibilityState !== 'visible' || !document.hasFocus()) {
      paused = true
      record('pause', { reason: 'background_at_start' })
    }
    await nextTick()
    requestAnimationFrame(rendered)
  },
  { immediate: true }
)

function record(type, data = {}) {
  if (!current || error.value) return
  const sessionId = current.id
  const event = {
    type,
    client_at: new Date().toISOString(),
    visibility: document.visibilityState || 'unknown',
    focus: document.hasFocus(),
    data
  }
  queue = queue
    .then(async () => {
      event.sequence = (sequences.get(sessionId) || 0) + 1
      sequences.set(sessionId, event.sequence)
      let failure
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await pb.send(`/api/fangji/research-sessions/${encodeURIComponent(sessionId)}/events`, {
            method: 'POST',
            body: event,
            requestKey: null,
            keepalive: true
          })
          return
        } catch (e) {
          failure = e
          if (Number(e.status) >= 400 && Number(e.status) < 500) break
        }
      }
      throw failure
    })
    .catch((e) => {
      if (current?.id === sessionId) error.value = getPbMessage(e, '事件未能保存')
    })
}
function rendered() {
  if (!current || props.submitted) return
  const panel = notice.value?.closest('.editor-panel-body--fields')
  if (!panel) return
  const bounds = panel.getBoundingClientRect()
  const left = Math.max(0, bounds.left)
  const top = Math.max(0, bounds.top)
  const right = Math.min(window.innerWidth, bounds.right)
  const bottom = Math.min(window.innerHeight, bounds.bottom)
  const elements = [...panel.querySelectorAll('[data-finding-id]')].filter(
    (element) => element.dataset.findingId && element.getClientRects().length
  )
  const renderedIds = [...new Set(elements.map((element) => element.dataset.findingId))]
  const presentedIds = [
    ...new Set(
      elements
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          return (
            Math.min(rect.bottom, bottom) > Math.max(rect.top, top) &&
            Math.min(rect.right, right) > Math.max(rect.left, left)
          )
        })
        .map((element) => element.dataset.findingId)
    )
  ]
  const eligible = current.presentation?.hints?.map((hint) => hint.id) || []
  const collapsedIds = props.densityCollapsedIds
  const data = {
    rendered_ids: renderedIds,
    presented_ids: presentedIds,
    collapsed_ids: collapsedIds,
    raw_count: current.presentation.raw_count,
    gate_eligible_count: current.presentation.eligible_ids.length,
    hidden_by_field_ids: eligible.filter(
      (id) => !renderedIds.includes(id) && !collapsedIds.includes(id)
    ),
    production_suppressed: current.presentation.production_suppressed,
    display_policy: current.presentation.display,
    density_limit: 3
  }
  const signature = JSON.stringify([data, document.visibilityState, document.hasFocus()])
  if (signature === lastRender) return
  lastRender = signature
  record('render', data)
}
watch(() => props.densityCollapsedIds, scheduleRender, { flush: 'post' })
function expandFindings() {
  if (!current || props.submitted) return
  record('expand')
  scheduleRender()
}
function activity() {
  if (!current || props.submitted) return
  const inactive = document.visibilityState !== 'visible' || !document.hasFocus()
  if (inactive !== paused) {
    paused = inactive
    record(inactive ? 'pause' : 'resume', {
      reason: inactive ? 'background_or_unfocused' : 'foreground'
    })
  }
  scheduleRender()
}
function scheduleRender() {
  clearTimeout(timer)
  timer = setTimeout(rendered, 120)
}
function click(event) {
  const hint = event.target.closest('[data-locate-finding]')
  if (hint?.dataset.locateFinding) record('locate', { hint_ids: [hint.dataset.locateFinding] })
}
async function flush() {
  rendered()
  await queue
  return current
    ? {
        researchSession: current.id,
        researchRecordingComplete: !error.value,
        researchSequence: sequences.get(current.id) || 0
      }
    : {}
}
defineExpose({ flush, expandFindings })
onMounted(() => {
  window.addEventListener('focus', activity)
  window.addEventListener('blur', activity)
  document.addEventListener('visibilitychange', activity)
  document.addEventListener('scroll', scheduleRender, true)
  document.addEventListener('click', click)
})
onBeforeUnmount(() => {
  clearTimeout(timer)
  if (current && !props.submitted) record('interruption', { reason: 'left_task' })
  window.removeEventListener('focus', activity)
  window.removeEventListener('blur', activity)
  document.removeEventListener('visibilitychange', activity)
  document.removeEventListener('scroll', scheduleRender, true)
  document.removeEventListener('click', click)
})
</script>
