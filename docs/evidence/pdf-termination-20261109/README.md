# PDF 加载期间退出的生命周期修复

关联 #415；未发布、未部署，不代表重组后的 PR/CI 已通过。

## 复现与实现边界

- 实测工作树：`/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity-pdf-termination`，分支 `fix/maturity-pdf-termination-ci`，基础提交 `0991fab18b8e80c27744a707fa1614dbd34528ab`。
- 原错误来自 [PR #410 Backend Unicode workflow](https://github.com/e-dialect/wanyu-proofreader/actions/runs/42545907858/job/128930769504)：`draft-logout.cjs` 第二场景出现 `Worker was terminated`，栈为 `ensureNotTerminated → onFailure`。原有异步 destroy 后的代次检查已经存在，不是本次修复。
- 新脚本挂载真实 App、编辑器和原装 PDF.js worker；仅把第一次本地 blob 读取交给受控请求屏障。退出、路由切换、账号替换时，旧实现均在 worker 的 `ReaderHeadersReady` 等待期间取消 URL 读取，真实复现相同栈：3/3 失败。没有替换 worker 或改写其消息处理。
- PDF.js 3.11 的终止路径取消了来源流；迟到的失败回调再次检查终止状态并抛异常。现在由 Viewer 先可取消地读取已有 blob，检查代次，再通过公开 `getDocument({data})` 传入原字节，避免该 URL 传输窗口。真实读取/解析错误仍呈现，不过滤任何 `pageerror`。
- 所有当前入口均为 `ProofreadEditorView` / `ArbitrationView` → `DocumentReviewWorkspace` → `useProjectPdf`。PDF 来源由受保护接口带认证取得 Blob，经账户隔离缓存产生 URL；图片分支保持原状。新读取不访问额外外部接口，也不修改 PDF 字节。账号替换清理缓存并撤销 URL，Viewer 同时取消并拒绝迟到结果。完整读取会短暂产生 ArrayBuffer，再转移给 worker；这里没有新的容量实测或容量承诺。

## 实际结果

| 检查 | 原实现 | 修后 |
| --- | --- | --- |
| 挂起读取后退出 / 离开 / 换账号 | 3/3 出现同一 worker 异常 | 3/3 通过，读取被取消且未创建旧 worker |
| 普通阅读与缩放、503 读取失败、坏 PDF | 3/3 通过 | 3/3 通过，真实错误继续显示 |
| 原有草稿退出场景 | 本地 7/7 通过，说明原测试受时序影响 | 7/7 通过 |
| 前端单测、lint、生产构建 | 未重复全测 | 590/590；lint、build 通过 |

原实现报告为 [before.json](before.json)，修后为 [after.json](after.json)，原草稿测试为 [draft-logout-after.json](draft-logout-after.json)。报告中的 Viewer SHA-256 标识实际被测源码：原 `d66c85ba7216accd79e1486797cd1545e433ac53c384d49b3e8e835a73492556`；修后 `b7efd67e76ef65f3d8b7b4d0cd349123db9bafcc745d450386255faf7ab31a21`。worker 原样保留，SHA-256 为 `feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b`。

本地实际环境：macOS、Chrome `155.0.8059.40`、Playwright `1.65.0`、沿用的依赖 Vue `3.5.44` / Vite `8.3.5`。基础提交 lock 为 Vue `3.5.45` / Vite `8.3.6`，CI Playwright 为 `1.62.1`；因此本地结果不冒充 CI 同安装结果。后续由整合树按 lock 安装并执行完整回归。

所有账号、PDF、正文均为合成 fixture。截图保留于本工作树 `output/playwright/pdf-lifecycle-before/`、`pdf-lifecycle-final/` 和 `draft-logout-after/`，不含真实业务材料。

## 复跑与首引层

在已安装前端依赖和 Playwright 的仓库根目录，现有统一 runner 会启动隔离服务并执行本组；新脚本已登记到 `repository` 组，没有平行 suite：

```sh
python3 backend/tests/run_frontend_quality_browser.py --only repository
```

仅使用已运行的合成 fixture Vite 服务，可设置 `REVIEW_BASE_URL` 后分别执行：

```sh
node frontend/tests/browser/pdf-lifecycle.cjs
node frontend/tests/browser/draft-logout.cjs
node --test frontend/tests/pdfLifecycle.test.js frontend/tests/pdfFullscreen.test.js
```

`PDF_LIFECYCLE_OUTPUT` / `DRAFT_LOGOUT_OUTPUT` 可指定受控输出目录；本机还设置了 `NODE_PATH=/private/tmp/wanyu-playwright-runtime/node_modules` 与 `BROWSER_CHANNEL=chrome`。如要复现旧实现，只替换测试隔离树内 Viewer 为 `0991fab` 版本，保留新脚本；应看到前 3 项失败而后 3 项通过，不能将该负向测试反转为通过。

建议第 5 层（草稿退出功能）首引。已核实 `27bcb90` 的 Viewer 与原生命周期单测和 `0991fab` 完全同 blob。新生产代码与单测可直接移植；runner、DESIGN、README 按窄补丁加入，避免把后续层的其他功能提前引入。重组后的最终 SHA 尚需实际验证。
