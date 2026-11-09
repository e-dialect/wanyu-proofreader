# #419 CSV 预览：独立 PR 的最终组合验证

基于最新 main `2c8e90b`（已包含 #421、#422、#424），只处理 CSV 预检的完整保存与明确拒绝。
`make check` 实际运行在 `00d02dd`：44 个迁移 up/down/up、Go、590 项前端、166 项后端 Python（1 项可选 Chrome 跳过）、脚本/Compose 门禁全部通过。
#424 squash 合入后机械 rebase 至 `0d184fd`；两补丁 range-diff 全等价，整棵 Git tree 逐字一致，没有把旧 head 的远端 CI 当作新 head 通过。

最新分支另跑三个顶层 Go race 回归，均通过：

```sh
GOMAXPROCS=2 go test -C backend -race . -run '^TestCSVInspection' -count=1
GOMAXPROCS=2 go test -C backend -race . -run '^TestProcessCSVInspectionCompleteOrExplicitlyTooLarge$' -count=1
```

五个真实 HTTP suite 在含本 CSV 修改的组合源码 `92c00ef` 上通过（assist_rules、difficulty、identity、cross_source、upload_jobs）；其中 upload_jobs 包含完整预检与超限作业回归。更早专项 HTTP/race 和体验证据保留在 [maturity-experience-followup-main](../maturity-experience-followup-main-20261109/README.md)，该历史证据包含已合入 #421 的独立 UI 修改，不冒称本 PR 的新增内容。

范围：前 20 条有效记录、整份序列化 UTF-8 报告最大 512 KiB。包含编码、列名、预览、位置等全部字段；保留原始字符且不截短单元格。超限为 `CSV_PREVIEW_TOO_LARGE`，保留上传原件且不生成半份页面。新迁移扩大 inspection_json 上限；存在超过旧默认 5000 字符的预检时拒绝 down，不能删除历史预检来强行回退。

本报告提交只增加证据。源码/日志摘要见 validation.json。缺少正式容量环境、真人/真机、真实材料等仍属原待办；无生产部署。R2（导入与迁移）。Human verification: **Not manually verified**。
