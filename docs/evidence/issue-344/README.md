# 导出反馈只对应当前请求

关联 [#344](https://github.com/e-dialect/wanyu-proofreader/issues/344)。基线 `upstream/main@df807e9`，2026-10-25 验证，Windows、Node 24.19.0、Python 3.13.7、Go 1.27.2、Edge。

来源核验工作区的 CSV／过程 JSON 导出原先只清除旧错误，保留旧成功信息。本次仅在开始导出时同步清除成功信息，与同组件保存操作一致。当前请求失败不显示旧成功、不发起文件保存，重试成功才显示新结果。API、格式、权限与持久化记录没有变化。

## 浏览器实物

已构建的真实前端连接一次性真实 PocketBase，全部资料与账号由 `source_fidelity_integration.mjs` 生成。第一轮和重试的响应均来自后端；只中断指定的一次导出请求来模拟网络故障。截图不是产品成功响应的 mock。

| 场景 | 成功 | 下一请求等待 | 下一请求失败 | 重试成功 |
| --- | --- | --- | --- | --- |
| 桌面 CSV | [截图](export-csv-desktop-01-success.png) | [截图](export-csv-desktop-02-pending.png) | [截图](export-csv-desktop-03-failed.png) | [截图](export-csv-desktop-04-retried.png) |
| 手机尺寸过程 JSON | [截图](export-json-mobile-01-success.png) | [截图](export-json-mobile-02-pending.png) | [截图](export-json-mobile-03-failed.png) | [截图](export-json-mobile-04-retried.png) |

断言覆盖：等待时旧成功和旧错误都消失、按钮禁用；失败后只有当前错误、按钮恢复且下载次数不增加；重试实际保存文件并核对 CSV 元数据列／JSON 版本、四条原始合成记录及无重复 CSV 正文。手机为 390×844 浏览器视口模拟，未作真实手机设备测试。

## 实际验证

- `node --test frontend/tests/sourceFidelityExport.test.js`：6/6，执行组件实际回调与既有错误格式化函数。覆盖两种导出的成功→等待→失败→重试、先前其他操作成功、本地文件下载抛错。
- 负控制：临时移除清理旧成功消息的语句，六条回归全部失败（0/6）；完整恢复文件后 6/6 通过。旧构建也通过独立浏览器脚本确认 CSV／JSON 均存在旧成功残留。
- `npm --prefix frontend test`：267/267；`npm --prefix frontend run lint`、`npm --prefix frontend run build`：通过。
- `node --check backend/tests/source_fidelity_browser.cjs`、`node --check backend/tests/source_fidelity_export_browser.cjs`：通过。新检查接入既有 source-fidelity 浏览器入口，因此现有 CI 会实际运行。
- `python backend/tests/run_integration.py source_fidelity_integration.mjs --env FANGJI_RESEARCH_MODE=1 --env FIDELITY_BROWSER_FIXTURE=<忽略区临时JSON> --env FIDELITY_BROWSER_SCRIPT=<仓库>/backend/tests/source_fidelity_browser.cjs --env FIDELITY_BROWSER_OUTPUT=<忽略区截图目录>`：新导出检查、原桌面／手机来源核验流程、研究展示与导出及后端断言均输出 PASS。**命令最终仍退出 1**，原因是既有 Windows harness 主动终止服务后把返回码 1 当作崩溃，未把完整命令报告为通过。
- 上述浏览器运行设置 `PYTHONUTF8=1`、现有 Playwright 的 `NODE_PATH`、`BROWSER_CHANNEL=msedge`，PATH 包含 Go、Poppler 与 WebP 工具。最初漏加页图转换工具时，原浏览器流程因 404 控制台错误失败；补齐与 CI 相同的工具后，全部浏览器断言通过。
- UI debt、空白与 LF 检查通过；独立 agent 只读复查未发现阻断项。

本轮共同基线的 Go 单测／vet、20 个迁移 up/down/up、38 套件清单、版本、Compose 结构与 Docker 构建目录检查已通过；本分支不改后端实现、迁移或配置，未为单行前端修复重复运行这些检查。

## 限制与边界

本机无 GNU Make，未直接通过 `make check`。共同基线工具自测有既有 Windows 限制：scripts 137 项中 2 个 POSIX 路径断言失败、1 项跳过；ops 6 项中 1 个符号链接权限错误；backend/tests 49 项中 1 个 build-stamp shell 失败、2 个备份符号链接／rename 权限错误。未改这些工具，也未把整套检查报告为全绿。

未修改 PR #333、导出字段、权限或数据迁移；不宣称 #184／#316 全链路验收完成。未运行全量集成、镜像、生产／staging 或真实语料试点。AI 用于实现、测试、浏览器操作和独立复查；Human verification: **Not manually verified**。合成结果与自动浏览器证据不替代人工语言核验。
