# 产品成熟度实施交接：评审与剩余验收

代码审查锚点：`9eeea42`；原实施基线：`6a306ea`。本文只读取该锚点并整理交接，未重新执行负载、浏览器或业务测试。文中命令是后续执行入口，不是本次通过回执。最终整合 SHA、最新检查结果以主报告和对应 manifest 为准；不创建远端 PR，不包含生产操作授权。

**当前不能宣告容量或发布验收通过。** 30 actor／20,000 条／180 s 的本地 smoke 曾有提交、仲裁及 UI 提交确认超线。近期发现临时二进制触发 PocketBase 默认开发模式；`8e1efd3` 已令测试 harness 显式传 `--dev=false`，并在 `runtime_sample.dev_mode` 记录实际值。更早的性能结果只能保留为开发模式下的功能或相对诊断证据，不能作为生产模式绝对达标数据，也不能与新运行冒称单变量对照。正式生产模式复跑结果不在本文审查锚点内。

生产参考是既有只读盘点的 **4 个逻辑 CPU、约 3674 MiB、与其他服务共驻**，不是 4 核 8 GiB；8 GiB 只作对照。后续验收前重新核对主机/cgroup、磁盘及共驻状态。本机 macOS 大内存测试、`GOMEMLIMIT` 和 CLI 的目标参数均不能代替实际规格证据。

## WP00–09：已有代码与未完成的验收

