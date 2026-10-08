// #190 拼音归一的纯呈现逻辑。
//
// 放在 lib/ 而不是 services/：这里全是可单测的纯函数，而 services 里的模块会 import
// pocketbase 客户端，用 node:test 直接跑时解析不了 Vite 的 @/ 别名。

export const NORMALIZATION_STATUS_LABELS = {
  EXACT: '自动确定',
  REVIEWED: '已复核',
  AMBIGUOUS: '需人工确认',
  UNSUPPORTED: '暂未支持'
}

export const CONVERSION_JOB_STATUS_LABELS = {
  queued: '排队中',
  processing: '转换中',
  completed: '已完成',
  completed_with_errors: '完成，部分条目写入失败',
  failed: '失败'
}

export function normalizationStatusLabel(value) {
  return NORMALIZATION_STATUS_LABELS[value] || value || '未转换'
}

// 只复用 style.css 里已有的 badge-* 修饰类，不为这四个状态新造配色。
export function normalizationBadgeClass(value) {
  if (value === 'EXACT') return 'badge badge-approved'
  if (value === 'REVIEWED') return 'badge badge-proofread'
  if (value === 'AMBIGUOUS') return 'badge badge-arbitration'
  if (value === 'UNSUPPORTED') return 'badge badge-rejected'
  return 'badge'
}

export function conversionJobStatusLabel(status) {
  return CONVERSION_JOB_STATUS_LABELS[status] || status || '未开始'
}

// conversionSummaryLines 产 #114 §8 的那几行。
//
// 「自动确定」= EXACT + REVIEWED：两条都是**不需要人看**的结论（REVIEWED 是例外表
// 已经给出过的结论），把它们分开列会让「跑了 10000 条、其中 9720 条自动确定」这句话
// 对不上——而那正是 #114 §8 用来判断这批数据要不要人工介入的数字。
//
// 「跳过」与「处理失败」都不属于那四行：前者是「这一次没有转换它」（没有可转换的值、
// 或已经有人复核过），后者是「试过但没写进去」。两条各自单列出来，四行之和与它们
// 加起来才等于共处理；混进去会让差额无从解释。
//
// 失败必须单列，不能像原来那样被丢掉：后端三个失败分支都是 failed++ **且** total++，
// 所以漏掉它时「完成，部分条目写入失败」的作业在界面上会呈现一个 共处理 比其余行
// 之和大出一截、且没有任何一行能解释的差额——而这一行的存在正是为了让差额可解释。
export function conversionSummaryLines(job) {
  const value = (key) => Number(job?.[`${key}_count`] || 0)
  const exact = value('exact')
  const reviewed = value('reviewed')
  return [
    { key: 'total', label: '共处理', count: value('total') },
    { key: 'auto', label: '自动确定', count: exact + reviewed },
    { key: 'ambiguous', label: '需人工确认', count: value('ambiguous') },
    { key: 'unsupported', label: '暂未支持', count: value('unsupported') },
    { key: 'skipped', label: '跳过', count: value('skipped') },
    { key: 'failed', label: '处理失败', count: value('failed') }
  ]
}

// hasAdapterNotice 判断「本实例还没有可用方案」这个状态要不要显示。
// 它必须与「跑完了但一条都没转」区分开：后者是结果，前者是配置还没做。
export function adapterNotice(adapters) {
  return String(adapters?.notice || '').trim()
}
