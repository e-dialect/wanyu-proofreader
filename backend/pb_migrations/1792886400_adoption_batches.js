// #315 D 用途编选 v0：一批一条采用范围，例外另存一表。
//
// 两张表而不是一张：
//
//   - adoption_batches 是「这一次交付要不要这批资料」的决定本身：哪个项目、
//     哪个用途/接收方、按什么规则、圈进多少、谁确认的。#314 的 D 是批次级取舍，
//     所以它是**一条**记录，不是每条资料挂一个状态（owner 2026-10-11 14:38 明确
//     不要求逐条三态）。
//   - adoption_exceptions 只装「规则判不了、由人单独定」的少量条目（D2）。它是
//     逐条的，但只在例外这一层——把例外做成第二张表，是为了让「例外有多少、还悬着
//     多少」可以直接 COUNT，而不是从一张全量状态表里筛。
//
// 为什么 reasons_json 存在批次上：D3.5 要「理由分布可统计」，D4.1 要导出说明覆盖/
// 采用/未采用/待处理。预演与确认各算一次，结果留在批次上，导出时再复算一次做对照
// （漂移时导出会写 drift=true，不静默用旧数）。
//
// 为什么 rule_json 是文本：筛选规则要「可被读出来」（D1.5），而不是只留一个结果
// 数字。存 JSON 原文同时给人和程序读；校验在 Go 侧（backend/adoption.go）做，
// 迁移不猜规则形状。
//
// 写规则全 null：与 conversion_jobs、review_findings 同口径，一律走 #315 的
// manager 路由，集合 API 不给直连，避免绕过权利门与项目作用域。

const PURPOSES = [
  "public_display",
  "internal_research",
  "model_training",
  "commercial_use",
  "redistribution",
  "raw_third_party_transfer"
]

// 必须与 backend/adoption.go 的 adoptionStatuses 逐字一致：两边漂移会让
// 「预览时算进去的条目」在导出时被判成 status_not_ready。
const DECISIONS = ["select", "exclude"]
const BATCH_STATUSES = ["draft", "previewed", "confirmed"]

const text = (name, required, id, max = 0) => ({
  autogeneratePattern: "", hidden: false, id, max, min: required ? 1 : 0,
  name, pattern: "", presentable: false, primaryKey: false, required, system: false, type: "text"
})
const select = (name, values, id) => ({
  hidden: false, id, maxSelect: 1, name, presentable: false, required: true,
  system: false, type: "select", values
})
const date = (name, required, id) => ({
  hidden: false, id, max: "", min: "", name, presentable: false, required,
  system: false, type: "date"
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

const batchesSpec = (projectsId, usersId) => ({
  name: "adoption_batches",
  type: "base",
  system: false,
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
  indexes: [
    "CREATE INDEX idx_adoption_batches_project ON adoption_batches (project, created DESC)",
    // 一个项目同一用途同时只允许一条未确认的编选：否则两个人各开一条，E 侧拿到
    // 两份「本批采用范围」，谁也不算错。确认后（confirmed）不再占位，允许下一批。
    "CREATE UNIQUE INDEX idx_adoption_batches_open ON adoption_batches (project, purpose) WHERE status IN ('draft','previewed')"
  ],
  fields: [
    { autogeneratePattern: "[a-z0-9]{15}", hidden: false, id: "text3208210256", max: 15, min: 15, name: "id", pattern: "^[a-z0-9]+$", presentable: false, primaryKey: true, required: true, system: true, type: "text" },
    relation("project", projectsId, "abproject01"),
    select("purpose", PURPOSES, "abpurpose1"),
    text("recipient", true, "abrecpt001", 120),
    select("status", BATCH_STATUSES, "abstatus01"),
    text("rule_json", true, "abrule0001"),
    text("note", false, "abnote0001", 500),
    number("total_count", "abtotal001"),
    number("selected_count", "abselect01"),
    number("excluded_count", "abexclud01"),
    number("pending_count", "abpending1"),
    text("reasons_json", false, "abreasons1"),
    date("previewed_at", false, "abpreviat1"),
    relation("created_by", usersId, "abcreated1", false, false),
    relation("confirmed_by", usersId, "abconfirm1", false, false),
    date("confirmed_at", false, "abconfirmd"),
    ...autoTimes
  ]
})

const exceptionsSpec = (batchesId, pagesId, usersId) => ({
  name: "adoption_exceptions",
  type: "base",
  system: false,
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
  indexes: [
    // 一条目在一批里只有一个例外结论；重复插入会撞在这里，由 Go 侧改成 upsert。
    "CREATE UNIQUE INDEX idx_adoption_exceptions_page ON adoption_exceptions (batch, page)",
    "CREATE INDEX idx_adoption_exceptions_batch ON adoption_exceptions (batch, created)"
  ],
  fields: [
    { autogeneratePattern: "[a-z0-9]{15}", hidden: false, id: "text3208210256", max: 15, min: 15, name: "id", pattern: "^[a-z0-9]+$", presentable: false, primaryKey: true, required: true, system: true, type: "text" },
    relation("batch", batchesId, "aebatch001"),
    relation("page", pagesId, "aepage0001"),
    select("decision", DECISIONS, "aedecision"),
    // 排除理由的取值集合在 Go 侧（backend/adoption.go 的 adoptionReasonCodes）；
    // 这里用文本而不是 select，是因为理由码与「阻塞原因五桶」同源、由两处代码共同
    // 定义，把它们抄进迁移就等于抄第三份。
    text("reason_code", false, "aereason01", 80),
    text("note", true, "aenote0001", 500),
    relation("decided_by", usersId, "aedecided1", false, false),
    date("decided_at", false, "aedecidedt"),
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
  const projects = app.findCollectionByNameOrId("projects")
  const pages = app.findCollectionByNameOrId("pages")
  const users = app.findCollectionByNameOrId("users")
  if (!exists(app, "adoption_batches")) {
    app.importCollections([batchesSpec(projects.id, users.id)], false)
  }
  if (!exists(app, "adoption_exceptions")) {
    // 例外表要引用批次表，所以顺序不能反：先建批次，再取它的 id。
    const batches = app.findCollectionByNameOrId("adoption_batches")
    app.importCollections([exceptionsSpec(batches.id, pages.id, users.id)], false)
  }
}, (app) => {
  for (const name of ["adoption_exceptions", "adoption_batches"]) {
    if (!exists(app, name)) continue
    app.delete(app.findCollectionByNameOrId(name))
  }
})
