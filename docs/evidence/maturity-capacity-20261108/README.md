# 混合容量驱动与本地烟雾证据（2026-11-08）

此目录保留合成数据的实际结果，不能作为生产容量通过声明。运行器只创建一次性本地服务及临时数据库，不接受外部 URL、令牌或生产 data-dir。证据不包含账户令牌、原始资料或数据库。正式参考为生产 **4 核、约 3.7 GiB、共享资源**；8 GiB 仅作对照。当前烟雾执行于 macOS 10 logical CPU / 64 GiB，规格不匹配，存储介质证据也未取得。

## 执行协议

- 30 个 actor 总计：24 校对者（其中 2 个真实 Playwright UI 用户，其余 HTTP）、4 仲裁者、2 管理员。两个浏览器通过任务大厅领取、等待可见原文、编辑、确认来源并点击提交，无成功业务响应替身。
- 20,000 条正式合成条目由真实 HTTP 流程模板离线扩充。扩充操作不计入吞吐。分布约为 50% 完成、20% 待仲裁、15% 一轮校对、15% 待领取。
- 200 页 / 21,109,735 bytes PDF：每页包含独立灰度图像和可见虚构标记；不是给小 PDF 追加无效填充。实际上传并校验页数后，批准该合成来源的项目校验策略。
- 并行第二项目 CSV 入站：正式 2,000 行，smoke 200 行。一个导出响应流按 1 MiB/s 读取，计算摘要并丢弃内容。该限速是消费端节奏，不声称网络链路整形。
- 正式每轮 60 min：5 min 预热、5 min 升压、40 min 稳态、10 min 回落，重复 3 轮且每轮重建数据库。HTTP 及业务延迟正式 gate 取稳态；页面 Web Vitals 保留整个真实页面生命周期。
- 冷读通过清浏览器缓存并重新加载文档测量；热读通过同一工作区重访已渲染页且确认没有新增来源载荷请求测量。稳态开始及每 5 min 执行一组，包含实际授权读取；无法证明缓存状态的普通导航单列 unknown，不冒充热读。

默认正式思考时间是**尚未经真实用户校准的合成假设**：校对 30–60 s，20% 为 120–180 s；仲裁 45–75 s；管理列表与摘要每 30 s。30 s smoke 刻意加速为 HTTP 校对 3 s、UI 校对 150 ms、管理员/仲裁 500 ms。因此本地烟雾的延迟超线不能直接推断正常人工节奏下的容量；也不能通过调慢 smoke 来宣称现有版本达标。

## 可复跑命令

需要 Go、Node、Python、前端 npm 依赖、Playwright Chromium/Chrome。独立故障套件的 OCR 用例另需 Docker 中的本地提取 worker 与 Python PyYAML。运行从仓库根目录开始，输出目录必须为空。`NODE_PATH` 可指向安装 Playwright 的本地运行时。

```sh
npm --prefix frontend ci
python3 backend/tests/test_capacity_report.py
BROWSER_CHANNEL=chrome python3 backend/tests/run_capacity_baseline.py \
  --profile smoke --duration 30 --entries 2000 --users 30 \
  --output output/capacity-smoke

# 五类故障 gate：实际运行独立本地套件，在至少 15 min 编排窗口内重复。
# 此模式不声称在 30 VU 上同时注入故障；缺少/失败任何子项不会通过。
BROWSER_CHANNEL=chrome python3 backend/tests/run_capacity_faults.py \
  --profile full --output output/capacity-faults

# 在获授权的隔离 4 核 / 约 3.7 GiB 环境执行。声明目标不会伪造 actual host。
BROWSER_CHANNEL=chrome python3 backend/tests/run_capacity_baseline.py \
  --profile full --reference-profile production_shared \
  --target-cpus 4 --target-memory-gib 3.7 \
  --fault-report output/capacity-faults/faults.json \
  --output output/capacity-full
```

