<template>
  <main class="container page page-guide">
    <div class="flex items-center gap-3 mb-6">
      <RouterLink to="/admin/projects/new" class="btn btn-secondary btn-sm"
        >← 返回创建项目</RouterLink
      >
      <h1 class="compact-page-title">项目文件与校对条目说明</h1>
    </div>

    <div class="card guide-content">
      <section>
        <h3>数据关系</h3>
        <p>
          项目用于组织 PDF 原文、CSV 导入作业和校对条目。CSV
          每一行生成一条校对任务，页码字段用于定位对应 PDF
          页面；除页码外的所有列都会保留为结构化字段。
        </p>
        <p>
          导入后，条目依次经历待接取、项目要求人数的独立校对和结果比较（默认且最少 2
          人）；收齐结果后全部一致自动完成，有差异时交由管理员仲裁，完成后可按原结构导出 CSV。
        </p>
      </section>

      <section>
        <h3>选择文件组合</h3>
        <ul>
          <li>
            <strong>PDF-only：</strong>可以验证并预览原文。上传本身不生成任务；本地文字层提取
            启用后，可在项目详情选择页码范围，提取为待修正的原文行。
          </li>
          <li>
            <strong>CSV-only：</strong>可以正常导入和校对，页码作为来源信息保留，但编辑器中没有原文
            PDF。
          </li>
          <li>
            <strong>PDF + CSV（推荐）：</strong>先等待 PDF 验证完成，再预检
            CSV。条目会永久关联预检时的 PDF；之后替换主 PDF 不会改变既有条目的原文。
          </li>
        </ul>
      </section>

      <section>
        <h3>本地文字层提取与人工修正</h3>
        <p>
          文字层提取
          按单栏逐行生成「原文」字段，不自动猜测领域分列。当前只接收不含图像且可映射的单栏纯文字层页面（含装饰图的页也保守拒绝）。扫描引擎因难字静默替换未通过安全评测，扫描结果不生成条目；资料不发送外部识别服务。每批最多
          200 个 PDF 物理页。
        </p>
        <p>
          识别时的「确定／待确认／弃权」与原始坐标单独保留，置信度不等于来源正确。可在条目表点「修正」核对导入文本，随后走原有独立校对与仲裁流程。重复识别会生成新批次，不覆盖已有条目。
        </p>
      </section>

      <section>
        <h3>CSV 要求</h3>
        <p>
          文件必须包含表头，并且只能包含一个页码字段：<code>PDF页码</code>、<code>page</code>、<code
            >pdf_page</code
          >
          或 <code>页码</code>。页码必须是正整数；存在主 PDF 时不能超过其总页数。支持 UTF-8、GB18030
          和 GBK。
        </p>
        <p>最小示例（保存为 UTF-8 CSV）：</p>
        <pre><code>PDF页码,文本
1,待校对的原文</code></pre>
        <p>结构化示例（同一 PDF 页可包含多条任务）：</p>
        <pre><code>PDF页码,词条,读音,释义
