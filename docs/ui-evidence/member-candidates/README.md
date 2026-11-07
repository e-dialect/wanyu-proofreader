# 成员候选游标与失败恢复（#131）

2026-11-06，本地 Chrome 实际挂载当前 `ProjectSettingsView.vue`；只用 `frontend/tests/fixtures/member-candidates.html` 的虚构项目、人员与模拟 API，无生产或私人资料。

- `failed-next-page.png`：下一批返回模拟 503；保留已经加载的候选与用户选择，显示重试入口。
- `loaded-last-page.png`：按同一游标重试成功，追加末批并移除加载更多入口。

`frontend/tests/browser/member-candidates.cjs` 同时断言 limit=50 的实际服务请求、精确查找后 PUT 携带原标识，以及切项目时迟到旧游标响应不追加到新项目。后端权限、稳定分页与持久限速另由真实临时后端 `project_access_integration.mjs` 验证；这些截图不代表生产数据验收。
