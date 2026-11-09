# #417 最终 PR 组合回执

当前接续 main `2c8e90b`，前置 #425 `ed386584`。此前保存的各候选/失败/定向/规模证据仍保持原样。本回执区分实际运行源码和后续重组；全量 race 已通过；最终远端 CI、审批及合入状态以本 PR 最新验收评论和暂停交接为准。

## 实际完成

- `4525866` 已整合交付专用 Go→JS bridge 的 BindDbx 修复、真实桥回归和有界 race 预算。该源码完整 `make check` 通过：45 个迁移 up/down/up/初始拒绝、Go 主包69.465s、590前端、168脚本、24运维、166后端Python（1项可选Chrome跳过）、六组Compose配置。
- `92c00ef` 已通过五个真实 HTTP suite（assist_rules、difficulty、identity、cross_source、upload_jobs）与真实 Chrome components/review/workbench；其交付检查真实失败并触发修复。未把被交付失败截断的第一轮浏览器命令写成全部通过。
- `4525866` 上单独完整交付 HTTP＋Chrome 全部通过，包括来源重核、原生生成、幂等、深链、脏表单和回执。
- 真实 main 测试已纳入完整 Go 自动发现，覆盖已提交私有批次后 kill/wait、同目录第二实例拒绝、重启标记、实际 cron 清理和后续 HTTP 重算。原专项 race/详细边界见 [进程回执](../assist-process-recovery-main-20261109/README.md)。
- 最终 Windows 全 Go 测试包交叉编译通过，仅构建，不是 Windows 实机运行。目录锁和桥修复各有独立只读复核，无当前代码阻断；复核 agent 未重复跑测试。
- CI race 步骤改为同一 `RACE=1 make test-go` 入口，capacityprobe 仍单独运行；仅该工作流变动后重跑 `make verify-static` 通过，没有跳过或移除测试。

## 全量 race 的记录边界

`92c00ef` 全量 race 在 Go 默认10分钟累计总期限中止，活动测试仅跑7秒且在Goja中正常执行，未见DATA RACE。失败日志完整保留。

`4525866` 以 `GOMAXPROCS=2 GOFLAGS=-v RACE=1 make test-go` 完整重跑通过，主包1058.469s，所有包366个顶层测试通过。3项明确跳过为可选规模探针、导出规模探针及浏览器专用Go入口；对应规模/真实Chrome证据另列。默认每包20分钟且可覆盖，普通Go期限、500ms业务工程门槛和所有断言均未更改。原10分钟失败保留。

## 规模证据与回退

[冻结规模报告](../assist-publication-main-20261109/README.md) 的 `727b829` 10k/20k 各四轮均通过500ms工程门槛；最终组合的writer/visibility/recovery关键源码与该证据及[实际进程回执](../assist-process-recovery-main-20261109/README.md)哈希对应。完整组合新增CSV迁移后另验45迁移，未把旧44迁移冒称最终45通过。

20k独立writer最大等待464.220ms、最长事务465ms、采样RSS约940.66MiB，均为本机合成工程探针；不是完整30人服务、1GiB硬上限或共享生产规格验收。保留所有超阈值旧候选，正式分机容量仍是用户确认待办 #400。

追加1794204700；任何publication marker存在时down拒绝。旧二进制不理解新可见性，不直接切旧版，也不以旧备份覆盖新写入；优先前滚修复，止损时停止批量重算并保留记录。实例锁只约束本应用，不是对外部SQLite工具的强制保护。首次原生serve仍需已有migrate-before-serve流程，Docker入口已按此运行。

R2。CODEOWNER、远端CI与合入须另验；无生产发布。真人/真机、真实材料、SMTP、异地备份与正式容量仍按原issue验收。Human verification: **Not manually verified**。

## 暂停前已收口的两项 CI 修复

`column_roles` 唯一旧 raw/!superseded_at 读取已改为既有 currentFindings（业务API当前ID＋原stored行）；所有1/0、字符及字段断言不变，普通和race真实HTTP均通过。56条gitleaks命中均为四份规模报告里的源码SHA-256，独立逐条读取其measured commit的Git blob重算后56/56匹配；仅补精确commit:file:rule:line指纹，不放宽path/rule扫描。最终扫描与暂停状态见 [PAUSED_HANDOFF.md](../product-maturity-20261109/PAUSED_HANDOFF.md)。
