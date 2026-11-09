# 编选与交付工作区验证（2026-11-08）

基线：`6a306ea`。仅本机一次性 PocketBase 数据库、合成来源和条目；没有生产写入、部署、消费方真实 dry-run 或真人签字。`release_decision` 仍为 `human_required`。

## 权威边界

- 编选预览、确认、例外保存及重评都使用调用者传入的事务 `core.App`；例外保存与批次退回草稿在同一事务完成。
- 新入口 `POST /api/fangji/projects/{projectId}/deliveries/from-adoption/preflight` 接受 `adoption_batch_id`、`expected_scope_digest`、`reviewer`、`previous`、`change_reason`。
- 创建入口为相同路径去掉 `/preflight`，另需 `preview_sha256` 与 UUID `request_id`。服务端读取接收方、用途、确认人和全部条目；先比较整个项目的存储、当前及请求 scope digest，再截取唯一完整 completed ReviewBundle 的全部条目。原生排除理由保留编选词表，不映射成旧五桶。
- `(project, operator, request_id)` 唯一。权限先检查；同参数重放在查询最新版本之前返回同包，首次 201、重放 200；同请求号不同参数返回 409。预检和生成全局最多 8 个、每项目最多 2 个在途请求，超限 429 + Retry-After。
- 新版本链按 `(project, recipient, purpose, import_job, version)` 唯一。旧快照、previous 链和 ZIP 不改；详情标注旧跨批次前包。新增可选元数据使用 `omitempty`，旧 fixture ZIP SHA-256 固定为 `306a349c63bb7204a90c725de0c7592ad6385f65458ccfe8514eea5023c6a52a`。
- 新包在保存记录时一并保存派生 `reconciliation_json`。分页列表只读当前页完整快照，项目统计读小元数据和事件；旧包缺摘要时读取旧快照兼容，不回写历史。指标分别注明不可变包快照口径与当前来源许可口径。

## 迁移与失败保护

`1794203000_delivery_adoption.js` 新增可选请求幂等、对账摘要字段及两个索引。空库支持 up/down/up；已有多导入批次共享旧版本键，或者已有原生请求幂等凭据时，down 在任何 schema 修改前拒绝，保留兼容迁移。回退应用二进制前仍须核对新链兼容性，不可强删索引/凭据来强行降级。

故障注入实测发现 PocketBase model hook 在 `e.Next()` 已上传 ZIP 后报错时，事务回滚会留下 ZIP；共享保存助手现显式清理本次新分配文件。测试分别覆盖外层事务失败和保存 hook 失败，验证没有记录、没有 ZIP；从不清理历史包。

## 工作区与读取 API

- 编选 URL：`?batch=&tab=overview|exceptions|history&page=`；例外使用 `exception=`（旧 `entry=` 链接仍兼容读取；选择或翻页统一写出 `exception` 并清除 `entry`）；已处理例外独立 `decidedPage=`。批次详情按 ID 请求，不依赖当前列表是否包含它。
- 交付 URL：`?package=&tab=summary|events&page=`；准备入口 `?view=prepare&adoption=`。默认使用已确认编选批次，旧人工 JSON 交接入口折叠保留。
- 新增交付 GET detail、GET events 分页；交付 list 带 page/perPage 时返回分页与全项目指标，不带分页参数时兼容旧 items/events 响应。
- 编选例外和事件分页不再截断在 200；例外支持 GET `.../exceptions/{pageId}`。草稿使用已有 WorkspaceLeaveGuard，对路由 query、离页和卸载提供保护。

## 已执行验证

- `go test ./...` 全部通过（主包约 23 秒），包括 `TestDelivery*`、`TestAdoption*`，包含迁移拒绝回滚、历史 ZIP 固定哈希、native ZIP replay、两种文件失败清理、SQL 查询日志验证分页只读一页完整快照、旧空摘要兼容与读取不改证据。
- `backend/tests/check_migrations.py`：32 个迁移 up/down/up 和初始 schema 拒绝破坏性回滚通过。
- `delivery_integration.mjs`：真实双人校对/仲裁、来源核查、旧交付兼容、完整批次与权利门禁、五身份、原生 digest 漂移、并发同请求得到 201+200 同包、冲突请求 409、权限先于重放、分页/详情/事件通过。
- `adoption_integration.mjs`：102 批历史稳定分页，以及超过 200 的待处理条目和 205 审计事件全部可达，精确条目读取与权限通过。
- 前端 494 tests、lint、production build、UI debt 和测试清单门禁通过。
- 真实 Chrome / 1440×1000：跨列表页的编选详情、刷新、后退；原生预检和实际生成；交付详情刷新；准备及回执草稿的 query 切换确认/取消通过，页面无未处理脚本错误。浏览器生成动作仅为合成测试，不是实际放行。

## 复现

常规集成：`python3 backend/tests/run_all.py delivery_integration adoption_integration`。本机需 Python 环境提供 `python`、PyYAML，Go 缓存目录可写，允许临时 loopback 服务。

浏览器附加验证沿用仓库 CJS Playwright 方式：启动本工作树前端，设置 `FRONTEND_URL`、可用的 `NODE_PATH` 和可选 `BROWSER_CHANNEL=chrome`，以及 `DELIVERY_BROWSER_SCRIPT=<repo>/frontend/scripts/test-delivery-workspace.cjs`，再运行 delivery 集成。脚本只接受本次临时实例写出的 fixture，截图默认 `/tmp/wanyu-delivery-browser`；不会自动访问生产。

容量、真实用户体验、真实消费方导入与双方签字仍为独立验收，以上结果不替代它们。