| 工作包 | 当前实现与主要入口 | 下一执行者仍需完成 |
| --- | --- | --- |
| WP00 实施基线与验收夹具 | `backend/tests/capacity_fixture.py`、`capacity_reconciliation.py`、`harness.py`：一次性实例、合成资料、HEAD/diff/逐源码摘要、二进制与前端构建摘要；`suites.json` 是集成测试清单。 | 合并后冻结一个最终 SHA；任何代码、迁移或运行器变化均生成新证据。旧 fault 报告不能跨 HEAD/diff/source hash 复用。不要把未运行项写成 pass。 |
| WP01 账户安全、恢复入口与令牌失效 | `account_security.go`、`account_recovery.go`、`external_identity.go`、`external_profile.go`、`profile.go` 与权限 hooks；事务内重新核验 actor/token generation，退出所有设备及改密撤销旧凭据。前端 `AccountActionView.vue`、`authService.js`、router 提供恢复/确认页与会话隔离。 | 验证真实 SMTP、HTTPS、有效/过期/重复/旧邮件链接；在授权的隔离 Docker 副本演练维护恢复。既有 API/文件/realtime 撤权测试不等于真实设备、邮件或生产恢复验收。 |
| WP02 安全事件、认证限速与本机草稿 | `account_rate_limits.go`、`security_failure_audit.go`、`pb_hooks/lib/security_events.js`：单实例限速、成功事件事务一致、失败写入预算与保留。`AccountSecurityView.vue`、`localAccountData.js`、`draftExit.js`、`useDraftLogout.js`、`useProofreadDrafts.js`：本账号草稿查看/导出/删除；AppShell 主动退出先同步 flush，再选择保留退出。 | 接收主报告中的后续修复：锚点的 `scope=mine` 仍只返回 success，`29d8cf1` 已在独立包修本人 failed/denied，整合后核验。真实受限存储、跨标签及中文 IME 人工检查仍需做；不建立管理云草稿，不清其他账号副本。 |
| WP03 共享后台作业观察器 | `lib/jobObserver.js`、`composables/useJobObserver.js`、`JobStatusPanel.vue`；CSV/PDF/OCR/Bundle/转换面板接入。标准 view、连接状态、上次成功读取时间及刷新兼容现有页面。`scheme_conversion.go` 新增按 job ID 读取。 | 真机后台切换、断网/联网及长作业走查。确认“连接陈旧”不会显示为业务失败；重试只 GET，不重发写操作。 |
| WP04 管理深链、分页及未保存保护 | `AdoptionView.vue`、`DeliveriesView.vue`、对应 service；`adoption.go`、`adoption_events.go`、`delivery_read.go` 精确详情与分页。`protectedPageScope.js`/`useProtectedPageScope.js` 和 `WorkspaceLeaveGuard.vue`：401/403 清表单/快照并取消，迟到响应不能复活；安全失效关闭待决离页确认。项目级 404 清整页，对象级 404 仅清详情；普通网络失败保留上次内容。 | 用真实角色重放跨页深链、刷新/后退、挂起 dirty 确认时撤权/删对象。合成 mounted 证据在 `admin-page-invalidation-20261109`；不以 fixture 替代后端权限验收。 |
| WP05 导入预检、能力与角色帮助 | `import_service.go`、`ProjectCsvImport.vue`/`csvInspection.js`：前 20 条有效记录只读预览及独立位置元数据。`ProjectFilesGuideView.vue`、`frontend/public/examples/` 有虚构 CSV、完整 Review Bundle 和配套三页 PDF/说明；支持独立校对→仲裁→来源/许可→编选→交付练习。 | 两位独立校对者及管理员人工完成练习，记录理解问题和耗时。来源、许可与交付回执须人工据实确认；不能自动勾选，也不能把样例生成成功当外部接收验收。扫描页能力保持明确拒绝，不宣传任意 OCR。 |
| WP06 全流程视觉与可访问性 | 保留 Vue/Reka、品牌色、字库和现有 App 控件；导入/转换统一按钮及作业状态，动态列局部滚动。`PdfSinglePageViewer.vue` 在固定视口显示加载状态，避免默认 canvas 尺寸跳变；销毁旧 worker 后再次检查代际。规范见 `docs/DESIGN.md`。 | 在 390/768/1440 宽度、200% 缩放、键盘/屏幕阅读器、中文 IME、触屏完成真实流程。现有截图与 mounted 检查不是完整 WCAG 或全设备认证；不得筛掉不利 CLS，目标仍为 0.1。 |
| WP07 服务端权威编选到交付 | `delivery_adoption.go`、`delivery_service.go`、`delivery_read.go`、`reviewbundle/`；由已确认批次派生单个完整入站 Bundle，服务端校验 digest/许可/前包/幂等。历史 ZIP/快照/previous 不回写；失败仅清新建文件。 | 升级副本兼容演练、旧包哈希核对、真实消费方 dry-run、来源/授权及放行人签字。原生入口部署默认关闭；未获这些证据不得以技术预检代签。跨入站 job 自动拆包不在本版范围。 |
| WP08 性能观测与运行保护 | `observability.go`、`database_pool.go`、`read_snapshot.go`、`pagination.go`、`pb_hooks/lib/claim_candidates.js`/`field_audit.js`；脱敏 route/request_id、运行预算、读池/只读快照、领取 keyset、字段摘要投影。`telemetryService.js`/`businessMetrics.js` 记录真实 ready/source/ack 时点；PDF 外部处理有截止时间。`ops/collect_runtime.py`/`summarize_metrics.py`、`backend/ops/backup.py` 提供本地采样与备份凭据。 | 生产模式冻结后重新量测；先确认 actual dev_mode=false，再评估热点。真实 Nginx/CSP/缓存、内存/磁盘预算、共驻竞争及告警收件人验收尚未完成。主报告另跟踪最早启动阶段禁止 PB dev 的安全小包，不能把该未合包写成本锚点行为。 |
| WP09 容量、故障、恢复、真实体验 | `run_capacity_baseline.py`、`run_capacity_remote.py`、`capacity_target.py`、`capacity_scenarios.mjs`、`capacity_browser.cjs`、`capacity_burst.*`、`capacity_report.py`、`capacity_resources.py`；`run_capacity_faults.py`、`run_restore_business.py`。完整协议及边界见 `docs/capacity-remote.md`。 | 完成同源码真实分机 60 min × 3、至少 15 min 五类独立故障、生产参考硬件/资源/恢复 gate，以及真人体验/消费方验收。不得用同机 smoke、两浏览器小样本、一次小备份恢复或旧 DEV 结果代替。 |

