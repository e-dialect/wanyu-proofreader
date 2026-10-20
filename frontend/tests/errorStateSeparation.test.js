import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function view(path) {
  return readFileSync(new URL(`../src/views/${path}`, import.meta.url), 'utf8')
}

test('操作错误不参与加载态门禁', () => {
  const gate = view('admin/GateRulesView.vue')
  assert.match(gate, /const loadError = ref\(''\)/)
  assert.match(gate, /const operationError = ref\(''\)/)
  assert.match(gate, /v-if="loadError"/)
  assert.doesNotMatch(gate, /const error = ref\(''\)/)
  assert.doesNotMatch(gate, /v-if="error"/)

  const grants = view('admin/CreatorGrantsView.vue')
  assert.match(grants, /const loadError = ref\(''\)/)
  assert.match(grants, /const operationErrorUser = ref\(''\)/)

  const discovery = view('ProjectDiscoveryView.vue')
  assert.match(discovery, /const loadError = ref\(''\)/)
  assert.match(discovery, /joinErrorProjectId === project\.id/)

  const hall = view('proofreader/TaskHallView.vue')
  assert.match(hall, /const loadError = ref\(''\)/)
  assert.match(hall, /const actionError = ref\(''\)/)

  const sources = view('admin/SourcesView.vue')
  assert.match(sources, /const loadError = ref\(''\)/)
  assert.match(sources, /const operationError = ref\(''\)/)
})
