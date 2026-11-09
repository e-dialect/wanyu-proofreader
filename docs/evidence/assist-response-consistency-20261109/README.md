# 同一响应内的分析发布一致性

基线：`5ffddc3c22222392dc750a47b31d9a42b75b5a37`（已合并 main `c728b49` 上的 #417 staging 检查点）。本补丁不改变 schema、writer、规则、正文或研究冻结事务，也不部署。

## 契约

`assist_read_consistency.js` 在组装完整响应前捕获项目与全局依据 epoch，重新读取页面、来源和权限，组装后再次校验当前 token 代际和项目权限，最后复验 epoch。期间版本变化返回 `409` / `data.reasonCode=ASSIST_READ_CHANGED`，不发送部分正文，不自动重试，也不占用长写事务。权限撤销优先返回现有 `401` / `403`。

页面的预读只定位项目 ID；用于输出的页面在捕获后重读，项目归属改变拒绝返回。`my-problems` 预读也只定位项目集合，随后重新读取报告和草稿；遇到未捕获但当前有权的新项目返回冲突。原有无权项目过滤保持不变，输出涉及的各项目在返回前再次校验校对权限。项目可各自有版本，本接口不建立通用跨项目数据库快照。

覆盖读取：

- 页面 verification、events 与 findings（保留 findings 原有更严格的在手／本人提交条件和盲校投影）。
- 项目 problems、verification-summary、verification-export、field-error-summary 与 findings。
- my-problems 的报告、草稿及其机器分析上下文。

只保证发布切换和 `_assist_basis_epochs` 已覆盖来源输入的一致性。普通人工判断、问题记录、草稿等并发变更不一定推动此 epoch；不能把此补丁描述成所有表的数据库快照。不同 HTTP 请求之间的分页不冻结。研究 freeze 仍使用其既有短写事务；Go queue/insights 的既有并发读快照保持。

## 合成工程回归

`backend/assist_read_consistency_test.go` 使用真实全迁移临时数据库、生产 JS 路由和 PocketBase HTTP router。在读连接的 SQL 查询边界提交真实 publication + retirement 事务，再继续同一个响应的后续查询。测试不是先完成旧请求再单独读取新请求。

覆盖十条读取场景（含 export 的事件／findings跨查询及 500 条 offset 分页）、发布后正常重读、token 轮换和 manager/proofreader membership 撤回优先级、未捕获项目、预读页面不能进入输出、404 保持，以及只有报告的校对员仍不能借 verification 权限读取 findings。

实际执行：

```sh
GOMAXPROCS=2 go test -C backend . -run '^TestAssist(ReadConsistency|Visibility)$' -count=1 -timeout=90s
# PASS 3.472s
GOMAXPROCS=2 go test -C backend -race . -run '^TestAssistReadConsistency$' -count=1 -timeout=120s
# PASS 35.083s
```

四个修改／新增的 JS 文件均通过 `node --check`，`git diff --check` 通过。定向测试时其它功能检查并行；用时仅用于说明执行完成，不是性能或容量证据。未运行新的正式容量、15 分钟故障或生产验收。
