#!/bin/sh
set -eu

run_id="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
network_name="fangji-proxy-rate-limit-ci-${run_id}"
backend_name="fangji-backend-proxy-ci-${run_id}"
frontend_name="fangji-frontend-proxy-ci-${run_id}"
backend_image="${PROXY_TEST_BACKEND_IMAGE:-fangji-backend:ci}"
frontend_image="${PROXY_TEST_FRONTEND_IMAGE:-fangji-frontend:ci}"
backend_id=''
frontend_id=''
network_id=''

cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ -n "$frontend_id" ]; then docker rm -f "$frontend_id" >/dev/null || result=1; fi
  if [ -n "$backend_id" ]; then docker rm -f "$backend_id" >/dev/null || result=1; fi
  if [ -n "$network_id" ]; then docker network rm "$network_id" >/dev/null || result=1; fi
  echo "Proxy test cleanup: run=${run_id} exit=${result}"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Reuse only local images; never pull or overwrite another test's tags/resources.
backend_image="$(docker image inspect --format '{{.Id}}' "$backend_image")"
frontend_image="$(docker image inspect --format '{{.Id}}' "$frontend_image")"
echo "Proxy test images: backend=${backend_image} frontend=${frontend_image} run=${run_id}"
set --
if [ -n "${PROXY_TEST_SUBNET:-}" ]; then set -- --subnet "$PROXY_TEST_SUBNET"; fi
network_id="$(docker network create --label fangji.test=proxy-rate-limit --label "fangji.test.run=$run_id" "$@" "$network_name")"
proxy_network_cidr="$(docker network inspect --format '{{(index .IPAM.Config 0).Subnet}}' "$network_name")"
backend_id="$(docker run -d --pull=never \
  --name "$backend_name" \
  --label fangji.test=proxy-rate-limit --label "fangji.test.run=$run_id" \
  --network "$network_name" \
  --network-alias backend \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=512m \
  --tmpfs /pb/pb_data:rw,uid=10001,gid=10001,mode=0700 \
  -e HINGHWA_IDENTITY_BASE_URL=https://127.0.0.1:1 \
  -e TRUSTED_PROXY_CIDRS="$proxy_network_cidr" \
  "$backend_image")"

backend_ready=false
for _ in $(seq 1 60); do
  if docker exec "$backend_name" curl --fail --silent http://127.0.0.1:8090/api/health >/dev/null 2>&1; then
    backend_ready=true
    break
  fi
  sleep 1
done
if [ "$backend_ready" != true ]; then
  docker logs "$backend_name"
  echo "Backend did not become ready." >&2
  exit 1
fi

start_frontend() {
  frontend_id="$(docker run -d --pull=never \
  --name "$frontend_name" \
  --label fangji.test=proxy-rate-limit --label "fangji.test.run=$run_id" \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --network "$network_name" \
  -p 127.0.0.1::8080 \
  -e ENABLE_POCKETBASE_ADMIN_UI="$1" \
  -e TRUSTED_PROXY_CIDRS="$proxy_network_cidr" \
  "$frontend_image")"
  frontend_url="http://$(docker port "$frontend_id" 8080/tcp)"
}
start_frontend false

frontend_ready=false
for _ in $(seq 1 30); do
  if curl --fail --silent "$frontend_url/healthz" >/dev/null 2>&1; then
    frontend_ready=true
    break
  fi
  sleep 1
done
if [ "$frontend_ready" != true ]; then
  docker logs "$frontend_name"
  echo "Frontend did not become ready." >&2
  exit 1
fi

test "$(docker exec "$backend_name" id -u)" = 10001
test "$(docker exec "$frontend_name" id -u)" != 0
# Verify the runtime font files are served as fonts, with cache/security headers.
FRONTEND_URL="$frontend_url" node frontend/scripts/test-font-cache.mjs

FRONTEND_URL="$frontend_url" node --input-type=module <<'NODE'
import assert from 'node:assert/strict'

