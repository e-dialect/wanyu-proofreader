# 辅助分析的分块准备与原子发布

关联 #417。修复基于已合并的 `main c728b49c2a075c12e7aeadcef2f1473019066d4e`；原 11 层 PR 已合入。早期全项目写事务候选 `d8d8a8f` 的长锁失败证据保留在 `docs/evidence/assist-atomic-20261109`，不能单独发布。本文件描述本地候选，最终验收 SHA 和未验事项以同目录证据及最终报告为准；没有生产部署。

## 发布与数据契约

1. `begin` 在短事务中重新鉴权，取得项目/全局依据版本并创建私有 `staging` marker。全实例同时最多一个 `rules/identity` marker；忙碌返回 `409 / ASSIST_BULK_BUSY`，不泄露占用者、项目或账号。`page` 不占用该槽，也不因槽忙而拒绝。
2. 在写事务外读取有界输入、构造上下文、运行原规则、准备派生值，按原作用域用 ID keyset 收集当前旧 finding 的退役候选。没有截断、部分成功或自动重试。
3. marker 保存预期数量。finding、machine-analysis event、派生值、退役候选分块保存；每块最多 100 条且估算载荷不超过 256 KiB。真实 finding/event 仍逐条普通 `Save`，不绕模型验证或 hooks。每块开始验证 marker 仍为 staging 且依据未变，及时停止必失败批次。
4. 最终事务重新验证当前账号/项目权限、依据及四类实际/预期数量，更新白名单派生字段，再普通 `Save` 把 marker 切成 `published`。仅这次 COMMIT 改变业务可见性；失败保留上一完整结果。单页先发布会使旧全量 prepared 依据失效，返回 `409 / ASSIST_BASIS_CHANGED`。
5. 自动单页分析保留调用方 txApp，并显式 SAVEPOINT。即使 `safeRecomputePage` 吞掉分析错误、外层提交业务，旧 finding、tier 和有效退役也不部分改变。PB 的 after-success 回调队列不由 JS savepoint 撤销；相关现有 hooks 无外部副作用，未来新增副作用必须先重查数据库中是否实际 published，不能把内存 Record 当提交证明。

迁移为 `1794204700_assist_publications.js`，未修改既有迁移：

| 对象 | 权威字段/行为 |
| --- | --- |
| `assist_publications` | 私有集合；`project/page` 为 ID 文本快照，避免阻断合法项目删除；`scope=page/rules/identity`，`state=staging/published/aborted`，`basis_json`，`expected_findings/events/pages/retirements`，`published_at/failure_code/created/updated`。marker 保留。 |
| `review_findings.assist_publication` / `verification_events.assist_publication` | 可空非级联 relation；新记录创建前就带 relation。只有 `machine_analysis` 可带 publication，人工判断/提交/研究事件不进入隐藏批次。 |
| `_assist_finding_retirements` | 复合 PK `(finding,publication)`，`staged_at` 只是私有准备时间。同一旧 finding 可有不同未发布候选，不阻塞单页；有效退役时间取最终 `publication.published_at`。 |
| `_assist_page_derivations` | PK `(publication,page)`；最终 UPDATE FROM 每行只连接一次。rules/page 只更新 difficulty 的 tier/basis/version；identity 只更新 `entry_identity_key`，保留原 `difficulty_stale` 契约。NULL 回落、显式空串、项目边界均保留；值未改变不动 `updated`。 |
| `_assist_basis_epochs` | 单调项目/全局版本，覆盖源行、来源引用、角色/策略/键盘、人工dismissal、有效 finding 及 publication/有效退役变化；缺任何依赖 trigger 时拒绝分析。未发布 stage 写入不使自己失效。 |
| `idx_assist_single_bulk` | `UNIQUE(state) WHERE state='staging' AND scope IN ('rules','identity')`。WHERE 下 state 为常量，对所有项目提供同一个全量槽，和 begin 的事务检查共同防并行准备。 |

页级退役继续排除 `PROJECT_ONLY_MESSAGE_KEYS`；rules 和 identity 只退役各自既有 kind，绝不整批退掉旧 publication 或其他 producer。人工权限/来源授权不由辅助分析授予。原记录正文、字符、顺序、旧 `superseded_at` 均不因退役被重写。