1,阿,ɑ533,前缀
1,阿妗,ɑ13inɡ21,姨母</code></pre>
      </section>

      <section>
        <h3>预检与修正</h3>
        <p>
          后端预检会展示编码、动态表头、总行数、页码范围、可导入与跳过数量、前 20
          条有效记录的只读预览和逐行错误。预览会单独标注 CSV 原始行号和 PDF
          物理页，不会占用或改写原始字段。缺少或重复页码字段、空白或重复表头、无法解析的 CSV
          会阻止提交；非法页码、空内容或列数不一致的行会列出原因。修正源文件后重新选择并预检即可。
        </p>
      </section>

      <section
        id="review-bundle-practice"
        ref="practiceSection"
        aria-labelledby="bundle-practice-title"
      >
        <h3 id="bundle-practice-title">管理员：完整资料包练习</h3>
        <p>
          <a href="/examples/review-bundle-practice-v1.zip" download
            >下载虚构 Review Bundle（3 条）</a
          >
          ·
          <a href="/examples/review-bundle-practice-v1/source.pdf" download
            >下载配套原文 PDF（3 页）</a
          >
          ·
          <a href="/examples/review-bundle-practice-v1/README.txt" download>下载逐步练习说明</a>
        </p>
        <p>
          材料全部为虚构，不代表方言事实，不含真实身份或凭据。请新建名称含「练习」的独立项目，
          安排两名不同账号的校对者；来源和用途登记需平台管理员协助。下载不会自动创建记录或确认许可。
        </p>
        <ol>
          <li>
            先上传配套 PDF，等待 3 页校验完成；在「资料导入 → Review Bundle」检查 ZIP， 核对 3
            条、来源声明和页码。检查通过不等于已经导入或获准使用。
          </li>
          <li>
            由平台管理员核对并登记来源逻辑 ID
            <code>practice-wanyu-reviewbundle-v1</code>；用途仍可保持未知。
            操作者再次核对项目和来源后，才自行确认导入；应为完整成功的同一批 3 条。
          </li>
          <li>
            保存来源核验约定，安排双人独立对照 PDF。相同结果自动比较完成，分歧交由管理员
            逐字段仲裁；不得互看尚未公开的校对结果。说明中另有仅供练习的差异场景。
          </li>
          <li>
            管理员补录实际来源判断、依据与页内位置；平台管理员分别判断本次用途和
            「原始材料转交第三方」。未知或禁止继续阻断，不为完成练习虚填「允许」。
          </li>
          <li>
            在用途编选中只选择这一个完整入站批次，核对采用、排除、待处理合计为 3，再人工确认。
            本练习不依赖转换规则，「要求记音归一已定稿」可保持未勾选。
          </li>
          <li>
            从已确认编选进入准备交付，填写实际核查人并检查接收方、用途、范围和正文数。
            预检通过后仍由人决定是否生成；仅下载到本地练习，未真实接收时保持待回执，不代签验收。
          </li>
        </ol>
        <p>
          从头重放请新建独立练习项目。同项目重复上传相同资料包会返回原作业，不会重建任务。
          权利判断、来源核对、交付确认和真实消费方验收不会由样例替你完成。
        </p>
      </section>
      <section>
        <h3>校对者：轻量字段练习</h3>
        <p>
          <a href="/examples/proofreading-practice.csv" download>下载虚构练习 CSV（3 条）</a>
          ，在另一个独立练习项目预检并观察空值、难字和组合字符。 CSV-only 没有原文
          PDF，适合熟悉输入和普通导出；原生编选交付练习请使用上方完整资料包。
          真实资料的双人操作、难字与移动端验收仍需项目成员完成。
        </p>
      </section>
      <section>
        <h3>推荐流程</h3>
        <ol>
          <li>创建项目并选择单个 PDF；选择后自动上传，等待校验完成。失败时可重试。</li>
          <li>
            选择 CSV，查看后端预检结果和错误明细；或使用项目详情的文字层提取，查看原始 JSON
            与识别时三态，并对照 PDF 修正。
          </li>
          <li>确认导入；校对员随后可从任务大厅接取条目。</li>
        </ol>
      </section>
    </div>
  </main>
</template>

<script setup>
import { nextTick, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

const route = useRoute()
const practiceSection = ref(null)
watch(
  () => route.hash,
  async (hash) => {
    if (hash !== '#review-bundle-practice') return
    await nextTick()
    // The global router resets new paths to the top; only this guide owns this anchor.
    requestAnimationFrame(() => {
      if (route.hash === hash && practiceSection.value?.isConnected) {
        practiceSection.value.scrollIntoView({ block: 'start' })
      }
    })
  },
  { immediate: true }
)
</script>

<style scoped>
.guide-content {
  display: grid;
  gap: 1.5rem;
}
.guide-content h3 {
  margin-bottom: 0.5rem;
  font-size: 1.05rem;
}
.guide-content p,
.guide-content li {
  line-height: 1.7;
}
.guide-content ul,
.guide-content ol {
  padding-left: 1.5rem;
}
.guide-content pre {
  margin-top: 0.75rem;
  padding: 0.85rem;
  overflow-x: auto;
  border-radius: var(--radius);
  background: var(--gray-900);
  color: var(--gray-50);
}
</style>
