# 集中提交屏障（2026-11-09）

独立分支基于 `efbb4ac`，先合入 remote orchestration `d2e3fe3`（本树为 `9385c44`）。只改容量工具；不修改产品业务 POST、权限、租约或性能阈值。

## 配置与计数

本地和远程 runner 均调用 `capacity_burst.make_submit_burst(config, enabled)`。远程先把目标 start epoch 转换为生成器本机时间，再构造同一个配置；目标协议无需增加字段。

```json
{
  "id": "steady-submit-1",
  "at_epoch_ms": "generator-local epoch",
  "prepare_window_ms": 240000,
  "max_start_skew_ms": 250,
  "participants": [{"vu": 0, "transport": "browser"}]
}
```

- `full` 无论 flag 均必须构造一次屏障，固定 24 名校对者（22 HTTP + 2 真实浏览器），位于 start + 15 min；准备窗为 11–15 min，完全在 40 min steady 内。准备后最多等待 240 s，小于 10 min 租约；各账号仍拥有自己的任务、租约、原文和编辑内容。服务器继续验证实际租约，提交失败不能通过。
- 60 min × 3、5/5/40/10 阶段和原有产品阈值不变。250 ms 是这一次集中分派的**生成器定义**，不是放宽或改写 API 响应时间。
- 默认 smoke 不启用屏障。显式 `--submit-burst` 才启用，epoch 为 steady 中点，准备窗从 steady 开始到 epoch（上限 240 s）。人数按此 smoke 的真实校对参与者计算；30 actors 对应 24 人。
- 两驱动复用纯 JS helper。每人只在窗口内第一次准备完的独立任务等待同一 epoch，一次性领取 burst 标记；迟到、旧任务未完成或退出前未参与均记录 missed，不重发 POST 凑人数。
- `requests.jsonl` 的 `burst_id`、`started_at_ms` 只在受控日志中。HTTP 在 fetch 前记录，浏览器从真实 request 的最终网络 timing 取 startTime。业务 body 不附带这些字段；行内容仍只保存 SHA-256。
- 报告要求每个指定 actor 恰一次 prepared、恰一个成功 burst submit，实际开始均位于 epoch 至 epoch+250 ms；错角色／错 ID／缺证／重复／迟到均 fail。完整记录参与门禁，不按 steady 过滤掉漏参与证据。全量 SLO 仍使用原有 steady 口径；event-loop p95>20 ms 仍为 invalid_generator。
- smoke-only `--burst-miss-vu N` 必须选择本次校对者，且需要 `--submit-burst`；full 拒绝。manifest 标注 test fault 与 expected_fail，真实退出码仍是 fail，不反转为产品 pass。

## 实测与限制

在协调好的计时空窗，以一次性库和真实前端执行两次 **500 条 / 10 actors / 45 s** 加速 smoke；其中 4 名校对者为 2 HTTP + 2 Chrome，其余 6 名为管理／仲裁角色。

- 正向：整体 smoke `pass`、退出 0；4 prepared、4 个成功 POST，开始跨度 **22.673 ms**，无重复补发；数据库逐条内容与事件对账通过。
- 负向：VU0 确实错过屏障，4 prepared 但仅 3 个 burst POST，错误为 `participant_missed` 与该 VU 的 `submission_count=0`；整体 `fail`、退出 1。数据库对账通过，不把普通后续提交计入 burst。
- 两轮 generator event-loop p95 约 12.06 ms；源冻结通过；`full_acceptance=false`。结果摘要及原始配置、真实开始时间、摘要对账见 `results.json`。未执行 24 名校对者的正式三轮集中负载，也未证明生产参考硬件、分机网络或正式故障验收。

首个探索 probe 保留在本地 `output/maturity/burst-positive`，结果为 fail：Playwright 的 request 回调时 startTime 尚为 0，门禁没有把缺证当作通过。现改在 requestfinished 读取真实 timing；同时修正 local 摘要覆盖 burst 结果的问题。200 条夹具后段耗尽也产生 next-URL timeout，正式小探针使用 500 条后不再发生；没有吞掉错误或放宽阈值。

## 图片来源请求计数补充

本轮源码复核发现旧 regex 只认 `/pages/{id}/pdf/images/...`，实际图片为 `/pages/{id}/images/{n}/asset`。现在纯函数按 `new URL(...).pathname` 同时匹配真实 PDF 和图片 payload，排除 descriptor、伪路径与 query 字符串。纯测试覆盖当前路径、URL 对象和 query。

上述两轮实际 burst 证据使用 canvas PDF 分支，发生在这个图片计数修正之前；不追改历史结果，也不声称已经实际验收图片缓存。最终补丁的路径分类由纯测试验证，后续同版本真实图片场景仍须观察 payload 请求和 hot/cold 分组。

## 复现

最终轻量容量测试共 38 项通过（包括屏障正反例、远程契约和来源路径分类）；未为整理提交再次运行重负载。

```sh
python3 -m unittest discover -s backend/tests -p 'test_capacity*.py'
NODE_PATH=/path/to/playwright/node_modules BROWSER_CHANNEL=chrome GOMAXPROCS=2 GOMEMLIMIT=768MiB \
  python3 backend/tests/run_capacity_baseline.py --profile smoke --users 10 --entries 500 \
  --duration 45 --repeats 1 --submit-burst --output output/burst-positive
# 预期真实 fail 退出码 1；不能把它当产品 pass：
NODE_PATH=/path/to/playwright/node_modules BROWSER_CHANNEL=chrome GOMAXPROCS=2 GOMEMLIMIT=768MiB \
  python3 backend/tests/run_capacity_baseline.py --profile smoke --users 10 --entries 500 \
  --duration 45 --repeats 1 --submit-burst --burst-miss-vu 0 --output output/burst-negative
```

`run_capacity_remote.py` 提供相同两个参数；正式 full 自动开启屏障。远程编排仍需明确的隔离目标、版本、硬件与预算证据，不能用 localhost 或这两个小 smoke 替代。
