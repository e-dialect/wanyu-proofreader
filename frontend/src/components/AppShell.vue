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
    <AppModal :open="logoutOpen" title-id="draft-logout-title" @close="cancelLogout">
      <h2 id="draft-logout-title">{{ logoutError ? '草稿尚未保存' : '退出前检查本机草稿' }}</h2>
      <p v-if="logoutError" role="alert">{{ logoutError }}</p>
      <template v-else>
        <p>
          当前账号在此浏览器保留 {{ logoutDraftCount }} 份草稿，其中
          {{ logoutHistoryCount }} 份为历史版本。
        </p>
        <p>本机草稿不等于正式提交。退出会保留这些内容；需要查看或导出时，请前往本机资料。</p>
      </template>
      <template #actions>
        <AppButton variant="secondary" @click="cancelLogout">返回处理</AppButton>
        <AppButton v-if="!logoutError" variant="secondary" @click="openLocalDrafts"
          >前往本机资料</AppButton
        >
        <AppButton v-if="!logoutError" variant="primary" @click="confirmLogout"
          >保留草稿并退出</AppButton
        >
      </template>
    </AppModal>
    <AppModal :open="helpOpen" title-id="app-help-title" @close="helpOpen = false">
      <h2 id="app-help-title">开始你的校勘工作</h2>
      <section aria-labelledby="help-proofreader-title">
        <h3 id="help-proofreader-title">校对者：从领取到提交</h3>
        <ol class="shell-help-steps">
          <li>从工作台继续当前任务，或在项目中领取条目。</li>
          <li>对照来源逐字段核对，保留难字、空值和组合字符；不确定时记录问题。</li>
          <li>使用字符键盘输入特殊字符，检查来源页与必填字段后提交。</li>
          <li>暂时离开时确认草稿已保存；本机草稿不等于正式提交。</li>
        </ol>
      </section>
      <section
        v-if="auth.hasManagedProjects || auth.isPlatformAdmin"
        aria-labelledby="help-manager-title"
      >
        <h3 id="help-manager-title">项目管理员：从资料到交付</h3>
        <ol class="shell-help-steps">
          <li>先登记来源与使用范围；上传 PDF 校验完成后，再预检 CSV 或提取文字层。</li>
          <li>核对预览、错误行和绑定来源后确认导入，安排独立校对并处理差异。</li>
          <li>分别检查来源保真、质量与授权条件，再从已编选批次准备交付。</li>
        </ol>
      </section>
      <section aria-labelledby="help-practice-title">
        <h3 id="help-practice-title">虚构材料练习</h3>
        <p>
          <a href="/examples/review-bundle-practice-v1.zip" download>下载虚构完整练习包</a>
          ·
          <RouterLink
            :to="{
              path: '/admin/guide/project-files',
              query: { practiceRole: helpPracticeRole },
              hash: '#review-bundle-practice'
            }"
            @click="helpOpen = false"
            >查看完整练习步骤</RouterLink
          >
        </p>
        <p class="text-sm text-muted">
          含 3 条任务、3 页原文和说明；只在独立练习项目使用，来源与交付确认须由人完成。
        </p>
      </section>
      <p class="text-sm mt-3">
        <a href="/examples/proofreading-practice.csv" download>下载虚构练习 CSV</a
        >：在单独的练习项目试用，勿与真实资料混用。无需 PDF 也能练习字段输入与流程。
      </p>
      <section v-if="auth.isPlatformAdmin" aria-labelledby="help-platform-title">
        <h3 id="help-platform-title">平台管理员</h3>
        <p>
          管理建项目资格与平台规则；项目内的成员角色决定各项操作权限。权限调整后，请重新核对受影响项目。
        </p>
      </section>
      <p class="text-sm text-muted mt-4">
        状态暂时失联时可重新读取原作业，不必再次上传。完成校对、通过质量检查和允许外发是分别记录的结果。
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
import AppButton from '@/components/AppButton.vue'
import { useDraftLogout } from '@/composables/useDraftLogout'
const auth = useAuthStore()
const helpPracticeRole = computed(() => {
  if (auth.hasManagedProjects) return 'manager'
  if (auth.isPlatformAdmin) return 'platform'
  return 'proofreader'
})
const route = useRoute()
const router = useRouter()
const {
  open: logoutOpen,
  error: logoutError,
  draftCount: logoutDraftCount,
  historyCount: logoutHistoryCount,
  requestLogout,
  cancel: cancelLogout,
  confirmLogout,
  openLocalData: openLocalDrafts
} = useDraftLogout({ auth, router })
const navigationOpen = ref(false)
const helpOpen = ref(false)
const accountMenu = ref(null)
const immersive = computed(() => isImmersiveRoute(route))
const shellArea = computed(() => {
  if (['CreatorGrants', 'GateRules'].includes(route.name)) return '平台管理'
  if (['ProofreaderProfile', 'AccountSecurity', 'AccountAction'].includes(route.name))
    return '账户与偏好'
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
  dismissAccountMenu()
  await requestLogout()
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
