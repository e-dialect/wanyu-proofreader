import { jobObserverScope } from './helpers/jobObserverScope.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { MAX_BUNDLE_BYTES, bundleTerminal, readBundleDeclaration } from '../src/lib/reviewBundle.js'

function archive(manifest, method) {
  const name = Buffer.from('materials/manifest.json')
  const raw = Buffer.from(JSON.stringify(manifest))
  const data = method === 8 ? deflateRawSync(raw) : raw
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50)
  local.writeUInt16LE(name.length, 26)
  const directory = Buffer.alloc(46)
  directory.writeUInt32LE(0x02014b50)
  directory.writeUInt16LE(method, 10)
  directory.writeUInt32LE(data.length, 20)
  directory.writeUInt32LE(raw.length, 24)
  directory.writeUInt16LE(name.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(local.length + name.length + data.length, 16)
  return new Blob([local, name, data, directory, name, end])
}

test('stored and deflated ZIP declarations display the exact original source and requested fields', async () => {
  const declaration = {
    source_system: '资料系统',
    source_project: 'project-a',
    source_id: ' ɕʰ ã ',
    source_version: 'v2',
    rights_ref: 'src-test',
    requested_fields: ['词', '音标']
  }
  for (const method of [0, 8])
    assert.deepEqual(await readBundleDeclaration(archive(declaration, method)), declaration)
  await assert.rejects(readBundleDeclaration(new Blob(['bad zip'])), /清单/)
  await assert.rejects(readBundleDeclaration({ size: MAX_BUNDLE_BYTES + 1 }), /20MB/)
})

const source = readFileSync(
  new URL('../src/components/admin/project/ProjectBundleImport.vue', import.meta.url),
  'utf8'
)
const script = source
  .match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"]\s*\n/g, '')
function component(overrides = {}) {
  const cleanup = []
  const events = []
  const scope = {
    ...jobObserverScope(cleanup),
    defineProps: () => ({ projectId: 'project-a' }),
    defineEmits: () => (value) => events.push(value),
    defineExpose: () => {},
    MAX_BUNDLE_BYTES,
    useAuthStore: () => ({ isPlatformAdmin: true }),
    getSource: async (reference) => ({ id: 'source-a', logical_id: reference, title: '合成来源' }),
    getPbStatus: (cause) => cause.status || 0,
    bundleTerminal,
    readBundleDeclaration: async () => ({ rights_ref: 'src-test' }),
    validateReviewBundle: async () => ({ ok: true, entry_count: 2, rights_ref: 'src-test' }),
    createBundleImport: async () => ({
      project: 'project-a',
      id: 'job-a',
      status: 'completed',
      success_count: 2
    }),
    getImportJob: async () => ({ project: 'project-a', id: 'job-a', status: 'completed' }),
    listImportJobErrors: async () => ({ items: [] }),
    getPbMessage: (cause, fallback) => cause.message || fallback,
    setTimeout: () => 1,
    clearTimeout: () => {},
    ...overrides
  }
  const instance = new Function(
    ...Object.keys(scope),
    `${script}\nreturn { checkSource, sourceState, rightsReference, chooseFile, inspect, submit, refreshJob, reset, file, report, declaration, job, jobTarget, busy, error, acknowledged, uncertain, alreadyImported, hasPendingWork }`
  )(...Object.values(scope))
  return { ...instance, events, unmount: () => cleanup.forEach((fn) => fn()) }
}
const pick = (instance) => {
  const file = { name: 'original.zip', size: 100 }
  instance.chooseFile({ target: { files: [file] } })
  return file
}

test('validation is read-only and refused reports cannot submit', async () => {
  let writes = 0
  const instance = component({
    validateReviewBundle: async () => ({
      ok: false,
      entry_count: 0,
      errors: [{ code: 'manifest_missing', message: '缺少清单' }]
    }),
    createBundleImport: async () => {
      writes++
    }
  })
  const file = pick(instance)
  await instance.inspect()
  instance.acknowledged.value = true
  await instance.submit()
  assert.equal(writes, 0)
  assert.deepEqual(instance.file.value, file)
  assert.equal(instance.report.value.errors[0].code, 'manifest_missing')
})

