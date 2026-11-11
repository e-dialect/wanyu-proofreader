<template>
  <main class="container page page-guide" ref="guideElement">
    <header class="page-heading guide-heading">
      <div>
        <h1 class="compact-page-title">项目文件与校对条目说明</h1>
        <p>从准备资料到交付成果，按你的角色找到下一步。</p>
      </div>
      <div class="guide-heading-actions">
        <RouterLink :to="anchor('review-bundle-practice')" class="guide-text-link">
          跳到完整资料包练习 <AppIcon name="arrow" />
        </RouterLink>
        <RouterLink :to="returnTarget" class="btn btn-secondary">{{ returnLabel }}</RouterLink>
      </div>
    </header>

    <nav class="guide-role-nav" aria-label="按角色查看操作步骤">
      <RouterLink :to="anchor('guide-manager')" class="guide-role-link">
        <strong>项目管理员</strong><span>准备材料、安排校对、交付成果</span><AppIcon name="arrow" />
      </RouterLink>
      <RouterLink :to="anchor('guide-proofreader')" class="guide-role-link">
        <strong>校对者</strong><span>领取任务、核对字段、提交结果</span><AppIcon name="arrow" />
      </RouterLink>
      <RouterLink :to="anchor('guide-platform')" class="guide-role-link">
        <strong>平台管理员</strong><span>登记来源、核对用途与转交许可</span><AppIcon name="arrow" />
      </RouterLink>
    </nav>

    <div class="guide-content">
      <section
        id="guide-manager"
        tabindex="-1"
        aria-labelledby="guide-manager-title"
        class="guide-section"
      >
        <div class="guide-section-heading">
          <div>
            <h2 id="guide-manager-title">项目管理员：把资料交给团队</h2>
            <p>推荐准备 PDF 原文和 CSV 条目，再安排至少两人独立核对。</p>
          </div>
          <RouterLink
            v-if="auth.canCreateProjects"
            to="/admin/projects/new"
            class="btn btn-primary"
          >
            创建项目
          </RouterLink>
        </div>
        <ol class="guide-steps">
          <li>
            <span class="guide-step-number" aria-hidden="true">1</span>
            <div>
              <h3>准备原文与条目</h3>
              <p>
                先上传 PDF，等待校验完成。CSV
                每行是一条任务，页码用于定位原文，其余列保留为校对字段。
              </p>
              <p class="guide-step-location">项目 → 材料 → 材料与导入</p>
            </div>
          </li>
          <li>
            <span class="guide-step-number" aria-hidden="true">2</span>
            <div>
              <h3>检查数量，再确认导入</h3>
              <p>
                核对实际来源、可导入与跳过行数，展开预览样本，查看错误记录。需要修改时，修正原 CSV
                后重新检查；检查完成后还需点击「确认导入」。
              </p>
            </div>
          </li>
          <li>
            <span class="guide-step-number" aria-hidden="true">3</span>
            <div>
              <h3>安排独立校对，处理分歧</h3>
              <p>
                配置成员与核验约定。默认且最少两人独立校对；收齐结果后，全部一致自动完成校对流程，有差异则进入管理员逐字段仲裁。
              </p>
              <p class="guide-step-location">项目 → 设置；项目 → 校勘 → 待办队列</p>
            </div>
          </li>
          <li>
            <span class="guide-step-number" aria-hidden="true">4</span>
            <div>
              <h3>核验来源，按用途交付</h3>
              <p>
                完成校对不代表来源与用途已获确认。补齐来源判断，与平台管理员核对许可，再确认编选范围、生成交付包；实际接收后据实登记回执。
              </p>
              <p class="guide-step-location">项目 → 交付 → 用途编选 / 交付包与回执</p>
            </div>
          </li>
        </ol>
        <div class="guide-reference">
          <AppDisclosure label="选择文件组合：PDF、CSV 或两者配合">
            <ul>
              <li>
                <strong>PDF + CSV（推荐）：</strong>先等待 PDF 验证完成，再预检
                CSV。条目永久关联预检时的 PDF；之后替换主 PDF 不会改变既有条目的原文。
              </li>
              <li>
                <strong>只有 CSV：</strong>可以导入和校对，页码作为来源信息保留，编辑器中没有来源
                PDF。
              </li>
              <li>
                <strong>只有 PDF：</strong
                >上传仅用于验证和预览，不会直接生成任务；文字层提取启用后，可选择页码范围生成待修正的原文行。
              </li>
            </ul>
          </AppDisclosure>
          <AppDisclosure label="CSV 格式、示例与常见错误">
            <p>
              必须有表头，选择文件后指定“PDF
              物理页码列”。列名可以是“扫描页”等自定义名称；其余列保留为校对内容。
              只有一个常见页码列名时会预选，多个候选时需要自行选择。页码是从 1 开始的 PDF 实际页序，
              不一定等于书中印刷页码；有主 PDF 时不能超过总页数。支持 UTF-8、GB18030 和 GBK。
            </p>
            <p>最小示例（保存为 UTF-8 CSV）：</p>
            <pre><code>PDF页码,文本
