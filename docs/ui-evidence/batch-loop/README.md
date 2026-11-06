# PR #374 批次闭环界面证据

2026-11-06，在 `fix/batch-loop-synced-main` 的 `64affdeb8ffbfe74355b55b4a3ff633f5a161bb6` 上截图；浏览器视口 1440 × 1000。夹具按现有浏览器测试方式挂载实际 `ProjectDetailView.vue`、`DeliveriesView.vue` 和当前样式表，通过内存路由及替换 `pb.send` 提供合成 API 返回值。图片是实际 Vue 界面渲染，数据及 API 均为模拟；未连接生产服务、真实消费方或私人语料，也未提交人工回执表单。

| 图片 | 可核对的界面状态 |
| --- | --- |
| [import-ledger.png](import-ledger.png) | 正常一致；历史成功 20、当前留存 18 时显示「需核对」而非改写失败数；10 行中 8 成功、2 失败仍可数量对账；终态失败不显示成功；已关联来源与 `source:unknown` 分开提示；错误包含作业、错误码、字段、数量与首行 |
| [receipt-states.png](receipt-states.png) | 尚未回执、人工全部成功、人工部分冲突、人工整体失败并回滚分别显示；部分冲突保留上游待办，展开凭据显示人工渠道、影响条数、责任人与合成凭据 |
| [manual-receipt-form.png](manual-receipt-form.png) | 选择第 4 版登记人工回执，明确自动回传尚未接入、回执绑定当前包和版本，失败不会变成尚未回执；表单仅填写合成值，未保存 |

台账合成输入分别为 100／20／10／5 行，总入册 126 行、未知来源 8 行。标签与说明按当前 `importCountBalance`、`importSourceHint` 返回形状构造；截图只能证明当前前端正确呈现这些返回值，不能替代后端对账、权限、真实 C→D→E 同批验收或消费方导入验证。对应后端逻辑另由现有单测及集成测试覆盖，本次没有改生产代码或测试矩阵。

临时 HTML 夹具留在本地 `output/playwright/batch-loop/`，不随 PR 提交。
