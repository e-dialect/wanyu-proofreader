import assert from 'node:assert/strict'
const base=process.env.PB_URL
async function api(path,{token='',body,method=body?'POST':'GET',status=200}={}) {
 const form=body instanceof FormData
 const response=await fetch(base+path,{method,headers:{Authorization:token,...(body&&!form?{'Content-Type':'application/json'}:{})},body:body?(form?body:JSON.stringify(body)):undefined})
 const result=await response.json()
 assert.equal(response.status,status,`${method} ${path}: ${JSON.stringify(result)}`)
 return result
}
const login=(identity,password,collection='users')=>api(`/api/collections/${collection}/auth-with-password`,{body:{identity,password}})
const su=await login(process.env.PB_SUPER_EMAIL,process.env.PB_SUPER_PASSWORD,'_superusers')
let admin=await login(process.env.APP_ADMIN_EMAIL,process.env.APP_ADMIN_PASSWORD)
await api('/api/collections/users/records/'+admin.record.id,{token:su.token,method:'PATCH',body:{must_change_password:false}})
admin=await login(process.env.APP_ADMIN_EMAIL,process.env.APP_ADMIN_PASSWORD)
const token=admin.token
const project=await api('/api/fangji/projects',{token,body:{name:'CSV页码选择 · 合成验收'},status:201})
const root=`/api/fangji/projects/${project.id}/imports/csv`
const form=(text,column,inspect=true)=>{const body=new FormData();body.set('file',new Blob([text]),'synthetic-page-columns.csv');if(column!==undefined)body.set('pdf_page_column',column);if(inspect)body.set('inspect_only','true');return body}
const text='物理页,书页,词条\r\n2,5,𠀀ka⁵³³\r\n坏页码,6,第二条\r\n3,7,"含逗号,原值"'
await api(root+'/columns',{body:form(text),status:401})
const columns=await api(root+'/columns',{token,body:form(text)})
assert.deepEqual(columns.headers,['物理页','书页','词条'])
assert.deepEqual(columns.page_column_candidates,[])
assert.equal(columns.suggested_page_column,null)
assert.equal(columns.preview[0].values[2],'𠀀ka⁵³³')
const wait=async id=>{for(let i=0;i<150;i++){const job=await api('/api/collections/import_jobs/records/'+id,{token});if(['validated','completed','completed_with_errors','failed'].includes(job.status))return job;await new Promise(r=>setTimeout(r,50))}throw Error('job timeout')}
const start=async(text,column,status=202)=>api(root,{token,body:form(text,column),status})
const first=await start(text,'物理页');let inspection=await wait(first.id)
assert.equal(inspection.status,'validated');assert.equal(inspection.csv_pdf_page_column,'物理页')
assert.equal(JSON.parse(inspection.inspection_json).pdf_page_field,'物理页')
assert.equal(inspection.success_count,2);assert.equal(inspection.failed_count,1)
const errors=await api('/api/collections/import_job_errors/records?filter='+encodeURIComponent(`job="${first.id}"`),{token})
assert.equal(errors.items[0].row_number,3);assert.equal(errors.items[0].column_name,'物理页')
await api('/api/fangji/imports/'+first.id+'/commit',{token,body:{},status:202})
const done=await wait(first.id);assert.equal(done.status,'completed_with_errors');assert.equal(done.success_count,2)
const pages=await api('/api/collections/pages/records?sort=page_number&filter='+encodeURIComponent(`import_job="${first.id}"`),{token})
assert.deepEqual(pages.items.map(p=>p.pdf_page),[2,3])
assert.deepEqual(JSON.parse(pages.items[0].ocr_row_json),{'书页':'5','词条':'𠀀ka⁵³³'})
assert.equal((await start(text,'物理页',200)).id,first.id)
const different=await start(text,'书页');assert.notEqual(different.id,first.id)
assert.equal((await wait(different.id)).success_count,3)
const alias='page,词条\n1,唯一别名合成样例'
const auto=await start(alias);await wait(auto.id)
assert.equal((await start(alias,'page',200)).id,auto.id)
const multiple='page,页码,词条\n1,2,双页码合成样例'
const multiColumns=await api(root+'/columns',{token,body:form(multiple)})
assert.deepEqual(multiColumns.page_column_candidates,['page','页码']);assert.equal(multiColumns.suggested_page_column,null)
const explicit=await start(multiple,'页码');assert.equal((await wait(explicit.id)).success_count,1)
await api(root,{token,body:form(text,'不存在'),status:400})
// Resume an existing validated job using only its authenticated record URL.
// Synthetic PDF metadata is sufficient here: this exercises CSV binding, not rendering.
const resumeProject=await api('/api/fangji/projects',{token,body:{name:'CSV恢复确认 · 合成验收'},status:201})
const oldPdf=await api('/api/collections/project_files/records',{token:su.token,body:{project:resumeProject.id,status:'ready',is_primary:true,page_count:8,original_filename:'original-source.pdf'},status:200})
const source=await api('/api/collections/sources/records',{token:su.token,body:{logical_id:'csv-resume-synthetic',title:'恢复时固定来源',original_vs_derived:'original',status:'pending_rights'},status:200})
const resumeForm=form('物理页,书页,词条\n2,5,恢复原值','物理页');resumeForm.set('source_id',source.id)
const pending=await api(`/api/fangji/projects/${resumeProject.id}/imports/csv`,{token,body:resumeForm,status:202})
assert.equal((await wait(pending.id)).status,'validated')
await api('/api/collections/project_files/records/'+oldPdf.id,{token:su.token,method:'PATCH',body:{is_primary:false}})
const newPdf=await api('/api/collections/project_files/records',{token:su.token,body:{project:resumeProject.id,status:'ready',is_primary:true,page_count:1,original_filename:'replacement-source.pdf'},status:200})
const resumedToken=(await login(process.env.APP_ADMIN_EMAIL,process.env.APP_ADMIN_PASSWORD)).token
const resumed=await api('/api/collections/import_jobs/records/'+pending.id,{token:resumedToken})
assert.equal(resumed.original_filename,'synthetic-page-columns.csv')
assert.equal(resumed.project_file,oldPdf.id);assert.equal(resumed.source,source.id)
assert.equal(resumed.pdf_page_limit,8);assert.equal(resumed.pdf_snapshot_captured,true)
assert.equal(resumed.csv_pdf_page_column,'物理页')
assert.equal(JSON.parse(resumed.inspection_json).preview_locations[0].pdf_page,2)
const originalPdf=await api('/api/collections/project_files/records/'+resumed.project_file,{token:resumedToken})
assert.equal(originalPdf.original_filename,'original-source.pdf')
const override={project_file:newPdf.id,source:'',csv_pdf_page_column:'书页',pdf_page_limit:1,inspection_json:'{}'}
await api('/api/collections/import_jobs/records/'+pending.id,{token:resumedToken,method:'PATCH',body:override,status:403})
await api('/api/fangji/imports/'+pending.id+'/commit',{token:resumedToken,body:override,status:202})
const resumedDone=await wait(pending.id)
assert.equal(resumedDone.status,'completed');assert.equal(resumedDone.project_file,oldPdf.id)
assert.equal(resumedDone.source,source.id);assert.equal(resumedDone.csv_pdf_page_column,'物理页');assert.equal(resumedDone.pdf_page_limit,8)
const resumedPages=await api('/api/collections/pages/records?filter='+encodeURIComponent(`import_job="${pending.id}"`),{token:resumedToken})
assert.equal(resumedPages.totalItems,1);assert.equal(resumedPages.items[0].pdf_page,2);assert.equal(resumedPages.items[0].project_file,oldPdf.id)
await api('/api/fangji/imports/'+pending.id+'/commit',{token:resumedToken,body:{},status:202})
assert.equal((await api('/api/collections/pages/records?filter='+encodeURIComponent(`import_job="${pending.id}"`),{token:resumedToken})).totalItems,1)
console.log('PASS CSV page column: headers/mapping, preserved content, dedup, resumed validated job, immutable PDF/source/mapping, idempotent confirmation')
