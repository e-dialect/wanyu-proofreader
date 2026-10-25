// #315 D5.3/D9：编选的追加事件表。
//
// 一张只追加的表，装两类事：
//
//   - rights_changed：某条用途权利结论变了，而它落在某个**已确认**批次的项目里。
//     事件记下是哪个来源、影响了多少条，供 D 侧回答「哪一批的采用范围作废了」。
//     它不改批次本身：确认过的范围是交付依据，历史不能被悄悄改写（D5.3「重评以追加
//     方式进行，不改写历史」）。
//   - reevaluated：有人（或后续作业）按当前数据重算了一次，事件同时记下确认时的四个数
//     与重算后的四个数。差异不写回批次，只在事件里。
//
// 为什么不把这些挂到 adoption_batches 上：一批可以经历多次权利变更与多次重评，
// 批次上只能留「最后一次」，而 D5.3 要的是「哪一批受影响、什么时候、为什么」。
// 代价是所有读取都要按 batch 聚合一次，但这张表只会随运维动作增长，不随条目数增长。
//
// 写规则全 null：事件只能由 Go 侧追加（权利钩子与重评路由），集合 API 不给直连。

const KINDS = ["rights_changed", "reevaluated"]

const text = (name, required, id, max = 0) => ({
  autogeneratePattern: "", hidden: false, id, max, min: required ? 1 : 0,
  name, pattern: "", presentable: false, primaryKey: false, required, system: false, type: "text"
})
const select = (name, values, id) => ({
  hidden: false, id, maxSelect: 1, name, presentable: false, required: true,
  system: false, type: "select", values
})
const number = (name, id) => ({
  hidden: false, id, max: null, min: 0, name, onlyInt: true, presentable: false,
  required: false, system: false, type: "number"
})
const relation = (name, collectionId, id, required = true, cascadeDelete = true) => ({
  cascadeDelete, collectionId, hidden: false, id, maxSelect: 1, minSelect: 0,
  name, presentable: false, required, system: false, type: "relation"
})

const autoTimes = [
  { hidden: false, id: "autodate2990389176", name: "created", onCreate: true, onUpdate: false, presentable: false, system: false, type: "autodate" },
  { hidden: false, id: "autodate3332085495", name: "updated", onCreate: true, onUpdate: true, presentable: false, system: false, type: "autodate" }
]

const eventsSpec = (batchesId, sourcesId, usersId) => ({
  name: "adoption_events",
  type: "base",
  system: false,
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
  indexes: [
    "CREATE INDEX idx_adoption_events_batch ON adoption_events (batch, created DESC)",
    "CREATE INDEX idx_adoption_events_kind ON adoption_events (kind, created DESC)"
  ],
  fields: [
    { autogeneratePattern: "[a-z0-9]{15}", hidden: false, id: "text3208210256", max: 15, min: 15, name: "id", pattern: "^[a-z0-9]+$", presentable: false, primaryKey: true, required: true, system: true, type: "text" },
    relation("batch", batchesId, "aebatch001"),
    select("kind", KINDS, "aekind0001"),
    // 来源与操作人都可空：reevaluated 事件没有来源，早期数据也没有操作人。
    relation("source", sourcesId, "aesource01", false, false),
    relation("actor", usersId, "aeactor001", false, false),
    text("note", false, "aenote0001", 500),
    number("affected_count", "aeaffected"),
    number("stored_total", "aestored01"),
    number("stored_selected", "aestored02"),
    number("stored_excluded", "aestored03"),
    number("stored_pending", "aestored04"),
    number("current_total", "aecurrent1"),
    number("current_selected", "aecurrent2"),
    number("current_excluded", "aecurrent3"),
    number("current_pending", "aecurrent4"),
    ...autoTimes
  ]
})

const exists = (app, name) => {
  try {
    app.findCollectionByNameOrId(name)
    return true
  } catch {
    return false
  }
}

migrate((app) => {
  if (exists(app, "adoption_events")) return
  const batches = app.findCollectionByNameOrId("adoption_batches")
  const sources = app.findCollectionByNameOrId("sources")
  const users = app.findCollectionByNameOrId("users")
  app.importCollections([eventsSpec(batches.id, sources.id, users.id)], false)
}, (app) => {
  if (exists(app, "adoption_events")) app.delete(app.findCollectionByNameOrId("adoption_events"))
})
