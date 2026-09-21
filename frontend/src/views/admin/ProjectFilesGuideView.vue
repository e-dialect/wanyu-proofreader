<template>
  <div class="container page" style="max-width:840px">
    <div class="flex items-center gap-3 mb-6">
      <RouterLink to="/admin/projects/new" class="btn btn-secondary btn-sm">← 返回创建项目</RouterLink>
      <h2 class="font-bold" style="font-size:1.5rem">项目文件与校对条目说明</h2>
    </div>

    <div class="card guide-content">
      <section>
        <h3>数据关系</h3>
        <p>项目用于组织 PDF 原文、CSV 导入作业和校对条目。CSV 每一行生成一条校对任务，页码字段用于定位对应 PDF 页面；除页码外的所有列都会保留为结构化字段。</p>
        <p>导入后，条目依次经历待接取、项目要求人数的独立校对和结果比较（默认且最少 2 人）；收齐结果后全部一致自动完成，有差异时交由管理员仲裁，完成后可按原结构导出 CSV。</p>
      </section>

      <section>
        <h3>选择文件组合</h3>
        <ul>
          <li><strong>PDF-only：</strong>可以验证并预览原文，但不会自动 OCR 或生成校对任务。</li>
          <li><strong>CSV-only：</strong>可以正常导入和校对，页码作为来源信息保留，但编辑器中没有原文 PDF。</li>
          <li><strong>PDF + CSV（推荐）：</strong>先等待 PDF 验证完成，再预检 CSV。条目会永久关联预检时的 PDF；之后替换主 PDF 不会改变既有条目的原文。</li>
        </ul>
      </section>

      <section>
        <h3>CSV 要求</h3>
        <p>文件必须包含表头，并且只能包含一个页码字段：<code>PDF页码</code>、<code>page</code>、<code>pdf_page</code> 或 <code>页码</code>。页码必须是正整数；存在主 PDF 时不能超过其总页数。支持 UTF-8、GB18030 和 GBK。</p>
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
        <p>后端预检会展示编码、动态表头、总行数、页码范围、可导入与跳过数量、数据预览和逐行错误。缺少或重复页码字段、空白或重复表头、无法解析的 CSV 会阻止提交；非法页码、空内容或列数不一致的行会列出原因。修正源文件后重新选择并预检即可。</p>
      </section>

      <section>
        <h3>推荐流程</h3>
        <ol>
          <li>创建项目并选择单个 PDF；选择后自动上传，等待校验完成。失败时可重试。</li>
          <li>选择 CSV，查看后端预检结果和错误明细。</li>
          <li>确认导入；校对员随后可从任务大厅接取条目。</li>
        </ol>
      </section>
    </div>
  </div>
</template>

<script setup>
import { RouterLink } from 'vue-router'
</script>

<style scoped>
.guide-content { display: grid; gap: 1.5rem; }
.guide-content h3 { margin-bottom: .5rem; font-size: 1.05rem; }
.guide-content p, .guide-content li { line-height: 1.7; }
.guide-content ul, .guide-content ol { padding-left: 1.5rem; }
.guide-content pre { margin-top: .75rem; padding: .85rem; overflow-x: auto; border-radius: var(--radius); background: var(--gray-900); color: var(--gray-50); }
</style>
