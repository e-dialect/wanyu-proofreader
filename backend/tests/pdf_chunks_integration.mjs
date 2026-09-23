import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
const base=process.env.PB_URL
async function api(path,{method='GET',token='',body,status=200}={}) {
 const form=body instanceof FormData
 const r=await fetch(base+path,{method,headers:{Authorization:token,...(!form&&body?{'Content-Type':'application/json'}:{})},body:body?form?body:JSON.stringify(body):undefined})
 const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data
}
function fixturePDF() {
 const objects=['','<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>']
 for(let i=0;i<4;i++)objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${i===1?'/Rotate 90':''} /Resources << /Font << /F1 11 0 R >> >> /Contents ${7+i} 0 R >>`)
 for(let i=0;i<4;i++){const content=`BT /F1 24 Tf 50 700 Td (SOURCE_PAGE_${i+1}) Tj ET\n0 0 1 RG 2 w 20 20 572 752 re S\n`;objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`)}
 objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
 let out='%PDF-1.4\n';const offsets=[0];for(let i=1;i<objects.length;i++){offsets.push(out.length);out+=`${i} 0 obj\n${objects[i]}\nendobj\n`}
 const xref=out.length;out+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`;for(const offset of offsets.slice(1))out+=`${String(offset).padStart(10,'0')} 00000 n \n`;return out+`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}

const admin=await api('/api/collections/users/auth-with-password',{method:'POST',body:{identity:process.env.APP_ADMIN_EMAIL,password:process.env.APP_ADMIN_PASSWORD}}),token=admin.token
const project=await api('/api/fangji/projects',{method:'POST',token,body:{name:'Chunk upload fixture'},status:201})
const source=Buffer.concat([Buffer.from(fixturePDF()),Buffer.alloc(2*1024*1024,10)])
if(process.env.PDF_UPLOAD_BROWSER_SCRIPT){
 const {writeFile}=await import('node:fs/promises')
 await writeFile(process.env.PDF_BROWSER_FIXTURE,JSON.stringify({base,auth:admin,project,source:source.toString('base64')}))
 const {spawnSync}=await import('node:child_process')
 assert.equal(spawnSync('node',[process.env.PDF_UPLOAD_BROWSER_SCRIPT],{stdio:'inherit',env:process.env}).status,0)
 process.exit(0)
}
const url=`/api/fangji/projects/${project.id}/pdf-uploads`
const contentHash=createHash('sha256').update(source).digest('hex')
const session=await api(url,{method:'POST',token,body:{name:'source.pdf',size:source.length,requestId:'slow-upload-fixture-001',contentHash},status:201})
const started=Date.now()
const putChunk=async(index)=>{
 const offset=index*session.chunkSize
 const data=source.subarray(offset,Math.min(source.length,offset+session.chunkSize))
 for(let repeat=0;repeat<2;repeat++){
  const result=await fetch(`${base}${url}/${session.id}/chunks/${index}`,{method:'PUT',headers:{Authorization:token,'Content-Type':'application/octet-stream'},body:data})
  assert.equal(result.status,204,await result.text())
 }
}
await putChunk(0)
const listed=await api(url,{token})
assert.equal(listed.items?.[0]?.id,session.id)
assert.deepEqual(listed.items[0].received,[0])
const resumed=await api(url,{method:'POST',token,body:{name:'source.pdf',size:source.length,requestId:'slow-upload-fixture-002',contentHash},status:200})
assert.equal(resumed.id,session.id)
const wrong=Buffer.from(source);wrong[wrong.length-1]^=1
const wrongHash=createHash('sha256').update(wrong).digest('hex')
await api(url,{method:'POST',token,body:{name:'source.pdf',size:source.length,requestId:'wrong-original-file-01',contentHash:wrongHash},status:409})
for(let offset=session.chunkSize,index=1;offset<source.length;offset+=session.chunkSize,index++){
 if(index===1&&process.env.FANGJI_SLOW_UPLOAD==='1')await new Promise(r=>setTimeout(r,61000))
 await putChunk(index)
}
const queued=await api(`${url}/${session.id}/complete`,{method:'POST',token,status:202})
const repeated=await api(`${url}/${session.id}/complete`,{method:'POST',token})
assert.equal(repeated.id,queued.id)
assert.equal(queued.file_hash,createHash('sha256').update(source).digest('hex'))
let file
for(let n=0;n<100;n++){file=await api(`/api/collections/project_files/records/${queued.id}`,{token});if(file.status==='ready')break;assert.notEqual(file.status,'failed');await new Promise(r=>setTimeout(r,100))}
assert.equal(file.status,'ready');assert.equal(file.page_count,4)
const ft=await api('/api/files/token',{method:'POST',token})
const download=await fetch(`${base}/api/files/${file.collectionId}/${file.id}/${file.file}?token=${ft.token}`,{headers:{Authorization:token}})
assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),source)
const records=await api(`/api/collections/project_files/records?filter=${encodeURIComponent(`project="${project.id}"`)}`,{token})
assert.equal(records.totalItems,1)
if(process.env.FANGJI_SLOW_UPLOAD==='1')assert(Date.now()-started>60000)
console.log(`PASS chunk upload, duplicate requests, exact bytes, async validation; elapsed ${Date.now()-started} ms`)
