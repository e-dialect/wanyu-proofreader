# PR #390 CI 跟进

核对日期：2026-11-08。核对基线为 PR 当前 head `e47fb0238621eeefbeed81171236de6407f45961`。本地先快进到该 head，保留已经合入的 main/`9295a34`（PR #388 OCR关停恢复），没有重写他人的同步提交。

## 原失败与修复

原 [CI run 42452119363](https://github.com/e-dialect/wanyu-proofreader/actions/runs/42452119363) 共55项：52成功、两个独立浏览器检查失败，以及由它们导致失败的总门禁。

| 检查 | 可核对根因 | 修复 |
| --- | --- | --- |
| [Source verification progress and excluded-task browser regression](https://github.com/e-dialect/wanyu-proofreader/actions/runs/42452119363/job/128643375288) | 全局完成文本同时命中可见任务状态和折叠结果说明，Playwright严格匹配报两个元素 | 在当前 `role=status` 且 `data-task-feedback=submitted` 的状态行内查找空队列结果；保留严格匹配，不使用 `.first()` 或删断言 |
| [Backend Unicode workflow](https://github.com/e-dialect/wanyu-proofreader/actions/runs/42452119363/job/128643375344) | 旧脚本仍查找已移除的 `.draft-indicator`，等待30秒超时 | 核对新的本机草稿状态、恢复提示，以及 localStorage 中账号、条目和完整Unicode字段；原校对、仲裁和导出断言保留 |

本次没有产品源码、API、权限、状态机、依赖或迁移变更，仅修复两处测试与这份记录。既有截图仍对应同一产品界面，无需重新截图。

## 实际验证

- 来源核验使用与CI相同的 `FIDELITY_BROWSER_SCRIPT/FIDELITY_BROWSER_FIXTURE` 入口及 `FANGJI_RESEARCH_MODE=1`，真实隔离后端、生产构建。本机先复现同一strict匹配失败，再修复；完整来源核验、草稿/退出恢复、两份都错、研究条件、事件与导出检查通过，无SKIP。
- `run_frontend_quality_browser.py --only unicode` 通过，包含真实导入、独立校对、仲裁、原值/组合符、CSV/JSONL与浏览器草稿刷新恢复。
- `run_rare_characters_integration.py` 通过，实际停服/重启后再次核对来源、采用结果、4000码位仲裁说明及服务端CSV/JSONL。
- `make check`、定向ESLint/Prettier及Git空白检查通过。
- 独立代理复核生产UI差异，未发现新的可复现P1/P2；完整报告、身份隔离、真实状态、总览门槛、稳定DOM与无延迟卸载经静态检查及10项定向测试核对。此复核不冒充外部审核或真人验收。

本机浏览器使用现有Microsoft Edge/Playwright 1.65.0；CI使用仓库声明的Chromium/Playwright运行时。测试材料均为合成、隔离数据。本机通过不代替修复提交的远端CI结果。

## 审核意见状态

核对时GitHub行级讨论为空，没有具体可执行的外部finding。Copilot的COMMENT报告额度不足、未完成审核；Codex的摘要报告在旧 `dff0ce7` 上审核失败，未产生具体行级意见。不能将这些通知解释为代码已经通过审核，也不因此绕过维护者或人工验收要求。本次未发布自我批准、未代替他人解决讨论或更改审核结论。

没有部署、合并PR或修改生产数据。实现、自动化验证和独立复核由OpenAI Codex完成。
