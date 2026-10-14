import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const directory = process.argv[2] || 'release'
const sourceSHA = process.env.SOURCE_SHA
assert.match(sourceSHA ?? '', /^[0-9a-f]{40}$/)
const git = (...args) => execFileSync('git', args)
assert.equal(git('rev-parse', 'HEAD').toString().trim(), sourceSHA, 'Manifest must describe checked-out source')
assert.equal(process.env.VERSION, `sha-${sourceSHA}`)
assert.match(process.env.BUILD_DATE ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const images = {}
for (const service of ['backend', 'frontend']) {
  const raw = await readFile(join(directory, `${service}-manifest.json`))
  const manifest = JSON.parse(raw)
  const config = JSON.parse(await readFile(join(directory, `${service}-config.json`), 'utf8'))
  const digest = process.env[`${service.toUpperCase()}_DIGEST`]
  assert.ok(hash(raw) === digest || (raw.at(-1) === 10 && hash(raw.subarray(0, -1)) === digest), `${service} registry digest`)
  assert.ok(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].includes(manifest.mediaType), 'A single-platform image manifest is required')
  assert.match(manifest.config?.digest ?? '', /^sha256:[0-9a-f]{64}$/)
  assert.equal(config.os, 'linux')
  assert.equal(config.architecture, 'amd64')
  assert.equal(config.config?.Labels?.['org.opencontainers.image.revision'], sourceSHA)
  images[service] = {
    image: `ghcr.io/e-dialect/wanyu-proofreader-${service}`,
    tag: `sha-${sourceSHA}`,
    digest,
    configDigest: manifest.config.digest,
    platform: 'linux/amd64',
    revision: sourceSHA,
  }
}
const goMod = git('show', `${sourceSHA}:backend/go.mod`).toString()
const pocketbaseVersion = goMod.match(/^\s*github\.com\/pocketbase\/pocketbase v([^\s]+)$/m)?.[1]
assert.ok(pocketbaseVersion, 'PocketBase version must be explicit')
// Canonical digest: SHA256 of UTF-8 JSON.stringify(sorted [{path,sha256}]),
// with no final newline. Read immutable Git blobs, never an operator data dir.
const migrations = git('ls-tree', '-rz', '--full-tree', sourceSHA, '--', 'backend/pb_migrations')
  .toString().split('\0').filter(Boolean).map(entry => {
    const [metadata, path] = entry.split('\t')
    const [mode, type, object] = metadata.split(' ')
    assert.ok(['100644', '100755'].includes(mode) && type === 'blob', 'Migration input must be a tracked regular file')
    return { path, sha256: hash(git('cat-file', 'blob', object)).slice(7) }
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
assert.ok(migrations.length > 0, 'Migration inventory must not be empty')
const release = {
  schemaVersion: 1,
  repository: 'e-dialect/wanyu-proofreader',
  sourceSHA,
  branch: 'main',
  platform: 'linux/amd64',
  workflowRunId: process.env.GITHUB_RUN_ID,
  ciRunId: process.env.CI_RUN_ID,
  createdAt: new Date().toISOString(),
  build: {
    frontend: { VITE_BACKEND_URL: '' },
    backend: { VERSION: process.env.VERSION, COMMIT: sourceSHA, BUILD_DATE: process.env.BUILD_DATE },
  },
  recovery: {
    kind: 'pocketbase', pocketbaseVersion, dataFormat: 'pocketbase-sqlite',
    migrationDigest: hash(Buffer.from(JSON.stringify(migrations))),
    compatibility: 'server-local-attestation-required', rollbackSafe: false,
  },
  images,
}
await writeFile(join(directory, 'release-manifest.json'), `${JSON.stringify(release, null, 2)}\n`)