## 接口与状态契约：评审时不能改变的边界

- **账户**：`GET /api/fangji/auth/capabilities` 返回邮件入口能力；`POST /api/fangji/auth/logout-all` 旋转 token key；`GET /api/fangji/security-events` 支持 mine/project/platform 权限范围。恢复/邮件确认复用 PocketBase 原生 users API；前端路径为 `/account/:action(recover|reset-password|confirm-email|verify-email)`。离线 `recover-account` 只改指定已有账号密码/令牌，不改角色或邮箱；操作入口用 `scripts/recover_account.py` 的真实停机与挂载守卫。
- **作业**：`useJobObserver({projectId, kind, job, read, panel})` 返回 `job/connection/lastFetchedAt/refresh`，保留 raw `snapshot/state/retry`。身份 key 为 `authEpoch:userId:projectId:kind:jobId`；同用户普通 token refresh 不换观察代次。前台 2 s，隐藏 15 s，离线暂停，失败 2/4/8/15 s，GET 10 s deadline；401/403 清快照停，404 unavailable。CSV validated 为 `awaiting_confirmation`；转换 `total_count` 是 processed，分母为 null。服务端没有的时间字段为 null，不拿客户端 lastFetchedAt 代替。
- **CSV/转换**：预检 `preview_limit=20`、`preview_kind=first_valid_rows`、`preview_locations` 与 preview 同索引，CSV 行号与 PDF 物理页不混入用户字段；本版只读，编辑原文件后重检。转换精确读取 `GET /api/fangji/projects/{projectId}/conversions/{jobId}`，不能以最新作业替代指定作业。
- **管理深链**：编选 `?page=&view=&batch=&tab=&exception=`；旧 `entry=` 只作读取 alias，交互写 canonical exception；已处理列表 `decidedPage=`。交付 `?page=&view=prepare&adoption=&package=&tab=`。编选 exact detail/exception 和 `GET /api/fangji/deliveries/{id}`、`/{id}/events` 不依赖当前列表页。Guard 只接受可选安全 bypass，不决定业务授权；详情 404 不能回退到列表中的旧同 ID 记录。
- **原生交付**：`POST /api/fangji/projects/{id}/deliveries/from-adoption/preflight` 接受 `adoption_batch_id/expected_scope_digest/reviewer/previous/change_reason`；生成同路径去掉 preflight，另带 `preview_sha256/request_id(UUID)`。先校验全项目 scope digest，再按规则显式指定的单个 completed Bundle 截取完整条目；项目范围与交付包范围分开显示。preview SHA 绑定正文、来源、前包等生成依据，不能用 scope digest 替代。跨 job 编选必须分别建立显式单 job 规则并重做预览/确认，不能直接拿 batch ID 假闭环。
- **幂等与历史**：`(project, operator, request_id)` 唯一；首次 201，同体重放 200 且 `replayed=true`，异体 409；重放也先查权限。界面明确“找回上次同一包”，不写回旧包。链键为 `(project, recipient, purpose, import_job, version)`，旧人工 JSON 入口兼容保留。并发准备上限全局 8/项目 2，超限 429；待定/范围外只交付标识和理由，不泄露正文。

## 迁移、开关与回滚审查

本锚点相对 `6a306ea` 新增以下迁移，不能只 cherry-pick 前端或只上线新二进制：

