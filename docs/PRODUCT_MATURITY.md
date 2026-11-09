# 产品成熟度实施与验收

审视基线：`6a306ea1f47d4ae666b97ac3c34cd3ff97f670a5`。本轮面向桌面专业工作与志愿者，目标单项目20,000条、30人同时工作。保持Vue/Reka、Go/PocketBase/SQLite、现有盲校和纸墨品牌。

## 分层与契约

页面负责路由和编排，公共组件负责展示和可访问性，composable负责状态和生命周期，service负责协议。权限、来源依据、作业和交付以服务端为准。跨账号、项目和作业的迟到响应不得发布。

服务端保持单体，分账户、校勘、资料作业、编选交付和运维职责。事务内所有读取使用同一`core.App`；外部HTTP、SMTP和长下载不持有写事务。新迁移追加，历史结果、审计、包字节不重写。

## 工作包与证据

| 包 | 实施职责 | 自动化入口 | 运营验收 |
| --- | --- | --- | --- |
| WP00 | 版本、夹具、运行环境清点 | 独立临时数据库与manifest | 实际生产版本/规格记录 |
| WP01 | 账户确认、撤销、恢复和一次性初始化 | Go账户/并发测试、账户集成与浏览器 | SMTP真实收信、恢复演练 |
| WP02 | 安全事件、共享出口限流、本机资料 | 权限/审计失败/隔离测试 | 管理员审计走查 |
| WP03 | 固定作业ID观察、共享请求、失联恢复 | observer单测与components浏览器组 | 断网/后台真实设备复测 |
| WP04 | 编选交付深链、分页、离页保护 | delivery/adoption集成与浏览器 | 管理员无提示完成 |
| WP05 | CSV20条只读预检、文字层能力和帮助 | upload_jobs及导入浏览器 | 新志愿者练习 |
| WP06 | 长尾操作/状态/帮助一致性 | browser截图、UI债务门禁 | 真机、200%缩放与读屏 |
| WP07 | 原生权威编选交付、摘要/幂等/版本链 | 原生交付、并发重试和文件失败测试 | 两名真人独立校对后同批交付 |
| WP08 | 结构化日志、脱敏RUM、PDF截止时间 | Go/Node/配置原子发布测试 | 正式资源限额与日志采集配置 |
| WP09 | 混合负载和恢复对账 | 隔离容量探针、现有故障/恢复套件 | 目标规格60分钟×3、异地恢复与实际通知 |

每项分别记录代码、单测/集成、浏览器、真人/真机、生产同规格和实际发布状态。自动化通过不代签真人或生产验收。

## 观测

`FANGJI_TELEMETRY_ENABLED=0`为默认；明确启用时前后端同时设为1。使用精确锁定的web-vitals标准构建，文档级LCP/INP/CLS与SPA业务耗时分开；不使用attribution、不上传URL/query/hash、DOM selector、用户/项目/条目ID。上报失败不能影响业务。

服务端JSON事件写stdout，路由以模板聚合。`http_completed`只记录时间、状态、大小和request_id。错误响应在统一处理器写入前的body字节数可能为0，不将它解释为客户端实际收到0字节。实时长连接不纳入普通HTTP延迟。

只读资源采集（在有权限的部署环境执行）：

```sh
python3 ops/collect_runtime.py --data-dir /private/path/pb_data --container BACKEND_CONTAINER --cache-interval 300 --backup-receipt /private/path/backup/receipt.json --backup-max-age 86400 --output /private/path/runtime.jsonl
python3 ops/summarize_metrics.py /private/path/application.jsonl --output /private/path/summary.json
```

指标报告必须保留样本数与缺口；小于200条的浏览器分组标记小样本。原始观测日志采用有容量上限的轮转和到期策略，安全事件遵循其独立保留策略，不能用采集日志替代业务审计。

## 性能探针与发布门槛

脚本只接受自己创建的临时服务，拒绝外部URL和已有数据目录。批量准备克隆真实HTTP产生的工作流模板，实际负载经普通用户领取、读取、提交和仲裁；批量夹具构造不算业务吞吐。

