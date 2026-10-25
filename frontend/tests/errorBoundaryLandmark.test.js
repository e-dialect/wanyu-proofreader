import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/components/AppErrorBoundary.vue', import.meta.url), 'utf8')

test('错误边界保留可聚焦的 main 地标并在恢复后重新准备', () => {
  assert.match(source, /<main[^>]*id="main-content"[^>]*tabindex="-1"/)
  assert.match(source, /watch\(error, async/)
  assert.match(source, /prepareMainLandmark\(\)/)
  assert.match(source, /role="alert"/)
  assert.doesNotMatch(source, /<main[^>]*role="alert"/)
})
