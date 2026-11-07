import { projectDetailSource } from './helpers/projectDetailSource.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  adminPageRouteQuery,
  normalizeAdminPageQuery,
  parseRangeInput
} from '../src/lib/adminPageList.js'

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
  assert.deepEqual(
    normalizeAdminPageQuery(
      {
        q: ['  方言  '],
        status: 'approved',
        qualityState: 'validated',
        minPage: '2',
        maxPage: '18',
        page: '3',
        perPage: '50'
      },
      options
    ),
    {
      q: '方言',
      status: 'approved',
      qualityState: 'validated',
      minPage: 2,
      maxPage: 18,
      page: 3,
      perPage: 50
    }
  )
  assert.deepEqual(
    normalizeAdminPageQuery(
      {
        q: 9,
        status: 'outsider',
        qualityState: 'unknown',
        minPage: '-2',
        maxPage: '1.5',
        page: '0',
        perPage: '1000'
      },
      options
    ),
    {
      q: '',
      status: '',
      qualityState: '',
      minPage: '',
      maxPage: '',
      page: 1,
      perPage: 25
    }
  )
})

test('serializes only non-default list state for clean shareable URLs', () => {
  assert.deepEqual(
    adminPageRouteQuery({
      q: '',
      status: '',
      qualityState: '',
      minPage: '',
      maxPage: '',
      page: 1,
      perPage: 25
    }),
    {}
  )
  assert.deepEqual(
    adminPageRouteQuery({
      q: '方言',
      status: 'active',
      qualityState: 'candidate',
      minPage: 2,
      maxPage: 18,
      page: 4,
      perPage: 100
    }),
    {
      q: '方言',
      status: 'active',
      qualityState: 'candidate',
      minPage: '2',
      maxPage: '18',
      page: '4',
      perPage: '100'
    }
  )
})

test('keeps detail pagination decoupled from stats and defers scheme loading', () => {
  const source = projectDetailSource()
  const loadPages = source.slice(
    source.indexOf('async function loadPages()'),
    source.indexOf('async function loadPageStats()')
  )
  const mounted = source.slice(
    source.indexOf('onMounted(async'),
    source.indexOf('onBeforeUnmount(() =>')
  )
  assert.doesNotMatch(loadPages, /result\.stats|loadPageStats|pages\.value\s*=\s*\[\]/)
  assert.match(mounted, /loadPageStats\(\)/)
  assert.match(mounted, /setupSchemeObserver\(\)/)
  assert.doesNotMatch(mounted, /Promise\.all\(\[[^\]]*loadSchemeState/)
  assert.match(source, /new IntersectionObserver/)
})

test('detail stats failures stay unknown instead of becoming zero', () => {
  const source = projectDetailSource()
  assert.match(source, /当前无法判断项目总体完成情况/)
  const urgent = source.slice(source.indexOf('class="project-status-action--urgent"'))
  const expression = urgent.match(/<small>\s*\{\{([\s\S]*?)\}\}\s*<\/small>/)?.[1]
  assert.ok(expression, 'arbitration status must have an explicit text expression')
  const label = new Function('hasLoadedPageStats', 'pageStats', `return (${expression})`)
  assert.equal(label(false, { arbitration: 0 }), '统计数据尚未加载')
  assert.equal(label(true, { arbitration: 0 }), '当前无异常')
  assert.equal(label(true, { arbitration: 1 }), '需要管理员处理')
  assert.match(source, /'is-empty': hasLoadedPageStats && pageStats\.arbitration === 0/)
  assert.match(source, /项目总数暂不可用/)
  assert.doesNotMatch(source, /<p>共 \{\{ pageStats\.total \}\} 条/)
})

test('detail route changes are applied during project initialization', () => {
  const source = projectDetailSource()
  const routeWatch = source.match(
    /watch\(\s*\(\) => route.query,\s*\(\) => \{([\s\S]*?)\n\s*\}\s*\)/
  )?.[1]
  assert.ok(routeWatch, 'route observer must remain connected')
  const calls = []
  const project = { value: null }
  const callback = new Function(
    'applyListQuery',
    'route',
    'clearTimeout',
    'searchTimer',
    'project',
    'loadPages',
    routeWatch
  )
  const args = [
    () => calls.push('apply'),
    { query: {} },
    () => {},
    null,
    project,
    () => calls.push('load')
  ]
  callback(...args)
  assert.deepEqual(calls, ['apply'])
  project.value = {}
  callback(...args)
  assert.deepEqual(calls, ['apply', 'apply', 'load'])
  const mounted = source.slice(
    source.indexOf('onMounted(async'),
    source.indexOf('onBeforeUnmount(() =>')
  )
  assert.match(mounted, /applyListQuery\(route\.query\)[\s\S]*Promise\.all\(\[loadPages\(\)/)
})
