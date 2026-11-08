import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as helpers from '../src/lib/importErrors.js'

const job = {
  id: 'job-a',
  project: 'project-a',
  status: 'completed_with_errors',
  updated: 'v1',
  failed_count: 205,
  mode: 'csv'
}
const records = Array.from({ length: 205 }, (_, i) => ({
  id: `e-${i}`,
  row_number: i + 2,
  column_name: '读音',
  error_code: 'TEST',
  message: '合成错误',
  raw_value: ' 𠮷 a̤̍⁵³³\t\n ',
  secret: 'never exported'
}))
const paging = (items, page, size) => ({
  page,
  perPage: size,
  totalItems: items.length,
  totalPages: Math.ceil(items.length / size),
  items: items.slice((page - 1) * size, page * size)
})
const getJob = async () => ({ ...job })

test('complete report reads every page beyond the old 100-record limit and preserves original Unicode and whitespace', async () => {
  const calls = []
  const report = await helpers.readImportErrorReport(
    job,
    async (id, page, size) => {
      calls.push([id, page, size])
      return paging(records, page, size)
    },
    getJob
  )
  assert.deepEqual(calls, [
    ['job-a', 1, 100],
    ['job-a', 2, 100],
    ['job-a', 3, 100]
  ])
  assert.equal(report.record_count, 205)
  assert.equal(report.records.at(-1).row_number, 206)
  assert.equal(JSON.parse(JSON.stringify(report)).records[0].raw_value, records[0].raw_value)
  assert.equal('secret' in report.records[0], false)
  assert.equal('id' in report.records[0], false)
})

test('empty and exact page boundaries do not omit or request a fictitious last page', async () => {
  for (const size of [0, 100, 200]) {
    let calls = 0
    const report = await helpers.readImportErrorReport(
      job,
      async (_id, page, perPage) => {
        calls++
        return paging(records.slice(0, size), page, perPage)
      },
      getJob
    )
    assert.equal(report.record_count, size)
    assert.equal(calls, Math.max(1, size / 100))
  }
})

test('failed, short, repeated or changing pages never return a partial complete report', async () => {
  for (const fault of ['network', 'short', 'repeated', 'count']) {
    await assert.rejects(
      helpers.readImportErrorReport(
        job,
        async (_id, page, size) => {
          const result = paging(records, page, size)
          if (page !== 2) return result
          if (fault === 'network') throw new Error('offline')
          if (fault === 'short') result.items.pop()
          if (fault === 'repeated') result.items[0] = records[0]
          if (fault === 'count') {
            result.totalItems++
            result.totalPages = Math.ceil(result.totalItems / size)
          }
          return result
        },
        getJob
      ),
      /offline|完整|重复|变化/
    )
  }
  await assert.rejects(
    helpers.readImportErrorReport(
      job,
      async (_id, page, size) => paging(records, page, size),
      async () => ({ ...job, updated: 'v2' })
    ),
    /状态已变化/
  )
  await assert.rejects(
    helpers.readImportErrorReport(
      { ...job, status: 'processing' },
      () => assert.fail('running job must not export'),
      getJob
    ),
    /仍在处理/
  )
})

test('cancelled reports stop at the awaited boundary and cannot continue to another page', async () => {
  const controller = new AbortController()
  let finish,
    calls = 0
  const pending = helpers.readImportErrorReport(
    job,
    async (_id, page, size) => {
      calls++
      await new Promise((resolve) => {
        finish = resolve
      })
      return paging(records, page, size)
    },
    getJob,
    { signal: controller.signal }
  )
  controller.abort()
  finish()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(calls, 1)
})

const script = readFileSync(
  new URL('../src/components/admin/project/ImportErrorsPanel.vue', import.meta.url),
  'utf8'
)
  .match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"]\s*\n/g, '')
function component(overrides = {}) {
  let change, unmount
  const files = []
  const props = { projectId: 'project-a', jobId: 'job-a', revision: '' }
  const scope = {
    ...helpers,
    AbortController,
    ref: (value) => ({ value }),
    defineProps: () => props,
    useAuthStore: () => ({ user: { id: 'account-a' } }),
    watch: (_get, callback) => {
      change = callback
    },
    onBeforeUnmount: (callback) => {
      unmount = callback
    },
    getImportJob: getJob,
    listImportJobErrors: async (_id, page, size) => paging(records, page, size),
    downloadText: (...args) => files.push(args),
    getPbMessage: (cause, fallback) => cause.message || fallback,
    ...overrides
  }
  const instance = new Function(
    ...Object.keys(scope),
    `${script}\nreturn { load, download, cancelDownload, job, rows, page, total, loading, downloading, loadError, downloadError, downloadStatus }`
  )(...Object.values(scope))
  return { ...instance, props, files, change: () => change(), unmount: () => unmount() }
}

test('component paginates, downloads all records and does not announce completion on a failed later page', async () => {
  const view = component()
  await view.load(3)
  assert.equal(view.page.value, 3)
  assert.equal(view.rows.value[0].row_number, 102)
  assert.equal(view.total.value, 205)
  await view.download()
  assert.equal(JSON.parse(view.files[0][0]).record_count, 205)
  assert.match(view.downloadStatus.value, /全部 205/)
  const failed = component({
    listImportJobErrors: async (_id, page, size) => {
      if (size === 100 && page === 2) throw new Error('synthetic offline')
      return paging(records, page, size)
    }
  })
  await failed.load()
  await failed.download()
  assert.equal(failed.files.length, 0)
  assert.equal(failed.downloadStatus.value, '')
  assert.match(failed.downloadError.value, /offline/)
})

test('late load or export cannot publish after switching project, identity, cancelling, or unmounting', async () => {
  let finish
  const old = component({
    getImportJob: () =>
      new Promise((resolve) => {
        finish = resolve
      })
  })
  const read = old.load()
  old.props.projectId = 'project-b'
  // The reactive watcher also invalidates identity and job changes.
  old.unmount()
  finish(job)
  await read
  assert.equal(old.job.value, null)
  for (const action of ['cancel', 'switch', 'unmount']) {
    const view = component({
      readImportErrorReport: () =>
        new Promise((resolve) => {
          finish = resolve
        })
    })
    await view.load()
    const download = view.download()
    if (action === 'cancel') view.cancelDownload()
    else if (action === 'unmount') view.unmount()
    else {
      view.props.projectId = 'project-b'
      view.change()
    }
    finish({ record_count: 205, records: [] })
    await download
    assert.equal(view.files.length, 0, action)
    assert.doesNotMatch(view.downloadStatus.value, /已下载/)
  }
})
