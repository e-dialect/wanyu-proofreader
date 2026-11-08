# 分机容量入口与证据边界

`backend/tests/run_capacity_remote.py` 在本机运行 HTTP 生成器和两个真实浏览器，将后端与前端静态服务放在明确指定的隔离 SSH 目标。原 `run_capacity_baseline.py` 继续作为同机工程演练；本入口不会把它的分机/资源缺口改成通过。

## 前置条件与运行

仅使用独立验收机器和独立代码 checkout。目标需 Python 3、Go、Node/npm、项目所需 PDF 工具和已经安装的前端依赖，本机需 Node、Playwright/Chrome、Python 3。两端必须是相同源码：真实 Git HEAD、dirty diff 摘要、逐源码文件 SHA-256 在准备前比对，运行后再次确认。目标前端直接构建到本轮临时目录，目标仓库中的 `dist` 不被覆盖。容量专用构建将经40位十六进制校验的实际 Git HEAD 通过 Go argv 的 `-ldflags=-X main.commit=...` 注入二进制，并记录实际二进制 SHA-256；runtime 日志中的 build_sha 必须与 HEAD 一致。dirty diff 与逐文件摘要仍独立保留，HEAD 不冒充未提交改动的完整身份。本入口不安装工具、不配置 SSH、不上传源码、不停止任何既有服务。

先复制 `backend/tests/fixtures/capacity-budget-v1.example.json`，在运行前评审并冻结版本 1 JSON。示例中的 `null` 是尚未决定的预算，保留时相应 gate 为 incomplete。不得用同一轮观测结果倒推阈值使该轮通过；报告记录文件原始字节 SHA-256、规范化内容 SHA-256 和完整预算快照，结束时确认原文件未变。资源和恢复预算都应来自待验证的参考配置，8 GiB 对照不替代生产 shared 配置验收。

```sh
# 仅显式选择隔离目标；不能把生产 SSH alias 填在这里。
python3 backend/tests/run_capacity_remote.py \
  --ssh-target capacity-lab --target-repo /srv/isolated/wanyu-proofreader \
  --budget /path/to/reviewed-capacity-budget-v1.json \
  --profile full --fault-report /path/to/compatible-faults.json \
  --output output/capacity/remote-full

# 只验证传输/生命周期；同机机器身份会使 separate_generator_host 失败。
NODE_PATH=/path/to/playwright/node_modules BROWSER_CHANNEL=chrome \
python3 backend/tests/run_capacity_remote.py --transport local \
  --profile smoke --entries 200 --users 8 --duration 12 \
  --budget /path/to/local-protocol-budget-v1.json \
  --output output/capacity/local-transport
```

full 固定 20,000 条、30 actors、2 browsers、3 × 3,600 秒，仍要求同源码的独立 15 分钟五类故障证据。smoke 不会满足 `three_full_repeats`。输出目录必须为空，不能把不同轮次或阈值拼在一起。缺证据为 incomplete，已观测超限为 fail，生成器饱和为 invalid_generator；只在所有协议/参考负载 gate 通过时设置 full_acceptance，scope 固定为 `isolated_protocol_reference_load`。独立 `release_gates` 中 production_stack、colocated_contention、container_hard_limits 仍为 incomplete，`release_ready=false`；该结果不能直接成为生产发布批准。

## 目标生命周期与秘密

目标辅助程序 `capacity_target.py` 只接受版本化 JSONL 协议，不接受 URL、数据库路径、现成数据目录或任意命令。每次 init 创建带随机 nonce 的 `mkdtemp` 目录，权限 0700、umask 077，导入真实迁移和合成工作流夹具后离线扩充；后端和前端服务只绑定 127.0.0.1。调度器得到端口后另启 `ssh -N -L`，只向本机 loopback 转发两个已验证的目标 loopback 端口。SSH 使用 BatchMode、StrictHostKeyChecking 和 ExitOnForwardFailure，不绕过已知主机校验。本机 SSH 客户端可使用 SSH_AUTH_SOCK，但显式禁止 agent/env 转发，目标仍清理环境。

双方清理环境，仅保留基本 PATH/HOME/locale/工具缓存路径。目标不会继承 APP/PB 管理员配置、身份服务地址、SMTP、代理或 NODE_OPTIONS；只按冻结预算重新注入 GOMAXPROCS/GOMEMLIMIT。PocketBase 的测试账号只在新临时数据库中创建。actor token 配置仅经过 stdio 管道和本机临时目录中的 0600 文件；不会写入报告或命令行。目标的构建/准备日志留在临时目录并随之删除，协议错误仅返回固定错误代码。

协议顺序为 init → ready → ping → arm → finish。ready 中的 config 是秘密消息，调度器只持久化独立的 evidence 对象。finish 只回传提交 ID/摘要进行对账，不传正文。artifact 名称固定为资源采样和脱敏 runtime 两种文件，拒绝任意路径、超大消息与异常状态。

