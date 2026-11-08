<template>
  <AppModal :open="open" title-id="workspace-leave-title" @close="decide(false)">
    <h2 id="workspace-leave-title">离开当前工作区？</h2>
    <p>{{ message }}</p>
    <template #actions>
      <button class="btn btn-secondary" @click="decide(false)">继续处理</button>
      <button class="btn btn-primary" @click="decide(true)">确认离开</button>
    </template>
  </AppModal>
</template>
<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import AppModal from '@/components/AppModal.vue'
const props = defineProps({
  dirty: Boolean,
  preserveQuery: { type: Boolean, default: true },
  message: {
    type: String,
    default: '还有未保存的修改。离开会丢失这些修改；你可以返回保存后再离开。'
  }
})
const open = ref(false)
let pending
function ask() {
  if (!props.dirty) return true
  if (pending) pending(false)
  open.value = true
  return new Promise((resolve) => {
    pending = resolve
  })
}
function decide(leave) {
  open.value = false
  pending?.(leave)
  pending = undefined
}
function beforeUnload(event) {
  if (!props.dirty) return
  event.preventDefault()
  event.returnValue = ''
}
onBeforeRouteLeave(ask)
onBeforeRouteUpdate((to, from) =>
  JSON.stringify(to.params) !== JSON.stringify(from.params) ||
  (!props.preserveQuery && to.fullPath !== from.fullPath)
    ? ask()
    : true
)
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload)
  pending?.(false)
})
</script>