1,待校对的原文</code></pre>
            <p>同一 PDF 页可有多条任务：</p>
            <pre><code>PDF页码,词条,读音,释义
1,阿,ɑ533,前缀
1,阿妗,ɑ13inɡ21,姨母</code></pre>
            <p>
              预检保留编码、表头、总行数、页码范围和前 20 条有效记录的只读样本。原 CSV 行号与 PDF
              物理页码单独标注，不改写原字段。样本不是全量正确性证明。
            </p>
            <p>
              空白或重复表头、无法解析的 CSV
              会阻止检查；非法页码、空内容和列数不一致的行会列出原因。
              页码列选错时可直接更改并重新检查；内容错误仍需修改原文件后重新选择。
            </p>
          </AppDisclosure>
          <AppDisclosure label="PDF 文字层提取：适用材料与人工修正">
            <p>
              按单栏逐行生成「原文」字段，不自动猜测领域分列。只接收不含图像且可映射的单栏纯文字层页面，含装饰图的页也会保守拒绝，每批最多
              200 个 PDF 物理页。
            </p>
            <p>
              提取前先核对页面显示的主 PDF 文件名、总页数与所选页段。换过主 PDF
              后重新核对，建议先提取少量页面查看排版。
            </p>
            <p>
              当前不支持扫描页和多列表格。可先人工转录，或使用已有的结构化资料整理为 CSV 后导入。
            </p>
            <p>
              「确定／待确认／弃权」与原始坐标单独保留，置信度不等于来源正确。在条目表点「修正」核对导入文本，再走独立校对与仲裁。重复提取生成新批次，不覆盖已有条目。
            </p>
          </AppDisclosure>
        </div>
        <RouterLink :to="practiceAnchor('manager')" class="guide-text-link"
          >用 3 条虚构材料练习完整流程 <AppIcon name="arrow"
        /></RouterLink>
      </section>

      <section
        id="guide-proofreader"
        tabindex="-1"
        aria-labelledby="guide-proofreader-title"
        class="guide-section"
      >
        <div class="guide-section-heading">
          <div>
            <h2 id="guide-proofreader-title">校对者：从第一条任务开始</h2>
            <p>先看来源，再逐字段核对；无法判断时保留疑点。</p>
          </div>
          <RouterLink to="/tasks" class="btn btn-secondary">前往我的任务</RouterLink>
        </div>
        <ol class="guide-steps">
          <li>
            <span class="guide-step-number" aria-hidden="true">1</span>
            <div>
              <h3>找到项目，领取任务</h3>
              <p>加入管理员安排的项目后，在「我的任务」领取或继续校对。</p>
            </div>
          </li>
          <li>
            <span class="guide-step-number" aria-hidden="true">2</span>
            <div>
              <h3>对照原文，核对每个字段</h3>
              <p>
                先读项目核验约定，再对照 PDF
                编辑内容。字符键盘在光标处插入、替换选区；遇到看不清的来源或难字，保存未完成工作并报告问题。
              </p>
            </div>
          </li>
          <li>
            <span class="guide-step-number" aria-hidden="true">3</span>
            <div>
              <h3>检查后提交，继续下一条</h3>
              <p>
                检查修改摘要与逐字段核对声明后提交。草稿仅保存在当前设备；提交后不能自行撤回，可从本人已提交记录回看。
              </p>
            </div>
          </li>
        </ol>
        <AppDisclosure label="校对者：轻量字段练习">
          <p>
            请管理员在独立练习项目导入
            <a href="/examples/proofreading-practice.csv" download>下载虚构练习 CSV（3 条）</a
            >，再安排你领取。练习包含空值、难字和组合字符。
          </p>
          <p>
            只有 CSV 时没有来源
            PDF，适合熟悉输入和普通导出；完整编选交付使用下方资料包练习。真实资料的双人操作、难字与移动端仍需团队实际核验。
          </p>
          <RouterLink :to="practiceAnchor('proofreader')" class="guide-text-link">
            查看校对者的完整练习清单 <AppIcon name="arrow" />
          </RouterLink>
        </AppDisclosure>
      </section>

      <section
        id="guide-platform"
        tabindex="-1"
        aria-labelledby="guide-platform-title"
        class="guide-section"
      >
        <div class="guide-section-heading">
          <div>
            <h2 id="guide-platform-title">平台管理员：确认来源与用途</h2>
            <p>需要与你协作的时点：导入之前、交付之前。</p>
          </div>
        </div>
        <ol class="guide-steps">
          <li>
            <span class="guide-step-number" aria-hidden="true">1</span>
            <div>
              <h3>导入前登记实际来源</h3>
              <p>
                核对来源资料和逻辑
                ID，完成来源登记后告知项目管理员。文件检查成功不代表来源登记或许可已经完成。
              </p>
            </div>
          </li>
          <li>
            <span class="guide-step-number" aria-hidden="true">2</span>
            <div>
              <h3>交付前分别核对两项许可</h3>
              <p>
                分别判断本次用途和「原始材料转交第三方」。未知或禁止时继续阻断交付，不为走完流程勾选「允许」。
              </p>
            </div>
          </li>
        </ol>
        <RouterLink to="/admin/sources" class="guide-text-link"
          >平台管理员前往来源库 <AppIcon name="arrow"
        /></RouterLink>
      </section>

      <ReviewBundlePractice :project-id="projectId" />
    </div>
  </main>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import AppDisclosure from '@/components/AppDisclosure.vue'