EOF、SIGINT、SIGTERM、协议错误和进程超时均进入 finally，关闭本轮 server/frontend/生成器及其自有进程组，并移除自己的 nonce 目录。正常目标退出码 0 是 `target_cleanup=pass` 的条件；失联或无法确认清理保持 incomplete。SIGKILL、目标掉电及文件系统故障不能由 Python finally 保证清理，需要验收机运维处理；不可据此删除任意同名前缀目录。

## 实测与判定

- 分机证据来自两端实际 Linux machine-id 或 macOS IOPlatformUUID 的 SHA-256，不保存原标识。相同身份明确失败，未知身份 incomplete；SSH 连接名和 CLI 参数不能代替分机证据。它是受信验收机的操作系统证据，不是硬件远程证明。
- CPU/内存读取目标实际主机/cgroup，SSD 仅在 `findmnt/lsblk` 或 `diskutil` 的设备查询确认时通过。无权限或未知设备不假定 SSD。入口不安装容器限额，GOMAXPROCS/GOMEMLIMIT 只是 Go 运行时预算；必须从服务端实际 runtime_sample 验证，旧版本没有字段则 incomplete。
- 负载前后各进行五次 stdio 时钟往返，使用最小 RTT 估计偏移及不确定度，并记录两次偏移变化上界。生成器按本机时钟调度，目标采样按换算后的目标时钟分类。超出冻结时钟误差预算失败，缺预算不通过。
- 每 5 秒采后端、目标静态服务和自有目标进程组 RSS/CPU、DB/WAL、磁盘余量及未完成作业。进程组包括辅助进程和继承进程组的 PDF 子进程；预算使用该组合 RSS，不只统计 Go。目录字节每 60 秒扫描一次并记录年龄，尾部强制刷新。Go heap/队列/runtime 设置沿用服务端约 30 秒采样；缺值和过期值不能凭环境声明补齐。离散采样不能证明间隔内没有峰值。
- 负载前有独立静置 baseline；原工作负载 warmup/ramp/steady/cooldown 保持原有比例。生成器全部退出后另有独立 `postload_idle` 观察窗口，不再领取任务，允许已在途服务端工作收尾。恢复 gate 检查末段 dwell 内进程组 RSS、heap 相对 baseline 的增长容差、作业/队列归零；不会把原先逐渐减载阶段冒充空载恢复，也不要求正常保留的 WAL 文件归零。
- 成功提交仍由已有 `prepare_fixture`/`clone_fixture`/`reconcile_fixture` 和摘要对账函数验证，两个浏览器仍走真实领取、原文读取和提交界面。前端静态服务采用现有测试 host，不是生产 Nginx 镜像；生产 Nginx/CSP/缓存需保留独立容器验收。实际共驻服务竞争、真实人工节奏和正式目标限制也不能由本机协议验证代签。

## 自动化覆盖与当前证据

`python3 backend/tests/test_capacity_remote.py` 覆盖环境 allowlist、拒绝已有路径/URL/越界负载、预算缺失/超限/恢复、机器身份与时钟边界、SSH 参数引用、artifact 路径穿越、真实辅助进程准备阶段 EOF 清理、正常完成时输入线程退出、结束前清理生成器后代及不足完整 dwell 的拒绝。与原容量 report/reconciliation 测试一同进入既有 Python 测试发现流程。

本次只进行本地 transport 协议演练，没有外部 SSH、生产访问、真实分机/SSD/共驻环境验收。首轮 20 条/8 actors/12 秒中两名 UI 用户提交 2/3 次，对账与资源采样通过；样本耗尽后的 browser_flow_failed 如实保留。该轮还暴露了辅助程序退出时 buffered stdin 线程未关闭，已增加正常退出回归修复；它的 cleanup incomplete 不追改为成功。最终复验结果另随交付回执记录，不将小型 smoke 冒称 20k/30 正式容量通过。

复验：200条/8 actors/12秒，两名浏览器分别提交13/14次，27次成功确认与DB摘要/审计链对账一致；mixed_runs、资源采样、源码冻结、目标身份保持、binary_build_identity、target_cleanup均通过，目标辅助进程退出码0。总结果仍fail：同机不满足分机要求，未填预算和旧基线缺少实际runtime预算字段保持incomplete。这是本地传输功能证据，不是正式参考硬件结果。修复后另有13项协议/清理/预算单测、5项报告和13项对账测试通过；Playwright采用detached浏览器进程组，超时清理已增加对已确认后代组的终止回归。

协议 JSON 对 NaN、Infinity、指数溢出和重复字段显式拒绝；预算只接受有限数或明确 null，版本和运行人数/时长使用严格整数。异常消息不包含原始 frame、ready config、token 或子进程环境。脱敏本地回执见 [验证记录](evidence/maturity-remote-capacity-20261109/README.md)。

失败回执仅保留允许列表内的 `error_phase` 和 `error_code`，区分后端构建、前端构建、夹具、启动、观察、对账及清理等阶段；命令错误和中断不回显异常消息、stderr 或环境。远端传入未知阶段/原因、额外消息字段统一拒绝为 protocol/invalid_error_frame。硬件 gate 先判断可观测的 CPU/内存是否已违反冻结规格：已知不符为 fail；规格匹配但 SSD 无法确认仍为 incomplete。
