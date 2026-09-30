import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EMPTY_MESSAGES,
  gatedOffCount,
  emptyReason,
  kindBreakdown,
  recomputeNotice,
  severityCount,
  truncatedNotice
} from '../src/lib/assistOverview.js'

test('空列表的四种成因互斥且各有说法', () => {
  const item = { kind: 'missing_field', severity: 'strong' }
  assert.equal(emptyReason({ items: [item], everRun: true, pagesScanned: 3 }), 'has-findings')
  assert.equal(emptyReason({ items: [], everRun: false, pagesScanned: 3 }), 'never-run')
  assert.equal(emptyReason({ items: [], everRun: true, pagesScanned: 0 }), 'no-entries')
  assert.equal(emptyReason({ items: [], everRun: true, pagesScanned: 5 }), 'clean')
  // never-run 的文案必须点明"这不表示资料干净"，否则空列表就会被读成后者。
  assert.match(EMPTY_MESSAGES['never-run'], /不表示资料干净/)
  assert.equal(EMPTY_MESSAGES.clean, '跑过了，当前批次没有疑点。')
  assert.notEqual(EMPTY_MESSAGES['never-run'], EMPTY_MESSAGES.clean, '两种空态不许共用一句话')
})

test('缺字段与缺参数时不许崩，也不许编数', () => {
  assert.deepEqual(kindBreakdown(undefined), [])
  assert.equal(gatedOffCount(null), 0)
  assert.equal(severityCount([null, {}, { severity: 'warn' }], 'warn'), 1)
  assert.equal(emptyReason({}), 'never-run')
  assert.equal(recomputeNotice(null), '')
  assert.equal(recomputeNotice({}), '')
  assert.equal(recomputeNotice({ pages: 2 }).includes('NaN'), false)
})

test('重算摘要里缺哪个字段就少说哪句，不猜', () => {
  const text = recomputeNotice({ pages: 500, findings: 12, duration_ms: 1958, unanchored: 2 })
  assert.match(text, /扫了 500 条/)
  assert.match(text, /产出 12 条疑点/)
  assert.match(text, /用时 1958 ms/)
  assert.match(text, /有 2 条找不到挂靠条目/)
  assert.equal(text.includes('下线旧批次'), false, '摘要里没有 superseded 就不该说它')
})

test('跨行重算的两个可见缺口都必须被说出来', () => {
  const stale = recomputeNotice({ pages: 3, findings: 2, difficulty_stale: true }, { identity: true })
  assert.match(stale, /再点一次「按项目重算疑点」/, `tier 过期不说出去，管理员就会拿旧分层去筛任务：${stale}`)
  const unattributed = recomputeNotice({ pages: 3, findings: 2, unattributed_groups: 4 }, { identity: true })
  assert.match(unattributed, /4 组有分歧但登记来源不足以判成跨来源冲突/)
  const plain = recomputeNotice({ pages: 3, findings: 2 }, {})
  assert.equal(plain.includes('登记来源'), false, '普通疑点重算不该报跨行专属的字段')
})

test('截断信号有出口：门控表截断与列表分页是两件事', () => {
  assert.match(truncatedNotice({ gate_rows_truncated: true }), /按 off 处理/)
  assert.match(truncatedNotice({ hasMore: true }), /下一页/)
  assert.equal(truncatedNotice({ gate_rows_truncated: false, hasMore: false }), '')
  assert.equal(truncatedNotice(null), '')
})

test('按 kind 汇总的顺序稳定且标签来自同一个词表', () => {
  const rows = kindBreakdown([
    { kind: 'merged_columns' }, { kind: 'merged_columns' },
    { kind: 'missing_field' }, { kind: 'page_outlier' }
  ])
  assert.deepEqual(rows.map((r) => r.kind), ['merged_columns', 'missing_field', 'page_outlier'])
  assert.deepEqual(rows.map((r) => r.count), [2, 1, 1])
  // 同数量按 kind 名排序，保证两次渲染逐字一致
  const tied = kindBreakdown([{ kind: 'page_outlier' }, { kind: 'missing_field' }])
  assert.deepEqual(tied.map((r) => r.kind), ['missing_field', 'page_outlier'])
  assert.equal(rows[0].label, '疑似列合并')
  assert.equal(kindBreakdown([{ kind: 'brand_new_kind' }])[0].label, 'brand_new_kind',
    '未知 kind 要原样回显而不是编一个中文标签')
})

test('off 档计数只数 gate 明确为 off 的条目', () => {
  assert.equal(gatedOffCount([
    { gate: 'off' }, { gate: 'off' }, { gate: 'warn' }, { gate: 'strong' }, {}
  ]), 2)
})
