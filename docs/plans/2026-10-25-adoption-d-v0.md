# D 用途编选 v0（#315）实施记录

本文件记录 #315 的前两刀：**批次级编选 + 例外 + 导出说明**的服务端，以及管理端界面。
目标是让「这一批交付采用哪些内容、其余为什么不采用」第一次有机器可读的答案与可点的入口，
而不是靠管理员人工整理交接文件。

## 范围

| 编号 | 要求 | 本刀状态 |
| --- | --- | --- |
| D1.1–D1.7 | 批次编选、可标识、规则可复算、预览数量、可导出 | 完成（服务端 + 界面） |
| D2.1–D2.4 | 例外可列出、留 who/when/basis、数量与积压可见 | 完成（服务端 + 界面） |
| D3.1/D3.2/D3.5 | 可枚举理由码、与既有词表同源、分布可统计 | 完成 |
| D4.1–D4.4 | 覆盖/采用/未采用/待处理、不静默遗漏、范围外显式请求 | 完成 |
| D5.1/D5.2 | 权利是硬边界，未知不得当允许 | 完成 |
| D8 | 五身份权限 | 完成（只有项目管理者可达；校对员不可见） |
| D6 | 不改 B 的成果与状态 | 完成（只读 pages，不写任何校对列） |
| D7 | 术语消歧 | 完成（接口 `select`/`exclude` + 界面文案写明与仲裁台「采用」的区别） |
| D3.3 | 理由码加行通道 | 未做 |
| D5.3 | 权利变更触发重评 | 未做 |
| D9 | 度量页 | 未做（批次详情已给三数与理由分布） |
| D10 | 退回 A/C 的返工通道 | 未做 |

## 数据形状

两张表，见 `backend/pb_migrations/1792886400_adoption_batches.js`：

- `adoption_batches`：一条编选一批。project、purpose（六类用途之一）、recipient、
  status（draft/previewed/confirmed）、rule_json、四个计数、reasons_json、
  previewed_at、created_by、confirmed_by/at、note。
- `adoption_exceptions`：只装例外。batch、page、decision（select/exclude）、
  reason_code、note、decided_by/at。`(batch, page)` 唯一。

不把「采用/不采用」写在 `pages` 上，是 owner 2026-10-11 14:38 的原话：**不要求管理员
对每个已校条目逐条选择状态**。逐条只发生在例外这一层；批次级结论是**一条**记录。
`adoption_batches` 上还有一条部分唯一索引：同一项目同一用途同时只允许一条未确认的
编选，避免 E 侧拿到两份「本批采用范围」。

## 规则与理由码

规则只有四个字段，随批次存原文（D1.5「规则本身可读出来」）：

```json
{"statuses": ["proofread", "approved"], "qualityStates": [], "importJobs": [], "requirePinyin": false}
```

判定优先级固定为 **状态 → 质量状态 → 阻塞原因 → 用途权利 → 拼音**。换优先级不会多选
或少选条目，但会让同一批的理由分布漂移，所以它写进代码注释与本文档。

理由码全部来自既有词表，不新造第二套（D3.2）：

- 结构原因：`outside_import_batch`、`status_not_ready`、`quality_state_insufficient`、
  `pinyin_pending`；
- 阻塞五桶（与 `backend/pb_hooks/lib/assist_difficulty.js` 的 `BLOCKED_BUCKETS` 逐字
  一致，有单测读源文件比对）：`glyph_table`、`scanned_read`、`column_merge`、
  `rights_gate`、`unknown`；
- 用途 gate 的两种失败：`purpose_denied`、`purpose_unknown`。

`blocked_reason` 里出现枚举外的 token 时按 `unknown` 记，不改写、不归并：那种值本身是
迁移与钩子漂移的证据。

## 三个数必须对得上

D4.2「不得静默遗漏，也不得把部分结果冒充全量」落在一条恒等式上：

```
total = selected + excluded + pending
```

`pending` 不是第三种编选结论，而是「排除已算出、理由还不够硬」：理由为 `unknown`
或 `purpose_unknown`、且没有例外结论的条目。确认不要求 pending 归零（D2.3 要求的是
可见），导出里 `complete=false` 与 `omitted.pending` 会把差额写出来。

预览之后数据变了，确认会被 409 拒绝并要求重新预览：不把新数字悄悄写进「已确认」。
已确认批次导出时再复算一次，与确认时记下的数字对照，不一致写 `drift=<哪一项>`。

