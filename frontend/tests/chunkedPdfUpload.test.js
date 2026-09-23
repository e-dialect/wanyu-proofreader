import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  hashPdfFile,
  loadPdfUploadResume,
  savePdfUploadResume,
  uploadPdfInChunks,
  retryUploadRequest,
  validatePdfFile
} from '../src/lib/chunkedPdfUpload.js'
const size = 1024 * 1024
const file = () => new File([new Uint8Array(size * 2 + 9)], 'book.pdf')
const sleep = async () => {}
function memoryStorage() {
  const data = new Map()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key)
  }
}
const hash = 'a'.repeat(64)
test('selection validation rejects empty, oversized, and non-PDF files before upload', () => {
  for (const candidate of [
    { name: 'empty.pdf', size: 0 },
    { name: 'large.pdf', size: 100 * 1024 * 1024 + 1 },
    { name: 'notes.txt', size: 1 }
  ]) assert.throws(() => validatePdfFile(candidate), /PDF 文件/)
  assert.doesNotThrow(() => validatePdfFile({ name: 'book.PDF', size: 1 }))
})
test('uploads sequential chunks and retries lost responses without duplicating session or completion', async () => {
  const seen = [], progress = [], keys = new Set(), failures = new Set()
  const result = await uploadPdfInChunks({ projectId: 'p', file: file(), sleep, contentHash: hash, onProgress: n => progress.push(n), send: async (path, req) => {
    seen.push(path)
    if (path.endsWith('pdf-uploads')) { keys.add(req.body.requestId); assert.equal(req.body.contentHash, hash); if (keys.size === 1 && seen.length === 1) throw {status:0}; return {id:'u',chunkSize:size} }
    if (path.includes('/chunks/')) {
      const i = Number(path.split('/').at(-1)); assert.equal(req.body.size, i === 2 ? 9 : size)
      if (i === 1 && !failures.has(path)) { failures.add(path); throw {status:503} }
      return
    }
    if (!failures.has(path)) { failures.add(path); throw {status:0} }
    return {id:'same-file',status:'processing'}
  } })
  assert.equal(result.id,'same-file'); assert.equal(keys.size,1)
  assert.deepEqual(progress,[0,49,99,100])
  assert.equal(seen.filter(p=>p.endsWith('/complete')).length,2)
})
test('permission errors do not retry and do not cancel a session the user can no longer manage', async () => {
  const methods=[]
  await assert.rejects(uploadPdfInChunks({projectId:'p',file:file(),sleep,contentHash:hash,send:async(path,req)=>{
    methods.push(req.method); if(req.method==='POST') return {id:'u',chunkSize:size}
    if(req.method==='PUT') throw Object.assign(new Error('revoked'),{status:403})
  }}),/revoked/)
  assert.deepEqual(methods,['POST','PUT'])
})
test('a rejected create still attempts cleanup so the user slot is not stranded', async () => {
  const methods=[]
  await assert.rejects(uploadPdfInChunks({projectId:'p',file:file(),sleep,contentHash:hash,send:async(path,req)=>{
    methods.push(req.method)
    if(req.method==='POST') throw Object.assign(new Error('forbidden'),{status:403})
  }}),/forbidden/)
  assert.deepEqual(methods,['POST','POST'])
})
test('transient errors retry at most three times; abort stops retry',async()=>{
 let calls=0; await assert.rejects(retryUploadRequest(async()=>{calls++;throw Error('offline')},{sleep}),/offline/);assert.equal(calls,4)
 const controller=new AbortController();calls=0
 await assert.rejects(retryUploadRequest(async()=>{calls++;controller.abort();throw Error('offline')},{sleep,signal:controller.signal}));assert.equal(calls,1)
})
test('cancellation recovers lost creation response and deletes the session',async()=>{
 const controller=new AbortController(), calls=[]
 await assert.rejects(uploadPdfInChunks({projectId:'p',file:file(),signal:controller.signal,sleep,contentHash:hash,send:async(path,req)=>{
  calls.push(req.method);if(calls.length===1){controller.abort();throw Error('lost')}
  if(req.method==='POST')return {id:'u',chunkSize:size}
 }}))
 assert.deepEqual(calls,['POST','POST','DELETE'])
})
test('resumes missing chunks after the same file hash is selected again', async () => {
  const storage = memoryStorage()
  const seen = []
  const pdf = file()
  const result = await uploadPdfInChunks({
    projectId: 'p', file: pdf, sleep, storage, userId: 'user-1', contentHash: hash,
    send: async (path, req) => {
      seen.push(path)
      if (path.endsWith('pdf-uploads')) {
        assert.equal(req.body.contentHash, hash)
        return { id: 'u', chunkSize: size, received: [0], contentHash: hash }
      }
      if (path.includes('/chunks/')) {
        assert.notEqual(path.split('/').at(-1), '0')
        return
      }
      return { id: 'same-file' }
    }
  })
  assert.equal(result.id, 'same-file')
  assert.equal(seen.some((path) => path.includes('/chunks/0')), false)
  assert.equal(seen.filter((path) => path.includes('/chunks/1')).length, 1)
  assert.equal(loadPdfUploadResume(storage, 'user-1', 'p'), null)
})
test('rejects a different file even when the name and size match', async () => {
  const storage = memoryStorage()
  savePdfUploadResume(storage, {
    userId: 'user-1',
    projectId: 'p',
    sessionId: 'u',
    requestId: 'resume-request-01',
    name: 'book.pdf',
    size: size * 2 + 9,
    contentHash: 'b'.repeat(64)
  })
  await assert.rejects(uploadPdfInChunks({
    projectId: 'p', file: file(), sleep, storage, userId: 'user-1', contentHash: 'c'.repeat(64),
    send: async () => { throw new Error('should not send') }
  }), /不是原来的文件/)
})
test('hashPdfFile is a full-file digest, not name and size', async () => {
  const left = new File([new Uint8Array([1, 2, 3, 4])], 'book.pdf')
  const right = new File([new Uint8Array([1, 2, 3, 5])], 'book.pdf')
  assert.equal(left.size, right.size)
  assert.notEqual(await hashPdfFile(left), await hashPdfFile(right))
})
test('project detail shows recoverable upload, reselect and abandon states', () => {
  const view = readFileSync(new URL('../src/views/admin/ProjectDetailView.vue', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
  assert.match(view, /有未完成的 PDF 上传/)
  assert.match(view, /重新选择同一 PDF/)
  assert.match(view, /放弃未完成上传/)
  assert.match(view, /已过期，请重新选择文件上传/)
  assert.match(view, /A successful empty list means the upload finished/)
  assert.match(view, /pdfResume\.value\?\.expired/)
})
