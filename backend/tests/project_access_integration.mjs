import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { managedProjectIds } = createRequire(import.meta.url)('../pb_hooks/lib/project_access.js')
const baseUrl = process.env.PB_URL || 'http://127.0.0.1:18091'
const platformEmail = process.env.APP_ADMIN_EMAIL
const platformPassword = process.env.APP_ADMIN_PASSWORD

if (!platformEmail || !platformPassword) {
  throw new Error('Set APP_ADMIN_EMAIL and APP_ADMIN_PASSWORD before running this integration test.')
}

async function rawRequest(path, { method = 'GET', token = '', body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  let payload = null
  if (text) {
    try { payload = JSON.parse(text) } catch { payload = text }
  }
  return { status: response.status, payload, text }
}

async function request(path, { expected = 200, ...options } = {}) {
  const response = await rawRequest(path, options)
  assert.equal(
    response.status,
    expected,
    `${options.method || 'GET'} ${path} returned ${response.status}: ${response.text}`
  )
  return response.payload
}

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const password = 'ProjectAccess123!'

async function createUser(label, displayName = label) {
  const email = `${label}-${suffix}@example.com`
  const record = await request('/api/collections/users/records', {
    method: 'POST',
    expected: 200,
    body: {
      email,
      password,
      passwordConfirm: password,
      name: displayName,
      role: 'platform_admin'
    }
  })
  assert.equal(record.role, 'user', 'public registration must not assign a privileged global role')
  const auth = await request('/api/collections/users/auth-with-password', {
    method: 'POST',
    body: { identity: email, password }
  })
  return { id: record.id, email, token: auth.token }
}

function accessUnitRecord(id, fields = {}) {
  return { id, getString: (key) => String(fields[key] || '') }
}

function testManagedProjectIdsBeyondLegacyLimit() {
  const auth = accessUnitRecord('unit-user', { role: 'user' })
  const owned = Array.from({ length: 501 }, (_, index) => accessUnitRecord(`owned-${index}`))
  const managerMemberships = Array.from({ length: 501 }, (_, index) => accessUnitRecord(
    `membership-${index}`,
    { project: `managed-${index}`, role: 'manager' }
  ))
  const dao = {
    findRecordsByFilter(collection, filter, sort, limit, offset) {
      assert.equal(offset, 0)
      if (collection === 'projects') {
        assert.equal(filter, 'admin = "unit-user"')
        return owned.slice(offset, offset + limit)
      }
      assert.equal(collection, 'project_memberships')
      assert.equal(filter, 'user = "unit-user" && role = "manager"')
      return managerMemberships.slice(offset, offset + limit)
    }
  }
  const ids = managedProjectIds(dao, auth)
  assert.equal(ids.length, 1002, 'owned and manager project ids must both exceed the old 500-row cap')
  assert.equal(new Set(ids).size, 1002)

  const platformProjects = Array.from({ length: 501 }, (_, index) => accessUnitRecord(`platform-${index}`))
  const platformIds = managedProjectIds({
    findRecordsByFilter(collection, filter, sort, limit, offset) {
      assert.equal(collection, 'projects', 'platform admin enumeration must not query memberships')
      return platformProjects.slice(offset, offset + limit)
    }
  }, accessUnitRecord('unit-admin', { role: 'platform_admin' }))
  assert.equal(platformIds.length, 501, 'platform admin ids must not stop at the old 500-row cap')
}

testManagedProjectIdsBeyondLegacyLimit()

const platformAuth = await request('/api/collections/users/auth-with-password', {
  method: 'POST',
  body: { identity: platformEmail, password: platformPassword }
})
const platform = { id: platformAuth.record.id, token: platformAuth.token }

const creator = await createUser('creator')
const manager = await createUser('manager')
const proofreader = await createUser('proofreader')
const outsider = await createUser('outsider')
const passwordUser = await createUser('password-user')
const rateLimitedUser = await createUser('rate-limited-user')
const sharedSourceAttackers = await Promise.all(
  Array.from({ length: 6 }, (_, index) => createUser(`shared-source-attacker-${index + 1}`))
)
const concurrentCreator = await createUser('concurrent-creator')
const projectIds = []

try {
  const platformContext = await request('/api/fangji/access-context', { token: platform.token })
  assert.equal(platformContext.isPlatformAdmin, true)
  assert.equal(platformContext.canCreateProjects, true)
  assert.equal(platformContext.projectLimit, null)

  await request('/api/fangji/projects', {
    method: 'POST',
    token: creator.token,
    expected: 403,
    body: { name: 'Must not exist' }
  })
  await request('/api/collections/projects/records', {
    method: 'POST',
    token: creator.token,
    expected: 403,
    body: { name: 'Direct create bypass', admin: creator.id, access_mode: 'public' }
  })

  await request(`/api/fangji/platform/creator-grants/${creator.id}`, {
    method: 'PUT',
    token: platform.token,
    body: { enabled: true, projectLimit: 1 }
  })
  const grantedContext = await request('/api/fangji/access-context', { token: creator.token })
  assert.equal(grantedContext.canCreateProjects, true)
  assert.equal(grantedContext.projectLimit, 1)
  assert.equal(grantedContext.remainingProjects, 1)

  await request(`/api/fangji/platform/creator-grants/${passwordUser.id}`, {
    method: 'PUT',
    token: platform.token,
    body: { enabled: true, projectLimit: null }
  })
  const unlimitedContext = await request('/api/fangji/access-context', { token: passwordUser.token })
  assert.equal(unlimitedContext.canCreateProjects, true)
  assert.equal(unlimitedContext.projectLimit, null)
  assert.equal(unlimitedContext.remainingProjects, null)

  const privateProject = await request('/api/fangji/projects', {
    method: 'POST',
    token: creator.token,
    expected: 201,
    body: { name: `Private ${suffix}`, description: 'members only by default' }
  })
  projectIds.push(privateProject.id)
  assert.equal(privateProject.access_mode, 'members_only')
  assert.equal(privateProject.owner, creator.id)
  assert.equal(privateProject.capabilities.projectRole, 'owner')

  await request('/api/fangji/projects', {
    method: 'POST',
    token: creator.token,
    expected: 403,
    body: { name: 'Over quota' }
  })
  await request(`/api/fangji/projects/${privateProject.id}`, {
    token: outsider.token,
    expected: 403
  })
  await request(`/api/collections/projects/records/${privateProject.id}`, {
    token: outsider.token,
    expected: 404
  })

  await request(`/api/fangji/projects/${privateProject.id}/members/${manager.id}`, {
    method: 'PUT',
    token: creator.token,
    body: { role: 'manager' }
  })
  await request(`/api/fangji/projects/${privateProject.id}/members/${proofreader.id}`, {
    method: 'PUT',
    token: manager.token,
    body: { role: 'proofreader' }
  })
  await request(`/api/fangji/projects/${privateProject.id}/members/${manager.id}`, {
    method: 'PUT',
    token: creator.token,
    body: { role: 'proofreader' }
  })
  const demotedContext = await request('/api/fangji/access-context', { token: manager.token })
  assert.ok(!demotedContext.managedProjectIds.includes(privateProject.id),
    'manager demotion must be visible immediately')
  assert.ok(demotedContext.proofreadingProjectIds.includes(privateProject.id),
    'proofreader promotion must be visible immediately')
  const demotedManaged = await request('/api/fangji/projects?scope=managed', { token: manager.token })
  assert.ok(!demotedManaged.some((item) => item.id === privateProject.id))
  const demotedProofreading = await request('/api/fangji/projects?scope=proofreading', { token: manager.token })
  assert.ok(demotedProofreading.some((item) => item.id === privateProject.id))

  await request(`/api/fangji/projects/${privateProject.id}/members/${manager.id}`, {
    method: 'PUT',
    token: creator.token,
    body: { role: 'manager' }
  })
  const restoredContext = await request('/api/fangji/access-context', { token: manager.token })
  assert.ok(restoredContext.managedProjectIds.includes(privateProject.id),
    'manager restoration must be visible immediately')
  assert.ok(!restoredContext.proofreadingProjectIds.includes(privateProject.id))

  const members = await request(`/api/fangji/projects/${privateProject.id}/members`, { token: manager.token })
  assert.equal(members.filter((item) => item.user === manager.id).length, 1)
  assert.equal(members.find((item) => item.user === manager.id).role, 'manager')
  assert.equal(members.find((item) => item.user === proofreader.id).role, 'proofreader')

  const accessCases = [
    { label: 'owner', user: creator, managed: true, proofreading: false, projectRole: 'owner', visible: true },
    { label: 'manager', user: manager, managed: true, proofreading: false, projectRole: 'manager', visible: true },
    { label: 'proofreader', user: proofreader, managed: false, proofreading: true, projectRole: 'proofreader', visible: true },
    { label: 'outsider', user: outsider, managed: false, proofreading: false, projectRole: null, visible: false },
    { label: 'platform admin', user: platform, managed: true, proofreading: false, projectRole: null, visible: true }
  ]
  for (const item of accessCases) {
    const context = await request('/api/fangji/access-context', { token: item.user.token })
    assert.ok(Array.isArray(context.managedProjectIds), `${item.label} managed ids must stay an array`)
    assert.ok(Array.isArray(context.proofreadingProjectIds), `${item.label} proofreading ids must stay an array`)
    assert.equal(context.managedProjectIds.includes(privateProject.id), item.managed, `${item.label} managed context`)
    assert.equal(context.proofreadingProjectIds.includes(privateProject.id), item.proofreading,
      `${item.label} proofreading context`)
    assert.equal(context.isPlatformAdmin, item.user === platform)

    const managedList = await request('/api/fangji/projects?scope=managed', { token: item.user.token })
    assert.ok(Array.isArray(managedList), `${item.label} managed list must stay an array`)
    const managedRow = managedList.find((project) => project.id === privateProject.id)
    assert.equal(Boolean(managedRow), item.managed, `${item.label} managed project list`)
    if (managedRow) {
      assert.equal(managedRow.capabilities.projectRole, item.projectRole)
      assert.equal(managedRow.capabilities.canManage, true)
      assert.ok(Object.hasOwn(managedRow, 'required_proofreads'))
    }

    const proofreadingList = await request('/api/fangji/projects?scope=proofreading', { token: item.user.token })
    assert.ok(Array.isArray(proofreadingList), `${item.label} proofreading list must stay an array`)
    const proofreadingRow = proofreadingList.find((project) => project.id === privateProject.id)
    assert.equal(Boolean(proofreadingRow), item.proofreading, `${item.label} proofreading project list`)
    if (proofreadingRow) {
      assert.equal(proofreadingRow.capabilities.projectRole, 'proofreader')
      assert.equal(proofreadingRow.capabilities.canProofread, true)
      assert.equal(proofreadingRow.capabilities.canManage, false)
    }

    for (const scope of ['all', 'discoverable']) {
      const visibleList = await request(`/api/fangji/projects?scope=${scope}`, { token: item.user.token })
      assert.ok(Array.isArray(visibleList), `${item.label} ${scope} list must stay an array`)
      const visibleRow = visibleList.find((project) => project.id === privateProject.id)
      assert.equal(Boolean(visibleRow), item.visible, `${item.label} ${scope} visibility`)
      if (visibleRow) assert.equal(visibleRow.capabilities.projectRole, item.projectRole)
    }
  }

  // The member picker reads this route. users.listRule limits account listing to
  // platform admins, so a project manager must only see accounts already
  // connected to projects they manage, and never an email address.
  // Nicknames are now login identities; similar candidates still need distinct IDs.
  const twins = [await createUser('twin-a', '重名候选'), await createUser('twin-b', '重名候选-2')]
  const candidatesPath = `/api/fangji/projects/${privateProject.id}/member-candidates`
  const candidates = await request(candidatesPath, { token: manager.token })
  assert.ok(Array.isArray(candidates), 'candidates must be a plain array, not a paginated result')
  assert.equal(new Set(candidates.map((item) => item.id)).size, candidates.length,
    'a duplicated id would let a Map silently hide it')
  for (const item of candidates) {
    assert.deepEqual(Object.keys(item).sort(), ['id', 'name', 'username'],
      `candidates must not carry email, got ${JSON.stringify(item)}`)
  }
  const candidateIds = new Set(candidates.map((item) => item.id))
  for (const user of [creator, manager, proofreader]) {
    assert.ok(candidateIds.has(user.id), `${user.email} is connected to this project and must be offered`)
  }
  for (const user of [outsider, ...twins, passwordUser, rateLimitedUser]) {
    assert.ok(!candidateIds.has(user.id), `${user.email} is unrelated and must not be enumerable by a project manager`)
  }
  assert.ok(candidates.every((item) => !JSON.stringify(item).includes('@')), 'no candidate row may contain an email')

  // Ordered by name then username, compared as code units.
  const codeUnitOrder = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1
    : a.username < b.username ? -1 : a.username > b.username ? 1 : 0)
  for (let index = 1; index < candidates.length; index++) {
    assert.ok(codeUnitOrder(candidates[index - 1], candidates[index]) <= 0,
      `candidates must be ordered name-then-username, but ${candidates[index - 1].name}:${candidates[index - 1].username} `
      + `preceded ${candidates[index].name}:${candidates[index].username}`)
  }

  // A platform admin may list accounts, per users.listRule, but still not by email.
  const asPlatformAdmin = await request(candidatesPath, { token: platform.token })
  const adminSeen = new Set(asPlatformAdmin.map((item) => item.id))
  for (const user of [outsider, ...twins]) {
    assert.ok(adminSeen.has(user.id), `${user.email} must be visible to a platform admin`)
  }
  assert.ok(asPlatformAdmin.length > candidates.length,
    'the platform admin view must be broader than the project-scoped one')
  // Similar nicknames must remain distinct, in deterministic name/username order.
  const twinPair = asPlatformAdmin.filter((item) => item.name.startsWith('重名候选'))
  assert.equal(twinPair.length, 2, 'both similar-name accounts must be listed')
  assert.ok(codeUnitOrder(twinPair[0], twinPair[1]) < 0, 'candidate order must be deterministic')

  // An owner holds no `role = "manager"` membership row, so the pool must be
  // derived from projects they own as well as ones they manage.
  const asOwner = await request(candidatesPath, { token: creator.token })
  const ownerSeen = new Set(asOwner.map((item) => item.id))
  for (const user of [manager, proofreader]) {
    assert.ok(ownerSeen.has(user.id), `a project owner must be offered ${user.email}`)
  }
  assert.ok(!ownerSeen.has(outsider.id), 'an owner still must not browse the whole platform')

  // A freshly created project has no members to draw candidates from, so the
  // documented "add this specific person" flow goes through a bounded `term`
  // lookup rather than a listing that could enumerate the platform.
  const secondProject = await request(`/api/fangji/projects/${privateProject.id}/members`, { token: creator.token })
  assert.ok(secondProject.some((item) => item.user === proofreader.id))
  const browsePath = `${candidatesPath}?term=`
  const browsed = await request(browsePath, { token: creator.token })
  assert.ok(!browsed.some((item) => item.id === outsider.id),
    'an empty term must stay scoped, not fall back to a platform listing')
  const searched = await request(`${candidatesPath}?term=${encodeURIComponent('outsider')}`, { token: creator.token })
  assert.ok(searched.some((item) => item.id === outsider.id),
    'an exact identifier lookup must work so a first member can still be added')
  assert.ok(searched.every((item) => !JSON.stringify(item).includes('@')), 'lookups must not return email either')
  // A lookup must not degrade into a sweep: prefixes of the auto-generated
  // `usersNNNNNN` usernames and of display names must return nothing, or any
  // project manager could walk the roster a few characters at a time.
  // Each prefix is pinned to the account it is supposed to reach, because a prefix
  // of nothing fails neither an exact match nor a contains sweep and so guards
  // nothing: `twin` sat here while `twin-a`/`twin-b` exist only in emails, and the
  // digits of `12` only in the run suffix.
  const sweepRows = new Map(asPlatformAdmin.map((item) => [item.id, item]))
  const unrelated = new Set([outsider.id, ...twins.map((twin) => twin.id)])
  const sweepVectors = [
    ['users', outsider], ['us', outsider], ['out', outsider], ['outsid', outsider],
    ['重名', twins[0]], ['重名候', twins[1]],
  ]
  for (const [prefix, target] of sweepVectors) {
    const row = sweepRows.get(target.id)
    assert.ok(row.name.startsWith(prefix) || row.username.startsWith(prefix),
      `the prefix ${JSON.stringify(prefix)} is a prefix of no account, so it tests nothing`)
    const swept = await request(`${candidatesPath}?term=${encodeURIComponent(prefix)}`, { token: creator.token })
    assert.ok(swept.every((item) => !unrelated.has(item.id)),
      `the prefix ${JSON.stringify(prefix)} must not resolve unrelated accounts`)
  }
  const swept = await request(`${candidatesPath}?term=${encodeURIComponent('users')}`, { token: creator.token })
  assert.ok(swept.length < 5, `a generic prefix must not fan out across the platform, got ${swept.length}`)

  // A term is interpolated into a filter, so anything able to break out is refused.
  for (const bad of ['a', 'x'.repeat(65), '" OR id != ""', 'a" || "1"="1', '50%', 'bo\\bs', '张三;drop']) {
    const rejected = await rawRequest(`${candidatesPath}?term=${encodeURIComponent(bad)}`, { token: creator.token })
    assert.equal(rejected.status, 400, `term ${JSON.stringify(bad)} must be rejected`)
  }
  // Whitespace-only is trimmed away and must fall back to the scoped browse.
  const blank = await request(`${candidatesPath}?term=${encodeURIComponent('   ')}`, { token: creator.token })
  assert.deepEqual(blank.map((item) => item.id).sort(), browsed.map((item) => item.id).sort(),
    'a blank term must behave like no term, not like a search')

  for (const [label, token] of [['proofreader', proofreader.token], ['outsider', outsider.token]]) {
    const refused = await rawRequest(candidatesPath, { token })
    assert.equal(refused.status, 403, `${label} must not enumerate member candidates`)
  }
  const unauthenticated = await rawRequest(candidatesPath)
  assert.equal(unauthenticated.status, 401, 'candidate enumeration must not be public')

  const detailsPath = `/api/fangji/projects/${privateProject.id}`
  const rareName = '项目𠮷𰻞𱁬'
  let updated = await request(detailsPath, { method: 'PATCH', token: manager.token, body: { name: rareName } })
  assert.equal(updated.name, rareName)
  assert.equal(updated.description, privateProject.description, 'omitted description must be preserved')
  updated = await request(detailsPath, { method: 'PATCH', token: manager.token, body: { description: '简介𠮷𰻞𱁬' } })
  assert.equal(updated.name, rareName)
  updated = await request(detailsPath, { method: 'PATCH', token: creator.token, body: { requiredProofreads: 3 } })
  assert.equal(updated.description, '简介𠮷𰻞𱁬', 'rule updates must preserve project metadata')
  assert.equal(updated.access_mode, 'members_only')
  for (const body of [{ name: '   ' }, { name: '𠮷'.repeat(501) }, { description: '𠮷'.repeat(2001) }, { requiredProofreads: 0 }, { requiredProofreads: '3' }, { description: null }, { accessMode: '' }]) {
    await request(detailsPath, { method: 'PATCH', token: manager.token, body, expected: 400 })
  }
  await request(detailsPath, { method: 'PATCH', token: proofreader.token, body: { name: 'Unauthorized' }, expected: 403 })
  await request(detailsPath, { method: 'PATCH', token: outsider.token, body: { name: 'Unauthorized' }, expected: 403 })
  updated = await request(detailsPath, { method: 'PATCH', token: manager.token, body: { description: '' } })
  assert.equal(updated.description, '', 'explicit empty description must clear it')
  assert.equal(updated.name, rareName)
  updated = await request(detailsPath, { token: creator.token })
  assert.equal(updated.name, rareName, 'name must survive a fresh read')
  assert.equal(updated.description, '')
  await request(detailsPath, { method: 'PATCH', token: creator.token, body: { requiredProofreads: 2 } })

  const emptyClaim = await request(`/api/fangji/projects/${privateProject.id}/claim`, {
    method: 'POST',
    token: proofreader.token
  })
  assert.equal(emptyClaim, null)

  const publicProject = await request('/api/fangji/projects', {
    method: 'POST',
    token: platform.token,
    expected: 201,
    body: { name: `Public ${suffix}`, accessMode: 'public' }
  })
  projectIds.push(publicProject.id)
  const discoverable = await request('/api/fangji/projects?scope=discoverable', { token: outsider.token })
  assert.ok(discoverable.some((item) => item.id === publicProject.id))
  await request(`/api/fangji/projects/${publicProject.id}/claim`, {
    method: 'POST',
    token: proofreader.token,
    expected: 403
  })
  const joinedPublic = await request(`/api/fangji/projects/${publicProject.id}/join`, {
    method: 'POST',
    token: outsider.token,
    body: {}
  })
  assert.equal(joinedPublic.capabilities.projectRole, 'proofreader')

  await request(`/api/fangji/projects/${publicProject.id}`, {
    method: 'PATCH',
    token: platform.token,
    body: { accessMode: 'members_only', name: publicProject.name, description: '' }
  })
  const persistentMember = await request(`/api/fangji/projects/${publicProject.id}`, { token: outsider.token })
  assert.equal(persistentMember.capabilities.projectRole, 'proofreader')

  const projectPassword = 'JoinThisProject!'
  await request(`/api/fangji/projects/${publicProject.id}`, {
    method: 'PATCH',
    token: platform.token,
    body: { accessMode: 'password', password: projectPassword, name: publicProject.name, description: '' }
  })
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await request(`/api/fangji/projects/${publicProject.id}/join`, {
      method: 'POST',
      token: rateLimitedUser.token,
      expected: 403,
      body: { password: `wrong-password-${attempt}` }
    })
  }
  await request(`/api/fangji/projects/${publicProject.id}/join`, {
    method: 'POST',
    token: rateLimitedUser.token,
    expected: 429,
    body: { password: 'wrong-password-5' }
  })
  await request(`/api/fangji/projects/${publicProject.id}/join`, {
    method: 'POST',
    token: rateLimitedUser.token,
    expected: 429,
    body: { password: projectPassword }
  })

  const resetProjectPassword = 'JoinThisProjectReset!'
  await request(`/api/fangji/projects/${publicProject.id}`, {
    method: 'PATCH',
    token: platform.token,
    body: {
      accessMode: 'password',
      password: resetProjectPassword,
      name: publicProject.name,
      description: ''
    }
  })
  const joinedWithPassword = await request(`/api/fangji/projects/${publicProject.id}/join`, {
    method: 'POST',
    token: passwordUser.token,
    body: { password: resetProjectPassword }
  })
  assert.equal(joinedWithPassword.capabilities.projectRole, 'proofreader')

  const sharedSourcePassword = 'SharedSourceGuard!'
  await request(`/api/fangji/projects/${publicProject.id}`, {
    method: 'PATCH',
    token: platform.token,
    body: {
      accessMode: 'password',
      password: sharedSourcePassword,
      name: publicProject.name,
      description: ''
    }
  })
  for (let index = 0; index < sharedSourceAttackers.length; index += 1) {
    await request(`/api/fangji/projects/${publicProject.id}/join`, {
      method: 'POST',
      token: sharedSourceAttackers[index].token,
      expected: index < 4 ? 403 : 429,
      headers: { 'X-Forwarded-For': `198.51.100.${index + 1}` },
      body: { password: `shared-source-wrong-${index + 1}` }
    })
  }

  await request(`/api/fangji/platform/creator-grants/${creator.id}`, {
    method: 'PUT',
    token: platform.token,
    body: { enabled: false, projectLimit: 1 }
  })
  const revokedContext = await request('/api/fangji/access-context', { token: creator.token })
  assert.equal(revokedContext.canCreateProjects, false)
  assert.ok(revokedContext.managedProjectIds.includes(privateProject.id))

  await request(`/api/fangji/projects/${privateProject.id}/owner`, {
    method: 'PUT',
    token: creator.token,
    body: { userId: manager.id }
  })
  await request(`/api/fangji/platform/creator-grants/${creator.id}`, {
    method: 'PUT',
    token: platform.token,
    body: { enabled: true, projectLimit: 1 }
  })
  const releasedQuota = await request('/api/fangji/access-context', { token: creator.token })
  assert.equal(releasedQuota.ownedProjectCount, 0)
  assert.equal(releasedQuota.remainingProjects, 1)
  assert.ok(releasedQuota.managedProjectIds.includes(privateProject.id), 'former owner should remain a manager')

  const replacement = await request('/api/fangji/projects', {
    method: 'POST',
    token: creator.token,
    expected: 201,
    body: { name: `Replacement ${suffix}` }
  })
  projectIds.push(replacement.id)

  await request(`/api/fangji/platform/creator-grants/${concurrentCreator.id}`, {
    method: 'PUT',
    token: platform.token,
    body: { enabled: true, projectLimit: 1 }
  })
  const concurrentResults = await Promise.all([
    rawRequest('/api/fangji/projects', {
      method: 'POST',
      token: concurrentCreator.token,
      body: { name: `Concurrent A ${suffix}` }
    }),
    rawRequest('/api/fangji/projects', {
      method: 'POST',
      token: concurrentCreator.token,
      body: { name: `Concurrent B ${suffix}` }
    })
  ])
  assert.deepEqual(concurrentResults.map((item) => item.status).sort(), [201, 403])
  const concurrentProject = concurrentResults.find((item) => item.status === 201).payload
  projectIds.push(concurrentProject.id)

  const grants = await request('/api/fangji/platform/creator-grants', { token: platform.token })
  assert.equal(grants.find((item) => item.user === creator.id).projectLimit, 1)

  console.log('Project access integration test passed.')
} finally {
  for (const projectId of projectIds.reverse()) {
    const response = await rawRequest(`/api/fangji/projects/${projectId}`, {
      method: 'DELETE',
      token: platform.token
    })
    if (response.status !== 204 && response.status !== 404) {
      console.warn(`Failed to clean up project ${projectId}: ${response.status} ${response.text}`)
    }
  }
}
