import assert from 'node:assert/strict'

// Run against a disposable production Nginx, never a production deployment.
const base = process.env.FRONTEND_URL
assert.ok(base, 'FRONTEND_URL is required')
for (const path of ['/_', '/_/']) {
  const response = await fetch(base + path)
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /legacy-account\.js/)
  assert.doesNotMatch(html, /PocketBase Admin|assets\/index/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/)
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/)
  assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-inline|unsafe-eval/)
}
assert.equal((await fetch(base + '/_/not-an-account-link')).status, 404)
assert.equal((await fetch(base + '/legacy-account.js')).status, 200)
for (const path of [
  '/account/recover',
  '/account/reset-password',
  '/account/confirm-email',
  '/account/verify-email'
]) {
  const response = await fetch(base + path)
  assert.equal(response.status, 200)
  assert.match(await response.text(), /runtime-config\.js/)
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
}
const runtime = await fetch(base + '/runtime-config.js')
assert.equal(runtime.headers.get('cache-control'), 'no-store')
assert.match(await runtime.text(), /__FANGJI_NATIVE_DELIVERY_ENABLED__ = false/)
// UI closure is intentionally distinct from the API proxy. Without a backend
// in this disposable Nginx test, 502 proves routing only, not API authorization.
const adminApi = await fetch(base + '/api/collections/_superusers/auth-with-password', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}'
})
assert.ok(
  [400, 401, 429, 502].includes(adminApi.status),
  `unexpected admin API proxy status ${adminApi.status}`
)
await fetch(base + '/account/recover?token=NGINX_LOG_SECRET_SENTINEL')
await fetch(base + '/api/files/private/record/source.pdf?token=NGINX_LOG_SECRET_SENTINEL')
console.log(
  JSON.stringify({
    status: 'pass',
    legacyBridge: true,
    recoveryRoutes: true,
    nativeDeliveryDisabled: true,
    adminUiClosed: true,
    adminApiProxyStatus: adminApi.status,
    boundary: 'Nginx routing and headers only; backend authorization has separate HTTP tests'
  })
)