```sh
GOMAXPROCS=2 python3 backend/tests/run_capacity_baseline.py --profile smoke --entries 2000 --users 30 --duration 30 --output output/maturity/smoke
GOMAXPROCS=2 python3 backend/tests/run_capacity_faults.py --profile full --output output/maturity/faults
GOMAXPROCS=2 python3 backend/tests/run_capacity_baseline.py --profile full --fault-report output/maturity/faults/faults.json --output output/maturity/capacity
```

混合驱动已覆盖200页约20MiB的实际PDF、两名真实UI校对者、其他独立HTTP身份、并行CSV和消费端1MiB/s慢导出。原文冷/热状态须有浏览器证据，无法确认者单列unknown；成功延迟只统计2xx，预期409单列。固定full为20,000条、30个actor、60分钟×3，HTTP指标取稳态，另附独立15分钟故障结果；短smoke不是正式容量验收。

每5秒采集测试后端RSS、WAL、磁盘与作业数，保留回落趋势。当前同机驱动的`separate_generator_host=false`，资源预算/恢复容差未冻结时为incomplete，不能仅靠延迟全绿获得`full_acceptance:true`。真正分机、生产共享规格和资源回落评审仍是发布门禁。命令的系统依赖与完整说明见容量证据README。

门槛：读API p95≤500ms；领取/提交/仲裁p95≤800ms、p99≤2s；字段汇总p95≤1s；热原文可读p95≤1s、冷原文≤3s；意外5xx/超时≤0.1%；无丢写/重复提交/泄漏/字符变化/OOM。测量失败才触发对应查询、锁、导出和资源争用优化。

用户已选择优先按现有生产规格优化。已核实生产机4 vCPU、3674MiB内存、与多项服务共驻；空闲时本产品后端约114MiB、可用内存约1420MiB。它们是一次只读采样，不能当峰值或安全余量。主验收使用`docker-compose.capacity-shared.yml`：后端2CPU/1GiB/GOMEMLIMIT768MiB、前端0.5CPU/128MiB，在隔离环境复现共驻负载后复验。OCR按需另加原有预算，不能假定还能独占768MiB。

`docker-compose.capacity.yml`保留4核8GiB参考对照配置。两个文件都不直接应用于生产；本机原生进程压测也不冒称已施加容器硬限制。

## 发布与恢复

邮件自助动作默认关闭，只有SMTP、HTTPS应用URL和真实收信验收完成后开启。新交付链下已产生的数据不得为迁移down而删除；发布后默认关闭新入口并前滚修复。

`FANGJI_NATIVE_DELIVERY_ENABLED`在Compose和示例配置中默认为0，先发布新旧数据兼容代码并演练迁移，再在前后端同时设1开放编选直接出包。紧急设0会隐藏快捷入口并使新生成端点返回503；已有交付包和原有清单流程继续可读、可用。开发和独立测试进程未设置时开放该能力，测试必须明确记录环境。

保持完整目录备份，RPO24小时/RTO60分钟是目标。异地目的地/实际通知未配置就记录未验收。线上发布遵循项目现有精确CI镜像与PocketBase兼容回放规程；本轮本地代码通过不等于已经上线。

## 发布前只读检查

`ops/release_preflight.py`接收维护者留存的验证回执（status/pass、verified_at、必要的build_sha），对缺失/过期/版本不符报告not_ready。它不伪造回执、不发送通知，也不是密码学证明；镜像/迁移兼容仍使用既有部署工具的实际回放证据。备份与异地验证要求24小时内，恢复90天内且匹配版本；真人与容量回执匹配待发布版本。

资源采集输出按10MiB×6份轮转（当前文件与5个旧文件），可显式配置上限；不要对长期运行的采集器使用无界重定向。Docker MemUsage是容器内存用量，不冒充操作系统RSS。

## 测量触发的架构调整

2万条、约24万条判断记录下，先完成最新判断覆盖索引与单次展开，真实Go HTTP仍超过1秒。按测量结果增加1794204100派生读模型：每个attempt/field的计数贡献与project/field总计，由8个SQLite触发器与源记录同事务维护；没有复制正文、判断原因或来源context。初始化回填、触发器和启用标志在同一个迁移事务中发布，失败完整回滚。

