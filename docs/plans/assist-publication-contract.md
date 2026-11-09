# 辅助分析发布契约（实现中）

关联 #417。迁移 `1794204700_assist_publications.js`，基线 `6b72711` + 原子正确性候选 `d8d8a8f`。仅新发布层与原子候选共同合入；单独候选有已测长写锁，不能发布。

- `assist_publications` 私有集合；`project`、`page` 是 ID 文本快照，合法项目删除不被 marker 阻止。`scope`: `page/rules/identity`；`state`: `staging/published/aborted`；`basis_json`, `expected_findings`, `expected_events`, `expected_pages`, `published_at`, `failure_code`, `created/updated`。marker 保留。
- `review_findings.assist_publication` 与 `verification_events.assist_publication` 是可空、非级联关系；新分析结果创建前就带 relation，并逐条实际 `Save`。仅 `machine_analysis` event 可挂 publication。
- `_assist_finding_retirements(finding PRIMARY KEY, publication, retired_at)` 是派生、不可外部写的退役索引。逐 finding 退役，不整批旧 publication 退役，保留单页/项目/identity 原作用域。
- `currentSQL(alias)` = 原 `superseded_at` 空，且 relation 空或 publication 为 published，且无 tombstone；`historySQL` 仅排除 staging/aborted，保留已退役历史；`eventSQL` 仅排除未发布 machine analysis。
- 读适配公共函数 `assist_visibility.records(dao, collection, whereDbxExpression, sort, limit, offset, mode)`，以及 `list` 分块无硬上限；where 为静态 SQL + bind，不解析自定义 PB filter。mode 为 `current/history/events`。禁止仅凭原 `superseded_at` 判断新行是否当前。
- `_assist_basis_epochs(scope PRIMARY KEY, revision)` 保存项目及全局引用版本；所有依据变更触发增量。首次读取前冻结；最终短事务验证同版本、权限、prepared 数量，任一不符 409。新 staging 载荷不增加版本；成功 publish 使其他 prepared 依据失效。
- `_assist_page_derivations(publication,page,...)` 只放可重建派生值。最终 SQL whitelist 仅 `difficulty_tier/difficulty_basis_json/difficulty_version/entry_identity_key`；仅值改变时更新 `updated`，不改正文、共识、来源许可或人工判断。
- 普通分块 stage 与最终 publish 都测实际独立 writer 等待，10k/20k 工程目标各 ≤500ms，不等于生产容量验收。调用方已在事务时保留 txApp，绝不逃逸到全局 app。
- final 事务原子写 tombstones、派生列并 `Save` publication published。失败不改旧有效结果。过期 staging 标 aborted，有限清理只删未发布载荷；marker 与 published 历史不删。native API（包括 superuser）不能改/删内部 marker/relation。
- 有任何 publication 时 migration down 拒绝。旧 binary 不理解新可见性，禁止热回退；维护停机后恢复迁移前备份，或另行审核的显式物化回退。

仍须：真实 PB/Goja 并发及故障、权限撤销、依据变更、全读面/历史导出与 10k/20k 写等待验收。未测不算通过。
