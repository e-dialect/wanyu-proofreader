import assert from 'node:assert/strict'

assert.match(process.env.SOURCE_SHA ?? '', /^[0-9a-f]{40}$/)
assert.ok(process.env.GHCR_TOKEN, 'Registry credentials required')
const tag = `sha-${process.env.SOURCE_SHA}`
for (const service of ['backend', 'frontend']) {
  for (let page = 1; ; page += 1) {
    const response = await fetch(`https://api.github.com/orgs/e-dialect/packages/container/wanyu-proofreader-${service}/versions?per_page=100&page=${page}`, {
      headers: {
        Authorization: `Bearer ${process.env.GHCR_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    // A new package returns 404. All other failures must block publication.
    if (response.status === 404 && page === 1) break
    assert.ok(response.ok, `Cannot establish tag absence (${response.status})`)
    const versions = await response.json()
    assert.ok(Array.isArray(versions), 'Invalid package-version response')
    assert.ok(!versions.some(version => version.metadata?.container?.tags?.includes(tag)),
      `Refusing to overwrite immutable wanyu-proofreader-${service} source tag`)
    if (versions.length < 100) break
  }
}
console.log('Both immutable source tags are absent')
