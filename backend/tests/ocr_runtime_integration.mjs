import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
const base = process.env.PB_URL
async function api(path, { method = 'GET', token = '', body, status = 200 } = {}) {
 const form = body instanceof FormData
 const response = await fetch(base+path,{method,headers:{Authorization:token,...(!form&&body?{'Content-Type':'application/json'}:{})},body:body?(form?body:JSON.stringify(body)):undefined})
 const text = await response.text();const result=text?JSON.parse(text):null
 assert.equal(response.status,status,`${method} ${path} -> ${response.status}: ${text}`)
 return result
}
async function wait(job,token,match) {
 for(let i=0;i<200;i++){const value=await api(`/api/collections/import_jobs/records/${job.id}`,{token});if(match(value))return value;await new Promise(r=>setTimeout(r,50))}
 throw Error('job did not reach expected state')
}
function pdf(count){
 const objects=['','<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${Array.from({length:count},(_,i)=>`${i+3} 0 R`).join(' ')}] /Count ${count} >>`]
 for(let i=0;i<count;i++)objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents ${count+i+3} 0 R >>`)
 for(let i=0;i<count;i++)objects.push('<< /Length 0 >>\nstream\n\nendstream')
 let out='%PDF-1.4\n';const offsets=[0]
 for(let i=1;i<objects.length;i++){offsets[i]=Buffer.byteLength(out);out+=`${i} 0 obj\n${objects[i]}\nendobj\n`}
 const offset=Buffer.byteLength(out);out+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`;for(const n of offsets.slice(1))out+=`${String(n).padStart(10,'0')} 00000 n \n`
 return out+`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`
}
const admin=await api('/api/collections/users/auth-with-password',{method:'POST',body:{identity:process.env.APP_ADMIN_EMAIL,password:process.env.APP_ADMIN_PASSWORD}})
const token=admin.token
if(process.env.OCR_RECOVERY_PHASE==='assert') {
 const state=JSON.parse(readFileSync(process.env.OCR_RECOVERY_STATE,'utf8'))
 for(const id of state.jobs){
  const job=await wait({id},token,value=>['completed','failed'].includes(value.status))
  assert.equal(job.status,'completed',JSON.stringify(job))
  const rows=await api(`/api/collections/pages/records?filter=${encodeURIComponent(`import_job="${id}"`)}`,{token})
  assert.equal(rows.totalItems,2,'restart must replace staging instead of duplicating rows')
  assert.ok(rows.items.every(page=>page.status==='pending'))
 }
 for(const item of [state.idempotent,state.defaults]){
  const response=await api(`/api/fangji/projects/${state.project}/imports/ocr`,{method:'POST',token,body:item.body,status:202});assert.equal(response.id,item.id,'request identity must survive restart')
 }
 const superAuth=await api('/api/collections/_superusers/auth-with-password',{method:'POST',body:{identity:process.env.PB_SUPER_EMAIL,password:process.env.PB_SUPER_PASSWORD}})
 const files=await api(`/api/collections/project_files/records?filter=${encodeURIComponent(`project="${state.project}"`)}`,{token:superAuth.token})
 for(const file of files.items)await api(`/api/collections/project_files/records/${file.id}`,{method:'DELETE',token:superAuth.token,status:204})
 for(const item of [state.idempotent,state.defaults])assert.equal((await api(`/api/fangji/projects/${state.project}/imports/ocr`,{method:'POST',token,body:item.body,status:202})).id,item.id,'missing live PDF must not change an existing operation')
 await api(`/api/fangji/projects/${state.project}`,{method:'DELETE',token,status:204})
 console.log('PASS: queued/processing OCR recovery and durable idempotency after restart/PDF removal')
} else {
const project=await api('/api/fangji/projects',{method:'POST',token,body:{name:'Synthetic OCR runtime contract'},status:201})
try {
 const upload=new FormData();upload.set('file',new Blob([pdf(4)],{type:'application/pdf'}),'synthetic.pdf')
 const file=await api(`/api/fangji/projects/${project.id}/files/pdf`,{method:'POST',token,body:upload,status:202})
 for(let i=0;i<100;i++){const current=await api(`/api/collections/project_files/records/${file.id}`,{token});if(current.status==='ready')break;assert.notEqual(current.status,'error',JSON.stringify(current));await new Promise(r=>setTimeout(r,50))}
 const url=`/api/fangji/projects/${project.id}/imports/ocr`
 await api(url,{method:'POST',token,body:{startPage:0,endPage:5},status:400})
 await api(url,{method:'POST',token,body:{layout:'mixed'},status:400})
 const duplicate=await fetch(base+url,{method:'POST',headers:{Authorization:token,'Content-Type':'application/json'},body:'{} {}'});assert.equal(duplicate.status,400)
 const oversized=await fetch(base+url,{method:'POST',headers:{Authorization:token,'Content-Type':'application/json'},body:JSON.stringify({layout:'x'.repeat(17000)})});assert.equal(oversized.status,400)
 const outsider=await api('/api/collections/users/records',{method:'POST',body:{email:'ocr-synthetic-outsider@example.com',name:'synthetic outsider',role:'user',password:'Synthetic12345!',passwordConfirm:'Synthetic12345!'}})
 const auth=await api('/api/collections/users/auth-with-password',{method:'POST',body:{identity:'ocr-synthetic-outsider@example.com',password:'Synthetic12345!'}})
 await api(url,{method:'POST',token:auth.token,body:{startPage:1,endPage:2},status:403})
 const stableBody={startPage:1,endPage:2,language:'eng',requestId:'transport-loss-request-0001'}
 for(const requestId of ['short','bad key contains spaces','x'.repeat(81)])await api(url,{method:'POST',token,body:{requestId},status:400})
 const concurrent=await Promise.all(Array.from({length:6},()=>api(url,{method:'POST',token,body:stableBody,status:202})))
 const job=concurrent[0];assert.ok(concurrent.every(value=>value.id===job.id),'concurrent retries must share one durable job')
 assert.equal((await api(url,{method:'POST',token,body:stableBody,status:202})).id,job.id)
 await api(url,{method:'POST',token,body:{...stableBody,endPage:1},status:409})
 const sameKeyJobs=await api(`/api/collections/import_jobs/records?filter=${encodeURIComponent(`project="${project.id}" && ocr_request_id="${stableBody.requestId}"`)}`,{token})
 assert.equal(sameKeyJobs.totalItems,1)

 await wait(job,token,value=>value.processed_count===1&&value.status==='processing')
 const visible=await api(`/api/collections/pages/records?filter=${encodeURIComponent(`import_job="${job.id}"`)}`,{token});assert.ok(visible.items.every(row=>row.status==='importing'))
 // An independent CSV still progresses while OCR is in its slow second page.
 const csv=new FormData();csv.set('file',new Blob(['PDF页码,原文\n1,CSV remains available'],{type:'text/csv'}),'parallel.csv');csv.set('inspect_only','true')
 const csvJob=await api(`/api/fangji/projects/${project.id}/imports/csv`,{method:'POST',token,body:csv,status:202})
 await wait(csvJob,token,value=>value.status==='validated')
 await api(`/api/fangji/imports/${csvJob.id}/commit`,{method:'POST',token,status:202})
 assert.equal((await wait(csvJob,token,value=>['completed','failed'].includes(value.status))).status,'completed')
 const stillOCR=await api(`/api/collections/import_jobs/records/${job.id}`,{token});assert.equal(stillOCR.status,'processing','CSV commit must finish before the blocked OCR worker')
 assert.equal((await api(url,{method:'POST',token,body:stableBody,status:202})).id,job.id)
 const completed=await wait(job,token,value=>['completed','failed'].includes(value.status));assert.equal(completed.status,'completed',JSON.stringify(completed));assert.equal(completed.total_count,2);assert.equal(completed.processed_count,2)
 const summary=JSON.parse(completed.ocr_result_json);assert.equal(summary.rows,3);assert.equal(summary.abstained,1);assert.equal(summary.artifacts.length,2)
 const pages=await api(`/api/collections/pages/records?filter=${encodeURIComponent(`import_job="${job.id}"`)}&sort=page_number`,{token})
 assert.equal(pages.items.length,3);assert.ok(pages.items.every(row=>row.status==='pending'))
 const ledger=await api(`/api/fangji/projects/${project.id}/import-ledger`,{token})
 const ocrBatch=ledger.batches.find(batch=>batch.id===job.id)
 assert.equal(ocrBatch.count_unit,'pages');assert.equal(ocrBatch.counts_label,'一致','2 physical pages yielding 3 rows must reconcile by the completed OCR result')
 assert.equal(ocrBatch.total_count,2);assert.equal(ocrBatch.inserted_count,3)
 assert.equal(ledger.summary.total_rows,1,'CSV input rows must not include OCR physical pages')
 assert.equal(ledger.summary.ocr_pages,2);assert.equal(ledger.summary.imported_rows,4,'actual retained rows include both CSV and OCR')
 const page=pages.items[0],original='  𠀀 \ue123 ⿰木木 ɕ˥'
 assert.equal(JSON.parse(page.ocr_row_json).原文,original);assert.equal(JSON.parse(page.ocr_cells_json)[0].text,original);assert.equal(pages.items[1].missing_glyph,true)
 const artifact=summary.artifacts[0]
 const evidenceResponse=await fetch(base+artifact.download_url,{headers:{Authorization:token}})
 assert.match(evidenceResponse.headers.get('content-type'),/application\/json/);assert.match(evidenceResponse.headers.get('cache-control'),/no-store/)
 const evidence=await evidenceResponse.json();assert.equal(evidence.raw_text,original+'\ndecode �')
 for(const memberToken of ['',auth.token]){const response=await fetch(base+artifact.download_url,{headers:{Authorization:memberToken}});assert.ok([401,403].includes(response.status))}
 await api(`/api/fangji/projects/${project.id}/members/${outsider.id}`,{method:'PUT',token,body:{role:'proofreader'}})
 assert.equal((await fetch(base+artifact.download_url,{headers:{Authorization:auth.token}})).status,403)
 await api(url,{method:'POST',token:auth.token,body:stableBody,status:403})
 // Corrections leave immutable OCR evidence/status attached to the original input.
 await api(`/api/fangji/projects/${project.id}/pages/${page.id}/content`,{method:'POST',token,body:{rowJson:JSON.stringify({原文:original+' corrected'}),headersJson:'["原文"]',expectedUpdated:page.updated}})
 const corrected=await api(`/api/collections/pages/records/${page.id}`,{token});assert.equal(corrected.ocr_cells_json,page.ocr_cells_json)
 const failed=await api(url,{method:'POST',token,body:{startPage:1,endPage:3,language:'eng'},status:202})
 const terminal=await wait(failed,token,value=>value.status==='failed');assert.equal(terminal.error_code,'OCR_WORKER_FAILED');assert.ok(terminal.finished_at);assert.equal(terminal.processed_count,3);assert.equal(terminal.success_count,2);assert.equal(terminal.failed_count,1)
 const hidden=await api(`/api/collections/pages/records?filter=${encodeURIComponent(`import_job="${failed.id}"`)}`,{token});assert.equal(hidden.totalItems,0,'worker failure must remove all unpublished rows')
 // Fresh job after a failed worker can finish normally.
 const retry=await api(url,{method:'POST',token,body:{startPage:1,endPage:1},status:202});assert.equal((await wait(retry,token,value=>['completed','failed'].includes(value.status))).status,'completed')
 const legacyAgain=await api(url,{method:'POST',token,body:{startPage:1,endPage:1},status:202});assert.notEqual(legacyAgain.id,retry.id,'unkeyed legacy calls remain independent');await wait(legacyAgain,token,value=>['completed','failed'].includes(value.status))
 const scanned=await api(url,{method:'POST',token,body:{startPage:4,endPage:4},status:202})
 const rejected=await wait(scanned,token,value=>value.status==='failed');assert.equal(rejected.error_code,'OCR_SCANNED_UNSUPPORTED');assert.equal(rejected.processed_count,1);assert.equal(rejected.failed_count,1)
 const scanRows=await api(`/api/collections/pages/records?filter=${encodeURIComponent(`import_job="${scanned.id}"`)}`,{token});assert.equal(scanRows.totalItems,0,'backend must reject Tesseract cells even if the worker returns HTTP200 and an unrelated engine label')

 // A terminal failure is still the same operation. The permanent request
 // index must not disappear with the legacy status!='failed' dedup predicate.
 const failedBody={requestId:'failed-transport-request-0001',startPage:1,endPage:3,language:'eng'}
 const failedKeyed=await api(url,{method:'POST',token,body:failedBody,status:202})
 await wait(failedKeyed,token,value=>value.status==='failed')
 assert.equal((await api(url,{method:'POST',token,body:failedBody,status:202})).id,failedKeyed.id)
 const defaultsBody={requestId:'snapshot-default-request-0001'}
 const defaultsJob=await api(url,{method:'POST',token,body:defaultsBody,status:202})
 await wait(defaultsJob,token,value=>value.status==='failed')
 // The same key is independent for a different manager, and for a different
 // project. No other actor's operation is returned.
 await api(`/api/fangji/projects/${project.id}/members/${outsider.id}`,{method:'PUT',token,body:{role:'manager'}})
 const otherActor=await api(url,{method:'POST',token:auth.token,body:stableBody,status:202});assert.notEqual(otherActor.id,job.id)
 await wait(otherActor,auth.token,value=>['completed','failed'].includes(value.status))
 const isolated=await api('/api/fangji/projects',{method:'POST',token,body:{name:'Synthetic request isolation'},status:201})
 try {
  const body=new FormData();body.set('file',new Blob([pdf(1)],{type:'application/pdf'}),'isolated.pdf')
  const isolatedFile=await api(`/api/fangji/projects/${isolated.id}/files/pdf`,{method:'POST',token,body,status:202})
  for(let i=0;i<100;i++){const value=await api(`/api/collections/project_files/records/${isolatedFile.id}`,{token});if(value.status==='ready')break;await new Promise(r=>setTimeout(r,50))}
  const otherProject=await api(`/api/fangji/projects/${isolated.id}/imports/ocr`,{method:'POST',token,body:{...stableBody,endPage:1},status:202});assert.notEqual(otherProject.id,job.id)
  await wait(otherProject,token,value=>['completed','failed'].includes(value.status))
 } finally {await api(`/api/fangji/projects/${isolated.id}`,{method:'DELETE',token,status:204})}
 // Replacing the live PDF must not renormalize a lost-response retry against
 // the new one-page limit, including a request which originally used defaults.
 const replacement=new FormData();replacement.set('file',new Blob([pdf(1)],{type:'application/pdf'}),'replacement.pdf')
 const replaced=await api(`/api/fangji/projects/${project.id}/files/pdf`,{method:'POST',token,body:replacement,status:202})
 for(let i=0;i<100;i++){const value=await api(`/api/collections/project_files/records/${replaced.id}`,{token});if(value.status==='ready')break;await new Promise(r=>setTimeout(r,50))}
 assert.equal((await api(url,{method:'POST',token,body:stableBody,status:202})).id,job.id)
 assert.equal((await api(url,{method:'POST',token,body:defaultsBody,status:202})).id,defaultsJob.id)
 console.log('PASS: OCR actual-schema authorization/range/progress/provenance/tri-state, CSV isolation, failure cleanup; idempotency concurrent/conflict/actor/project/terminal/PDF-snapshot')
 // Seed durable queued/processing checkpoints with the real collection API.
 // Neither record has an in-memory work item: restart recovery must discover it.
 const superAuth=await api('/api/collections/_superusers/auth-with-password',{method:'POST',body:{identity:process.env.PB_SUPER_EMAIL,password:process.env.PB_SUPER_PASSWORD}})
 const checkpoints=[]
 for(const status of ['queued','processing']) {
  const checkpoint=await api('/api/collections/import_jobs/records',{method:'POST',token:superAuth.token,status:200,body:{project:project.id,created_by:admin.record.id,mode:'ocr',status,project_file:file.id,pdf_page_limit:4,file_hash:(status==='queued'?'a':'b').repeat(64),original_filename:'Synthetic recovery',ocr_options_json:JSON.stringify({startPage:1,endPage:1,language:'eng',layout:'single_column'})}})
  checkpoints.push(checkpoint.id)
  await api('/api/collections/pages/records',{method:'POST',token:superAuth.token,body:{project:project.id,import_job:checkpoint.id,project_file:file.id,page_number:999+checkpoints.length,pdf_page:1,status:'importing',ocr_text:'obsolete staging',proofread_round:1}})
 }
 writeFileSync(process.env.OCR_RECOVERY_STATE,JSON.stringify({project:project.id,jobs:checkpoints,idempotent:{id:job.id,body:stableBody},defaults:{id:defaultsJob.id,body:defaultsBody}}))
} catch(error) {
 await api(`/api/fangji/projects/${project.id}`,{method:'DELETE',token,status:204})
 throw error
}
}