| 迁移 | 作用 / 必查项 |
| --- | --- |
| `1794201000_account_security.js` | 建 security_events 与索引；已有事件时拒绝 down，不能删除审计来强行回退。 |
| `1794201100_account_mail_pages.js` | 仅替换已知旧模板 URL 为新账户页；核对自定义模板及旧链接桥。 |
| `1794201200_security_retention_index.js` | outcome/created/id 保留清理索引。 |
| `1794203000_delivery_adoption.js` | 可选原生交付幂等、对账元数据和链索引；有新链/幂等凭据时 down 可拒绝。旧包不可变。 |
| `1794204000_field_summary_judgment_index.js`、`1794204100_field_summary_projection.js` | 最新 judgment 索引、事务 trigger/backfill 读模型；对账旧 SQL 口径和全部写/撤销/删除路径，不改源正文。 |
| `1794204200_claim_queue_indexes.js`、`1794204300_own_review_cursor_index.js`、`1794204400_claim_tier_filter_cover.js`、`1794204410_claim_active_order.js` | 领取/本人已校 cursor/档位及 active 排序索引；需 populated upgrade、结果顺序/NULL/source_empty/跨账号一致性验证。未在本锚点的后续索引不算已集成。 |

上线回退应使用旧镜像与升级前**整目录**备份，不能让旧程序直接打开新 schema。迁移测试通过也不能代替真实数据量副本演练。

| 设置 | 当前约定 |
| --- | --- |
| `ACCOUNT_EMAIL_ACTIONS_ENABLED=false` | 默认不开新邮件申请；true 还需 SMTP enabled + HTTPS AppURL。已发有效 token 的确认不因开关关闭而阻断；旧邮件桥至少保留至模板切换 7 天后。 |
| `FANGJI_NATIVE_DELIVERY_ENABLED=0` | `.env.example`/两个生产 Compose 默认关闭；前后端配置同源。当前 Go 以显式 `0` 关闭，裸二进制不要依赖缺省环境来证明关闭。 |
| `FANGJI_TELEMETRY_ENABLED=0` | 默认不收浏览器指标；开启需同时配置前后端，服务端只收认证用户的固定脱敏字段，不收 URL/query/hash/输入正文。 |
| `ENABLE_POCKETBASE_ADMIN_UI=false` | 两个生产 Compose 默认关闭 UI；旧邮件静态桥独立保留。不是关闭所有超管 API。 |
| `FANGJI_DB_DATA_MAX_OPEN/IDLE=8/4`；`FANGJI_DB_AUX_MAX_OPEN/IDLE=2/2` | 只约束并发 reader；PB 每库 writer 仍独立单连接。重启生效，不等于 RSS 上限。 |
| `GOMAXPROCS` / `GOMEMLIMIT` | 本地近期对照用 2 / 768 MiB；分机由预先冻结 budget 注入并读取 runtime 实测值。属于运行时预算，不是容器 CPU/内存硬限。 |

## 建议的 PR 评审分组与依赖

这是评审切面，不是已创建的远端 PR；拆分提交前先逐组核对依赖，避免机械摘取导致共享入口缺失。

1. **账户/权限/审计（WP01–02）**：Go + JS 双端事务内授权、原生 API 绕过、token/file/realtime、失败预算、邮件模板及 1000/1100/1200 迁移；连同账户页面和恢复工具审查。合入后续 mine 与 dev 禁止小包再冻结安全证据。
2. **作业/导入/帮助/视觉（WP03、05–06）**：observer、CSV metadata、转换 exact GET、练习文件、PDF 生命周期；不引入新框架或扫描能力承诺。账户隔离依赖第 1 组。
3. **管理工作区与交付（WP04、07）**：深链/分页、scope cancel、Guard、picker、完整单 Bundle adapter、3000 迁移、幂等/历史兼容作为一个可运行切面；依赖第 1 组授权。
4. **草稿退出（WP02 交互部分）**：AppShell registry、同步 flush、固定账号归属、焦点/选区恢复及强制失效 bypass；同时审查路由与第 3 组 Guard，避免两个确认框互锁。
5. **观测与性能（WP08）**：日志白名单/脱敏、runtime-config、真实业务时点、PDF deadline、连接池、read snapshot、4000–4410 索引/投影；每项需语义对账，不以较快响应代替正确性。
6. **验收/运维（WP00、09）**：同机/分机 runner、source freeze、burst、精确行摘要/审计链对账、资源恢复、故障进程清理、备份及 release receipts；测试驱动变更也需要独立评审，不能放宽阈值“修绿”。