## 接口

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| POST | `/api/fangji/projects/{id}/adoption-batches` | 项目所有者/管理员/manager |
| GET | `/api/fangji/projects/{id}/adoption-batches` | 同上 |
| GET | `/api/fangji/adoption-batches/{id}` | 同上 |
| DELETE | `/api/fangji/adoption-batches/{id}` | 同上（已确认不可删） |
| POST | `/api/fangji/adoption-batches/{id}/preview` | 同上 |
| GET | `/api/fangji/adoption-batches/{id}/exceptions` | 同上 |
| POST | `/api/fangji/adoption-batches/{id}/exceptions` | 同上 |
| POST | `/api/fangji/adoption-batches/{id}/confirm` | 同上 |
| GET | `/api/fangji/adoption-batches/{id}/manifest?include=select` | 同上；`include` 非 `select` 仅平台管理员 |

例外候选只列前 200 条（D2.4：例外不得变成逐条审批的后门），`pendingTotal` 给全量。
例外一旦改动，批次退回 `draft`，逼调用方重新预览。

## 与 B/C/E 的边界

- **B**：只读 `pages.status`、`quality_state`、`blocked_reason`、`normalization_status`，
  不写任何校对列（D6.1）。
- **C**：`requirePinyin` 读 #190 的 `normalization_status`，但 C 的异常清单还没有接成
  不采用理由（D3.4 待 C 接 v2 后做）。
- **E**：#332 现在用 `selection_authority=manual_handoff_pending_315` 绕过 D；本刀落地后
  那份交接文件可以由 `manifest` 取代。

## 管理端界面

`frontend/src/views/admin/AdoptionView.vue`，路由 `/admin/projects/:id/adoption`，入口在项目页的分区导航。
页面只有三个区：新建批次（用途、接收方、规则、说明）、当前批次（三数 + 理由分布 + 预览/确认/导出/删除）、
例外（待处理逐条处理 + 已处理留痕）。批次历史在最后一栏切换。

界面上的几条硬口径：

- 三数各自可见（本批条目 / 进入本批 / 已定不进入 / 待处理）。前端自己再算一次
  `total === selected + excluded + pending`；对不上时显示「界面不照抄」，而不是照样摆数字。
- 有 pending 时明确写「确认后导出的清单会写明 `complete: false`，不会把部分结果冒充全量」。
- 导出按钮分两个：默认只导进入本批的条目；「含未采用与待处理」的按钮写明需要平台管理员，
  403 由服务端给。
- 待处理条目必须写依据；判为「不进入本批」时必须选枚举内的理由。
- D7 的术语消歧写在页首：这里的「编选」是整批交付取舍，不是仲裁台里选哪份校对结果的「采用」。

截图与走查记录见 [`docs/ui-evidence/adoption/`](../ui-evidence/adoption/README.md)。

## 本刀明确没做

- 理由码加行通道（D3.3）：需要真人先用出「补不上」的实例。
- 权利变更后的批次重评（D5.3）。
- 退回 A/C 的返工通道（D10）。
- 与 #184 的 CSV/文件导出对接（D4 的 JSON 清单是机器可读的最小形态）。
- 按导入批次筛选的界面：接口支持 `importJobs`，界面上先以「15 位批次 id」文本框给出，
  没有专门的批次选择器（后端也没有列导入批次的路由）。

## 验证

- `go test ./...` 与 `go vet ./...` 通过；新增单测覆盖规则解析、判定优先级、计数恒等式、
  理由分布稳定性、范围过滤、403 文案边界，以及两条「与 JS 侧同源」的防漂移比对。
- `python backend/tests/check_migrations.py`：21 个迁移 up/down/up 与初始 schema 拒回滚
  全部通过；本迁移的索引、查询计划与字段契约在 `SPECS` 里断言。
- 前端：`npm test` 269 项通过（新增 8 项：计数恒等式、规则表单校验、规则摘要、枚举漂移、
  页面文案与无裸表格/内联样式、路由与入口、服务层不直读集合）；`npm run lint` 与
  `npm run build` 通过；UI 债务门禁与行尾检查通过。
- 容器 + 真浏览器走查：见上面的截图目录；导出清单的 `counts` 对得上，默认只含进入本批的条目。
