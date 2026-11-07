import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemberCandidatesClient } from '../src/lib/memberCandidatesClient.js'

function fixture() {
  const calls = []
  let result = []
  const methods = createMemberCandidatesClient({
    async send(...args) {
      calls.push(args)
      return result
    }
  })
  return {
    ...methods,
    calls,
    reply(value) {
      result = value
    }
  }
}
test('legacy list keeps array contract and an ordinary related candidate needs no search term', async () => {
  const state = fixture()
  const row = { id: 'related', name: '同项目成员', username: 'related-user' }
  state.reply([row])
  assert.deepEqual(await state.listMemberCandidates('project'), [row])
  await state.setProjectMember('project', row.id, 'manager')
  assert.equal(state.calls[0][0], '/api/fangji/projects/project/member-candidates')
  assert.deepEqual(state.calls[1][1].body, { role: 'manager', candidateTerm: '' })
})
test('exact identifier search is encoded and only its returned person carries the term on PUT', async () => {
  const state = fixture()
  state.reply([{ id: 'known', name: '已知同学', username: 'known-user' }])
  await state.listMemberCandidates('project', '  已知同学  ')
  await state.setProjectMember('project', 'known', 'proofreader')
  assert.match(state.calls[0][0], /term=%E5%B7%B2%E7%9F%A5%E5%90%8C%E5%AD%A6$/)
  assert.deepEqual(state.calls[1][1].body, { role: 'proofreader', candidateTerm: '已知同学' })
  await state.setProjectMember('other-project', 'known', 'manager')
  await state.setProjectMember('project', 'not-returned', 'manager')
  assert.equal(state.calls[2][1].body.candidateTerm, '')
  assert.equal(state.calls[3][1].body.candidateTerm, '')
})
test('cursor API keeps metadata and scopes exact lookup proof in the same way', async () => {
  const state = fixture()
  const result = { items: [{ id: 'known' }], nextCursor: 'opaque-next' }
  state.reply(result)
  assert.equal(
    await state.listMemberCandidatePage('p/slash', {
      limit: 2,
      cursor: 'cursor&literal',
      term: 'known-name'
    }),
    result
  )
  const url = new URL(state.calls[0][0], 'http://fixture')
  assert.equal(url.pathname, '/api/fangji/projects/p%2Fslash/member-candidates')
  assert.equal(url.searchParams.get('cursor'), 'cursor&literal')
  assert.equal(url.searchParams.get('limit'), '2')
  await state.setProjectMember('p/slash', 'known', 'manager')
  assert.equal(state.calls[1][1].body.candidateTerm, 'known-name')
})
test('failed exact lookup cannot authorize a guessed ID', async () => {
  const calls = []
  const client = createMemberCandidatesClient({
    async send(path, options) {
      calls.push(options)
      if (path.includes('member-candidates')) throw new Error('429')
    }
  })
  await assert.rejects(client.listMemberCandidates('p', 'known-name'), /429/)
  await client.setProjectMember('p', 'guessed-id', 'manager')
  assert.equal(calls[1].body.candidateTerm, '')
})
