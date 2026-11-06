# 共享状态与基础组件验证（#267 / #268）

2026-11-06，本地 Vite + Chrome，1440×1000，全部为合成账号/API 数据，无生产材料。`before-*` 取自迁移前页面；`after-*` 取自当前共享组件。图像只是界面证据，不代表真人走查。

- `node --test frontend/tests/asyncResource.test.js frontend/tests/adoption.test.js frontend/tests/adoptionHistory.test.js frontend/tests/adminProjectInsights.test.js frontend/tests/errorStateSeparation.test.js`：27/27 通过。
- `npm --prefix frontend run build`：通过。
- `NODE_PATH=<playwright module path> node frontend/tests/browser/ui-foundations.cjs`：通过。实际 Sources HTTP 请求卸载后被 abort；读取失败可重试；POST 保存失败后标题与提交按钮保留；三类空态各有可见说明；ConfirmDialog 保持 AppModal 的 Tab 圈定、Esc 与关闭后焦点返回。

`useAsyncResource` 为每次 reload 建立 AbortSignal，同时用 generation 拦截不响应取消的旧结果。失败保留最后数据；dispose 后不再发布状态。操作请求与加载错误仍分开，不清除未提交输入。

迁移页面：WorkspaceHome、Sources、GateRules、CreatorGrants、Dashboard、Adoption 复用异步资源与共享状态；Sources/GateRules/CreatorGrants/Dashboard/ProjectSettings 使用 AppDataTable；上述管理表单使用 AppField；Dashboard 与 Adoption 使用 AppPagination。API、权限判据、排序和列内容保持原服务契约。AppDataTable 的滚动区域保留名称、tabindex 与原生 table 语义。

共享组件的其余页面接入由同一集成分支的页面负责人完成。新人真人走查和真实材料验收仍需对应人员实际执行，不能由本合成浏览器验证替代。
