# 连续仲裁队列

关联 #186。仲裁台按条号、ID 排序显示当前待仲裁位置及上一条／下一条。差异仍需逐字段确认，提交仍走原有仲裁端点；成功后刷新队列并进入后面的待仲裁条目。若后面已无条目但前面仍有未处理项，继续到最早的剩余项；全部处理完时显示完成状态。

队列加载中、加载失败、当前条目已离开队列和空队列各有独立提示。提交失败保留输入；提交已成功但后续队列读取失败时，只重试读取队列，不重复提交。切换条目重新加载材料并清空上一条的选择、说明及来源判断；旧保存或队列响应迟到时不会覆盖新条目或触发跨条跳转；未保存的修改仍有离开确认。来源核验模式沿用原返回路径。

## 接口和兼容性

`GET /api/fangji/projects/{projectId}/arbitration-queue` 沿用项目所有者、管理者、平台管理员的管理权限。普通校对员及项目外用户被拒绝。只返回条目标识和条号，不返回校对内容。

- `page` 从 1 开始，`perPage` 默认 25、最多 100；响应的 `items` 只包含这一页。
- 可选 `anchor` 指定当前条目。未给 `page` 时，服务端定位其所在页；`position` 是当前待仲裁队列中的位置，条目已处理时为 0。
- `previous`／`next` 使用同一稳定排序，独立于分页边界。锚点必须属于该项目。
- 数量、位置和分页窗口在同一数据库事务中读取。使用已经发布的 `idx_pages_project_status_order` 索引，无新增迁移。
- 不改仲裁提交、独立校对、来源核验及逐字段确认规则；不批量裁决或自动采纳内容。

## 自动验证（2026-11-06）

实际通过：

```sh
make check
npm --prefix frontend run build
cd backend && go test -run TestArbitrationQueue -v .
python3 backend/tests/run_integration.py arbitration_queue_integration.mjs
```

完整 `make check` 通过，覆盖 Go 全包、前端单测、ESLint、迁移往返、守卫及六种 Compose 配置检查；最终前端单测为 325 项，另行复跑全部前端单测、ESLint 和构建通过。保留既有非阻断 `bare_tables` 债务警告。

`TestArbitrationQueuePaginationAndIsolation` 在一次性 PocketBase/SQLite 库创建 1,001 条合成待仲裁记录：逐页遍历无重复、无遗漏，验证首末、单条、空队列、分页大小上限、已处理锚点、跨项目锚点、管理成员／所有者及校对员／外部账号权限，并断言查询计划使用既有索引。11 次 HTTP 分页合计 **10.48 ms**（本机 `httptest`，不含网络、建库和造数）；这是本地功能规模实测，不是生产延迟或性能 SLA。

完整迁移集成套件使用两个合成账号真实提交不一致结果，再逐条仲裁两条记录；验证队列及时收缩、原两份独立结果及一份仲裁记录保留、处理完无待办，校对员不能读取队列。已登记 CI 套件清单。

浏览器复现：启动 Vite 后执行已有浏览器测试风格的脚本（运行环境需可用 Playwright 和 Chrome）：

```sh
VITE_DEV_SERVER_PORT=52729 npm --prefix frontend run dev -- --host 127.0.0.1
REVIEW_BASE_URL=http://127.0.0.1:52729 node frontend/tests/browser/arbitration-queue.cjs
```

真实 Chrome 的 1440×900 和 390×900 视口均通过：未确认差异不能前进、提交失败保留输入、保存后队列失败可重试、自动下一条及清空旧说明／差异选择、最后一条完成状态。该脚本使用合成响应，不连接生产；后端行为由上述真实服务集成验证。夹具未提供 PDF，截图中的原文提示如实保留，不能用它宣称 PDF 预览验证或真机验证。

截图：

- [桌面队列](../screenshots/arbitration-queue/1440-queue.png)
- [保存成功后队列失败及重试入口](../screenshots/arbitration-queue/1440-queue-error.png)
- [390px 队列](../screenshots/arbitration-queue/390-queue.png)
- [390px 最后一条完成](../screenshots/arbitration-queue/390-done.png)

未部署生产，未使用真实语言材料或真人校对验收。