字段汇总仍先检查项目管理权限。模型缺表/缺触发器或显式禁用时回退原SQL；仅关闭读取且全部触发器持续完整时，维护继续进行，才能直接恢复读取。若曾缺触发器或修复过表，必须先重建并与权威SQL对账，不能仅重装触发器就启用旧计数。最新判断遮盖、非法JSON、同时间revision/id排序、跨项目移动、删除及回滚均与历史SQL逐步对账。legacy已完成但无提交的计数继续实时读取。派生数据不能反向改写业务原记录。

独立20,000条基准中，真实HTTP p95约16.5ms，派生空间约13.7MiB；这是本机合成基准，不能推导共享生产机混合负载已达标。保留优化前失败与最终测量报告，避免只展示有利的SQL微基准。

## 安全与评审边界

账户与权限操作的成功审计同事务提交；导出授权在发送正文前记录，传输完成只表示服务端写完，不能作为接收方回执。原生和旧清单交付都在事务内复核当前身份与项目权限。恢复能力、审计字段与限制见account-security.md；适用标准映射见security-asvs-mapping.md，未覆盖项保持开放。


派生读模型和权限代际补丁集成后，已实际通过完整常规门禁、41个默认集成套件与账户/Bundle/转换重启生命周期。后续新增的退出保护、例外URL兼容、Nginx默认关闭与备份运行证据会在最终集成证据中分别列出，不能沿用早期测试数量冒充最终检查。


HTTP观测替代PocketBase默认请求activity logger：新请求以路由模板、状态、时延、字节和request_id写JSONL，不再把原始URI/query/Referer写入logs.db；PocketBase系统/业务日志与已有历史不改写。Nginx访问日志同样只写固定路由类别和数值字段，实际容器已用token查询哨兵验证。原生管理UI两种生产入口均默认关闭，API权限边界单独验收。

失败审计的三个账户/权限入口及导出流失败共用来源与时间窗预算，固定词表的汇总日志可见；成功事件不走失败预算。新增迁移1794201200增加保留查询索引，清理按failed/denied/success独立每批至多500条，不能删除原校勘审计。管理员安全记录投影保留资源和原因码，mine继续限制字段。

### 2万条混合负载触发的领取修复

03a3a3c的180秒加速混合测试未通过：领取p95约8秒、提交约11秒、RSS峰值约1.5GiB。仅限制读连接的对照仍未通过，实际读池4–5连接且没有等待，写池累计等待约3242秒；不能把内存增长归因于120个读连接已全部打开。

领取原来在写事务内一次物化全部候选。现改为按page_number/id每批64条keyset扫描，SQL先应用层级/缺字过滤，同页邻接仍先于层级，租约和已提交排除继续在同一事务复核。64是单批上限，非总扫描上限；几乎已做完全队列的用户仍可能遍历很多候选。迁移1794204200补层级与本人活动任务索引。

主数据读池默认open/idle为8/4，辅助库2/2，另各有1个写连接。四项FANGJI_DB_*配置只接受有界正数且idle不超过open；连接上限和GOMEMLIMIT都不是RSS硬隔离。每30秒同时记录四池等待统计、Go堆保留/释放、实际内存软预算及GOMAXPROCS。后续对照显式设GOMAXPROCS=2、GOMEMLIMIT=768MiB并保留原负载、阈值和失败证据。

## 本轮最终本地回执

实施、架构适配、逐工作包六项状态及完整接续入口见 [最终报告](evidence/product-maturity-20261109/IMPLEMENTATION.md) 和 [agent 交接](evidence/product-maturity-20261109/REVIEW_HANDOFF.md)。业务实现锚点8de31fa、精确容量协议0d27b29；两者只差两个容量测试Python文件。精确20k/30用户短测、24人集中提交、959次逐条对账和约1005.5秒独立故障通过；正式同规格分机60分钟×3、真人真机与实际邮件/备份/通知仍待验。未push、未创建PR、未发布。
