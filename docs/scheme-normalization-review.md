# 归一人工复核 API 与草稿依据

管理端前后端需要一起更新。读取队列的权限与既有 `UNSUPPORTED` / `AMBIGUOUS` 状态不变，缺少 PDF 仍允许按既有业务做记音归一；缺失来源与实际读取失败严格区分。

## 读取与提交

`GET /api/fangji/projects/{projectId}/normalizations?status=AMBIGUOUS,UNSUPPORTED` 的每一行增加：

- `expected_basis`：服务器生成的不透明复核依据凭据，客户端必须按原值回传。
- `normalization_source_column` / `current_source_pronunciation`：转换记录使用的列和当前实际读音；原 `source_pronunciation` 仍是转换时的快照。
- `normalization_schema_version`：当前登记规则的 schema。
- `source_changed`：当前读音/记音列与转换依据不一致时为 true，须先重跑转换再复核，不能仅刷新凭据绕过。

例：从当前队列中选出的 `row` 发起人工结论（仍须填写真实核对依据）：

```js
await pb.send(`/api/fangji/pages/${encodeURIComponent(row.id)}/normalization`, {
  method: 'POST',
  requestKey: null,
  body: {
    canonical_pronunciation: actualCanonical,
    basis: actualManualEvidence,
    expected_basis: row.expected_basis
  }
})
```

凭据覆盖：转换源值与当前实际源值、记音列及项目 reading 角色、源/目标方案、规则/schema 版本及真实载入的 source/target 文档摘要、当前归一结果/候选/trace、来源身份与关联 PDF 文件快照（无显式文件时绑定主 PDF 回退）。已经存在的人工记音字段即使为空串/纯空白，也表示当前空值，不回退到OCR旧读音；旧凭据会失配，重新转换只计跳过，不为其捏造结论。

不使用任意 `updated`，所以无关质量状态、租约与时间戳变化不会使草稿失配。队列对文件做批量读取，避免逐条查询。

POST 在同一写事务内重新读取条目、项目及所需来源文件，再比较与保存。缺失或变化的 `expected_basis` 返回 **409**，且不改变条目的人工结论。旧客户端没有该凭据时也不能提交：须刷新/更新客户端，不能自动补一次新 GET 然后继续发送旧稿。其他既有字段校验/不可复核状态仍按原 400 权限与校验行为处理。

转换 worker 也在每条写事务内重新读取条目并检查人工复核标记，早已读入批次的旧记录不能覆盖稍后提交的人工 `REVIEWED`。两种先后顺序均受保护。

## 界面行为

同一条目且同一依据时，刷新/翻页保留尚未提交的填写。来源、方案或规则变化时，旧写法和旧依据转入只读旧稿，当前输入清空并禁止提交；点击「按当前依据重新填写」后，须重新核对并输入当前写法与依据，旧文字不会自动套回。若来源尚未重跑，按钮保持禁用。

收到 409 后必须先成功重新读取队列，才能重新开始填写；若刷新网络失败，旧来源继续只读，不标作「当前依据」。不在当前页、切换筛选或已移出队列的草稿仍有工作区内的只读查看入口。这些草稿仅保留在当前挂载工作区，关闭前需自行保留需要的文字，不声称已写入服务端或持久化。

本次没有迁移、没有改动人工语言规则、没有将合成规则升级为生产规则。回滚客户端和服务端需要一起回滚；更严格的条件提交是明确的 API 兼容边界。