## 后续执行顺序与命令

在最终整合 checkout 根目录执行。先安装仓库固定依赖；Node/Go 版本按 `frontend/package.json`/`backend/go.mod` 与 `check_runtime_versions.py` 校验。Python 需 `requirements-dev.txt`；浏览器入口需已安装的 Playwright/Chrome，可设置 `NODE_PATH=/path/to/playwright/node_modules`、`BROWSER_CHANNEL=chrome`。不要与其他计时负载并行。下列步骤本次均未重跑。

```sh
npm --prefix frontend ci
python3 -m pip install -r requirements-dev.txt
make check
npm --prefix frontend run build
python3 backend/tests/run_account_security_integration.py
python3 backend/tests/run_all.py delivery_integration adoption_integration
python3 backend/tests/run_scheme_conversion_integration.py
BROWSER_CHANNEL=chrome python3 backend/tests/run_frontend_quality_browser.py --only components repository workbench delivery
python3 -m unittest discover -s backend/tests -p 'test_capacity*.py'
python3 backend/tests/run_restore_business.py --output output/maturity-next/restore-business.json
```

`run_all.py` 会跳过注册了专用 runner 的套件，不能仅凭它的汇总宣称这些都跑过；账户恢复、转换重启等须显式运行上述专用入口。CI 还覆盖真实 Nginx 镜像、文件/字体与来源浏览器组，按 `.github/workflows/ci.yml` 补齐，不新增并行测试体系。`admin-invalidation.cjs` 已登记 components，退出测试在 repository，练习 Bundle 在 workbench。

先跑生产模式诊断并保留失败，再进入正式分机协议：

```sh
# 同机工程诊断；输出目录必须全新，不声称正式容量通过。
GOMAXPROCS=2 GOMEMLIMIT=768MiB BROWSER_CHANNEL=chrome \
python3 backend/tests/run_capacity_baseline.py --profile smoke \
  --entries 20000 --users 30 --duration 180 --repeats 1 \
  --output output/maturity-next/prod-mode-20k

# 单独验证集中提交；旧 A/B smoke 默认不开，避免改变既有负载。
GOMAXPROCS=2 GOMEMLIMIT=768MiB BROWSER_CHANNEL=chrome \
python3 backend/tests/run_capacity_baseline.py --profile smoke --submit-burst \
  --entries 20000 --users 30 --duration 180 --repeats 1 \
  --output output/maturity-next/prod-mode-burst

# 冻结同一源码后执行五类独立故障；需要 OCR 本地 worker 等既有套件依赖。
BROWSER_CHANNEL=chrome python3 backend/tests/run_capacity_faults.py \
  --profile full --output output/maturity-next/faults

# 先评审并冻结预算；示例中的 null 必须有独立依据，不能按本轮结果倒推。
# capacity-lab 是明确授权的隔离验收机示例，不得填生产 SSH alias。
BROWSER_CHANNEL=chrome python3 backend/tests/run_capacity_remote.py \
  --ssh-target capacity-lab --target-repo /srv/isolated/wanyu-proofreader \
  --budget /path/to/reviewed-capacity-budget-v1.json --profile full \
  --fault-report output/maturity-next/faults/faults.json \
  --output output/maturity-next/remote-full
```

正式协议保持 20k/30 actor（24 校对者含 2 个真实浏览器、4 仲裁、2 管理）、200 页约 20 MiB PDF、第二项目 CSV、1 MiB/s 导出消费、每轮 5/5/40/10 min、3 轮。full 强制稳态内一次 24 人同 epoch 提交；250 ms 起发跨度是生成器同步定义，不是产品响应阈值，漏参与或迟到不能重发 POST 补人数。预备窗 240 s，小于任务租约；`--burst-miss-vu` 仅 smoke 负面测试并应返回 fail。正式思考时间仍是合成假设，需真人校准后另存协议版本，不能为达标偷偷调慢。

