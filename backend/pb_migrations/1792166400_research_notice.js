// 研究用途选择是追加记录：同一版告知可以先同意再退出，旧行保留。
// 集合 API 不开放，读写只走 /api/fangji/research-notice。

const text = (name, required, id, max = 0) => ({
  autogeneratePattern: "", hidden: false, id, max, min: required ? 1 : 0,
  name, pattern: "", presentable: false, primaryKey: false, required, system: false, type: "text"
})
const select = (name, values, id) => ({
  hidden: false, id, maxSelect: 1, name, presentable: false, required: true,
  system: false, type: "select", values
})
const date = (name, id) => ({
  hidden: false, id, max: "", min: "", name, presentable: false, required: true,
  system: false, type: "date"
})
const relation = (name, collectionId, id) => ({
  cascadeDelete: true, collectionId, hidden: false, id, maxSelect: 1, minSelect: 0,
  name, presentable: false, required: true, system: false, type: "relation"
})

const autoTimes = [
  { hidden: false, id: "autodate2990389176", name: "created", onCreate: true, onUpdate: false, presentable: false, system: false, type: "autodate" },
  { hidden: false, id: "autodate3332085495", name: "updated", onCreate: true, onUpdate: true, presentable: false, system: false, type: "autodate" }
]

const spec = (usersId) => ({
  name: "research_notice_decisions",
  type: "base",
  system: false,
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
  indexes: [
    "CREATE INDEX idx_research_notice_latest ON research_notice_decisions (user, notice_version, decided_at)"
  ],
  fields: [
    { autogeneratePattern: "[a-z0-9]{15}", hidden: false, id: "text3208210256", max: 15, min: 15, name: "id", pattern: "^[a-z0-9]+$", presentable: false, primaryKey: true, required: true, system: true, type: "text" },
    relation("user", usersId, "rnuser000000001"),
    select("choice", ["participate", "opt_out"], "rnchoice0000001"),
    text("notice_version", true, "rnversion000001", 40),
    date("decided_at", "rndecided0000001"),
    ...autoTimes
  ]
})

const exists = (app) => {
  try {
    app.findCollectionByNameOrId("research_notice_decisions")
    return true
  } catch {
    return false
  }
}

migrate((app) => {
  if (exists(app)) return
  const users = app.findCollectionByNameOrId("users")
  app.importCollections([spec(users.id)], false)
}, (app) => {
  if (!exists(app)) return
  app.delete(app.findCollectionByNameOrId("research_notice_decisions"))
})
