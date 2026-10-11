import test from 'node:test'
import assert from 'node:assert/strict'
import { createPdfPreviewCache } from '../src/lib/pdfPreviewCache.js'
test('reuses only the same user/version/range/window and releases old blob URLs',()=>{
 let now=1000,created=0;const revoked=[]
 const cache=createPdfPreviewCache({now:()=>now,urls:{createObjectURL:()=>`blob:${++created}`,revokeObjectURL:u=>revoked.push(u)}})
 const descriptor={key:'file-v1/pages-2-3/window-1',expiresAt:new Date(5000).toISOString()}
 const first=cache.put('alice',descriptor,new Blob(['pdf']))
 for(let task=0;task<10;task++)assert.equal(cache.get('alice',descriptor),first)
 assert.equal(created,1)
 assert.equal(cache.get('bob',descriptor),null)
 assert.equal(cache.get('alice',{...descriptor,key:'replacement'}),null)
 now=5000;assert.equal(cache.get('alice',descriptor),null)
 assert.equal(cache.get('alice',{...descriptor,expiresAt:new Date(9000).toISOString()}),null,'a fresh authorization window must not resurrect an expired browser blob even when the shared asset key is unchanged')
 cache.put('alice',{...descriptor,key:'new'},new Blob(['pdf2']))
 assert.deepEqual(revoked,['blob:1']);cache.clear();assert.deepEqual(revoked,['blob:1','blob:2'])
})