import AppIcon from '@/components/AppIcon.vue'
import ReviewBundlePractice from '@/components/admin/project/ReviewBundlePractice.vue'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const auth = useAuthStore()
const projectId = computed(() =>
  typeof route.query.project === 'string' && /^[a-z0-9]{15}$/.test(route.query.project)
    ? route.query.project
    : ''
)
const returnTarget = computed(() =>
  projectId.value
    ? {
        path: `/admin/projects/${projectId.value}`,
        query: {
          section: 'materials',
          view: 'import',
          method: ['pdf', 'csv', 'ocr', 'bundle'].includes(route.query.method)
            ? route.query.method
            : 'pdf'
        }
      }
    : auth.canCreateProjects
      ? '/admin/projects/new'
      : '/workspace'
)
const returnLabel = computed(() => {
  if (projectId.value) return '返回项目材料'
  return auth.canCreateProjects ? '返回创建项目' : '返回工作台'
})
const guideElement = ref(null)
const anchors = new Set([
  'guide-manager',
  'guide-proofreader',
  'guide-platform',
  'review-bundle-practice'
])
const anchor = (id) => ({ path: route.path, query: route.query, hash: `#${id}` })
const practiceAnchor = (role) => ({
  ...anchor('review-bundle-practice'),
  query: { ...route.query, practiceRole: role }
})
watch(
  () => route.hash,
  async (hash) => {
    const id = hash.slice(1)
    if (!anchors.has(id)) return
    await nextTick()
    // Let the router finish its page reset before positioning an explicit guide anchor.
    requestAnimationFrame(() => {
      const section = guideElement.value?.querySelector(`[id="${id}"]`)
      if (route.hash === hash && section?.isConnected) {
        section.scrollIntoView({ block: 'start' })
        section.focus({ preventScroll: true })
      }
    })
  },
  { immediate: true }
)
</script>

