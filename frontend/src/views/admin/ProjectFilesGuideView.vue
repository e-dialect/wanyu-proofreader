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

      <section>
        <h3>先在独立项目练习</h3>
        <p>
          <a href="/examples/proofreading-practice.csv" download>下载虚构练习 CSV（3 条）</a
          >。示例词条与释义均为虚构，不代表任何方言事实；不含真实用户或来源资料。请新建名称含「练习」的独立项目，勿导入真实资料项目。
        </p>
        <ol>
          <li>以 CSV-only 方式预检，核对 3 条样本、空值、组合字符与 PDF 页码，再确认导入。</li>
          <li>
            邀请两名练习校对者独立提交；先提交相同结果，再为另一条保留不同结果，比较自动完成与人工仲裁的区别。
          </li>
          <li>管理员查看差异与来源记录，给出仲裁说明，检查质量与授权条件。</li>
          <li>
            练习 CSV 可用于核对与导出；原生回传交付需从完整 Review Bundle 入站并满足编选条件。不要把
            CSV 导出当作已验收的回传交付。
          </li>
        </ol>
        <p>
          练习不会自动创建项目或任务。没有 PDF
          时原文预览不可用；真实资料的双人操作、难字与移动端验收仍需项目成员完成。
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
import { RouterLink } from 'vue-router'
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
