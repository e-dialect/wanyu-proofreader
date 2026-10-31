import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
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
const superAuth=await api('/api/collections/_superusers/auth-with-password',{method:'POST',body:{identity:process.env.PB_SUPER_EMAIL,password:process.env.PB_SUPER_PASSWORD}})
const project=await api('/api/fangji/projects',{method:'POST',token,body:{name:'PDF access fixture'},status:201}),users=[]
for(let n=0;n<2;n++){
 const email=`pdf-reader-${n}@example.com`,password='PDFReader12345!'
 const user=await api('/api/collections/users/records',{method:'POST',body:{email,name:`reader${n}`,role:'user',password,passwordConfirm:password}})
 users.push(await api('/api/collections/users/auth-with-password',{method:'POST',body:{identity:email,password}}))
 await api(`/api/fangji/projects/${project.id}/members/${user.id}`,{method:'PUT',token,body:{role:'proofreader'}})
}
const form=new FormData();form.set('file',new Blob([fixturePDF()],{type:'application/pdf'}),'source.pdf')
const queued=await api(`/api/fangji/projects/${project.id}/files/pdf`,{method:'POST',token,body:form,status:202})
let file
for(let i=0;i<100;i++){file=await api(`/api/collections/project_files/records/${queued.id}`,{token});if(file.status==='ready')break;assert.notEqual(file.status,'failed');await new Promise(r=>setTimeout(r,100))}
assert.equal(file.page_count,4)

const pages=[]
for(const [order,start] of [[1,2],[2,1],[3,2],[4,2]])pages.push(await api('/api/collections/pages/records',{method:'POST',token:superAuth.token,body:{project:project.id,project_file:file.id,page_number:order,pdf_page:start,ocr_text:'test',ocr_row_json:'{"内容":"test"}',status:'pending'}}))
const claim=async(user,previousTaskId='')=>api(`/api/fangji/projects/${project.id}/claim`,{method:'POST',token:user.token,body:{previousTaskId}})
const submit=async(user,task)=>api(`/api/fangji/pages/${task.id}/submit`,{method:'POST',token:user.token,body:{rowJson:'{"内容":"test"}',text:'test',leaseToken:task.leaseToken}})
const descriptor=async(user,id)=>api(`/api/fangji/pages/${id}/pdf/descriptor`,{token:user.token})
const pdf=async(user,id)=>{const r=await fetch(`${base}/api/fangji/pages/${id}/pdf`,{headers:{Authorization:user.token}});assert.equal(r.status,200,await r.clone().text());return Buffer.from(await r.arrayBuffer())}
await api(`/api/fangji/projects/${project.id}/claim`,{method:'POST',token:users[0].token,body:{previousTaskId:pages[1].id},status:403})
const first=await claim(users[0]);assert.equal(first.id,pages[0].id)
if(process.env.PDF_REUSE_BROWSER_SCRIPT){
 // The browser submits on its own fetch, outside the integration preload.
 await api('/api/fangji/research-notice',{method:'POST',token:users[0].token,body:{choice:'participate'}})
 await writeFile(process.env.PDF_BROWSER_FIXTURE,JSON.stringify({base,auth:users[0],claim:first,pages,project,file,superToken:superAuth.token}))
 const {spawnSync}=await import('node:child_process');assert.equal(spawnSync('node',[process.env.PDF_REUSE_BROWSER_SCRIPT],{stdio:'inherit',env:process.env}).status,0)
}else{
 const original=await descriptor(users[0],first.id), originalBytes=await pdf(users[0],first.id)
 await submit(users[0],first)
 await api(`/api/fangji/pages/${first.id}/pdf/descriptor`,{token:users[0].token,status:403})
 const second=await claim(users[0],first.id);assert.equal(second.id,pages[2].id,'must prefer same PDF over eligible earlier page')
 assert.equal((await descriptor(users[0],second.id)).key,original.key)
 assert.deepEqual(await pdf(users[0],second.id),originalBytes,'same window across task IDs reuses identical watermarked PDF')
 const other=await claim(users[1]);assert.equal(other.id,pages[0].id)
 assert.equal((await descriptor(users[1],other.id)).key,original.key,'different authorized users share one asset key')
 assert.deepEqual(await pdf(users[1],other.id),originalBytes,'different authorized users receive identical cached bytes')
 await api(`/api/fangji/pages/${second.id}/pdf/descriptor`,{token:users[1].token,status:403})
 await api(`/api/collections/project_files/records/${file.id}`,{method:'PATCH',token:superAuth.token,body:{file_hash:'replacement-version'}})
 assert.notEqual((await descriptor(users[0],second.id)).key,original.key,'file replacement invalidates preview')
 await submit(users[0],second);await submit(users[1],other)
 const [third,concurrent]=await Promise.all([claim(users[0],second.id),claim(users[1],other.id)])
 assert.equal(third.id,pages[3].id);assert.notEqual(third.id,concurrent.id,'concurrent users must not claim same task')
 await submit(users[0],third)
 const fallback=await claim(users[0],third.id);assert.equal(fallback.id,pages[1].id,'same-page exhaustion returns to original order; no repeat proofread')
 assert.notEqual((await descriptor(users[0],fallback.id)).key,original.key)
 const lease=(await api(`/api/collections/task_leases/records?filter=${encodeURIComponent(`page="${fallback.id}"`)}`,{token:superAuth.token})).items[0]
 await api(`/api/collections/task_leases/records/${lease.id}`,{method:'PATCH',token:superAuth.token,body:{expires_at:'2020-01-01 00:00:00.000Z'}})
 await api(`/api/fangji/pages/${fallback.id}/pdf/descriptor`,{token:users[0].token,status:403})
}
console.log('PASS same-page claim affinity, PDF reuse and live descriptor authorization')