## 读取、恢复与回退

- `assist_visibility.currentSQL` 要求 legacy 空 relation 或 marker 已发布、原 superseded_at 空、无已发布退役证明。`historySQL` 保留所有曾发布历史，仅隐藏 staging/aborted。历史只读 Record 的 superseded_at 投影取原值优先、再取确定性最早的已发布退休时间；数据库原值不改。EXISTS 查询不使用会在零匹配时仍返回一行的聚合。
- findings、verification、field audit、research、history/export 统一适配。跨多个查询的管理/verification/audit 响应使用开始/结束依据复验；变化时 `409 / ASSIST_READ_CHANGED`，撤权优先 `401/403`。这是 publication/已跟踪来源的一致性保护，不宣称为所有人工事件的通用数据库快照。
- native API 包括 superuser 不能创建、改写或删除内部 marker/关联/隐藏载荷以绕过发布；合法项目删除保留文本 marker，不会把 stage relation 清成 legacy。
- `registerAssistPublicationRecovery` 是窄 Go OnServe hook（PB JSVM 不暴露 OnServe），在 HTTP 接入前执行。前置是最早 Bootstrap 的 OS 数据目录独占锁，`fangjiDataDirectoryOwner=true`。第二实例必须在 DB/恢复之前拒绝；恢复不能只相信 PID 或过期时间去抢活跃实例。
- 启动仅把遗留全量 staging 标为 aborted，普通 Save、保 marker，不自动发布/续算。正常 abort/publish 释放全量槽；长准备遇过期 marker 不得复活。每分钟清理过期 staging、分类型清 aborted 载荷，单类最多 100 条/估算 256 KiB，先读 ID/字节数再加载完整 Record；raw 表按 publication 与主键定位。已发布历史和 marker 不删。异常超大存量载荷保留并明确报维护错误，不先读进内存。
- 一旦有任何 publication，migration down 拒绝。旧 binary 不理解可见性与实例锁，禁止热回退到旧 binary；应停服并恢复迁移前备份，或另行审核显式物化回退。不能让旧进程与新进程共享数据目录运行。

## 资源边界和验收口径

输入合计 32 MiB、单行 2 MiB、准备序列化数据 64 MiB、估算总载荷 128 MiB、单结果/每块 256 KiB；既有 50k 行防护仍明确拒绝，不静默少读。策略/角色元数据先检查 256 KiB，关联键盘定义合计先检查 2 MiB。页记录只读实际需要的白名单；ID keyset 显式范围，不反复 OFFSET 读正文。identity 的二次方 partner 数组在分配前估算，普通规则/identity 输出在累计时检查预算。拒绝只影响本次辅助分析，不改变导入上限、原貌校对或交付。

这些是序列化/估算预算，不是 RSS 硬上限；不承诺任意 20k 行材料都能分析。全局单 bulk 约束跨请求准备内存；普通单页仍能工作。实际 4 核约 3674 MiB 共享生产规格、30人正式容量、共驻负载仍属于 #400 外部验收。

`TestAssistBatchScaleContention` 的 `ASSIST_SCALE_SCHEMA=full` 使用全部迁移及全部 `.pb.js` hooks、真实 PB/Goja/SQLite 普通 Save；调用直接 writer，不冒充完整 HTTP 服务容量或 main 全部 Go hooks。记录独立 writer 等待、每个成功/失败阶段含 COMMIT 的持有时间、提交前 SQL 分段、估算/持久化字节及独立资源采样。资源样本缺失/失败或超过明示最大间隔须标 incomplete，采样峰值不冒称真实瞬时峰值。

工程目标是每块/final 写事务及独立 writer 等待各 ≤500ms。保留 10k 通过但 20k 失败、旧 SQL 分段、FROM 单变量失败记录；不以单条/少量诊断替代全部 10k/20k 和正式容量。最终命令、源码冻结指纹和结果见 `docs/evidence/assist-publication-main-20261109`；未测不算通过。
