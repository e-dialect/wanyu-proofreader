# #417 原子发布：main 上的工程证据

应用与测试源码冻结为 `727b829d17de91f1084e28b32018ad8bed17c781`，基于实际已合并 main `c728b49c2a075c12e7aeadcef2f1473019066d4e`。证据提交只加文档，不把后来重组的 SHA 冒充已测源码。实现契约见 [assist-publication-contract.md](../../plans/assist-publication-contract.md)。尚未推送、创建 PR 或部署。

最终 10k、20k 均通过本次 **每块事务/final 含 COMMIT ≤500ms、独立 writer 等待 ≤500ms** 的工程目标。每种规模运行 rules、identity、rules 替换、identity 替换四轮，没有删除失败样本或改阈值。完整计数、每阶段耗时、输入/产物字节、资源采样和源码指纹见 [final-engineering-probe.json](final-engineering-probe.json)。

| 合成行数 | 轮次 | 最长事务 ms | final ms | 独立 writer 最长等待 ms | sampled RSS MiB |
| --- | --- | ---: | ---: | ---: | ---: |
| 10k | rules 首次 | 235 | 235 | 234.203 | 607.87 |
| 10k | identity 首次 | 164 | 164 | 160.744 | 662.66 |
| 10k | rules 替换 | 212 | 212 | 210.002 | 689.00 |
| 10k | identity 替换 | 130 | 5 | 127.478 | 699.26 |
| 20k | rules 首次 | 465 | 465 | 464.220 | 839.62 |
| 20k | identity 首次 | 337 | 337 | 337.188 | 905.38 |
| 20k | rules 替换 | 436 | 436 | 433.178 | 936.25 |
| 20k | identity 替换 | 154 | 10 | 152.755 | 940.66 |

20k 替换的退休候选分别分为 392/368 块，单块最长 26/24ms。源码 HEAD、dirty diff 与所有登记源文件 hash 在两次运行前后完全一致。10k Go 测试 118.004s，20k 276.463s；shell 日志创建至最终输出的 UTC 窗口分别为 `06:44:55–06:46:58`、`06:48:24–06:53:02`（2026-11-09），这不是逐业务操作的 UTC 时间戳。

环境为本机 64 GiB、10 逻辑 CPU，Go 1.27.3、PB 0.40.6，`GOMAXPROCS=2`、`GOMEMLIMIT=768MiB`、实际 `dev_mode=false`。`full` 模式加载 44 个迁移和所有 `.pb.js` hooks，使用真实 Goja/PB/SQLite、普通 Save；它直接调用 writer，**不是完整 main HTTP 并发服务或全部 main Go hooks**。研究 mode 关闭，项目级研究 event 不在此负载中；单页 event 另有真实读写/回滚测试。

RSS/heap 是独立 1s 目标采样的最大观测值，实际样本数、最大间隔、错误计数全部保留；本轮均 complete。940.66 MiB 不是容器内存硬上限通过，更不证明主服务加 30 人负载可放进 1 GiB。实际 4 核约 3674 MiB 共享生产规格、同源 60min×3、15min 故障、真人/真机/真实材料仍不能由这份工程探针替代；正式容量归 #400。

保留的失败和单变量证据：

- [全迁移初版](full-schema-before-sql-optimization.json)：10k 通过，20k final `700/466/977/544ms`，不能提升为 20k 通过；等价源 checkpoint `cfe1afc`。
- [旧 SQL 分段](old-sql-breakdown-20k.json)：退休和派生更新的实际成本，20k final `868/498/990/506ms`。首轮可能与独立安全 race 的准备阶段短重叠，仅作热点诊断，不作验收。
- [UPDATE FROM 单变量](from-20k.json)：源 `4258c8f`，final `557/436/845/478ms`，仍失败。随后将退役证明改为复合主键、私有分块保存，final 只核数量与切换 marker；没有跳过必要的逐条 finding/event Save。
- 更早全项目长写事务候选及其失败仍在 [assist-atomic-20261109](../assist-atomic-20261109/README.md)，不得单独发布。

功能验证：`TestAssist*` race 通过（422.022s）；44 迁移完成 up/down/up 与初始结构拒绝回退；既有 inventory 49 套登记通过。最终 `assist_rules`（含四轮各八个并发请求、完整字符信号）、`difficulty`、`identity`、`cross_source` 四套真实 HTTP 均通过。它们的 elapsed/P95 输出只作功能门禁记录，不冒充这次独占规模验收。新增真实 PB 回归还覆盖最终撤权、依据变化、丢失 trigger、外层吞错后继续 commit 的 SAVEPOINT、真实已提交 stage/未提交 final 的并发读屏障、第二退休块失败、两个私有退休证明、单页先发布、历史退休时间、字节清理、恢复所有权前置以及有 marker 拒绝 down。

完整进程被终止、第二个 backend 同目录被拒绝、重启恢复的组合验收由单独实际 main 进程 gate 补齐；此证据提交时仍待该 gate 的最终报告，不能把 DB close/reopen 或 OS 锁子进程测试冒充组合通过。

可复跑命令（仓库根目录，临时合成数据库；量测时停止其他编译/浏览器/负载）：

```sh
GOMAXPROCS=2 go test -C backend -race . -run '^TestAssist' -count=1
python3 backend/tests/check_test_inventory.py
python3 backend/tests/check_migrations.py
GOMAXPROCS=2 python3 backend/tests/run_all.py assist_rules_integration difficulty_integration identity_integration cross_source_integration
GOMAXPROCS=2 GOMEMLIMIT=768MiB ASSIST_SCALE_10K=1 ASSIST_SCALE_ROWS=10000 ASSIST_SCALE_SCHEMA=full go test -C backend . -run '^TestAssistBatchScaleContention$' -count=1 -v
GOMAXPROCS=2 GOMEMLIMIT=768MiB ASSIST_SCALE_10K=1 ASSIST_SCALE_ROWS=20000 ASSIST_SCALE_SCHEMA=full go test -C backend . -run '^TestAssistBatchScaleContention$' -count=1 -v
```

Python guards 需要 `requirements-dev.txt` 的 PyYAML；使用任务专用 venv，不改全局 Python。Goja budget、retirement、可见性与恢复测试属于已有 Go 自动发现，未建立平行测试入口。
