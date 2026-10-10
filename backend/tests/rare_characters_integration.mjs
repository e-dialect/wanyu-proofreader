import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { toSafeCsvCell } from '../../frontend/src/lib/csvExport.js'

const baseUrl = process.env.PB_URL || 'http://127.0.0.1:18095'
const sample = '𢶀𠮷㙟𰻞䲠a̤̍e̤̍o̤̍ṳ́ṳ̂ṳ̍ṳ̄n̂n̍n̄〔Ǿɑɡɔ∣‖①⑭■▲◆●﹑－―—～５〕ãăǎạa̩'
const key = '词条𢶀'
const sourceRow = { [key]: sample, 释义: sample }
const password = 'RareIntegration12345'
const suffix = Date.now()
const users = []
const generatedUserIds = []
let project
async function request(path, {method='GET',token='',body,expected=200}={}) {
 const multipart = body instanceof FormData
 const response = await fetch(baseUrl+path, {method,headers:{...(token?{Authorization:token}:{}),...(body&&!multipart?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:multipart?body:JSON.stringify(body)})
 const raw = await response.text()
 assert.equal(response.status,expected,`${method} ${path}: ${raw}`)
 return raw?JSON.parse(raw):null
}
async function waitJob(id, token, statuses) {
 for(let n=0;n<150;n++){
  const job=await request(`/api/collections/import_jobs/records/${id}`,{token})
  assert.notEqual(job.status,'failed',JSON.stringify(job))
  if(statuses.includes(job.status))return job
  await new Promise(r=>setTimeout(r,200))
 }
 throw new Error('import timeout')
}
if(process.argv.includes('--verify-persistence')) {
 const fixture=JSON.parse(await readFile(process.env.RARE_BROWSER_FIXTURE,'utf8'))
 const freshAuth=await request('/api/collections/_superusers/auth-with-password',{method:'POST',body:{identity:process.env.PB_SUPER_EMAIL,password:process.env.PB_SUPER_PASSWORD}})
 for(let i=0;i<fixture.pages.length;i++) {
  const page=await request(`/api/collections/pages/records/${fixture.pages[i].id}`,{token:freshAuth.token})
  assert.deepEqual(JSON.parse(page.ocr_row_json),sourceRow)
  assert.equal(page.ocr_text,`${sample} ${sample}`)
  if(i<2) {
   assert.equal(page.status,'approved')
   assert.deepEqual(JSON.parse(page.proofread_row_json),i===0?{...sourceRow,释义:sample+'终'}:sourceRow)
  }
  if(i===0)assert.equal(page.arbitration_note,'甲'.repeat(3999)+'𢶀')
 }
 console.log('PASS: source, approved results and boundary-length arbitration note survive process restart')
 process.exit(0)
}
const admin=await request('/api/collections/users/auth-with-password',{method:'POST',body:{identity:process.env.APP_ADMIN_EMAIL,password:process.env.APP_ADMIN_PASSWORD}})
const superAuth=await request('/api/collections/_superusers/auth-with-password',{method:'POST',body:{identity:process.env.PB_SUPER_EMAIL,password:process.env.PB_SUPER_PASSWORD}})
const token=admin.token
try {
 project=await request('/api/fangji/projects',{method:'POST',token,expected:201,body:{name:`生僻字 ${sample} ${suffix}`,description:sample}})
 assert.equal(project.description,sample)
 for(let n=0;n<2;n++){
  const email=`rare-${suffix}-${n}@example.com`
  const nickname=`${sample}-${n}`
  const user=await request('/api/collections/users/records',{method:'POST',body:{email,password,passwordConfirm:password,name:nickname,role:'user'}})
  assert.equal(user.name,nickname)
  const auth=await request('/api/collections/users/auth-with-password',{method:'POST',body:{identity:email,password}})
  users.push(auth)
  await request(`/api/fangji/projects/${project.id}/members/${user.id}`,{method:'PUT',token,body:{role:'proofreader'}})
 }
 const csv='\uFEFF'+['PDF页码,'+key+',释义',...[1,2,3].map(n=>`${n},${sample},${sample}`)].join('\r\n')
 const data=new FormData();data.set('file',new Blob([csv],{type:'text/csv;charset=utf-8'}),`生僻字${sample}.csv`);data.set('inspect_only','true')
 const queued=await request(`/api/fangji/projects/${project.id}/imports/csv`,{method:'POST',token,body:data,expected:202})
 const inspected=await waitJob(queued.id,token,['validated'])
 const inspection=JSON.parse(inspected.inspection_json)
 assert(inspection.headers.includes(key))
 assert(JSON.stringify(inspection.preview).includes(sample))
 await request(`/api/fangji/imports/${queued.id}/commit`,{method:'POST',token,expected:202})
 const job=await waitJob(queued.id,token,['completed'])
 assert.equal(job.success_count,3)
 const pages=(await request(`/api/collections/pages/records?filter=${encodeURIComponent(`project="${project.id}"`)}&sort=page_number`,{token})).items
 assert.equal(pages.length,3)
 for(const page of pages){assert.deepEqual(JSON.parse(page.ocr_row_json),sourceRow);assert.equal(page.ocr_text,`${sample} ${sample}`)}
 console.log('PASS: UTF-8 BOM CSV upload, inspection headers/preview, commit, source JSON/text, project/user fields')
 const firstRow={...sourceRow,释义:sample+'甲'}
 const secondRow={...sourceRow,释义:sample+'乙'}
 for(let i=0;i<2;i++){
  const claim=await request(`/api/fangji/projects/${project.id}/claim`,{method:'POST',token:users[i].token})
  assert.equal(claim.id,pages[0].id)
  const task=await request(`/api/fangji/pages/${claim.id}/task`,{token:users[i].token})
  assert.deepEqual(JSON.parse(task.ocr_row_json),sourceRow)
  await request(`/api/fangji/pages/${claim.id}/submit`,{method:'POST',token:users[i].token,body:{rowJson:JSON.stringify(i?secondRow:firstRow),leaseToken:claim.leaseToken}})
 }
 const arbitration=await request(`/api/fangji/pages/${pages[0].id}/arbitration`,{token})
 assert.deepEqual(arbitration.attempts.map(x=>JSON.parse(x.row_json)),[firstRow,secondRow])
 assert(arbitration.attempts.every(x=>x.text.includes(sample)))
 const finalRow={...sourceRow,释义:sample+'终'}
 const note="甲".repeat(3999)+"𢶀"+"尾"
 await request(`/api/fangji/pages/${pages[0].id}/arbitrate`,{method:'POST',token,body:{rowJson:JSON.stringify(finalRow),note}})
 const final=await request(`/api/collections/pages/records/${pages[0].id}`,{token})
 assert.equal(final.status,'approved');assert.deepEqual(JSON.parse(final.proofread_row_json),finalRow)
 assert.equal(final.proofread_text,`${sample} ${sample}终`);assert.equal(final.arbitration_note,"甲".repeat(3999)+"𢶀")
 console.log('PASS: task API, two independent submissions, attempt JSON/text, arbitration and note persistence')
 for(const user of users){
  const claim=await request(`/api/fangji/projects/${project.id}/claim`,{method:'POST',token:user.token})
  assert.equal(claim.id,pages[1].id)
  await request(`/api/fangji/pages/${claim.id}/submit`,{method:'POST',token:user.token,body:{rowJson:JSON.stringify(sourceRow),leaseToken:claim.leaseToken}})
 }
 const matching=await request(`/api/collections/pages/records/${pages[1].id}`,{token})
 assert.equal(matching.status,'approved');assert.deepEqual(JSON.parse(matching.proofread_row_json),sourceRow)
 const exported='\uFEFF'+[Object.keys(finalRow),Object.values(JSON.parse(final.proofread_row_json))].map(row=>row.map(toSafeCsvCell).join(',')).join('\r\n')
 assert.equal(Buffer.from(exported,'utf8').toString('utf8'),exported)
 assert(exported.includes(sample))
 console.log('PASS: matching submissions auto-approve, frontend CSV escaping and UTF-8 bytes')
 await request(`/api/fangji/projects/${project.id}`,{method:'PATCH',token,body:{name:'甲'.repeat(79)+sample}})
 const batch=await request(`/api/fangji/projects/${project.id}/volunteers/generate`,{method:'POST',token,expected:201,body:{count:1,usernamePattern:`unicode${suffix}{n}`,startNumber:1,digits:1,nicknamePattern:sample+'{n}',loginUrl:'https://example.com/login'}})
 generatedUserIds.push(...batch.accounts.map(account=>account.id))
 assert.equal(batch.accounts[0].nickname,sample+'1')
 assert.equal(batch.fileName,'甲'.repeat(79)+'𢶀_志愿者账号.csv')
 assert(batch.csv.includes(sample+'1'))
 const volunteer=await request(`/api/collections/users/records/${batch.accounts[0].id}`,{token:superAuth.token})
 assert.equal(volunteer.name,sample+'1')
 await request(`/api/fangji/projects/${project.id}`,{method:'PATCH',token,body:{name:project.name}})
 console.log('PASS: generated volunteer nickname, CSV and filename truncation at a supplementary character')
 if(process.env.RARE_BROWSER_FIXTURE){
  await writeFile(process.env.RARE_BROWSER_FIXTURE,JSON.stringify({baseUrl,admin,superAuth,users,project,pages,sample,key,sourceRow}),{mode:0o600})
  console.log('Kept isolated fixtures for real-browser edit/draft/submit/arbitration/export and restart checks')
 }
} finally {
 if(!process.env.RARE_BROWSER_FIXTURE){
  if(project)await request(`/api/collections/projects/records/${project.id}`,{method:'DELETE',token:superAuth.token,expected:204})
  for(const id of generatedUserIds)await request(`/api/collections/users/records/${id}`,{method:'DELETE',token:superAuth.token,expected:204})
  for(const user of users)await request(`/api/collections/users/records/${user.record.id}`,{method:'DELETE',token:superAuth.token,expected:204})
 }
}
