import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  normalizeProjectInsightsQuery,
  serializeProjectInsightsQuery,
  toProjectInsightsRouteQuery
} from '../src/lib/adminProjectInsights.js'

test('项目总览查询会 trim 搜索词、校验筛选并限制分页参数', () => {
  assert.deepEqual(normalizeProjectInsightsQuery({
    q: '  粤语 方言  ',
    filter: 'attention',
    page: '3',
    perPage: '80'
  }), {
    q: '粤语 方言',
    filter: 'attention',
    page: 3,
    perPage: 50
  })

  assert.deepEqual(normalizeProjectInsightsQuery({
    q: ['  第一版  ', '被忽略'],
    filter: 'unknown',
    page: '-2',
    perPage: '2.5'
  }), {
    q: '第一版',
    filter: 'all',
    page: 1,
    perPage: 12
  })
})

test('项目总览服务序列化保留筛选语义并发送规范页码', () => {
  const params = new URLSearchParams(serializeProjectInsightsQuery({
    q: '  山歌 ',
    filter: 'completed',
    page: '4',
    perPage: 12
  }))
  assert.equal(params.get('q'), '山歌')
  assert.equal(params.get('filter'), 'completed')
  assert.equal(params.get('page'), '4')
  assert.equal(params.get('perPage'), '12')
})

test('项目总览路由只省略默认条件，非默认筛选和页码可恢复', () => {
  assert.deepEqual(toProjectInsightsRouteQuery({ q: ' ', filter: 'all', page: 1 }), {})
  assert.deepEqual(toProjectInsightsRouteQuery({
    q: '  闽语 ',
    filter: 'incomplete',
    page: 2,
    perPage: 50
  }), {
    q: '闽语',
    filter: 'incomplete',
    page: '2'
  })
})

test('Dashboard 使用项目总览接口且不再拉取全量条目做前端汇总', () => {
  const service = readFileSync(new URL('../src/services/projectsService.js', import.meta.url), 'utf8')
  const dashboard = readFileSync(new URL('../src/views/admin/DashboardView.vue', import.meta.url), 'utf8')

  assert.match(service, /export async function listProjectInsights\(query = \{\}\)/)
  assert.match(service, /\/api\/fangji\/project-insights\?\$\{serializeProjectInsightsQuery\(query\)\}/)
  assert.match(dashboard, /const PROJECTS_PER_PAGE = 12/)
  assert.doesNotMatch(dashboard, /listAllPages|pagesService|summarizePages|sortProjectInsights|force:\s*true/)
})

test('Dashboard 保留路由历史、300ms 防抖和过期响应保护', () => {
  const dashboard = readFileSync(new URL('../src/views/admin/DashboardView.vue', import.meta.url), 'utf8')

  assert.match(dashboard, /\}, 300\)/)
  assert.match(dashboard, /router\.replace\(\{ query: toProjectInsightsRouteQuery\(next\) \}\)/)
  assert.match(dashboard, /router\.push\(\{ query: toProjectInsightsRouteQuery\(next\) \}\)/)
  assert.match(dashboard, /if \(generation !== loadGeneration\) return/)
  assert.match(dashboard, /更新失败，当前显示上次结果/)
})

test('快捷筛选和翻页采用最新输入并取消防抖中的旧搜索', () => {
  const dashboard = readFileSync(new URL('../src/views/admin/DashboardView.vue', import.meta.url), 'utf8')
  const setFilter = dashboard.slice(dashboard.indexOf('function setFilter'), dashboard.indexOf('function clearFilters'))
  const goToPage = dashboard.slice(dashboard.indexOf('function goToPage'), dashboard.indexOf('function sameDashboardQuery'))
  assert.match(setFilter, /clearSearchTimer\(\)/)
  assert.match(setFilter, /q: searchQuery\.value/)
  assert.match(goToPage, /clearSearchTimer\(\)/)
  assert.match(goToPage, /q: searchQuery\.value/)
})
