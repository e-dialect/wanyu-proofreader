# #185 字段操作、仲裁来源与历史字段正误（2026-11-06）

本次复用 #341 已合并的 `verification_events`、`source_fidelity.js` 和提交／仲裁事务，补齐只读查询、字段维度聚合和可重复验收。不新增事件集合或迁移，不回填历史，不改写原提交；原问题中的 schema／端点属于实现示例，实际按可追溯行为验收。

## 查询与权限

- `GET /api/fangji/pages/:id/events?page=1&perPage=25`：复用现有来源核验的项目／条目访问条件。项目管理者可分页读取该条目的全部事件；普通校对者只读 `actor=本人` 的 submission／field_action。totalItems、totalPages 先按同一权限过滤，按 created、id 稳定升序；默认 25 条，上限 100，越过末页回到末页，空列表为第 1 页。
- 普通响应只投影原输入、来源版本、依据、本人动作／理由和本人实际提交。不会返回轮次、任务状态、参与人数、机器／研究内部上下文或其他人的判断、结果；查询参数不能覆盖服务端 actor 过滤。过去的原值可由事件 context.input 查到，提交值可由 ref 关联的 submission.payload.row 查到。
- `GET /api/fangji/projects/:id/field-error-summary?page=1&perPage=25`：仅项目管理者可读；按字段给出 submittedFields、correctCount、incorrectCount、evaluatedCount、pendingCount、withdrawnCount、unrecordedCount、unverifiedCount。字段列表同样服务端分页。
- 每份独立提交的每字段以**最新保存的明确来源判断**计一次；修订和撤回不会重复记错，匹配／采用不代替正误，待核实／撤回／未记录不计入错误或已判分母。统计保留当时记录的来源依据，明确标为 historical recorded source basis；不把旧判断冒称当前来源已复核。旧版已完成条目没有提交历史时单列 legacyApprovedPagesWithoutSubmissions，不伪造字段判断。

两个端点均为只读。普通成果 CSV／JSONL 的契约不变，过程 JSON 与项目内审计另行读取。仲裁页沿用现有的字段来源判断及处理历史，不建设第二套审计 UI。

## 实际验证

[`field_audit_integration.mjs`](../../../backend/tests/field_audit_integration.mjs) 已登记进集成矩阵并通过，使用完整迁移的一次性真实 PocketBase、合成账号及 PDF：

- 103 次专用业务保存加两人提交，历史超过 100 条；逐页无重复／遗漏、末页、非法参数、稳定排序正确。事件集合禁止直接创建，连 superuser 也不能绕过专用接口。
- 两名校对者各自只能得到 4 条本人事件；管理者的 100+ 条历史不影响普通分页总数。原输入和本人提交可追溯，另一人的字段值、轮次及机器上下文不出现在普通响应。
- 非成员、普通校对者访问字段汇总、跨项目管理者均 403；未登录 401。空项目没有伪造统计。
- 按字段验证正确、错误、待核实、撤回及未记录；重复修订不重复计数，撤回后的旧错误不继续计错。变更核验约定不偷偷把历史判断换成当前依据的结论；没有提交的旧版条目只增加未记录历史覆盖说明。

[`field_audit_capacity.py`](../../../backend/tests/field_audit_capacity.py) 另外先运行既有 source_fidelity 集成，再用真实提交／仲裁验证：

- 两人各改八字段，field_action 的 actor、字段、原输入及实际提交正确；仲裁分别取 A、取 B、管理员自拟，final_adoption 的 by_field／selections 指向实际 attempt 或明确 custom，原提交保持不变。
- 只在临时数据库注入 submission 事件拒写。失败前已尝试写的八个字段动作、attempt 和页面整体回滚，不留半状态；移除故障后原租约重试成功一次。故障触发器不进入生产 schema。
- 普通响应无他人提交或最终采用值，非成员 403。以下容量及浏览器步骤完成后，数 GB 数据库自动删除；仓库只保留无账号／token 的汇总和合成截图。

`make check`、前端生产构建、上述新集成套件、脚本语法及 `git diff --check` 均通过。

## 100k 容量、聚合与完整页面

最终原始汇总见 [`capacity.json`](capacity.json)，页面截图见 [加量前](arbitration-before.png)／[加量后](arbitration-after.png)。浏览器实际查看过截图，原文 PDF、八字段差异与提交门槛均可见。

