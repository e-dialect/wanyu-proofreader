import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computed, ref } from 'vue'

const source = readFileSync(new URL('../src/components/AppShell.vue', import.meta.url), 'utf8')
const labelSetup = source.match(/const returnLabel = computed\(\(\) => \{[\s\S]*?\n\}\)/)[0]

test('shell labels object todo targets and problem or ordinary queue paths', () => {
  const todoReturn = ref({ path: '/admin/todos', query: { stage: 'source_review' } })
  const returnTarget = ref(todoReturn.value)
  const returnLabel = new Function(
    'computed',
    'todoReturn',
    'returnTarget',
    `${labelSetup}; return returnLabel`
  )(computed, todoReturn, returnTarget)
  assert.equal(returnLabel.value, '返回统一待办')
  todoReturn.value = ''
  returnTarget.value = '/tasks/problems?view=reports'
  assert.equal(returnLabel.value, '返回问题与草稿')
  returnTarget.value = '/tasks?view=active'
  assert.equal(returnLabel.value, '返回队列')
  assert.match(source, /v-if="todoReturn \|\| immersive"/)
  assert.match(source, /\{\{\s*returnLabel\s*\}\}/)
})