冻结门槛：常用读 p95 ≤500 ms；claim/submit/arbitrate p95 ≤800 ms、p99 ≤2 s；字段摘要 p95 ≤1 s；原文热/冷 p95 ≤1/3 s；submit_ack ≤800 ms；LCP/INP/CLS ≤2.5 s/200 ms/0.1；意外 5xx/超时 ≤0.1%。`editor_ready` 只报告。生成器 loop p95 >20 ms 为 invalid_generator。`b084485` 起 HTTP 错误覆盖**全部阶段**，成功业务延迟/source/ack 的 full gate 仍只取稳态；Web Vitals 保留完整生命周期。现有 `unexpected_http_responses` 还会对任一 `ok=false` 失败，不能在修复阶段悄悄把 5xx 加入允许列表。

每轮检查：manifest 的 HEAD/diff/source/dist/binary、`dev_mode=false`、实际硬件和 runtime 预算；`acceptance.json` 各 gate；资源 baseline→steady→postload_idle/dwell；`reconciliation.json` 中所有 load actor 的新增 attempt 与真实请求规范化 row SHA-256、唯一 submission event 及 actor/page/project/ref 一致。该对账不宣称覆盖全部 consensus 语义，仍需既有业务集成套件。unknown cache 单列，不能改成 hot；普通/预期 409 不进入成功延迟样本。

同机 runner 的资源预算/恢复/分机 gate 仍 incomplete；正式走 remote。remote 即使 `full_acceptance=true` 也只证明 `isolated_protocol_reference_load`，production_stack、colocated_contention、container_hard_limits 独立发布 gate 仍需证据。退出码和失败日志保留，不能拼接不同 SHA/预算的绿项。

最后由实际负责人补齐：真实 SMTP、加密异地备份及回读、实际数据量整目录恢复（目标 RPO 24 h/RTO 60 min）、告警触达、真实设备/双人校对/管理员全流程与消费方签字。执行 `python3 ops/release_preflight.py --build-sha <40位SHA> --output <新文件>`，按实际凭据传入 `--backup-receipt`、`--remote-backup-receipt`、`--restore-receipt`、`--smtp-receipt`、`--notification-receipt`、`--human-receipt`、`--capacity-receipt`；缺项应为 not_ready。该工具不生成回执、不发送消息、不替人批准发布。

## 证据索引及已知后续包

- 体验/恢复：`../maturity-experience-20261108/`、`../maturity-bundle-practice-20261109/`、`../maturity-draft-logout-20261109/`、`../admin-page-invalidation-20261109/`、`../maturity-restore-business-20261109/`。
- 交付/性能：`../maturity-delivery-20261108/`、`../maturity-field-summary-20261108/`、`../maturity-own-review-20261109/`、`../maturity-read-snapshot-20261109/`、`../maturity-claim-indexes-20261109/`。目录里的原测试计数和成绩属于各自源版本，不累加成最终检查结果。
- 容量：`../maturity-capacity-20261108/`、`../maturity-submit-burst-20261109/`、`../maturity-remote-capacity-20261109/`。更近 20k 时间序列在本地忽略的 `output/maturity/`，按主报告列出的源 SHA/manifest 使用；不要提交含凭据、正文或实际个人资料的原始日志。
- 锚点之后待主报告确认整合与检查：本人 failed/denied 事件读取 `29d8cf1`；PB 默认关闭且最早 bootstrap 拒绝 dev 的 `dc114cb`；历史 DEV 证据注记 `7a3eb03`；队列元数据覆盖索引 `7412b57`（迁移 `1794204420`）。生产模式复跑仍须另收结果。本文不把这些标成 `9eeea42` 已有代码，也不记录尚未完成的通过值。
