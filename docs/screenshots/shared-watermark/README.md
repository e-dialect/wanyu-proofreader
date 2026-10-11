# 共享水印验收证据

2026-10-11，Windows + Chromium，生产前端构建、真实临时后端和四页合成 PDF。仅含一次性测试身份，不含真实语料或凭据。

| 截图 | 场景 |
| --- | --- |
| [desktop.png](desktop.png) | 1440 × 900，WebP 页图，重复 UID / 项目 ID / UTC 时间；红框为已有坐标测试标记 |
| [mobile.png](mobile.png) | 390 × 844，WebP 页图，移动端原文水印 |
| [fallback.png](fallback.png) | 1440 × 900，PDF.js 降级，公共来源水印 + 同一身份覆盖层 |
| [fallback-mobile.png](fallback-mobile.png) | 390 × 844，移动端 PDF.js 降级 |

同页任务复用浏览器回归也通过：连续三条只下载一次，保留同一 canvas、缩放、滚动与局部页码；跨页重新下载，租约失效清理。

自动断言覆盖两种路径的 UID、项目、UTC 时间、重复覆盖、不拦截点击、缩放/旋转时尺寸跟随、时间保持、进入/退出全屏。页图相邻页导航会更新访问时间；只缩放/旋转时不会更新。

[请求和首屏记录](network-and-timing.json)：页图桌面 331ms、移动 229ms；PDF 降级桌面 433ms、移动 423ms。
这些是本机合成 PDF 的单次样本，包含 UI 启动，不代表真实词典或生产网络速度。

[跨用户缓存与访问审计](cross-user-cache.json)：两个用户、三次授权下载，同一个 asset_id；一次 `pages-hit` 生成和两次 `watermark-hit`，缓存目录对应成品只有一份（2250 字节）。API 测试另断言不同用户 key 与 PDF 字节相同。日志摘录只保留结构化预览事件，未收录 HTTP 请求或 token。

Go 回归还验证跨五分钟授权窗口 key 不变、成品复用（删除源文件后仍可命中）、原件替换失效、页范围隔离、24 小时闲置清理。匿名、其他校对员、失效/释放租约对 PDF 与 descriptor 的拒绝断言保持。

复现浏览器证据：

```sh
npm --prefix frontend ci
npm --prefix frontend run build
REQUIRE_PAGE_IMAGES=1 \
PDF_BROWSER_SCRIPT="$PWD/backend/tests/page_images_browser.cjs" \
PDF_BROWSER_FIXTURE=/tmp/shared-watermark-fixture.json \
PDF_BROWSER_OUTPUT=/tmp/shared-watermark \
python3 backend/tests/run_integration.py pdf_access_integration.mjs
python3 backend/tests/run_integration.py pdf_reuse_integration.mjs
```

需要可用的 Poppler、cwebp 和 Playwright Chromium，Playwright 可通过 `NODE_PATH` 定位。
fixture 含短期测试凭据，不能提交；本目录只保存合成截图和不含凭据的结果。

本机限制：集成与浏览器业务断言全部通过后，现有 harness 的 Windows `TerminateProcess` 返回 1（Linux 预期 SIGTERM），因此标准 runner 在收尾报告错误；并行测试还遇到渲染子进程未退出导致临时文件占用。已独立核对业务 PASS、跨用户日志和缓存目录。`make check` 的等价检查中，既有 Python 测试还依赖 POSIX 路径、`/bin/sh`、符号链接权限及可重命名的 SQLite 文件；这些 Windows 限制未在本 PR 修改。
