import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryHistory, createRouter } from 'vue-router'
import { authPageLocation, authRedirect } from '../src/lib/authRedirect.js'

test('login and registration retain the destination including its query and hash', () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: {} }]
  })
  const destination = '/tasks/task-123/edit?field=字音&filter=a%26b#row-7'
  const registration = router.resolve(authPageLocation('/register', destination))
  assert.equal(registration.query.redirect, destination)
  const login = router.resolve(authPageLocation('/login', registration.query.redirect))
  assert.equal(login.query.redirect, destination)
  assert.equal(authRedirect(login.query.redirect), destination)
})

test('missing or unsafe destinations are omitted and allow the normal login default', () => {
  for (const value of [undefined, null, '', ['/projects'], 'https://example.com', '//example.com', '/\\example.com', '/projects\n', ' /projects', 'javascript:alert(1)']) {
    assert.equal(authRedirect(value), '', JSON.stringify(value))
    assert.deepEqual(authPageLocation('/login', value), { path: '/login', query: {} })
  }
})
