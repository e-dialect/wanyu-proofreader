# 全屏失败后继续阅读原文

关联 issue：[#343](https://github.com/e-dialect/wanyu-proofreader/issues/343)。基线为 `upstream/main@df807e9`，验证日期为 2026-10-25。

浏览器拒绝全屏操作时，提示现在使用独立状态，不再触发 PDF 致命错误分支卸载原文。进入、退出分别说明失败，可重试；切换来源会清理旧提示，旧来源延迟返回的失败不会污染新来源。真正的 PDF 加载／渲染错误仍保留原路径。

## 实际界面证据

以下均为已构建的真实前端、一次性 PocketBase 与合成四页 PDF。成功响应来自真实后端；仅浏览器全屏方法被定向替换为拒绝，以稳定复现环境拒绝。随后恢复原生方法，实际进入和退出全屏。未读取真实 `pb_data`，未使用真实语料。

| 场景 | 进入失败 | 退出失败 |
| --- | --- | --- |
| 桌面页图 | [截图](desktop-fullscreen-denied.png) | [截图](desktop-exit-fullscreen-denied.png) |
| 手机尺寸页图 | [截图](mobile-fullscreen-denied.png) | [截图](mobile-exit-fullscreen-denied.png) |
| 桌面 PDF 降级 | [截图](fallback-fullscreen-denied.png) | [截图](fallback-exit-fullscreen-denied.png) |
| 手机尺寸 PDF 降级 | [截图](fallback-mobile-fullscreen-denied.png) | [截图](fallback-mobile-exit-fullscreen-denied.png) |

每个模式均实际断言：原图／画布为同一个 DOM 节点且仍连接、具有可见宽度；水印保留；失败后缩放可用；拒绝退出时仍保持全屏；恢复原生 API 后重试成功、提示清除。手机为 390×844 浏览器视口模拟，不表示原生手机设备验证。

## 实际验证

环境：Windows、Go 1.27.2、Node 24.19.0、Python 3.13.7、已安装 Edge。浏览器依赖通过 `NODE_PATH` 指向现有 Playwright；设置 `BROWSER_EXECUTABLE` 为 Edge，PATH 包含 Poppler 与官方 WebP 1.6.0 的工具。`PYTHONUTF8=1`。

- `node --test frontend/tests/pdfFullscreen.test.js`：5/5。执行真实组件 setup 和 Vue 响应式，覆盖进入拒绝、API 不可用、进入／退出重试、保留致命错误、切换来源和旧请求延迟失败。
- `npm --prefix frontend test`：266/266；`npm --prefix frontend run lint`、`npm --prefix frontend run build`：通过。
- `node --check backend/tests/page_images_browser.cjs`：通过。
- `python backend/tests/run_integration.py pdf_access_integration.mjs --env REQUIRE_PAGE_IMAGES=1 --env PDF_BROWSER_FIXTURE=<忽略区临时JSON> --env PDF_BROWSER_SCRIPT=<仓库>/backend/tests/page_images_browser.cjs --env PDF_BROWSER_OUTPUT=<忽略区截图目录>`：四种浏览器模式全部完成，输出 `PASS browser`；后续鉴权、租约、原件限制断言也输出 `PASS: authenticated...`。**命令最终退出 1**：既有 harness 主动结束 Windows 进程后把退出码 1 当作服务崩溃；没有把该完整命令报告为成功。
- `cd backend; go vet ./...; go test ./...`：通过。
- `python backend/tests/check_migrations.py`：20 个迁移 up/down/up 与初始 schema 拒绝回滚通过。
- 套件清单（38 个）、运行时版本、Compose 结构、Docker 构建目录、UI debt、空白和 LF 检查通过。UI debt 无增加。
- 独立 agent 只读复查未发现阻断项。

## 环境限制

未宣称完整 `make check` 通过：本机无 GNU Make。按 Makefile 分项执行时，未改动工具仍有 Windows 兼容失败：scripts 137 项中 2 个 POSIX 路径断言失败、1 项跳过；ops 6 项中 1 个符号链接权限错误；backend/tests 49 项中 1 个 build-stamp shell 断言失败、2 个备份符号链接／rename 权限错误。以上与本次组件修改无关，未扩大范围修改工具。

没有修改后端、权限、缓存协议、迁移或部署配置；未运行全量后端集成、镜像构建、生产／staging 或真人试点。AI 用于实现、测试、浏览器操作和独立复查；Human verification: **Not manually verified**。截图与自动断言不替代真人试用。
