import assert from 'node:assert/strict'
import vm from 'node:vm'

// Run against the production Nginx entrypoint, not Vite.
const base = process.env.FRONTEND_URL || 'http://127.0.0.1:18080'
const index = await fetch(`${base}/`)
assert.equal(index.status, 200)
assert.equal(index.headers.get('cache-control'), 'no-cache')
const html = await index.text()
assert(
  html.indexOf('/runtime-config.js') < html.indexOf('/assets/'),
  'runtime configuration must load before the application'
)
const runtime = await fetch(`${base}/runtime-config.js`)
assert.equal(runtime.status, 200)
assert.equal(runtime.headers.get('cache-control'), 'no-store')
assert.match(runtime.headers.get('content-type'), /javascript/)
const context = {}
vm.runInNewContext(await runtime.text(), context)
assert.equal(context.__FANGJI_BACKEND_URL__, process.env.EXPECTED_BACKEND_URL || '')
const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]
assert(asset, 'production entrypoint must reference a hashed JS asset')
const bundle = await fetch(`${base}${asset}`)
assert.equal(bundle.status, 200)
assert.equal(bundle.headers.get('cache-control'), 'public, max-age=31536000, immutable')
const cachedBundle = await fetch(`${base}${asset}`, {
  headers: { 'If-None-Match': bundle.headers.get('etag') }
})
assert.equal(cachedBundle.status, 304)
assert.equal(cachedBundle.headers.get('cache-control'), 'public, max-age=31536000, immutable')
const missingBundle = await fetch(`${base}/assets/missing.js`)
assert.equal(missingBundle.status, 404)
assert(!missingBundle.headers.get('cache-control')?.includes('immutable'))
for (const result of [index, runtime, bundle, cachedBundle, missingBundle]) {
  assert.match(result.headers.get('content-security-policy'), /script-src 'self'/)
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff')
}
for (const [directory, manifestName, missingFile] of [
  ['rare-han', 'manifest.json', 'rare-1234-000000000000.woff2'],
  ['phonetic', 'manifest.json', 'phonetic-000000000000.woff2'],
  ['phonetic', 'symbols-manifest.json', 'symbols-000000000000.woff2']
]) {
  const manifestResponse = await fetch(`${base}/fonts/${directory}/${manifestName}`)
  assert.equal(manifestResponse.status, 200)
  const manifest = await manifestResponse.json()
  const url = `${base}/fonts/${directory}/${manifest.file || manifest.subsets[0].file}`
  const response = await fetch(url)
  assert.equal(response.status, 200, url)
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable', url)
  assert.match(response.headers.get('content-type'), /woff2/)
  assert.equal(
    Buffer.from(await response.arrayBuffer())
      .subarray(0, 4)
      .toString(),
    'wOF2'
  )
  assert(response.headers.get('etag'))
  const cached = await fetch(url, { headers: { 'If-None-Match': response.headers.get('etag') } })
  assert.equal(cached.status, 304)
  assert.equal(cached.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  const missing = await fetch(`${base}/fonts/${directory}/${missingFile}`)
  assert.equal(missing.status, 404)
  assert(!missing.headers.get('cache-control')?.includes('immutable'))
  for (const result of [response, cached, missing]) {
    assert.match(result.headers.get('content-security-policy'), /font-src 'self' data:/)
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(result.headers.get('x-frame-options'), 'DENY')
    assert.equal(result.headers.get('referrer-policy'), 'strict-origin-when-cross-origin')
  }
}
console.log('PASS: runtime URL, immutable bundles/fonts, cache, 304, 404 and security headers')
