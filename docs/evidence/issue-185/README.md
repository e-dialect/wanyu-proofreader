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

初版接口的 `make check` 与前端生产构建通过。本轮聚合优化重新运行新集成套件、5 条 smoke、100k／200k 提交规模及 Chrome／PDF 验收，均通过；脚本语法与 `git diff --check` 通过，未重复旧完整套件。

## 100k 条目、200k 提交与完整页面

最终汇总见 [`capacity.json`](capacity.json)，同规模查询优化对照见 [`summary-query-comparison.json`](summary-query-comparison.json)，页面截图见 [加量前](arbitration-before.png)／[加量后](arbitration-after.png)。截图为已查看的真实构建页面，原文 PDF、八字段差异与提交门槛均可见。

容量部分停止脚本拥有的临时服务，同项目加入 100,000 条条目，每条有两份实际 schema 的合成 `proofreading_attempts`，每份均保存八字段实际值、来源快照及对应合成 actor。加入 1,600,000 条 field_action 和 200,000 条 submission 事件；每个动作的 ref、actor、page 和字段都与对应 attempt 一致。批量构造只存在于临时库，不代表通过 HTTP 完成了 200k 次业务提交或任何真人工作量。

全量 SQL 关联检查通过；首、末条还经实际普通用户审计 API 读取，各只返回本人的八动作和一提交。聚合逐字段断言 submittedFields 从 4 增至 200,004，unrecordedCount 从 2 增至 200,002，correct／incorrect／pending／withdrawn／evaluated 均不变。此证据确实让新接口展开了新增 160 万个已提交字段，不再只是增加条目和动作而让聚合仍只有四份 attempt。

项目仅有 24 条明确标记为合成的 judgment，分布如表；本次不声称覆盖百万 judgment 的最新判断排序最坏场景。

| 项目 | 实测 |
| --- | ---: |
| 新增条目／attempt | 100,000／200,000 |
| 新增 field_action／submission 事件 | 1,600,000／200,000 |
| 项目实际 proofreading attempts | 200,004 |
| 数据库总大小 | 8,702,820,352 bytes（约 8.11 GiB） |
| 事件表／attempt 表 | 7,391,805,440／821,293,056 bytes |
| 事件表两索引 | 291,688,448 bytes |
| 单字段事件 context＋payload 样本 | 2,453 bytes |

该项目事件 kind：`field_action` 1,600,032、`final_adoption` 1、`judgment` 24、`machine_analysis` 5、`review_completed` 1、`review_progress` 1、`submission` 200,004。

| 优化版读取 | 加量前 p50／p95（ms） | 加量后 p50／p95（ms） |
| --- | ---: | ---: |
| `arbitration` API | 2.275／2.829 | 2.107／2.477 |
| `verification` API | 9.202／20.906 | 10.047／19.479 |
| `field-error-summary` API | 3.210／3.398 | 2303.344／2330.527 |
| 完整 Chrome 首屏（含真实 PDF） | 221.036／280.341 | 244.191／316.054 |

| 同样 200,004 attempts 的聚合 | p50（ms） | p95（ms） |
| --- | ---: | ---: |
| 优化前 | 7447.205 | 7831.768 |
| 优化后 | 2303.344 | 2330.527 |

第一次含 200k 新增 attempt 的实际测量显示：旧实现为分页总数及结果各执行整套聚合一次，每个已提交字段都 LEFT JOIN 最新判断，API p50 达 7.45 秒。优化后按字段统计所有提交总量一次，只对少量明确判断按 attempt 主键核对 page／字段／实际值，再合并四类已知判断；unrecorded 为总数减四类，撤回、未知及历史依据口径不变。一条 SQL 用 COUNT(*) OVER()／ROW_NUMBER() 同时返回分页元数据并夹到末页，空列表仍为第 1 页。新真实集成已覆盖正误、撤回、未记录、旧依据、空项目及越界末页。

两次优化对照均为同一主机、等量实际 schema 提交与关联事件的独立临时库。每端点预热 3 次后取 15 个顺序请求；同规模聚合 p50 从约 7.45 秒降至 2.30 秒，仍然是全项目历史查询，不是毫秒级点查。

Chrome 在真实构建产物上运行：同源代理只转发实际临时后端响应，没有 mock 成功数据；一次预热后完整导航 7 次，等待八字段和实际 PDF 都渲染完成。数据来自本机 macOS 15.8.1／Intel、Go 1.27.0、Node 24.11.0；未覆盖生产网络、并发负载或真人时延。仲裁首屏始终独立于全项目 summary 查询，本机约 0.22→0.24 秒的 p50 维持相同量级，小样本不支持严格零回退或生产时延承诺。

离线临时库上对实际生产 SQL 的 EXPLAIN（SQLite 版本见 JSON）显示：page 历史／page＋kind 使用 idx_verification_events_page，project＋kind 使用 idx_verification_events_project。字段总量扫描 attempt 并展开 JSON、分组一次；judgment 先按 project／kind 索引筛选去重，再用 attempt 主键读取实际值，仅小集合参与判断 JOIN。分组／窗口仍使用临时 B-tree；JSON 保留完整计划，不把必要的 attempt 扫描描述成全程索引点查。JS／前端只持有结果页，无新缓存、迁移或生产索引。

数据总大小包含 200k 新增 attempt 及 180 万新增事件。更长的原文、更多来源／机器依据、附加判断及 SQLite 页分配会改变空间和时延，应按实际授权样本规划；本数不是生产固定配额。所有 SQLite 连接均显式关闭，每次成功／失败后临时库自动删除。

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

探针固定每条两份八字段提交和 16 个字段动作。大规模探针按需运行，不进入每次 PR 的集成矩阵。没有设置浏览器脚本时，JSON 明确记 browser_before／after 为 not_run；不能用该模式宣称完成浏览器验收。本记录的最终 JSON 两态均已实际执行。

历史链从 #341 的来源核验迁移启用后开始；更早的内容保持未记录。本次没有生产部署、历史回填或真实语言学判断；#185 的行为验收由以上合成资料自动验证，不代替 #362／#372 的真人和真实批次验收。
