#!/usr/bin/env node
// Local research artifacts. Reference readings are supplied by humans, saved
// before comparison, and never sent to runtime routing or rule engines.
import { parseArgs } from 'node:util'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const comparison = createRequire(import.meta.url)('../../backend/pb_hooks/lib/source_comparison.js')
const digest = value => createHash('sha256').update(value).digest('hex')
const readJSON = async file => JSON.parse(await readFile(file, 'utf8'))
const saveJSON = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
function studyView(raw) {
  if (!raw?.id || raw.snapshot?.version !== 'source-study-v1') throw new Error('需要 freeze 返回的完整研究快照')
  return raw
}
function requireValue(values, key) { if (!values[key]) throw new Error(`缺少 --${key}`); return values[key] }

export async function makeBlindPackage(study, sources, output) {
  studyView(study)
  // mkdir without recursive/writes with wx deliberately refuses to overwrite a
  // filled reference or an earlier blind package.
  await mkdir(output)
  await mkdir(path.join(output, 'sources'))
  const copied = new Set()
  const materials = []
  const references = []
  for (const item of study.snapshot.materials) {
    const source = item.context.source
    if (!source || !/^[a-z0-9]{15}$/.test(source.id) || path.basename(source.file) !== source.file) throw new Error('来源文件标识无效')
    if (!copied.has(source.id)) {
      const input = path.join(sources, source.file)
      const bytes = await readFile(input)
      if (digest(bytes) !== source.hash) throw new Error(`来源 PDF 摘要不符：${source.name}`)
      await copyFile(input, path.join(output, 'sources', `${source.id}.pdf`))
      copied.add(source.id)
    }
    const fields = Object.keys(item.context.input)
    const readers = study.snapshot.assignments.filter(assignment => assignment.material_id === item.material_id && assignment.role === 'reference')
    materials.push({ material_id: item.material_id, provenance: item.provenance, split: item.split, source: `sources/${source.id}.pdf`, physical_page: item.context.pdf_page, fields,
      convention: { instructions: item.context.policy.instructions, reading_fields: item.context.policy.reading_fields, tone_equivalence: item.context.policy.tone_equivalence, comparison_version: item.context.policy.comparison_version } })
    for (const reader of readers) for (const field of fields) references.push({ material_id: item.material_id, field, participant: reader.participant, state: 'unrecorded', value: '', alternatives: [], location: '', reason: '', read_at: null })
  }
  const identity = { study: study.id, snapshot_hash: digest(JSON.stringify(study.snapshot)), version: 'independent-source-reference-v1' }
  await saveJSON(path.join(output, 'materials.json'), { ...identity, materials, instructions: '只对照所附来源 PDF 判读。此材料包不包含导入答案、机器提示或校对提交。先保存实际判读，再进入评价比较。' })
  await saveJSON(path.join(output, 'reference-template.json'), { ...identity, demonstration: false, entries: references })
  await saveJSON(path.join(output, 'effort-template.json'), { study: study.id, entries: study.snapshot.assignments.filter(item => ['maintenance', 'arbitration', 'feedback'].includes(item.role)).map(item => ({ participant: item.participant, role: item.role, material_id: item.material_id, started_at: null, ended_at: null, note: '' })) })
  return { materials: materials.length, reference_fields: references.length }
}

