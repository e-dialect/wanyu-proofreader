# 质量汇总的大项目对账（#172）

2026-11-06，本地 Go 1.27.3，临时 PocketBase/SQLite，无真实资料。测试为
`backend/quality_state_test.go` 的 `TestQualitySummaryReconcilesTwentyThousandActualSchemaRows`。

测试载入仓库真实初始 schema，再通过 PocketBase 官方 JS 绑定执行真实的
`1789200000_source_registry.js` 和 `1789200400_page_quality_state.js`，不使用汇总专用
替身表。随后直接向测试数据库批量插入 20,000 条合成 pages，并调用真实带认证 HTTP
`GET /api/fangji/projects/:id/quality-summary` handler。

结果与独立 SQL 条件逐项相等：candidate 10,000（含 5,000 个历史空值），validated
5,000，withheld 5,000，总数 20,000。五个批次桶各 4,000（含未关联批次空桶）；
三个来源桶分别 8,000、8,000、4,000（含未关联来源空桶），三种分组的和均为总数。
另一个项目的 validated 记录未计入本项目。测试还混合了 pending/claimed/proofread/
approved/arbitration，确认质量维度与流程状态正交。

一次本地运行 handler 约 498 ms，测试全程约 1.24 s；这是合成规模功能对账，不能
推断生产 SLA、并发容量或真实资料质量。没有修改生产质量状态逻辑。

复现：

```sh
cd backend
go test -run TestQualitySummaryReconcilesTwentyThousandActualSchemaRows -v .
```
