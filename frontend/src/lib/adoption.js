// #315 D 用途编选的前端口径。
//
// 这里只放「说法」与「算法」，不放请求：枚举中文名、规则摘要、三个数是否对得上、
// 以及从表单构造规则。视图与测试共用同一份，避免界面上一套说法、导出里另一套。
//
// 术语（D7）：本页的「编选」是**整批交付要不要这条资料**；仲裁台里的「采用」
// 是**在这几份校对结果里选哪一份**。两处都在管理端可见，所以界面文案必须写明
// 区别，而不是靠读者猜。

export const PURPOSE_LABELS = {
  public_display: '公开检索与展示',
  internal_research: '内部研究',
  model_training: '模型训练',
  commercial_use: '商业使用',
  redistribution: '再分发',
  raw_third_party_transfer: '原始内容转交第三方'
}

export const BATCH_STATUS_LABELS = {
  draft: '草稿',
  previewed: '已预览',
  confirmed: '已确认'
}

export const DECISION_LABELS = {
  select: '进入本批',
  exclude: '不进入本批'
}

// 与后端 backend/adoption.go 的 adoptionReasonCodes 同源：五桶阻塞原因逐字沿用，
// 另外三个是 D 自己的结构原因、两个是六类用途 gate 的失败。顺序也保持一致。
export const REASON_LABELS = {
  outside_import_batch: '不在所选导入批次',
  status_not_ready: '校对状态未到',
  quality_state_insufficient: '质量状态不足',
  pinyin_pending: '拼音尚未定稿',
  purpose_denied: '该用途被明确拒绝',
  purpose_unknown: '该用途尚未决定',
  glyph_table: '缺字表待查',
  scanned_read: '扫描页需识读',
  column_merge: '列结构待修',
  rights_gate: '授权未决',
  unknown: '看过但认不出卡在哪'
}

export const PAGE_STATUS_LABELS = {
  pending: '待领取',
  claimed: '已领取',
  proofreading: '校对中',
  proofread: '已校对',
  reviewing: '复核中',
  approved: '已通过',
  rejected: '已退回',
  arbitration: '仲裁中',
  importing: '导入中'
}

export const QUALITY_STATE_LABELS = {
  candidate: '待定',
  validated: '已确认',
  withheld: '暂缓外发'
}

export const DEFAULT_STATUSES = ['proofread', 'approved']

export function defaultRule() {
  return { statuses: [...DEFAULT_STATUSES], qualityStates: [], importJobs: [], requirePinyin: false }
}

export function purposeLabel(code) {
  return PURPOSE_LABELS[code] || String(code || '')
}

export function batchStatusLabel(code) {
  return BATCH_STATUS_LABELS[code] || String(code || '')
}

export function reasonLabel(code) {
  return REASON_LABELS[code] || String(code || '')
}

export function statusLabel(code) {
  return PAGE_STATUS_LABELS[code] || String(code || '')
}

export function qualityStateLabel(code) {
  return QUALITY_STATE_LABELS[code] || String(code || '')
}

// countsConsistent 是 D4.2 的机器可读形式：total 必须等于三段之和。后端保证这一点，
// 前端仍然算一遍——界面拿到的数字如果对不上，应当显示「数据不一致」而不是照抄。
export function countsConsistent(counts) {
  const safe = normalizeCounts(counts)
  return safe.total === safe.selected + safe.excluded + safe.pending
}

export function normalizeCounts(counts) {
  const value = (name) => {
    const number = Number(counts?.[name])
    return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0
  }
  return {
    total: value('total'),
    selected: value('selected'),
    excluded: value('excluded'),
    pending: value('pending'),
    complete: counts?.complete === true
  }
}

// ruleSummary 把规则翻成一句话，供批次列表与导出前的确认用（D1.5「规则本身可读出来」）。
export function ruleSummary(rule) {
  const statuses = (rule?.statuses || []).map(statusLabel)
  const quality = (rule?.qualityStates || []).map(qualityStateLabel)
  const jobs = (rule?.importJobs || []).length
  const parts = [`校对状态：${statuses.length ? statuses.join('、') : '未限制'}`]
  if (quality.length) parts.push(`质量状态：${quality.join('、')}`)
  if (jobs) parts.push(`限定 ${jobs} 个导入批次`)
  if (rule?.requirePinyin) parts.push('要求拼音已定稿')
  return parts.join('；')
}

// ruleFromForm 把表单值收成后端要的形状，并在提交前挡住明显写错的值。
// importJobs 用逗号分隔的 15 位 id：后端会再验一次归属，这里只挡形状。
export function ruleFromForm({ statuses = [], qualityStates = [], requirePinyin = false, importJobsText = '' } = {}) {
  const importJobs = String(importJobsText || '')
    .split(/[,，\s]+/)
    .map((value) => value.trim())
    .filter(Boolean)
  const bad = importJobs.find((value) => !/^[a-z0-9]{15}$/.test(value))
  if (bad) return { error: `导入批次 id「${bad}」不是 15 位小写字母数字。` }
  if (!statuses.length) return { error: '至少要选一个校对状态，否则这一批永远是空的。' }
  return {
    rule: {
      statuses: [...statuses],
      qualityStates: [...qualityStates],
      importJobs,
      requirePinyin: Boolean(requirePinyin)
    }
  }
}

// include 控制导出带哪些条目。默认只带本批采用范围，其余必须显式请求——
// 界面上要把这件事说出来，而不是给一个「导出全部」的按钮了事。
export const INCLUDE_OPTIONS = {
  select: '只导出进入本批的条目',
  all: '导出全部条目（含未采用与待处理，需平台管理员）'
}

export function includeLabel(include) {
  return INCLUDE_OPTIONS[include] || String(include || '')
}

// manifestFilename 让导出文件名带上批次 id 与用途，避免两份清单混在一起分不清。
export function manifestFilename(batch) {
  const purpose = String(batch?.purpose || 'batch')
  const id = String(batch?.id || '')
  return `编选-${purpose}-${id}.json`
}
