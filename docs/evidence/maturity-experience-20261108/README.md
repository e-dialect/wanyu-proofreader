# 作业反馈、导入预检与角色帮助

基线：`6a306ea`。保留现有 Vue、Reka、万语校坊配色、字体与公共控件。

## 已实现契约

- CSV、PDF 校验、文字层提取、资料包与转换共同使用纯 JavaScript 作业观察器及 Vue 封装。按会话代次、用户、项目、作业类别和作业 ID 隔离。最后一个订阅者卸载即释放请求与定时器。
- 活跃前台每 2 秒读取；页面或面板隐藏时每 15 秒；离线暂停；失败按 2/4/8/15 秒退避。每次 GET 最多等待 10 秒，即使 transport 不响应取消，也会退出读取态、保留快照并进入退避；不会把作业标记为失败。恢复可见或联网立即读取。401/403 清除快照并停止，404 明确不可用；暂时失败保留已有快照与上次成功时间。按钮只重读原作业，不重发写请求。
- 同账号正常 token 更新保留观察；退出或切换账号后，保留的组件不能拿旧的 POST 响应重新填充新会话。请求代次和 AbortController 共同阻止迟到结果。
- 转换新增受项目管理权限保护的 GET `/api/fangji/projects/{projectId}/conversions/{jobId}`，不再用最新一条作业代替指定作业。转换的 `total_count` 仅显示已处理数，不生成百分比。
- CSV 预检保留前 20 条有效记录的原值，所有动态字段可横向查看。`preview_locations` 与原始字段分开，含 CSV 原始物理行号、PDF 物理页；`preview_limit=20`、`preview_kind=first_valid_rows`。旧记录仍可读，并明确旧记录未保存位置。第一版只读，修正原 CSV 后重新检查；validated 明确等待确认。
- 导入与转换按钮复用 AppButton；语义 progress 替代动态 inline style，UI 债务阈值从 7 降到 6。
- 项目入口与帮助明确“文字层提取”，扫描页不生成条目。角色帮助覆盖校对者、项目管理员、平台管理员；提供 3 条虚构练习 CSV。练习需要人工新建独立项目，不自动创建业务记录。CSV 练习不被描述为原生 Review Bundle 回传交付。

## 验证

- 前端 Node：503/503；其中纯作业观察器与真实 Vue 会话封装 10 项，覆盖共享、15 秒隐藏周期、退避、离线、权限、迟到响应、validated 与换账号。
- 前端 lint、Vite 生产构建、UI 债务检查、48 个后端集成套件 inventory 均通过。
- 后端 `upload_jobs_integration.mjs`：实际 20 行预检、独立位置 metadata、确认导入及原有上传回归通过。
- 后端 scheme conversion runner：精确读取、未登录/缺失/跨项目隔离、CSV 恢复排序、转换断点续跑及规则升级保护通过。
- 真实浏览器：Reka、disclosure、新 observer 夹具、auth navigation、discovery、完整 App workbench、entry list、Review Bundle/CSV 原来源重放与状态读取失败恢复、205 条 import errors、tone batch、scheme conversion 全部通过。
- 新截图来自挂载生产 Vue 组件的合成 API 夹具；浏览器真实执行共享 GET、离线/隐藏/会话事件与预检操作。390px 和 1440px 没有整页横向溢出；CSV 动态列在表格区域内横向滚动。截图已逐张检查。完整 App 与资料包流程另使用隔离的真实后端。

所有数据、账号与文件均为虚构测试材料；以上不是实际使用者的双人操作、真实设备、来源内容正确性或生产容量验收。未部署、未访问生产数据。
