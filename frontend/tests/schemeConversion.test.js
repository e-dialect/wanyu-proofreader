import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  adapterNotice,
  conversionJobStatusLabel,
  conversionSummaryLines,
  normalizationBadgeClass,
  normalizationStatusLabel
} from '../src/lib/schemeConversion.js'

const style = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const job = (overrides) => ({
  total_count: 10000, exact_count: 9000, reviewed_count: 720,
  ambiguous_count: 241, unsupported_count: 39, skipped_count: 0, failed_count: 0,
  ...overrides
})

test('自动确定 sums EXACT and REVIEWED', () => {
  // #114 §8 的「共处理 10000 / 自动确定 9720 / 需人工确认 241 / 暂未支持 39」
  // 就是这四个数对得上；把 REVIEWED 单列会让 9720 这个数字算不出来。
  const lines = conversionSummaryLines(job())
  const byKey = Object.fromEntries(lines.map((line) => [line.key, line.count]))
  assert.equal(byKey.total, 10000)
  assert.equal(byKey.auto, 9720)
  assert.equal(byKey.ambiguous, 241)
  assert.equal(byKey.unsupported, 39)
})

test('四行之和加跳过等于共处理', () => {
  // 两条不变式一起钉：四行互不重叠，且没有第 6 个没被列出来的分支。
  for (const sample of [job(), job({ skipped_count: 12, total_count: 10012 }), job({ total_count: 0, exact_count: 0, reviewed_count: 0, ambiguous_count: 0, unsupported_count: 0 })]) {
    const lines = conversionSummaryLines(sample)
    const byKey = Object.fromEntries(lines.map((line) => [line.key, line.count]))
    assert.equal(
      byKey.auto + byKey.ambiguous + byKey.unsupported + byKey.skipped,
      byKey.total,
      JSON.stringify(sample)
    )
  }
})

test('缺字段的作业显示 0 而不是 NaN', () => {
  const lines = conversionSummaryLines(null)
  for (const line of lines) assert.equal(line.count, 0)
  assert.equal(conversionJobStatusLabel(undefined), '未开始')
  assert.equal(normalizationStatusLabel(''), '未转换')
})

test('未转换的条目要能与「转换过但不是这个状态」区分开', () => {
  assert.equal(normalizationStatusLabel('AMBIGUOUS'), '需人工确认')
  assert.equal(normalizationStatusLabel('NOPE'), 'NOPE', '取值表外的状态原样显示，不能吞成空白')
  assert.equal(conversionJobStatusLabel('failed'), '失败')
})

test('every badge class exists in the stylesheet', () => {
  // #129 记过一类债：引用了不存在的类名，静默走 fallback，页面上看不出来。
  for (const status of ['EXACT', 'REVIEWED', 'AMBIGUOUS', 'UNSUPPORTED', 'UNKNOWN']) {
    for (const name of normalizationBadgeClass(status).split(/\s+/)) {
      assert.match(style, new RegExp(`\\.${name}\\s*\\{`), `${name} must exist in style.css`)
    }
  }
})

test('adapter notice is shown as configuration, not as a result', () => {
  assert.equal(adapterNotice({ notice: '' }), '')
  assert.equal(adapterNotice(null), '')
  assert.match(adapterNotice({ notice: '本实例没有配置规则目录（环境变量 FANGJI_SCHEME_ADAPTER_DIR）' }),
    /没有配置规则目录/)
})
