import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as inspection from '../src/lib/csvInspection.js'

const source = readFileSync(
  new URL('../src/components/admin/project/ProjectCsvImport.vue', import.meta.url),
  'utf8'
)
const script = source
  .match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"]\s*\n/g, '')
function component(overrides = {}) {
  let unmount
  let refreshes = 0
  const scope = {
    ...inspection,
    ref: (value) => ({ value }),
    computed: (get) => ({
      get value() {
        return get()
      }
    }),
    onBeforeUnmount: (callback) => {
      unmount = callback
    },
    defineExpose: () => {},
    defineProps: () =>
      Object.fromEntries(
        ['refreshPages', 'refreshStats', 'refreshQuality', 'refreshLedger', 'clearSelection']
          .map((name) => [
            name,
            () => {
              refreshes++
            }
          ])
          .concat([['projectId', 'project-a']])
      ),
    createCsvInspection: async () => ({ id: 'job-a', status: 'validated' }),
    commitCsvImport: async () => ({ id: 'job-a', status: 'completed' }),
    getImportJob: async () => ({ id: 'job-a', status: 'completed' }),
    listImportJobErrors: async () => ({ items: [] }),
    listSources: async () => ({ items: [] }),
    getPbMessage: (cause) => cause.message,
    getUploadErrorMessage: (cause) => cause.message,
    window: {
      setTimeout: (resolve) => {
        resolve()
        return 1
      }
    },
    ...overrides
  }
  const instance = new Function(
    ...Object.keys(scope),
    `${script}\nreturn { uploadCsv, confirmCsvImport, refreshCsvJob, onCsvSelected, sourceId, csvFile, csvJob, csvError, csvSuccess, csvActualSource, csvSourceMismatch, csvSourceReady, csvSourceError, requestedSourceId }`
  )(...Object.values(scope))
  instance.csvFile.value = { name: 'original.csv' }
  return { ...instance, unmount: () => unmount(), refreshes: () => refreshes }
}

test('CSV inspection responses cannot publish or clear the selected file after leaving the project', async () => {
  let resolve
  const instance = component({
    createCsvInspection: () =>
      new Promise((done) => {
        resolve = done
      })
  })
  const file = instance.csvFile.value
  const request = instance.uploadCsv()
  instance.unmount()
  resolve({ id: 'old-job', status: 'validated' })
  await request
  assert.equal(instance.csvJob.value, null)
  assert.equal(instance.csvFile.value, file)
  assert.equal(instance.refreshes(), 0)
})

test('CSV poll responses are checked again after the network await', async () => {
  let resolve
  const instance = component({
    createCsvInspection: async () => ({ id: 'old-job', status: 'processing' }),
    getImportJob: () =>
      new Promise((done) => {
        resolve = done
      })
  })
  const request = instance.uploadCsv()
  while (!resolve) await new Promise(setImmediate)
  instance.unmount()
  resolve({ id: 'old-job', status: 'completed' })
  await request
  assert.equal(instance.csvJob.value.status, 'processing')
  assert.equal(instance.csvSuccess.value, '')
  assert.equal(instance.refreshes(), 0)
})

test('a late CSV commit failure cannot replace the next workspace error', async () => {
  let reject
  const instance = component({
    commitCsvImport: () =>
      new Promise((_resolve, fail) => {
        reject = fail
      })
  })
  instance.csvJob.value = { id: 'job-a', status: 'validated' }
  const request = instance.confirmCsvImport()
  instance.unmount()
  instance.csvError.value = 'new workspace'
  reject(new Error('old workspace'))
  await request
  assert.equal(instance.csvError.value, 'new workspace')
  assert.equal(instance.csvJob.value.status, 'validated')
  assert.equal(instance.refreshes(), 0)
})

const sources = [
  { id: 'source-a', logical_id: 'src-a', title: '来源 A' },
  { id: 'source-b', logical_id: 'src-b', title: '来源 B' }
]
test('replayed CSV uses the existing job source A when B was selected, and confirms only that original job', async () => {
  const commits = [],
    requests = []
  const instance = component({
    listSources: async () => ({ items: sources }),
    createCsvInspection: async (body) => {
      requests.push(body)
      return { id: 'existing-job', status: 'validated', source: 'source-a' }
    },
    commitCsvImport: async (id) => {
      commits.push(id)
      return { id, status: 'completed', source: 'source-a' }
    }
  })
  instance.sourceId.value = 'src-b'
  await instance.uploadCsv()
  assert.equal(requests[0].sourceId, 'src-b')
  assert.equal(instance.csvActualSource.value.title, '来源 A')
  assert.equal(
    instance.sourceId.value,
    'src-b',
    'the chosen input is retained, never sent as a source rewrite'
  )
  assert.equal(instance.csvSourceMismatch.value, true)
  assert.equal(instance.csvSourceReady.value, true)
  await instance.confirmCsvImport()
  assert.deepEqual(commits, ['existing-job'])
  assert.equal(instance.csvActualSource.value.id, 'source-a')
})

test('poll failure retries the known job in place without reuploading or forgetting source context', async () => {
  let uploads = 0,
    reads = 0
  const instance = component({
    listSources: async () => ({ items: sources }),
    createCsvInspection: async () => {
      uploads++
      return { id: 'existing-job', status: 'processing', source: 'source-a' }
    },
    getImportJob: async (id) => {
      assert.equal(id, 'existing-job')
      if (++reads === 1) throw new Error('temporary offline')
      return { id, status: 'validated', source: 'source-a' }
    }
  })
  instance.sourceId.value = 'src-b'
  await instance.uploadCsv()
  assert.match(instance.csvError.value, /offline/)
  assert.equal(instance.csvFile.value, null)
  assert.equal(instance.csvJob.value.id, 'existing-job')
  await instance.refreshCsvJob()
  assert.equal(uploads, 1)
  assert.equal(reads, 2)
  assert.equal(instance.csvJob.value.status, 'validated')
  assert.equal(instance.csvActualSource.value.id, 'source-a')
  assert.equal(instance.requestedSourceId.value, 'src-b')
  assert.equal(instance.csvSourceMismatch.value, true)
  assert.equal(instance.csvError.value, '')
})

test('source lookup failure blocks confirmation and a late lookup cannot cross a new file selection', async () => {
  let commits = 0,
    finishSource
  const instance = component({
    createCsvInspection: async () => ({
      id: 'existing-job',
      status: 'validated',
      source: 'source-a'
    }),
    listSources: async () => {
      throw new Error('source lookup failed')
    },
    commitCsvImport: async () => {
      commits++
    }
  })
  await instance.uploadCsv()
  assert.equal(instance.csvSourceReady.value, false)
  await instance.confirmCsvImport()
  assert.equal(commits, 0)
  const other = component({
    createCsvInspection: async () => ({ id: 'old-job', status: 'validated', source: 'source-a' }),
    listSources: () =>
      new Promise((resolve) => {
        finishSource = resolve
      })
  })
  const pending = other.uploadCsv()
  while (!finishSource) await new Promise(setImmediate)
  other.onCsvSelected({ target: { files: [{ name: 'new.csv' }] } })
  finishSource({ items: sources })
  await pending
  assert.equal(other.csvActualSource.value, null)
  assert.equal(other.csvJob.value, null)
  assert.equal(other.csvFile.value.name, 'new.csv')
})
