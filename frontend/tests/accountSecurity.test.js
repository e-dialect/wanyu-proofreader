import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import {
  passwordProblem,
  takeAccountActionToken,
  accountErrorMessage
} from '../src/lib/accountSecurity.js'
import {
  listLocalAccountDrafts,
  exportLocalAccountDrafts,
  removeLocalAccountDrafts
} from '../src/lib/localAccountData.js'

function storage() {
  const data = new Map()
  return {
    get length() {
      return data.size
    },
    key: (i) => [...data.keys()][i],
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k)
  }
}
test('password checks reflect PocketBase bcrypt byte limit', () => {
  assert.equal(passwordProblem('A'.repeat(71), 'A'.repeat(71)), '')
  assert.match(passwordProblem('密'.repeat(30), '密'.repeat(30)), /72/)
  assert.match(passwordProblem('sufficient-password', 'different-password'), /不一致/)
})
test('action tokens leave URL before requests and reject invalid content', () => {
  const calls = []
  const history = { state: { key: 'state' }, replaceState: (...args) => calls.push(args) }
  assert.equal(
    takeAccountActionToken(
      { hash: '#token=abc.def-123.sig', pathname: '/account/reset-password', search: '' },
      history
    ),
    'abc.def-123.sig'
  )
  assert.deepEqual(calls[0], [{ key: 'state' }, '', '/account/reset-password'])
  assert.equal(
    takeAccountActionToken(
      { hash: '#token=%3Cscript%3E', pathname: '/account/reset-password', search: '' },
      history
    ),
    ''
  )
})
test('legacy reset, email change and seven-day verification links bridge without external redirect', () => {
  const script = readFileSync(new URL('../public/legacy-account.js', import.meta.url), 'utf8')
  for (const [old, next] of [
    ['confirm-password-reset', 'reset-password'],
    ['confirm-email-change', 'confirm-email'],
    ['confirm-verification', 'verify-email']
  ]) {
    const calls = []
    vm.runInNewContext(script, {
      window: {
        location: {
          hash: `#/auth/${old}/abc.def.sig`,
          pathname: '/_/',
          replace: (url) => calls.push(url)
        },
        history: { state: null, replaceState: () => calls.push('cleared') }
      },
      document: {}
    })
    assert.deepEqual(calls, ['cleared', `/account/${next}#token=abc.def.sig`])
  }
  const status = { textContent: '' }
  vm.runInNewContext(script, {
    window: {
      location: {
        hash: '#/auth/confirm-verification/https://evil.test',
        pathname: '/_/',
        replace: () => assert.fail('redirected')
      },
      history: { replaceState() {} }
    },
    document: { getElementById: () => status }
  })
  assert.match(status.textContent, /不完整/)
})
test('draft cleanup preserves other accounts, new writes, and malformed exports', () => {
  const s = storage()
  const key = 'fangji:task-draft:v1:user:page'
  s.setItem(key, JSON.stringify({ pageId: 'page', savedAt: '2020-01-01', row: { text: '未提交' } }))
  s.setItem(`${key}:history:old`, 'corrupt but recoverable bytes')
  s.setItem('fangji:task-draft:v1:other:page', 'other account')
  s.setItem('pocketbase_auth', 'session')
  const snapshot = listLocalAccountDrafts(s, 'user')
  assert.equal(snapshot.length, 2)
  assert.equal(snapshot.find((d) => !d.history).old, true)
  assert.match(exportLocalAccountDrafts(s, 'user'), /corrupt but recoverable bytes/)
  s.setItem(key, 'a new save from another tab')
  assert.equal(removeLocalAccountDrafts(s, 'user', snapshot), 1)
  assert.equal(s.getItem(key), 'a new save from another tab')
  assert.equal(s.getItem('fangji:task-draft:v1:other:page'), 'other account')
  assert.equal(s.getItem('pocketbase_auth'), 'session')
})

test('account native validation errors are localized without exposing token contents', () => {
  assert.match(
    accountErrorMessage({
      status: 400,
      response: {
        data: { token: { code: 'validation_invalid_token', message: 'Invalid or expired token.' } }
      }
    }),
    /链接已过期/
  )
  assert.match(
    accountErrorMessage({
      status: 400,
      response: { data: { oldPassword: { code: 'validation_invalid_old_password' } } }
    }),
    /当前密码不正确/
  )
  assert.match(accountErrorMessage({ status: 429 }), /过于频繁/)
})