容量部分停止脚本自己创建的临时服务，同项目批量加入 100,000 条条目、1,600,000 条 schema 相同的合成字段动作，然后重启同一实际后端。`100,000 × 8 × 2` 是字段动作量级，不是项目总事件数上限；实际业务还有提交、采用、判断、草稿等。bulk 加量用于存储／查询压力，没有通过 HTTP 执行 160 万次业务提交，不能宣称同等导入吞吐或真人工作量。

事件分布与新增聚合的实测均明确列在下面，**不把大量 field_action 当作大量 judgment 最新去重的最坏场景**。完整来源约定、实际合成 PDF、两份独立提交及判断通过业务端点产生；批量加量的行仅用于规模压力。

| 项目 | 实测 |
| --- | ---: |
| 新增条目／事件 | 100,000／1,600,000 |
| 数据库总大小 | 6,976,360,448 bytes（约 6.50 GiB） |
| 事件表／两索引 | 6,570,545,152／256,065,536 bytes |
| 单事件实际 context＋payload 样本 | 2,453 bytes |

该项目事件 kind：`field_action` 1,600,032、`final_adoption` 1、`judgment` 24、`machine_analysis` 5、`review_completed` 1、`review_progress` 1、`submission` 4。

| 读取 | 加量前 p50／p95（ms） | 加量后 p50／p95（ms） |
| --- | ---: | ---: |
| `arbitration` API | 1.923／4.205 | 2.050／2.874 |
| `verification` API | 8.914／11.038 | 9.404／12.417 |
| `field-error-summary` API | 3.436／3.581 | 3.677／4.622 |
| 完整 Chrome 首屏（含真实 PDF） | 242.832／265.286 | 221.725／261.853 |

每端点预热 3 次后取 15 个顺序请求。Chrome 页面在真实构建产物上运行：同源代理只转发真实临时后端响应，没有 mock 成功数据；一次预热后完整导航 7 次，等待八字段和实际 PDF 均渲染完成。数据来自本机 macOS 15.8.1／Intel、Go 1.27.0、Node 24.11.0；这不是生产网络、并发负载或真人时延。

在该合成规模下，完整仲裁首屏保持相同量级，没有测到随 100k 条目明显退化；不把小样本的较低数值解释成优化收益。新增字段聚合的耗时也已实际采样，但其判断事件只有表中数量，不承诺百万判断的最坏窗口排序成本。

`EXPLAIN QUERY PLAN` 对 page 历史／page＋kind 使用 `idx_verification_events_page (page, created, id)`，project＋kind 使用 `idx_verification_events_project (project, kind, created, id)`，均为索引 SEARCH，没有事件表全扫。新增聚合在 SQLite 完成，JS／前端只持有结果页；本次没有因建议索引名称另加生产索引。

保存的是实际样本 context／payload 的空间占用，不是生产固定配额。更长的原文、更多来源／机器依据、附加事件及 SQLite 页分配会增加空间；容量规划应以实际授权样本再次量测。

## 复现

从仓库根目录执行。探针不接受外部服务 URL 或已有数据目录，使用脚本拥有的临时目录，并显式关闭所有 SQLite 连接。

```sh
python3 backend/tests/run_integration.py field_audit_integration.mjs
npm --prefix frontend run build

# 需要 Node 能加载本机 Playwright；按实际安装位置设置 NODE_PATH。
BROWSER_CHANNEL=chrome \
FIELD_AUDIT_BROWSER_SCRIPT="$PWD/backend/tests/field_audit_browser.cjs" \
python3 backend/tests/field_audit_capacity.py \
  --output /tmp/wanyu-field-audit/capacity.json

# 快速验证探针；不是 100k 验收
python3 backend/tests/field_audit_capacity.py \
  --entries 5 --samples 5 --output /tmp/wanyu-field-audit-smoke.json
```

大规模探针按需运行，不进入每次 PR 的集成矩阵。没有设置浏览器脚本时，JSON 明确记 browser_before／after 为 not_run；不能用该模式宣称完成浏览器验收。本记录的最终 JSON 两态均已实际执行。

历史链从 #341 的来源核验迁移启用后开始；更早的内容保持未记录。本次没有生产部署、历史回填或真实语言学判断；#185 的行为验收由以上合成资料自动验证，不代替 #362／#372 的真人和真实批次验收。