test('unknown submission retains the exact file and recovers the existing idempotent job', async () => {
  const calls = []
  const instance = component({
    createBundleImport: async ({ file }) => {
      calls.push(file)
      if (calls.length === 1) throw Object.assign(new Error('网络中断'), { status: 0 })
      return {
        status: 'already_imported',
        job: { project: 'project-a', id: 'existing-job', status: 'completed', success_count: 2 }
      }
    }
  })
  const file = pick(instance)
  await instance.inspect()
  await instance.submit()
  assert.equal(calls.length, 0, 'human confirmation is required')
  instance.acknowledged.value = true
  await instance.submit()
  assert.equal(instance.uncertain.value, true)
  assert.equal(instance.hasPendingWork.value, true)
  assert.deepEqual(instance.file.value, file)
  await instance.submit()
  assert.deepEqual(calls, [file, file])
  assert.equal(instance.job.value.id, 'existing-job')
  assert.equal(instance.alreadyImported.value, true)
  assert.equal(instance.uncertain.value, false)
  assert.equal(instance.hasPendingWork.value, false)
  assert.deepEqual(instance.events, ['changed'])
})

test('422 import refusal stays visible and cannot be mistaken for an accepted job', async () => {
  const refusal = {
    ok: false,
    entry_count: 0,
    errors: [{ code: 'checksum', message: '校验和不一致' }]
  }
  const instance = component({
    createBundleImport: async () => {
      throw { status: 422, response: refusal, message: '拒绝' }
    }
  })
  pick(instance)
  await instance.inspect()
  instance.acknowledged.value = true
  await instance.submit()
  assert.deepEqual(instance.report.value, refusal)
  assert.equal(instance.uncertain.value, false)
  assert.equal(instance.job.value, null)
})

test('late validation and polling responses cannot replace another project or an unmounted workspace', async () => {
  let resolve
  const instance = component({
    validateReviewBundle: () =>
      new Promise((done) => {
        resolve = done
      })
  })
  pick(instance)
  const pending = instance.inspect()
  instance.reset()
  resolve({ ok: true, entry_count: 2 })
  await pending
  assert.equal(instance.report.value, null)
  assert.equal(instance.busy.value, false)
  let resolveJob
  const other = component({
    getImportJob: () =>
      new Promise((done) => {
        resolveJob = done
      })
  })
  other.jobTarget.value = { project: 'project-a', id: 'old-job', status: 'processing' }
  const read = other.refreshJob()
  await Promise.resolve()
  other.unmount()
  resolveJob({ project: 'project-a', id: 'old-job', status: 'completed' })
  await read
  assert.equal(other.job.value.status, 'processing')
  assert.deepEqual(other.events, [])
})

test('a missing registry entry blocks import, then rechecking keeps the exact file and enables confirmation', async () => {
  let exists = false
  let writes = 0
  const instance = component({
    readBundleDeclaration: async () => {
      throw new Error('浏览器无法展开')
    },
    getSource: async (reference) => {
      assert.equal(
        reference,
        'src-test',
        'use the server-parsed declaration even without browser decompression'
      )
      if (!exists) throw { status: 404 }
      return { id: 'source-a', logical_id: reference, title: '合成来源' }
    },
    createBundleImport: async () => {
      writes++
      return { id: 'job-a', project: 'project-a', status: 'queued' }
    }
  })
  const file = pick(instance)
  await instance.inspect()
  assert.equal(instance.sourceState.value, 'missing')
  instance.acknowledged.value = true
  await instance.submit()
  assert.equal(writes, 0)
  exists = true
  await instance.checkSource()
  assert.equal(instance.sourceState.value, 'ready')
  assert.deepEqual(instance.file.value, file)
  await instance.submit()
  assert.equal(writes, 1)
})

test('forbidden and unavailable registry reads remain unknown instead of declaring a source missing', async () => {
  for (const status of [403, 500, 0]) {
    const instance = component({
      getSource: async () => {
        throw { status }
      }
    })
    pick(instance)
    await instance.inspect()
    assert.equal(instance.sourceState.value, 'error')
    assert.equal(instance.job.value, null)
  }
})
