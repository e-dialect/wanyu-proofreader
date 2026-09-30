// #228 门控放行需要可审计：变更集身份、批准人与批准时间、应用人，以及人工降档标记。
// 只加字段，不动 `gate` 的语义，也不改集合规则（listRule 等仍为 null——写入一律走路由）。
// down 只删这六列，`gate`/`sample_n`/`precision_hat` 等原有列保持不动。
// 初始快照 1788940000_initial_schema.js 的 down 仍会拒绝执行；要撤更早的迁移，先备份 pb_data。

const NEW_FIELDS = () => ([
  new TextField({ name: "approved_by", required: false, max: 200 }),
  new DateField({ name: "approved_at", required: false }),
  new TextField({ name: "changeset", required: false, max: 120 }),
  new TextField({ name: "applied_by", required: false, max: 40 }),
  new DateField({ name: "revoked_at", required: false }),
  new TextField({ name: "revoked_by", required: false, max: 40 })
])

migrate((app) => {
  const gates = app.findCollectionByNameOrId("assist_rule_gates")
  let changed = false
  for (const field of NEW_FIELDS()) {
    if (!gates.fields.getByName(field.name)) {
      gates.fields.add(field)
      changed = true
    }
  }
  if (changed) app.save(gates)
}, (app) => {
  const gates = app.findCollectionByNameOrId("assist_rule_gates")
  let changed = false
  for (const name of ["approved_by", "approved_at", "changeset", "applied_by", "revoked_at", "revoked_by"]) {
    if (gates.fields.getByName(name)) {
      gates.fields.removeByName(name)
      changed = true
    }
  }
  if (changed) app.save(gates)
})
