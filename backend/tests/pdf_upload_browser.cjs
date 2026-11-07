// Exercises the real upload UI and backend; injects transient HTTP/response loss.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {chromium}=require('playwright')
const fixture=JSON.parse(fs.readFileSync(process.env.PDF_BROWSER_FIXTURE))
const dist=path.resolve(__dirname,'../../frontend/dist')
const csp=fs.readFileSync(path.resolve(__dirname,'../../frontend/nginx.conf'),'utf8').match(/add_header Content-Security-Policy "([^"]+)"/)[1]
// A validation error fails after one POST; a transient error is retried four
// times. Both paths send one final cleanup POST with the same requestId.
// Update these counts and the assertions below if upload cleanup changes.
const CREATE_POSTS_PER_VALIDATION_FAILURE=2
const CREATE_POSTS_PER_TRANSIENT_FAILURE=5

async function navigationResume(page, output, originalRecords) {
 const { createHash } = require('node:crypto')
 const source = Buffer.from(fixture.source, 'base64')
 const label = source.indexOf('SOURCE_PAGE_1')
 assert.ok(label >= 0)
 source.write('RESUME_PAGE_1', label, 'ascii') // Same byte length preserves PDF xref offsets.
 const contentHash = createHash('sha256').update(source).digest('hex')
 assert.notEqual(contentHash, createHash('sha256').update(Buffer.from(fixture.source, 'base64')).digest('hex'))
 const url = `/api/fangji/projects/${fixture.project.id}/pdf-uploads`
 const materialUrl = `http://localhost/admin/projects/${fixture.project.id}?section=materials&view=import&method=pdf`
 const scopeKey = `fangji:pdf-upload:v1:${fixture.auth.record.id}:${fixture.project.id}`
 const deletions = [], creates = [], resumedChunks = [], nativeDialogs = []
 let phase = 'pausing', sessionId, releaseHeld, receivedHeld
 const held = new Promise(resolve => { receivedHeld = resolve })
 const released = new Promise(resolve => { releaseHeld = resolve })
 const pattern = /\/api\/fangji\/projects\/[^/]+\/pdf-uploads(?:\/.*)?$/
 const handler = async route => {
  const request = route.request(), pathname = new URL(request.url()).pathname
  if (request.method() === 'DELETE') deletions.push(pathname)
  if (request.method() === 'POST' && pathname === url) creates.push(request.postDataJSON())
  const chunk = pathname.match(/\/pdf-uploads\/([^/]+)\/chunks\/(\d+)$/)
  if (chunk) {
   sessionId = chunk[1]
   const index = Number(chunk[2])
   if (phase === 'resuming') resumedChunks.push(index)
   if (phase === 'pausing' && index === 1) {
    // Chunk zero has already reached the real backend. Hold the next request
    // before forwarding so SPA unmount can pause a genuinely partial upload.
    receivedHeld()
    await released
    return route.abort('aborted').catch(() => {})
   }
  }
  return route.fallback()
 }
 const onDialog = async dialog => { nativeDialogs.push(dialog.type()); await dialog.dismiss() }
 const read = async pathname => {
  const response = await fetch(fixture.base + pathname, { headers: { Authorization: fixture.auth.token } })
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
 }
 await page.route(pattern, handler)
 page.on('dialog', onDialog)
 try {
  const marker = await page.evaluate(() => globalThis.__pdfSpaMarker = crypto.randomUUID())
  await page.locator('input[type=file][accept=".pdf"]').setInputFiles({ name: 'resume.pdf', mimeType: 'application/pdf', buffer: source })
  let timer
  try {
   await Promise.race([held, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Second upload did not reach chunk one')), 10000) })])
  } finally { clearTimeout(timer) }
  assert.ok(sessionId)
  assert.deepEqual((await read(url)).items.find(item => item.id === sessionId).received, [0])
  await page.locator('a.back-link[href="/admin"]').click()
  const leave = page.getByRole('dialog', { name: '离开当前工作区？', exact: true })
  await leave.waitFor()
  await leave.getByText('离开会暂停 PDF 上传并保留已有分片', { exact: false }).waitFor()
  await leave.getByRole('button', { name: '确认离开', exact: true }).click()
  await page.waitForURL('http://localhost/admin')
  assert.equal(await page.evaluate(() => globalThis.__pdfSpaMarker), marker, 'this is a SPA departure, without native beforeunload')
  releaseHeld()
  await page.waitForLoadState('networkidle')
  const partial = (await read(url)).items.find(item => item.id === sessionId)
  assert.ok(partial, 'confirmed navigation preserves the active server upload')
  assert.deepEqual(partial.received, [0])
  assert.deepEqual(deletions, [], 'navigation pause must not DELETE the server session')
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), scopeKey)
  assert.equal(stored.sessionId, sessionId)
  assert.equal(stored.contentHash, contentHash)
  assert.deepEqual(stored.received, [0])
  await page.goto(materialUrl)
  await page.getByRole('button', { name: '重新选择同一 PDF', exact: true }).waitFor()
  await page.getByText('有未完成的 PDF 上传：resume.pdf', { exact: false }).waitFor()
  await page.screenshot({ path: path.join(output, 'upload-navigation-paused.png'), fullPage: true })
  phase = 'resuming'
  await page.locator('input[type=file][accept=".pdf"]').setInputFiles({ name: 'resume.pdf', mimeType: 'application/pdf', buffer: source })
  await page.waitForFunction(() => document.body.textContent.includes('PDF 深度校验完成，共 4 页') && !document.querySelector('progress'), {}, { timeout: 30000 })
  assert.deepEqual(resumedChunks, [1, 2], 'reselection uploads only the two missing chunks, without re-uploading chunk zero')
  assert.equal(creates.length, 2, 'the original create and resume handshake are the only create requests')
  assert.equal(creates[0].requestId, creates[1].requestId)
  assert.equal(creates[1].contentHash, contentHash)
  assert.deepEqual(deletions, [])
  assert.deepEqual(nativeDialogs, [], 'SPA navigation uses the reviewable leave modal')
  assert.equal(await page.evaluate(key => localStorage.getItem(key), scopeKey), null)
  assert.equal((await read(url)).items.length, 0, 'completion removes the active resume session')
  const records = await read(`/api/collections/project_files/records?filter=${encodeURIComponent(`project="${fixture.project.id}"`)}`)
  assert.equal(records.totalItems, originalRecords.totalItems + 1, 'pause and resume produce exactly one additional file')
  const added = records.items.filter(item => !originalRecords.items.some(original => original.id === item.id))
  assert.equal(added.length, 1)
  assert.equal(added[0].status, 'ready')
  assert.equal(added[0].file_hash, contentHash)
  assert.equal(added[0].page_count, 4)
  await page.screenshot({ path: path.join(output, 'upload-navigation-resumed.png'), fullPage: true })
  console.log('PASS browser: SPA leave confirmation preserves chunk zero and its scoped session; same-hash reselection sends only missing chunks and creates one new ready file')
 } finally {
  releaseHeld()
  await page.unroute(pattern, handler)
  page.off('dialog', onDialog)
 }
}
;(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})})
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}})
 const chunks=[],completions=[],errors=[];let failed=false,lost=false,forwardedCreates=0,validationCreates=0,blockedCreates=0
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());assert.equal(url.origin,'http://localhost')
  if(url.pathname.startsWith('/api/')){
   assert(!url.pathname.endsWith('/files/pdf'),'UI must use chunked upload')
   if(url.pathname.endsWith('/pdf-uploads')&&req.method()==='POST'){
    // A validation failure and its cleanup request must not reach the backend.
    if(validationCreates<CREATE_POSTS_PER_VALIDATION_FAILURE){validationCreates++;return route.fulfill({status:400,json:{message:'PDF 结构损坏'}})}
    // A transient create failure gets four attempts, then one cleanup POST.
    // Block all five so the backend sees only the session created by UI retry.
    if(blockedCreates<CREATE_POSTS_PER_TRANSIENT_FAILURE){blockedCreates++;return route.fulfill({status:503,json:{message:'暂时无法上传，请重试'}})}
    forwardedCreates++
   }
   if(url.pathname.includes('/chunks/')){
    const data=req.postDataBuffer();assert(data.length<=1024*1024);chunks.push({path:url.pathname,size:data.length})
    if(!failed&&url.pathname.endsWith('/chunks/1')) {failed=true;return route.fulfill({status:503,json:{message:'temporary upload failure'}})}
   }
   const headers={...req.headers()};delete headers.host;delete headers['content-length']
   const res=await fetch(fixture.base+url.pathname+url.search,{method:req.method(),headers,body:req.postDataBuffer()||undefined})
   const body=Buffer.from(await res.arrayBuffer())
   if(url.pathname.endsWith('/complete')){
    assert([200,202].includes(res.status),body.toString());completions.push(JSON.parse(body))
    if(!lost){lost=true;return route.abort('failed')}
   }
   const responseHeaders=Object.fromEntries(res.headers);delete responseHeaders['content-length'];delete responseHeaders['content-encoding']
   return route.fulfill({status:res.status,headers:responseHeaders,body})
  }
  const target=path.resolve(dist,'.'+url.pathname);assert(target.startsWith(dist+path.sep)||target===dist)
  if(fs.existsSync(target)&&fs.statSync(target).isFile())return route.fulfill({path:target})
  return route.fulfill({path:path.join(dist,'index.html'),headers:{'Content-Security-Policy':csp}})
 })
 await page.addInitScript(auth=>localStorage.setItem('pocketbase_auth',JSON.stringify({token:auth.token,record:auth.record,model:auth.record})),fixture.auth)
 await page.goto(`http://localhost/admin/projects/${fixture.project.id}?section=materials&view=import&method=pdf`)
 const input=page.locator('input[type=file][accept=".pdf"]')
 assert.equal(await input.getAttribute('multiple'),null,'PDF selection remains single-file')
 const out=process.env.PDF_BROWSER_OUTPUT||path.resolve(__dirname,'../../output/playwright/pdf-upload')
 fs.mkdirSync(out,{recursive:true})
 await input.setInputFiles({name:'invalid.txt',mimeType:'text/plain',buffer:Buffer.from('invalid')})
 await page.getByText('请选择不超过 100 MiB 的 PDF 文件').waitFor()
 assert.equal(blockedCreates,0,'invalid selection must not attempt to create a session')
 assert.equal(forwardedCreates,0,'invalid selection must not forward a create POST')
 await page.screenshot({path:path.join(out,'upload-invalid.png'),fullPage:true})
 await input.setInputFiles({name:'source.pdf',mimeType:'application/pdf',buffer:Buffer.from(fixture.source,'base64')})
 await page.getByText(/PDF 结构损坏.*重新选择 PDF 文件/).waitFor()
 assert.equal(validationCreates,CREATE_POSTS_PER_VALIDATION_FAILURE,'validation failure must consume create and cleanup POSTs')
 assert.equal(await page.getByRole('button',{name:'重试上传 PDF'}).count(),0,'validation failure must not offer retry')
 await page.waitForFunction(()=>document.querySelector('input[type=file][accept=".pdf"]')?.value==='')
 assert.equal(await input.inputValue(),'','failed upload must reset file input')
 await page.screenshot({path:path.join(out,'upload-validation-failure.png'),fullPage:true})
 await input.setInputFiles({name:'source.pdf',mimeType:'application/pdf',buffer:Buffer.from(fixture.source,'base64')})
 await page.getByRole('button',{name:'重试上传 PDF'}).waitFor()
 assert.equal(blockedCreates,CREATE_POSTS_PER_TRANSIENT_FAILURE,'failed create must consume four retries and one cleanup POST')
 assert.equal(forwardedCreates,0,'failed create POSTs must be intercepted before forwarding')
 await page.screenshot({path:path.join(out,'upload-failure.png'),fullPage:true})
 await page.getByRole('button',{name:'重试上传 PDF'}).click()
 await page.locator('progress').waitFor({state:'visible'})
 assert(await input.isDisabled(),'selection must be disabled during upload')
 await page.waitForFunction(()=>Number(document.querySelector('progress')?.value)>0)
 await page.screenshot({path:path.join(out,'upload-progress.png'),fullPage:true})
 await page.waitForFunction(()=>document.body.textContent.includes('PDF 深度校验完成，共 4 页')&&!document.querySelector('progress'),{},{timeout:30000})
 assert.equal(forwardedCreates,1,'retry must forward exactly one create POST')
 assert.equal(await page.getByRole('button',{name:'重试上传 PDF'}).count(),0,'success must not show retry')
 await page.screenshot({path:path.join(out,'upload-success.png'),fullPage:true})
 assert.equal(chunks.length,4,'three chunks plus one retry')
 assert.equal(completions.length,2,'lost completion response must retry')
 assert.equal(completions[0].id,completions[1].id)
 const records=await fetch(`${fixture.base}/api/collections/project_files/records?filter=${encodeURIComponent(`project="${fixture.project.id}"`)}`,{headers:{Authorization:fixture.auth.token}}).then(r=>r.json())
 assert.equal(records.totalItems,1)
 assert.equal(records.items[0].status,'ready')
 assert.deepEqual(errors,[])
 console.log('PASS browser: 1 MiB chunks, progress, temporary 503 retry, lost completion response, exactly one ready file')
 await navigationResume(page,out,records)
 assert.deepEqual(errors,[])
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)})
