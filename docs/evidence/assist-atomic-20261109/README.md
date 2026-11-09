# 重算批次原子性候选：正确性通过，写入争用仍阻断合并

基线为 PR 406 的 `5d1a9a9ba29a2c2c50ce1a7d283e88deff56c869`。
这是隔离工作树中的候选，未推送、未部署；用户已选择继续缩短批量发布写锁后再合并。
实测源码 SHA-256、运行时及版本边界见 [receipt.json](./receipt.json)。

## 已确认的缺陷

CI 的 8 个重算 HTTP 响应都已返回，当前结果仍缺少
`char_out_of_repertoire/non_ipa_range_codepoints`。这不是等待不足：旧请求的
`supersede` 可下线新请求刚写入的首条记录，随后按时间戳收尾无法恢复它。
本机原 HTTP 套件通过，但重复波次留下 6–7 行、2–3 个毫秒批次，说明原集合断言掩盖了重复。

新增 Go 回归直接加载实际 JS writer/rules，使用真实 PocketBase 与 SQLite：

- 原代码在第 2 条 finding 保存失败后，单条、项目和身份三路径都破坏已提交旧批次。
- 原代码的混合单条/项目并发第一波得到 10 行，正确串行投影为 6 行。
- 候选通过三条失败回滚、4×8 混合并发的字段/参数/字符证据精确比较、外层事务回滚。
- 四个相关 HTTP 套件通过。HTTP 并发现在要求恰好一份完整批次，并逐字段检查参数及码位区间。

候选三个入口使用传入的 `txApp`，不再按时间排序。仍使用 `dao.save` 的验证、hook 和审计；
没有绕过模型验证、没有直接写 SQL、没有改规则或字符结果。同一事务内缓存每页来源上下文
及只读项目/角色/文件元数据。响应保留 `settled: 0` 以兼容已有消费者。

## 仍失败的性能边界

冻结候选在本机 macOS、Go 1.27.3、`GOMAXPROCS=2`、实际 `dev_mode=false` 下运行
10,000 条合成记录。另一笔独立写入在首条 finding 插入时发起：

| 操作 | 总耗时 | 该笔并行写等待 |
| --- | ---: | ---: |
| 全项目规则重算 | 23.913 s | 16.403 s |
| 身份重算 | 17.900 s | 7.191 s |

这不是生产同规格或容量验收；探针也没有覆盖准备阶段更早发起的写入，不能将其当作等待上界。
此前未缓存候选的等待约 23.3/13.5 s；缓存改善后仍不能作为短事务发布方案合并。
后续需要显式暂存与有界原子发布，并审查所有读取入口、依据复核、tier 切换和崩溃恢复。

## 可复跑命令

在对应候选树执行；本机 Node 为 24.11.0，失败 CI 为 24.22.2，不声称版本相同：

```sh
cd backend
GOMAXPROCS=2 go test . -run 'TestAssist(BatchFailure|Concurrent|Nested)' -count=1 -v
GOMAXPROCS=2 go test -race . -run 'TestAssist(BatchFailure|Concurrent|Nested)' -count=1 -v
GOMAXPROCS=2 ASSIST_SCALE_10K=1 go test . -run TestAssistBatchScaleContention -count=1 -v
cd ..
GOMAXPROCS=2 python3 backend/tests/run_all.py assist_rules_integration identity_integration difficulty_integration cross_source_integration
```

定向 race 为缓存适配器 v3 实测；最终仅将其五参数转发从 rest 改为显式参数，以兼容既有
读取上限守卫，随后重跑了普通 Go、四套 HTTP 和上述精确源码规模诊断。两份 hash 均在 receipt。
未伪称最终字节已重跑 race。原始临时日志保留在
`/private/tmp/wanyu-pr-followup-20261109/assist-atomic/`，只提交此处脱敏汇总。
