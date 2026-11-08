<template>
  <div class="app-shell" :class="{ 'app-shell--immersive': immersive }">
    <aside v-if="!immersive" class="app-sidebar"><AppNavigation /></aside>
    <div class="app-canvas">
      <header class="shell-header">
        <div class="shell-header__context">
          <button
            v-if="!immersive"
            type="button"
            class="btn btn-quiet shell-menu-button"
            aria-label="打开导航"
            :aria-expanded="navigationOpen"
            @click="navigationOpen = true"
          >
            <AppIcon name="menu" />
          </button>
          <RouterLink v-if="immersive" :to="returnTarget" class="shell-return"
            ><AppIcon name="back" /><span>返回队列</span></RouterLink
          >
          <span v-if="immersive" class="shell-header__brand">万语校坊</span>
          <div v-else class="shell-location-context" aria-label="当前位置">
            <span class="shell-area">{{ shellArea }}</span>
            <span class="shell-location-divider" aria-hidden="true">/</span>
            <span class="shell-location">{{ pageTitleFor(route.name) }}</span>
          </div>
        </div>
        <div id="workbench-guidance" class="shell-guidance"></div>
        <details ref="accountMenu" class="shell-account" @keydown.esc.prevent="dismissAccountMenu">
          <summary aria-label="账户与帮助">
            <UserAvatar :user="auth.user" /><span>{{
              auth.user?.name || auth.user?.username || '我的账户'
            }}</span
            ><span aria-hidden="true">⌄</span>
          </summary>
          <div class="shell-account__menu">
            <RouterLink to="/tasks/profile" @click="closeAccountMenu">个人中心</RouterLink
            ><button type="button" @click="showHelp">使用帮助</button
            ><button type="button" @click="replayGuide">重放新手引导</button
            ><button type="button" @click="logout">退出登录</button>
          </div>
        </details>
      </header>
      <div class="app-page"><slot /></div>
    </div>
    <AppModal :open="navigationOpen" title-id="app-navigation-title" @close="navigationOpen = false"
      ><h2 id="app-navigation-title" class="sr-only">导航</h2>
      <AppNavigation @navigate="navigationOpen = false" /><template #actions
        ><button type="button" class="btn btn-secondary" @click="navigationOpen = false">
          关闭导航
        </button></template
      ></AppModal
    >
    <AppModal :open="helpOpen" title-id="app-help-title" @close="helpOpen = false">
      <h2 id="app-help-title">开始你的校勘工作</h2>
      <ol class="shell-help-steps">
        <li>在工作台继续当前任务，或从「项目」加入一项工作。</li>
        <li>对照来源逐字段核对。需要特殊字符时，打开字符键盘。</li>
        <li>完成后检查并提交；无法判断时保存未完成工作并报告问题。</li>
      </ol>
      <p class="text-sm text-muted">
        草稿保存在当前设备。来源、质量与交付状态分别记录，完成校对不等于可以外发。
      </p>
      <template #actions
        ><button type="button" class="btn btn-primary" @click="helpOpen = false">
          开始工作
        </button></template
      >
    </AppModal>
  </div>
</template>
<script setup>
import { computed, onMounted, provide, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { pageTitleFor } from '@/lib/pageTitle'
import { isImmersiveRoute, navigationArea, rememberWork } from '@/lib/workbenchNavigation'
import { browserSessionStorage, queueReturnTarget } from '@/lib/queueReturn'
import { browserLocalStorage } from '@/lib/onboarding'
import AppNavigation from '@/components/AppNavigation.vue'
import AppIcon from '@/components/AppIcon.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import AppModal from '@/components/AppModal.vue'
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const navigationOpen = ref(false)
const helpOpen = ref(false)
const accountMenu = ref(null)
const immersive = computed(() => isImmersiveRoute(route))
const shellArea = computed(() => {
  if (['CreatorGrants', 'GateRules'].includes(route.name)) return '平台管理'
  if (route.name === 'ProofreaderProfile') return '账户与偏好'
  return (
    { workspace: '工作空间', tasks: '校勘工作', projects: '项目空间', sources: '来源资料' }[
      navigationArea(route)
    ] || '工作空间'
  )
})
const returnTarget = computed(() =>
  queueReturnTarget(browserSessionStorage(), auth.user?.id, route)
)
provide('workReturnTarget', returnTarget)

function closeAccountMenu() {
  if (accountMenu.value) accountMenu.value.open = false
}
function dismissAccountMenu() {
  closeAccountMenu()
  accountMenu.value?.querySelector('summary')?.focus()
}
function showHelp() {
  dismissAccountMenu()
  helpOpen.value = true
}
async function replayGuide() {
  closeAccountMenu()
  await router.push('/tasks/profile?guide=1')
}
async function logout() {
  closeAccountMenu()
  auth.logout()
  await router.push('/login')
}
watch(
  () => route.fullPath,
  () => {
    navigationOpen.value = false
    closeAccountMenu()
    rememberWork(browserLocalStorage(), auth.user?.id, route)
  },
  { immediate: true }
)
onMounted(() => {
  void auth.loadAccessContext().catch(() => {
    /* Page-owned readers provide recovery. */
  })
})
</script>