const base = process.env.FRONTEND_URL
let requestCount = 0
async function login(clientIP, identity, expected) {
  const sequence = ++requestCount
  const forgedIP = `198.51.100.${sequence}`
  const response = await fetch(`${base}/api/fangji/auth/external/hinghwa/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // This is the configured trusted edge's authoritative client address.
      // Nginx must replace the forged forwarding values before the backend.
      'X-Real-IP': clientIP,
      'X-Forwarded-For': forgedIP,
      'Forwarded': `for=${forgedIP}`,
      'X-Fangji-Client-IP': forgedIP,
      'X-Account-Security-Rate-Limited': 'true',
      'fangjiClientIP': forgedIP,
      'accountSecurityRateLimited': 'true'
    },
    body: JSON.stringify({ identity, password: 'proxy-test-password' }),
    signal: AbortSignal.timeout(10000)
  })
  // Drain each response before the next attempt, retaining every status.
  await response.arrayBuffer()
  assert.equal(response.status, expected, `request ${sequence} client ${clientIP} identity ${identity}`)
}

// Unique identities isolate the 120/IP/minute budget from the separate
// 10/identity/minute budget. Reusing one identity would only test the latter.
const ipStarted = performance.now()
for (let attempt = 1; attempt <= 120; attempt++) {
  await login('203.0.113.20', `proxy-ip-${attempt}`, 502)
}
await login('203.0.113.20', 'proxy-ip-121', 429)
const ipWindowMs = performance.now() - ipStarted
assert(ipWindowMs < 60000, `IP probes crossed the real one-minute window: ${ipWindowMs}ms`)
await login('203.0.113.21', 'proxy-independent-client', 502)

// Conversely, rotating genuine edge-provided client addresses must not reset
// the identity budget. No single address reaches its own IP limit here.
const identityStarted = performance.now()
for (let attempt = 1; attempt <= 10; attempt++) {
  await login(`203.0.113.${30 + attempt}`, 'proxy-shared-identity', 502)
}
await login('203.0.113.41', 'proxy-shared-identity', 429)
const identityWindowMs = performance.now() - identityStarted
assert(identityWindowMs < 60000, `Identity probes crossed the real one-minute window: ${identityWindowMs}ms`)
await login('203.0.113.41', 'proxy-independent-identity', 502)
console.log(JSON.stringify({
  status: 'pass', requestCount, ipAllowed: 120, ipBlocked: 1, independentClient: true,
  identityAllowedAcrossIPs: 10, identityBlocked: 1, independentIdentity: true,
  forgedForwardingAndInternalHeadersIgnored: true,
  ipWindowMs: Math.round(ipWindowMs), identityWindowMs: Math.round(identityWindowMs)
}))
NODE

# Closed admin UI serves only the static legacy account-link bridge at these
# exact paths. A 200 alone must not accidentally accept the admin UI or SPA.
FRONTEND_URL="$frontend_url" node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
const base = process.env.FRONTEND_URL
for (const path of ['/_', '/_/']) {
  const response = await fetch(base + path)
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /legacy-account\.js/)
  assert.doesNotMatch(html, /PocketBase Admin|assets\/index/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  const policy = response.headers.get('content-security-policy')
  assert.match(policy, /default-src 'none'/)
  assert.match(policy, /script-src 'self'/)
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/)
}
assert.equal((await fetch(base + '/_/not-an-account-link')).status, 404)
assert.equal((await fetch(base + '/legacy-account.js')).status, 200)
console.log('PASS: closed administrator UI serves only the protected static account-link bridge')
NODE

docker rm -f "$frontend_id" >/dev/null
frontend_id=''
start_frontend true
for _ in $(seq 1 30); do
  if curl --fail --silent "$frontend_url/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done

FRONTEND_URL="$frontend_url" node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
const base = process.env.FRONTEND_URL
const redirect = await fetch(`${base}/_`, { redirect: 'manual', headers: { Host: 'fangji.example.com', 'X-Forwarded-Proto': 'https' } })
assert.equal(redirect.status, 308)
assert.equal(redirect.headers.get('location'), '/_/')
const ui = await fetch(`${base}/_/`)
assert.equal(ui.status, 200)
const html = await ui.text()
assert.match(html, /PocketBase/)
const script = html.match(/<script[^>]+src="([^"]+)"/)
assert(script, 'PocketBase UI must reference a script')
const asset = await fetch(new URL(script[1], `${base}/_/`))
assert.equal(asset.status, 200)
assert.match(asset.headers.get('content-type'), /javascript/)
const protectedApi = await fetch(`${base}/api/settings`)
assert([401, 403].includes(protectedApi.status), 'Enabling UI must not bypass administrator authentication')
console.log('PocketBase administrator UI: disabled paths, relative HTTPS-safe redirect, UI/assets and protected API checks passed.')
NODE
