import test from 'node:test'
import assert from 'node:assert/strict'
import { uploadPdfInChunks, retryUploadRequest, validatePdfFile } from '../src/lib/chunkedPdfUpload.js'
const size = 1024 * 1024
const file = () => new File([new Uint8Array(size * 2 + 9)], 'book.pdf')
const sleep = async () => {}
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
  const result = await uploadPdfInChunks({ projectId: 'p', file: file(), sleep, onProgress: n => progress.push(n), send: async (path, req) => {
    seen.push(path)
    if (path.endsWith('pdf-uploads')) { keys.add(req.body.requestId); if (keys.size === 1 && seen.length === 1) throw {status:0}; return {id:'u',chunkSize:size} }
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
test('permission errors do not retry and failed upload is canceled', async () => {
  const methods=[]
  await assert.rejects(uploadPdfInChunks({projectId:'p',file:file(),sleep,send:async(path,req)=>{
    methods.push(req.method); if(req.method==='POST') return {id:'u',chunkSize:size}
    if(req.method==='PUT') throw Object.assign(new Error('revoked'),{status:403})
  }}),/revoked/)
  assert.deepEqual(methods,['POST','PUT','DELETE'])
})
test('transient errors retry at most three times; abort stops retry',async()=>{
 let calls=0; await assert.rejects(retryUploadRequest(async()=>{calls++;throw Error('offline')},{sleep}),/offline/);assert.equal(calls,4)
 const controller=new AbortController();calls=0
 await assert.rejects(retryUploadRequest(async()=>{calls++;controller.abort();throw Error('offline')},{sleep,signal:controller.signal}));assert.equal(calls,1)
})
test('cancellation recovers lost creation response and deletes the session',async()=>{
 const controller=new AbortController(), calls=[]
 await assert.rejects(uploadPdfInChunks({projectId:'p',file:file(),signal:controller.signal,sleep,send:async(path,req)=>{
  calls.push(req.method);if(calls.length===1){controller.abort();throw Error('lost')}
  if(req.method==='POST')return {id:'u',chunkSize:size}
 }}))
 assert.deepEqual(calls,['POST','POST','DELETE'])
})