export function validateReference(reference) {
  if (reference.version !== 'independent-source-reference-v1' || !Array.isArray(reference.entries)) throw new Error('参照记录格式无效')
  const seen = new Set()
  for (const item of reference.entries) {
    const key = `${item.material_id}\u0000${item.field}\u0000${item.participant}`
    if (seen.has(key)) throw new Error('参照字段重复')
    seen.add(key)
    if (!['readable', 'blank', 'unreadable', 'unrecorded'].includes(item.state) || typeof item.value !== 'string' || !Array.isArray(item.alternatives) || item.alternatives.some(value => typeof value !== 'string')) throw new Error('参照状态或实际判读无效')
    if (item.state === 'readable' && !item.value) throw new Error('可判读内容须保存实际值；原文无内容请标 blank')
    if (item.state !== 'readable' && (item.value || item.alternatives.length)) throw new Error('空白、不可判读或未记录不能携带推测答案')
    if (item.state === 'unreadable' && !String(item.reason || '').trim()) throw new Error('暂不可判读时须记录原因')
    if (item.read_at !== null && item.read_at !== undefined && !Number.isFinite(Date.parse(item.read_at))) throw new Error('判读时间无效；未测量时保留 null')
  }
  return reference
}
export function sealReference(reference) {
  validateReference(reference)
  return { ...reference, sealed_at: new Date().toISOString(), reading_digest: digest(JSON.stringify(reference.entries)), provenance: 'independent_source_reference' }
}
function tally(items) {
  const known = items.filter(item => typeof item.correct === 'boolean')
  return { correct: known.filter(item => item.correct).length, incorrect: known.filter(item => !item.correct).length, denominator: known.length, unknown: items.length - known.length, accuracy: known.length ? known.filter(item => item.correct).length / known.length : null }
}
function timingFor(session, events) {
  const stream = events.filter(event => event.ref === session.id && ['research_event', 'research_submission'].includes(event.kind)).sort((a, b) => String(a.at).localeCompare(String(b.at)))
  let start = null, duration = 0, complete = true, hasInterval = false, finished = false
  for (const event of stream) {
    if (finished) continue
    const type = event.kind === 'research_submission' ? 'submit' : event.payload.type
    const stamp = event.at
    const time = stamp ? Date.parse(stamp) : NaN
    if (!Number.isFinite(time)) { complete = false; continue }
    if (['start', 'resume', 'effort_start'].includes(type)) {
      if (session.role === 'proofreader' && (event.payload.visibility !== 'visible' || event.payload.focus !== true)) complete = false
      if (start !== null) complete = false
      start = time
    } else if (['pause', 'interruption', 'abandon', 'submit', 'effort_end'].includes(type)) {
      if (start === null || time < start) complete = false
      else { duration += time - start; hasInterval = true }
      start = null
    }
    if (type === 'interruption') complete = false
    if (['submit', 'abandon', 'effort_end'].includes(type)) finished = true
    if (type === 'submit' && event.payload.timing_events_complete !== true) complete = false
  }
  if (start !== null || session.recording_incomplete) complete = false
  return { session: session.id, participant: session.participant, condition: session.condition, role: session.role, measured_ms: complete && hasInterval ? duration : null, complete, reason: complete && hasInterval ? 'server_observed_foreground_intervals' : 'missing_or_interrupted_events', hint_duration: null }
}
export function evaluate(study, reference, process, effort = { entries: [] }) {
  studyView(study); validateReference(reference)
  if (!reference.sealed_at || reference.reading_digest !== digest(JSON.stringify(reference.entries))) throw new Error('参照须先 seal-reference 保存；密封后修改须另存新版本重新密封')
  if (reference.study !== study.id || reference.snapshot_hash !== digest(JSON.stringify(study.snapshot))) throw new Error('参照与冻结材料版本不一致')
  const assignments = study.snapshot.assignments
  const fields = []
  const rows = []
  const finalFields = []
  for (const material of study.snapshot.materials) {
    const readers = assignments.filter(item => item.material_id === material.material_id && item.role === 'reference')
    for (const reader of readers) {
      if ((process.attempts || []).some(attempt => attempt.page === material.page && attempt.proofreader === reader.user)) throw new Error('独立参照者已提交同一材料的校对，角色隔离不成立')
    }
    const materialRefs = reference.entries.filter(item => item.material_id === material.material_id)
    for (const item of materialRefs) if (!readers.some(reader => reader.participant === item.participant)) throw new Error('参照者不在冻结的独立参照分配中')
    const decide = (field, value) => {
      const candidates = materialRefs.filter(item => item.field === field && ['readable', 'blank'].includes(item.state))
      if (!candidates.length) return { correct: null, status: materialRefs.some(item => item.field === field && item.state === 'unreadable') ? 'source_unreadable' : 'reference_unrecorded' }
      // Multiple independent readers must agree under the same convention before
      // an automated score is produced; no majority vote manufactures truth.
      const policy = material.context.policy
      const accepted = candidates.map(item => [item.value, ...item.alternatives])
      if (!accepted.every(values => values.some(a => accepted[0].some(b => comparison.equivalent(a, b, field, policy))))) return { correct: null, status: 'reference_disagreement' }
      return { correct: accepted.every(values => values.some(answer => comparison.equivalent(value, answer, field, policy))), status: 'independent_source_reference' }
    }
    for (const assignment of assignments.filter(item => item.material_id === material.material_id && item.role === 'proofreader')) {
      const attempts = (process.attempts || []).filter(attempt => {
        const context = JSON.parse(attempt.verification_context_json || '{}')
        return attempt.page === material.page && attempt.proofreader === assignment.user && attempt.kind === 'proofread' && context.basis === material.context.basis && context.research_session?.study === study.id && context.research_session?.condition === assignment.condition
      })
      const attempt = attempts.at(-1)
      const row = attempt ? JSON.parse(attempt.row_json) : null
      const rowFields = []
      for (const field of Object.keys(material.context.input)) {
        const result = row ? decide(field, row[field]) : { correct: null, status: 'unsubmitted_or_version_mismatch' }
        const item = { study: study.id, material_id: material.material_id, page: material.page, field, attempt: attempt?.id || null, participant: assignment.participant, condition: assignment.condition, ...result }
        fields.push(item); rowFields.push(item)
      }
      rows.push({ material_id: material.material_id, participant: assignment.participant, condition: assignment.condition, correct: rowFields.every(item => typeof item.correct === 'boolean') ? rowFields.every(item => item.correct) : null })
    }
    const final = (process.records || []).find(item => item.id === material.page && item.value_source === 'final_adopted_value' && item.context.basis === material.context.basis)
    for (const field of Object.keys(material.context.input)) finalFields.push({ material_id: material.material_id, field, ...(final ? decide(field, final.row[field]) : { correct: null, status: 'no_final_value_or_version_mismatch' }) })
  }
  const manualEffort = (effort.entries || []).map(item => {
    if (!assignments.some(assignment => assignment.participant === item.participant && assignment.role === item.role && assignment.material_id === item.material_id)) throw new Error('投入记录须关联冻结的参与者职责与材料')
    const start = item.started_at ? Date.parse(item.started_at) : NaN
    const end = item.ended_at ? Date.parse(item.ended_at) : NaN
    if ((item.started_at && !Number.isFinite(start)) || (item.ended_at && !Number.isFinite(end)) || end < start) throw new Error('人工投入起止时间无效')
    return { ...item, measured_ms: Number.isFinite(start) && Number.isFinite(end) ? end - start : null }
  })
  return { version: 'source-study-evaluation-v1', study: study.id, implementation_version: study.snapshot.implementation_version, compared_at: new Date().toISOString(), reference_sealed_at: reference.sealed_at, demonstration: reference.demonstration === true || study.snapshot.demonstration === true,
    field_results: fields, row_results: rows, final_field_results: finalFields,
    by_condition: Object.fromEntries(['current', 'new'].map(condition => [condition, { fields: tally(fields.filter(item => item.condition === condition)), rows: tally(rows.filter(item => item.condition === condition)) }])),
    final: tally(finalFields), timings: (process.sessions || []).filter(session => session.study === study.id).map(session => timingFor(session, process.events || [])), manual_effort: manualEffort,
    limitations: ['业务仲裁、操作记录与独立来源参照分开。', '暂不可判读、未完成及记录缺失不计正误分母；整条需全部字段已判定。', '提示呈现不等于阅读；不推算每条提示耗时；用时缺失保持 null。', '构造材料或演示结果不能作为真人研究完成或方法有效的证据。'] }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['url', 'project', 'config', 'study', 'sources', 'out', 'input', 'reference', 'process', 'effort'].map(name => [name, { type: 'string' }])) })
  const command = positionals[0]
  if (command === 'freeze') {
    const token = process.env.PB_AUTH_TOKEN
    if (!token) throw new Error('请通过 PB_AUTH_TOKEN 环境变量提供项目管理凭证')
    const response = await fetch(`${requireValue(values, 'url').replace(/\/$/, '')}/api/fangji/projects/${encodeURIComponent(requireValue(values, 'project'))}/research/freeze`, { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify(await readJSON(requireValue(values, 'config'))) })
    if (!response.ok) throw new Error(`冻结失败：${response.status} ${await response.text()}`)
    await saveJSON(requireValue(values, 'out'), await response.json())
  } else if (command === 'package') console.log(await makeBlindPackage(await readJSON(requireValue(values, 'study')), requireValue(values, 'sources'), requireValue(values, 'out')))
  else if (command === 'seal-reference') await saveJSON(requireValue(values, 'out'), sealReference(await readJSON(requireValue(values, 'input'))))
  else if (command === 'evaluate') await saveJSON(requireValue(values, 'out'), evaluate(await readJSON(requireValue(values, 'study')), await readJSON(requireValue(values, 'reference')), await readJSON(requireValue(values, 'process')), values.effort ? await readJSON(values.effort) : undefined))
  else throw new Error('命令：freeze / package / seal-reference / evaluate；参数见 scripts/research/README.md')
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(error.message); process.exitCode = 1 })
