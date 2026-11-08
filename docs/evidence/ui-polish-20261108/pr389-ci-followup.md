# PR #389 最新评审与 CI 跟进（2026-11-08）

本次复查起点为 `07222e1c38f2c45207cd432de680998439301fcc`，不是上一轮已通过全部检查的 `0a261dd`。原三项来源工作区问题的修复仍完整保留。后续 Reka UI 改动新增的 [P2 评审](https://github.com/e-dialect/wanyu-proofreader/pull/389#discussion_r4502992779) 与 [CI 失败](https://github.com/e-dialect/wanyu-proofreader/actions/runs/42392650467) 涉及三处旧测试消费者。

本次仅同步测试交互：

- OCR：打开条目的“更多操作”，选择“修正导入值”。
- PDF 离页恢复：按链接的可访问名称“所有项目”返回。
- 分页：按搜索框的可访问名称“搜索条目”输入查询。

未改变生产组件、业务断言或超时。以下本地验证均使用临时数据库和虚构账号、材料：

- `npm --prefix frontend test`：470 项通过；ESLint、生产构建、diff-check 通过。
- `python3 backend/tests/run_frontend_quality_browser.py --only pagination`：10000 条目分页与搜索、14 项目任务大厅分页完整通过。
- `python3 backend/tests/run_integration.py pdf_chunks_integration.mjs`（启用 `PDF_UPLOAD_BROWSER_SCRIPT` 与临时 fixture）：分片重试、完成响应丢失、SPA 离页确认、保留首分片、仅续传缺失分片及最终单份文件断言完整通过。
- `python3 backend/tests/run_ocr_browser.py`：以当前源码重建的隔离 OCR worker 和生产前端完成原完整旅程，包含 Unicode 修正、原始 cells 保留、下载、重试、刷新恢复和手机布局。

浏览器使用 Playwright 与本机 Edge，`NODE_PATH` 指向已安装的测试依赖。没有把测试定位失败表述为产品上传或 OCR 故障。远端最终结论以本次修复后的精确 head 的全部检查为准。