<style scoped>
.guide-heading {
  align-items: flex-start;
}
.guide-heading-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}
.guide-heading p,
.guide-section-heading p {
  margin-top: var(--space-2);
  color: var(--ink-muted);
}
.guide-role-nav {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
  margin-bottom: var(--space-6);
}
.guide-role-link {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--space-2);
  align-content: start;
  padding: var(--space-4);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  color: var(--ink);
  text-decoration: none;
}
.guide-role-link span {
  grid-column: 1;
  color: var(--ink-muted);
  font-size: var(--text-sm);
  line-height: 1.6;
}
.guide-role-link .app-icon {
  grid-column: 2;
  grid-row: 1;
  color: var(--primary);
}
.guide-role-link:hover {
  border-color: var(--primary);
  background: var(--primary-glow-soft);
}
.guide-content {
  display: grid;
  gap: var(--space-6);
}
.guide-section {
  min-width: 0;
  padding: var(--space-5);
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--surface);
  scroll-margin-top: 96px;
}
.guide-section:focus-visible {
  outline: 3px solid var(--focus-ring);
  outline-offset: var(--space-1);
}
.guide-section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-5);
}
.guide-section-heading h2 {
  font-size: var(--text-xl);
  line-height: 1.4;
}
.guide-section-heading .btn {
  flex-shrink: 0;
}
.guide-section p,
.guide-section li {
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.guide-section p + p {
  margin-top: var(--space-3);
}
.guide-section code {
  overflow-wrap: anywhere;
}
.guide-steps {
  list-style: none;
  padding: 0;
  margin: 0 0 var(--space-5);
}
.guide-steps > li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-4);
  padding: var(--space-4) 0;
  border-top: 1px solid var(--line);
}
.guide-steps > li:first-child {
  padding-top: 0;
  border-top: 0;
}
.guide-step-number {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--space-6);
  height: var(--space-6);
  background: var(--paper);
  color: var(--accent);
  border-radius: var(--radius-circle);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.guide-steps h3 {
  margin-bottom: var(--space-1);
  font-size: var(--text-lg);
}
.guide-step-location {
  color: var(--ink-muted);
  font-size: var(--text-sm);
}
.guide-reference {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-4) 0;
}
.guide-reference > * {
  border-top: 1px solid var(--line);
  padding-top: var(--space-2);
}
.guide-reference ul {
  padding-left: var(--space-5);
}
.guide-reference li + li {
  margin-top: var(--space-3);
}
.guide-reference pre {
  margin: var(--space-3) 0;
  padding: var(--space-4);
  overflow-x: auto;
  border-radius: var(--radius-panel);
  background: var(--paper);
  color: var(--ink);
}
.guide-text-link {
  display: inline-flex;
  gap: var(--space-2);
  align-items: center;
  min-height: var(--control-height);
  color: var(--primary);
}
@media (max-width: 768px) {
  .guide-role-nav {
    grid-template-columns: 1fr;
    gap: var(--space-2);
  }
  .guide-role-link {
    gap: var(--space-1) var(--space-3);
  }
  .guide-section {
    padding: var(--space-4);
  }
  .guide-section-heading {
    flex-direction: column;
  }
  .guide-section-heading h2 {
    font-size: var(--text-lg);
  }
  .guide-steps > li {
    gap: var(--space-3);
  }
  .guide-text-link {
    min-height: var(--control-height-touch);
  }
}
</style>
