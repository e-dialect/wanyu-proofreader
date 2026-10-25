// Production build, synthetic PDF and real throwaway backend. No real corpus.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')
const fixture = JSON.parse(fs.readFileSync(process.env.PDF_BROWSER_FIXTURE))
const dist = path.resolve(__dirname, '../../frontend/dist')
const out = process.env.PDF_BROWSER_OUTPUT || path.resolve(__dirname, '../../output/playwright/page-images')
const csp = fs.readFileSync(path.resolve(__dirname, '../../frontend/nginx.conf'), 'utf8').match(/add_header Content-Security-Policy "([^"]+)"/)[1]
;(async () => {
 const browser = await chromium.launch({headless:true, ...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {})})
 fs.mkdirSync(out,{recursive:true})
 const evidence = {}
 try {
  for(const mode of ['desktop','mobile','fallback','fallback-mobile']) {
   const mobile=mode.includes('mobile'), fallback=mode.startsWith('fallback')
   const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:900}})
   const page=await context.newPage(), network=[], errors=[]
   page.on('pageerror',e=>errors.push(e.message))
   await page.route('**/*', async route=>{
    const req=route.request(), url=new URL(req.url())
    assert.equal(url.origin,'http://localhost')
    if(url.pathname.startsWith('/api/')) {
     if(url.pathname.includes('/images/') || /\/pdf(?:\/descriptor)?$/.test(url.pathname)) network.push(url.pathname)
     if(fallback && url.pathname.includes('/images/')) return route.fulfill({status:404,json:{message:'image unavailable fixture'}})
     const headers={...req.headers()};delete headers.host;delete headers['content-length']
     const response=await fetch(fixture.base+url.pathname+url.search,{method:req.method(),headers,body:req.postDataBuffer()||undefined})
     const responseHeaders=Object.fromEntries(response.headers);delete responseHeaders['content-length'];delete responseHeaders['content-encoding']
     return route.fulfill({status:response.status,headers:responseHeaders,body:Buffer.from(await response.arrayBuffer())})
    }
    const target=path.resolve(dist,'.'+url.pathname)
    assert(target.startsWith(dist+path.sep)||target===dist)
    if(fs.existsSync(target)&&fs.statSync(target).isFile()) return route.fulfill({path:target})
    return route.fulfill({path:path.join(dist,'index.html'),headers:{'Content-Security-Policy':csp}})
   })
   await page.addInitScript(({auth,claim})=>{
    localStorage.setItem('pocketbase_auth',JSON.stringify({token:auth.token,record:auth.record,model:auth.record}))
    localStorage.setItem(`fangji:onboarding:v1:${auth.record.id}`,JSON.stringify({version:1,completed:true}))
    sessionStorage.setItem(`fangji:task-lease:v1:${auth.record.id}:${claim.id}`,JSON.stringify({token:claim.leaseToken,expiresAt:claim.leaseExpiresAt}))
   },fixture)
   const started=Date.now()
   let initialMs
   await page.goto(`http://localhost/tasks/${fixture.claim.id}/edit`)
   if(fallback) {
    await page.waitForFunction(()=>document.querySelector('.pdf-canvas')?.width>10 && !document.querySelector('.pdf-loading-mask') && !document.querySelector('.pdf-transition-mask'))
    initialMs=Date.now()-started
    assert.equal(network.filter(p=>/\/pdf$/.test(p)).length,1)
   }else {
    await page.waitForFunction(()=>document.querySelector('.pdf-page-image')?.naturalWidth>10 && !document.querySelector('.pdf-transition-mask'))
    await page.waitForFunction(()=>!document.querySelector('.pdf-transition-mask'))
    initialMs=Date.now()-started
    assert.equal(await page.locator('.pdf-canvas').count(),0)
    assert.equal(await page.locator('script[src*="pdf.min.js"]').count(),0)
    // Wait for adjacent preload completion before navigating.
    await page.waitForTimeout(250)
    assert.equal(network.filter(p=>p.endsWith('/asset')).length,2)
    assert.equal(network.filter(p=>/\/pdf$/.test(p)).length,0)
    assert(network.every(p=>!p.includes('/images/') || /\/images\/[23]\//.test(p)))
   }
   const watermark=page.locator('.pdf-identity-watermark')
   await watermark.waitFor({state:'visible'})
   let stamp=await watermark.locator('span').first().textContent()
   assert(stamp.includes(`UID ${fixture.auth.record.id}`))
   assert(stamp.includes(`项目 ${fixture.project.id}`))
   assert.match(stamp,/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC/)
   assert(await watermark.locator('span').count()>1,'identity repeats across the page')
   assert.equal(await watermark.evaluate(el=>getComputedStyle(el).pointerEvents),'none')
   if(mode==='desktop') {
    // Coordinates use the descriptor's natural width/height, scaled with the page.
    await page.evaluate(({width,height})=>{
     const stage=document.querySelector('.pdf-canvas-stage')
     stage.dataset.sourceWidth=width;stage.dataset.sourceHeight=height
     const box=document.createElement('div')
     box.textContent='坐标示例 (10%, 15%)'
     Object.assign(box.style,{position:'absolute',left:'10%',top:'15%',width:'35%',height:'8%',border:'2px solid #e11d48',background:'rgba(225,29,72,.08)',color:'#9f1239',fontSize:'14px',pointerEvents:'none'})
     stage.appendChild(box)
    },fixture.imageInfo)
   }
   await page.screenshot({path:path.join(out,`${mode}.png`),fullPage:true})
   if(!fallback) {
    const before=network.filter(p=>p.endsWith('/asset')).length
    if(mobile) await page.locator('.source-actions-menu > summary').click()
    await page.getByRole('button',{name:'下一页',exact:true}).click()
    await page.waitForFunction(()=>document.querySelector('.pdf-page-input')?.value==='3' && document.querySelector('.pdf-page-image')?.naturalWidth>10 && !document.querySelector('.pdf-transition-mask'))
    if(mobile) await page.locator('.source-actions-menu > summary').click()
    assert.equal(network.filter(p=>p.endsWith('/asset')).length,before,'adjacent page should reuse prefetched asset')
    stamp=await watermark.locator('span').first().textContent()
    await page.getByRole('button',{name:'旋转 90°',exact:true}).click()
    await page.getByRole('button',{name:'放大',exact:true}).click()
    assert.equal(await page.locator('.pdf-zoom-label').textContent(),'125%')
    assert.equal(network.filter(p=>/\/pdf$/.test(p)).length,0)
   }
   if(fallback) {
    await page.getByRole('button',{name:'旋转 90°',exact:true}).click()
    await page.getByRole('button',{name:'放大',exact:true}).click()
    await page.waitForFunction(()=>!document.querySelector('.pdf-loading-mask'))
   }
   assert.equal(await watermark.locator('span').first().textContent(),stamp,'view controls keep the access stamp stable')
   assert.equal(await watermark.evaluate(el=>{
    const overlay=el.getBoundingClientRect(),stage=el.parentElement.getBoundingClientRect()
    return Math.abs(overlay.width-stage.width)<1 && Math.abs(overlay.height-stage.height)<1
   }),true,'overlay follows image and canvas dimensions')
   const previewSelector=fallback?'.pdf-canvas':'.pdf-page-image'
   await page.evaluate(selector=>{
    window.__fullscreenPreview=document.querySelector(selector)
    window.__nativeRequestFullscreen=Element.prototype.requestFullscreen
    Element.prototype.requestFullscreen=()=>Promise.reject(new DOMException('Synthetic fullscreen denial','NotAllowedError'))
   },previewSelector)
   const assertPreviewRetained=async()=>{
    assert.equal(await page.evaluate(selector=>{
     const preview=document.querySelector(selector)
     return preview===window.__fullscreenPreview && preview.isConnected && preview.getBoundingClientRect().width>10
    },previewSelector),true,`${mode}: fullscreen failure must retain the rendered preview node`)
    assert.equal(await page.locator('.pdf-viewer > .alert-error').count(),0,'fullscreen failure is not a fatal PDF error')
    assert.equal(await watermark.isVisible(),true,'identity remains visible after fullscreen failure')
   }
   await page.getByRole('button',{name:'全屏',exact:true}).click()
   await page.getByRole('status').filter({hasText:'浏览器未允许进入全屏模式，请重试。'}).waitFor({state:'visible'})
   await assertPreviewRetained()
   await page.getByRole('button',{name:'放大',exact:true}).click()
   assert.equal(await page.locator('.pdf-zoom-label').textContent(),'150%','zoom remains usable after denial')
   await page.getByRole('button',{name:'缩小',exact:true}).click()
   await page.screenshot({path:path.join(out,`${mode}-fullscreen-denied.png`),fullPage:true})
   await page.evaluate(()=>{Element.prototype.requestFullscreen=window.__nativeRequestFullscreen})
   await page.getByRole('button',{name:'全屏',exact:true}).click()
   await page.waitForFunction(()=>document.fullscreenElement?.classList.contains('pdf-viewer'))
   assert.equal(await page.locator('.pdf-fullscreen-notice').count(),0,'successful entry retry clears the notice')
   await assertPreviewRetained()
   assert.equal(await watermark.isVisible(),true,'identity remains in fullscreen')
   await page.evaluate(()=>{
    window.__nativeExitFullscreen=Document.prototype.exitFullscreen
    Document.prototype.exitFullscreen=()=>Promise.reject(new DOMException('Synthetic exit denial','NotAllowedError'))
   })
   await page.getByRole('button',{name:'退出全屏',exact:true}).click()
   await page.getByRole('status').filter({hasText:'浏览器未允许退出全屏模式，请重试。'}).waitFor({state:'visible'})
   await assertPreviewRetained()
   assert.equal(await page.evaluate(()=>document.fullscreenElement?.classList.contains('pdf-viewer')),true)
   await page.screenshot({path:path.join(out,`${mode}-exit-fullscreen-denied.png`),fullPage:true})
   await page.evaluate(()=>{Document.prototype.exitFullscreen=window.__nativeExitFullscreen})
   await page.getByRole('button',{name:'退出全屏',exact:true}).click()
   await page.waitForFunction(()=>!document.fullscreenElement)
   assert.equal(await page.locator('.pdf-fullscreen-notice').count(),0,'successful exit retry clears the notice')
   await assertPreviewRetained()
   assert.deepEqual(errors,[])
   evidence[mode]={initialMs,network,identityStamp:stamp}
   await context.close()
  }
  fs.writeFileSync(path.join(out,'network-and-timing.json'),JSON.stringify(evidence,null,2))
  console.log('PASS browser: page images without PDF.js; adjacent-only preload; cached navigation; rotation/zoom; mobile; PDF fallback; fullscreen entry/exit denial and retry retain previews',JSON.stringify(evidence))
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)})
