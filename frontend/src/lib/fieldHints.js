import { renderFindingMessage } from './findingMessages.js'

// Limit the initial list per entry. The rest remain available on expansion.
export const HINT_DISPLAY_LIMIT = 3

// kind 短标签：#176 §2 的 10 值枚举是封闭集合，新增 kind 需要迁移，
// 因此这里查不到时回退成 kind 本身（可读、不抛错）就是留给 #178 这类
// 后续生产者的接入点——渲染端永远不需要为新 kind 改代码。
const KIND_LABELS = {
  char_out_of_repertoire: '集外字符',
  confusable_substitution: '易混替换',
  encoding_form_anomaly: '编码形式',
  missing_field: '缺字段',
  reading_format_invalid: '记音格式',
  punctuation_mix: '标点混用',
  page_outlier: '分页异常',
  duplicate_identity: '疑似重复合并',
  cross_source_conflict: '跨来源不一致',
  merged_columns: '疑似列合并'
}

export function hintKindLabel(kind) {
  const key = String(kind ?? '')
  return KIND_LABELS[key] || key || '机器疑点'
}

const EMPTY_HINTS = Object.freeze([])

export function prepareFieldHints(rawHints, renderedColumns) {
  if (!Array.isArray(rawHints) || !rawHints.length) return EMPTY_HINTS
  const fields = new Set(renderedColumns)
  const emphasized = []
  const regular = []
  for (const [index, hint] of rawHints.entries()) {
    const field = String(hint?.field ?? '')
    const item = {
      key: hint?.id || index,
      id: String(hint?.id || ''),
      field,
      targetField: fields.has(field) ? field : '',
      kind: String(hint?.kind || ''),
      text: renderFindingMessage(hint?.message),
      highlight: Boolean(hint?.highlight),
      inputStatus: String(hint?.input_status || 'legacy_unrecorded'),
      evidence: hint?.evidence
    }
    if (item.highlight) emphasized.push(item)
    else regular.push(item)
  }
  return [...emphasized, ...regular]
}

// ---- SourceSpan 定位（#161 期望结果 3 的"先字段内、后页图"的第一步）----
//
// evidence.char_offsets 是 [[start,end],…] 的**码位**偏移对（生产者侧 corpus_probe
// 与 #178 的 Python/JS 规则都以码位计），textarea/DOM 的 selection 是 UTF-16 索引，
// 所以必须换算；汉字表意文字补充平面（如 𰻞）会让两者相差 1/码位。
// 任何形状不符（缺省、非数组、区间倒置、越界）都返回 null——定位降级为"聚焦该字段"，
// 绝不因为证据形状问题阻断点击。

function codepointSpanToUtf16(text, start, end) {
  const chars = Array.from(text)
  if (start < 0 || end > chars.length || end <= start) return null
  let utf16Start = 0
  for (let i = 0; i < start; i += 1) utf16Start += chars[i].length
  let utf16End = utf16Start
  for (let i = start; i < end; i += 1) utf16End += chars[i].length
  return { start: utf16Start, end: utf16End }
}

export function locateSpan(text, charOffsets) {
  if (typeof text !== 'string' || !Array.isArray(charOffsets) || charOffsets.length === 0)
    return null
  for (const pair of charOffsets) {
    if (!Array.isArray(pair) || pair.length !== 2) continue
    const [rawStart, rawEnd] = pair
    if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) continue
    const span = codepointSpanToUtf16(text, rawStart, rawEnd)
    if (span) return span
  }
  return null
}

// #228/#234：被门控挡住的条数要说出来。
//
// 这条文案存在的唯一理由是：`hints: []` 有两种成因——规则没放行，或者这条真的没疑点。
// 两者在校对端长得一模一样，而后者会被读成"可以放心"。有了 suppressed_by_gate，
// 界面才能把第一种情况说成第一种。数字为 0 时返回空串（那就确实没有东西被挡住）。
export function gatedNotice(suppressed) {
  const count = Number(suppressed)
  if (!Number.isFinite(count) || count <= 0) return ''
  return `本条另有 ${Math.floor(count)} 处机器疑点暂未开放显示（规则尚未放行，不代表这条没有值得看的地方）。`
}