`full` 拒绝缩短时长、降低样本规模或减少重复次数。退出码：0 pass、1 fail、2 incomplete、3 invalid_generator。`full_acceptance` 仅在三轮混合 gate、生产参考硬件实测、故障 gate、来源未变化等全部满足时为 true。8 GiB 对照使用 `--reference-profile 8g_comparison`，不能获得生产参考配置的 full acceptance。

## 阈值与失败语义

| 项目 | gate |
| --- | --- |
| 意外 5xx / 超时 | ≤ 0.1%，其他非预期 HTTP 响应也单独失败 |
| 常用读取 p95 | ≤ 500 ms |
| claim / submit / arbitrate | p95 ≤ 800 ms；p99 ≤ 2 s |
| 字段摘要 p95 | ≤ 1 s |
| 可读原文 p95 | 有证据热读 ≤ 1 s；冷读 ≤ 3 s |
| UI 提交确认 p95 | ≤ 800 ms |
| LCP / INP / CLS | ≤ 2.5 s / 200 ms / 0.1 |
| 生成器事件循环 p95 | 10 ms 采样，> 20 ms 为 invalid_generator |

`editor_ready` 仅报告，无擅自增加的 1 s 硬线。HTTP 失败响应不会进入“成功请求延迟”样本。每轮比对成功提交 HTTP 回执、proofread attempt 增量、submission event 增量，并检查 SQLite integrity、重复尝试、第二项目导入行数；任何不一致失败。生成器 CPU 指标是各 Node 主进程单核占用，不代表 Chrome 子进程或服务器总 CPU。服务端脱敏 runtime 事件另存于本地输出。

## 当前证据边界

本目录仅提交小型安全 JSON 摘要；完整请求时间序列留在本地忽略的 `output/`。manifest 记录 Git 基线、工作区 diff 摘要、运行器源文件 SHA-256、前端 dist 摘要、实际主机与目标参数。测试样本全是虚构数据。

- 已实际完成 30 s / 2,000 条 / 30 actor 混合 smoke，保留失败结果；无意外 5xx/超时，两个 UI 用户确实完成提交，数据库对账一致。
- 已运行报告器单测，覆盖“失败响应不能当快速成功”“unknown 不能冒充热缓存”“生成器饱和不能当容量通过”。
- **待执行**：生产参考规格隔离验收、60 min × 3、独立 15 min 五类故障完整 gate、实际人工思考/刷新节奏采样。已有其他线程的单项故障回归不被自动认定为本协议的 15 min gate。
- 独立故障覆盖：浏览器断网恢复、已接受 OCR POST 的响应丢失与幂等恢复、转换服务器重启、成员撤权、存储写失败回滚。故障报告必须和容量报告基线及运行器源文件摘要一致。


最近一次带稳态冷/热探针的 smoke（`smoke-with-source-probes/`）仍为 **fail**，来源未变化检查 pass：190 个提交回执 = 190 个 attempt 增量 = 190 个 submission event 增量；两个 UI 用户各完成 21 次提交，CSV 200/200 行，重复尝试 0，意外 5xx/超时 0。生成器 loop p95 为 11.12 / 11.08 ms。冷读 4 样本 p95 1,198 ms，证据热读 2 样本 p95 117 ms；其他 41 次导航仍列 unknown。样本量仅适合验证探针执行，不能作为正式性能证书。

| 指标 | 最近 smoke p95 | gate |
| --- | ---: | --- |
| claim | 780 ms | pass |
| submit | 1,148 ms | fail |
| arbitrate | 1,212 ms（p99 2,732 ms） | fail |
| field summary | 1,783 ms | fail |
| 管理列表 | 708 ms | fail |
| UI submit ack | 767 ms | pass |
| LCP / INP / CLS | 1,128 ms / 72 ms / 0.142 | CLS fail |

较早冻结 smoke（`smoke-before-source-probes/`）也保留：claim 867 ms、submit 1,260 ms、summary 1,989 ms、UI ack 1,074 ms、CLS 0.155。两次差异不表示产品已优化；运行器加了测量探针，负载与时序也有波动，两次均没有通过总体验收。产品 CLS 的 0.1 目标未放宽，具体布局位移来源尚待定位。
