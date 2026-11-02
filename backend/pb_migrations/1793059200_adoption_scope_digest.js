// #315 D 用途编选：确认范围的成员指纹。
//
// 四个计数相同不代表范围相同：两条同状态条目互换（A 选入/B 排除 → A 排除/B 选入）
// 会让 selected/excluded 都不变，只比计数会漏掉范围漂移。scope_digest 是全部条目的
// page/decision/reason/pending 排序后的 SHA-256，确认时存下，导出与重评时复算比对。
//
// 旧记录（字段上线前确认的批次）保持空串：没有可比对象时不伪造 drift，界面照旧。
// 回滚：删除字段；已确认批次的指纹一并丢掉，不影响四个计数或历史事件。

migrate((app) => {
  const batches = app.findCollectionByNameOrId("adoption_batches")
  if (!batches.fields.getByName("scope_digest")) {
    batches.fields.add(new TextField({ name: "scope_digest" }))
    app.save(batches)
  }
}, (app) => {
  const batches = app.findCollectionByNameOrId("adoption_batches")
  if (batches.fields.getByName("scope_digest")) {
    batches.fields.removeByName("scope_digest")
    app.save(batches)
  }
})
