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
python3 ops/collect_runtime.py --data-dir /private/path/pb_data --container BACKEND_CONTAINER --output /private/path/runtime.jsonl
python3 ops/summarize_metrics.py /private/path/application.jsonl --output /private/path/summary.json
```

指标报告必须保留样本数与缺口；小于200条的浏览器分组标记小样本。原始观测日志采用有容量上限的轮转和到期策略，安全事件遵循其独立保留策略，不能用采集日志替代业务审计。

## 性能探针与发布门槛

脚本只接受自己创建的临时服务，拒绝外部URL和已有数据目录。批量准备克隆真实HTTP产生的工作流模板，实际负载经普通用户领取、读取、提交和仲裁；批量夹具构造不算业务吞吐。

```sh
GOMAXPROCS=2 python3 backend/tests/run_capacity_baseline.py --entries 200 --users 3 --duration 180 --output output/maturity/smoke
GOMAXPROCS=2 python3 backend/tests/run_capacity_baseline.py --entries 20000 --users 30 --duration 3600 --output output/maturity/capacity
```

当前协议探针明确输出`full_acceptance:false`：它不能单独证明大PDF、浏览器可读时间、并行导入、限速下载、故障演练或生产规格验收。完整发布必须补齐这些独立门禁，不能把短探针改名为完整压力验收。

门槛：读API p95≤500ms；领取/提交/仲裁p95≤800ms、p99≤2s；字段汇总p95≤1s；热原文可读p95≤1s、冷原文≤3s；意外5xx/超时≤0.1%；无丢写/重复提交/泄漏/字符变化/OOM。测量失败才触发对应查询、锁、导出和资源争用优化。

`docker-compose.capacity.yml`只定义4核8GiB参考环境的起始容器预算，不直接用于未知生产机器。生产机器或共驻服务资源不同必须单独复验。

## 发布与恢复

邮件自助动作默认关闭，只有SMTP、HTTPS应用URL和真实收信验收完成后开启。新交付链下已产生的数据不得为迁移down而删除；发布后默认关闭新入口并前滚修复。

保持完整目录备份，RPO24小时/RTO60分钟是目标。异地目的地/实际通知未配置就记录未验收。线上发布遵循项目现有精确CI镜像与PocketBase兼容回放规程；本轮本地代码通过不等于已经上线。
