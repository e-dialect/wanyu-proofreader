import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { adminPageRouteQuery, normalizeAdminPageQuery, parseRangeInput } from '../src/lib/adminPageList.js'

const options = {
  statuses: ['active', 'pending', 'approved'],
  qualityStates: ['candidate', 'validated', 'withheld'],
  pageSizes: [10, 25, 50, 100]
}

test('parses normal, reversed and Chinese-comma ranges safely', () => {
  assert.deepEqual(parseRangeInput('1-3, 5，8-7', 8), [0, 1, 2, 4, 6, 7])
  assert.deepEqual(parseRangeInput('0, nope, 12', 8), [])
  assert.deepEqual(parseRangeInput('', 8), [])
})

test('normalizes URL filters and rejects unknown or invalid values', () => {
  assert.deepEqual(normalizeAdminPageQuery({
    q: ['  方言  '],
    status: 'approved',
    qualityState: 'validated',
    minPage: '2',
    maxPage: '18',
    page: '3',
    perPage: '50'
  }, options), {
    q: '方言', status: 'approved', qualityState: 'validated',
    minPage: 2, maxPage: 18, page: 3, perPage: 50
  })
  assert.deepEqual(normalizeAdminPageQuery({
    q: 9, status: 'outsider', qualityState: 'unknown',
    minPage: '-2', maxPage: '1.5', page: '0', perPage: '1000'
  }, options), {
    q: '', status: '', qualityState: '', minPage: '', maxPage: '', page: 1, perPage: 25
  })
})

test('serializes only non-default list state for clean shareable URLs', () => {
  assert.deepEqual(adminPageRouteQuery({
    q: '', status: '', qualityState: '', minPage: '', maxPage: '', page: 1, perPage: 25
  }), {})
  assert.deepEqual(adminPageRouteQuery({
    q: '方言', status: 'active', qualityState: 'candidate',
    minPage: 2, maxPage: 18, page: 4, perPage: 100
  }), {
    q: '方言', status: 'active', qualityState: 'candidate',
    minPage: '2', maxPage: '18', page: '4', perPage: '100'
  })
})

test('keeps detail pagination decoupled from stats and defers scheme loading', () => {
  const source = readFileSync(new URL('../src/views/admin/ProjectDetailView.vue', import.meta.url), 'utf8')
  const loadPages = source.slice(source.indexOf('async function loadPages()'), source.indexOf('async function loadPageStats()'))
  const mounted = source.slice(source.indexOf('onMounted(async'), source.indexOf('onBeforeUnmount(() =>'))
  assert.doesNotMatch(loadPages, /result\.stats|loadPageStats|pages\.value\s*=\s*\[\]/)
  assert.match(mounted, /loadPageStats\(\)/)
  assert.match(mounted, /setupSchemeObserver\(\)/)
  assert.doesNotMatch(mounted, /Promise\.all\(\[[^\]]*loadSchemeState/)
  assert.match(source, /new IntersectionObserver/)
})
