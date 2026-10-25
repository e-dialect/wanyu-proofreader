import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getPbMessage } from '../src/utils/pbErrors.js'

// Exercise the component's real callback and its error formatter. Keep this
// independent of the Vue template so pending promises can be controlled.
const source = readFileSync(new URL('../src/views/admin/SourceFidelityView.vue', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')
const callback = source.match(/async function download\(mode, process = false\) \{[\s\S]*?\n\}/)?.[0]
assert.ok(callback, 'source verification must provide its download callback')
assert.match(source, /import \{ getPbMessage \} from '@\/utils\/pbErrors'/)

function workspace({ previousSuccess = '', previousError = '', fileError } = {}) {
  const busy = { value: false }
  const message = { value: previousSuccess }
  const operationError = { value: previousError }
  const requests = []
  const files = []
  const bindings = {
    busy, message, operationError, projectId: 'synthetic-project', getPbMessage,
    exportVerification(project, mode) {
      return new Promise((resolve, reject) => requests.push({ project, mode, resolve, reject }))
    },
    downloadText(text, name, type) {
      if (fileError) throw fileError
      files.push({ text, name, type })
    }
  }
  const download = new Function(...Object.keys(bindings), `return (${callback})`)(...Object.values(bindings))
  return { busy, message, operationError, requests, files, download }
}

const result = { version: 'source-fidelity-export-v1', mode: 'all', csv: '\uFEFF词条,记音\r\n合成,ka533', selected_count: 1, records: [{ id: 'synthetic-entry' }] }

for (const [name, process] of [['CSV', false], ['process JSON', true]]) {
  const expectedMessage = process ? '关联过程已导出，包含未完成、无提示及未记录状态。' : '已导出 1 条内容。'

  test(`${name}: a second export clears earlier success, reports failure and can retry`, async () => {
    const state = workspace()
    const first = state.download('all', process)
    state.requests[0].resolve(result)
    await first
    assert.equal(state.message.value, expectedMessage)
    assert.equal(state.files.length, 1)

    const failed = state.download('all', process)
    assert.equal(state.busy.value, true)
    assert.equal(state.message.value, '', 'previous success is cleared while the new export is pending')
    assert.equal(state.operationError.value, '')
    state.requests[1].reject(new Error('合成网络故障'))
    await failed
    assert.equal(state.busy.value, false)
    assert.equal(state.message.value, '', 'a failed export must not keep an earlier success')
    assert.equal(state.operationError.value, '合成网络故障')
    assert.equal(state.files.length, 1, 'a failed response cannot create a download')

    const retried = state.download('all', process)
    assert.equal(state.busy.value, true)
    assert.equal(state.message.value, '')
    assert.equal(state.operationError.value, '', 'retry clears the earlier error immediately')
    state.requests[2].resolve(result)
    await retried
    assert.equal(state.busy.value, false)
    assert.equal(state.message.value, expectedMessage)
    assert.equal(state.operationError.value, '')
    assert.equal(state.files.length, 2)
    assert.deepEqual(state.requests.map(({ project, mode }) => ({ project, mode })), Array(3).fill({ project: 'synthetic-project', mode: 'all' }))
    const file = state.files[1]
    if (process) {
      const { csv, ...bundle } = result
      void csv
      assert.deepEqual(JSON.parse(file.text), bundle)
      assert.equal(file.name, 'synthetic-project_过程记录.json')
      assert.equal(file.type, 'application/json')
    } else {
      assert.equal(file.text, result.csv)
      assert.equal(file.name, 'synthetic-project_all.csv')
      assert.equal(file.type, 'text/csv;charset=utf-8')
    }
  })

  test(`${name}: export clears a successful workspace operation and an old error`, async () => {
    const state = workspace({ previousSuccess: '新约定版本已保存，旧依据仍保留。', previousError: '较早的操作失败' })
    const pending = state.download('completed', process)
    assert.equal(state.busy.value, true)
    assert.equal(state.message.value, '')
    assert.equal(state.operationError.value, '')
    state.requests[0].reject({ response: { message: '合成拒绝：本次导出不可用' } })
    await pending
    assert.equal(state.busy.value, false)
    assert.equal(state.message.value, '')
    assert.equal(state.operationError.value, '合成拒绝：本次导出不可用')
    assert.equal(state.files.length, 0)
    assert.equal(state.requests[0].mode, 'completed')
  })

  test(`${name}: a browser download error cannot announce success`, async () => {
    const state = workspace({ previousSuccess: '先前的操作成功', fileError: new Error('合成浏览器下载故障') })
    const pending = state.download('all', process)
    state.requests[0].resolve(result)
    await pending
    assert.equal(state.busy.value, false)
    assert.equal(state.message.value, '')
    assert.equal(state.operationError.value, '合成浏览器下载故障')
    assert.equal(state.files.length, 0)
  })
}
