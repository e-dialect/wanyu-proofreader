# 工作台体验重构验收

本轮基线 main `80cd5bf`，分支 `feat/workbench-experience`。全部浏览器资料、账号和PDF均为自动生成的虚构样例。未连接生产数据库，未部署。

## 已执行检查

- 前端构建、ESLint和UI债务门禁。
- 前端完整Node回归及本轮新增导航、队列恢复、作业偏好和异步隔离测试。
- 编辑器桌面/手机精确字符与光标、PDF受限页码、弹窗焦点、提交503重试、本人回看零写入。
- 完整应用真实API：首页一次点击开始/继续、原队列query/hash、加入项目、管理者硬刷新、手机导航及账号替换。
- 项目分区、空项目落点、失败不当零、设置分区草稿与离页确认、问题事项详情及失败重试。
- 独立临时后端交付包与回执：数量对账、人工确认、实际ZIP、来源许可与角色边界。
- 独立临时后端归一：真实规则目录、13条队列、翻页与单条复核；409和来源变化旧稿保护。

自动化结果及限制见下文和最终 `summary.json`。本报告区分自动化通过、视觉对照以及尚未执行的真人/原生设备验收。

## 最终本地回归结果

| 检查 | 结果 |
| --- | --- |
| `make check` | 通过；470项前端测试、Go全包、ESLint、格式、31项迁移up/down/up、仓库及Compose守卫 |
| 生产前端构建 | 通过；全部静态托管专项使用同一份冻结后的构建，统一组件runner使用Vite |
| 统一浏览器runner | 全部10组通过，包含真实App、权限、PDF、字符、草稿、失败重试、Unicode、资料包和CSV |
| 页面回流 | 85组路由/宽度组合，0整页溢出、0页面异常 |
| 上传与预览专项 | PDF分片重试、丢失完成响应、SPA离页续传、受限页图、PDF回退、复用、租约撤销均通过 |
| 人工处理与管理专项 | 来源复核及过程导出、问题事项、质量状态、机器疑点、编选、交付回执、归一及正式工作文件导出均通过 |
| 实际OCR镜像 | 当前源码构建的本地worker完成提取、校正、原始JSON下载、刷新恢复及手机布局 |
| CI证据门禁 | 新增截图/JSON存在性检查实际执行通过；本分支尚未推送，不代表远程CI运行完成 |

13项命令结果、日志摘要哈希、环境和产物校验见 [summary.json](summary.json)。关键原始JSON收据保存在 [receipts](receipts/)。在含10,000条材料的项目中，条目页首屏为531ms、1次列表请求、72,717字节；筛选后14个可领取项目正确显示12+2两页，3次请求共4,674字节。该时间来自本机Vite和虚构数据库，不作为线上性能保证。

640×400 CSS视口测试通过字符插入、切字段、来源声明和确认按钮可达性，见 [回流收据](reflow-640x400.json)及[确认框截图](reflow-640x400-confirmation.png)。它对应1280×800在200%时的布局空间；未将其称为原生浏览器缩放或原生键盘验收。

## 同材料前后对照

同一隔离后端、同一条目与来源、相同视口分别运行基线和改版。截图时没有改写字段、来源、判断或项目；两组字段原值和10条列表数据逐项一致。测量记录及校验见 [comparison.json](before-after/comparison.json)。

| 测量 | 基线 | 改版 |
| --- | --- | --- |
| 1440×900首个输入框顶端 | 706.3px | 425.5px |
| 390×844首个输入框顶端 | 936.5px，首屏外 | 486.3px，完整可见 |
| 桌面原文面板高度 | 399.5px | 820px |
| 原文工具面板 | 2处 | 1处 |
| 桌面默认常驻字符键 | 24个 | 0个，按需展开 |

这是本次虚构样例的几何结果，不代表所有长字段、错误提示或设备都具有同样数值。阻塞情况自动展开，字段区可独立滚动。

| 页面 | 基线 | 改版 |
| --- | --- | --- |
| 桌面校对 | [原界面](before-after/before-desktop-editor.png) | [新界面](before-after/after-desktop-editor.png) |
| 手机校对 | [原界面](before-after/before-mobile-editor.png) | [新界面](before-after/after-mobile-editor.png) |
| 项目条目 | [原界面](before-after/before-desktop-project.png) | [新界面](before-after/after-desktop-project.png) |

8组主文本/背景组合的对比度测量见 [contrast.json](contrast.json)，均大于4.5:1；不把这一检查扩称为所有状态及第三方内容的完整可及性认证。

## 复现

```sh
npm --prefix frontend ci
make check
npm --prefix frontend run build
NODE_PATH=/path/to/playwright/node_modules python3 backend/tests/run_frontend_quality_browser.py
```

使用仓库要求的Go/Node版本和PyYAML。浏览器runner自行建立临时数据库、运行前端和清理服务。`workbench`组追加真实App验收；角色和材料由seed_demo生成，不使用真实账号。

## 证据位置

- `output/playwright/workbench/result.json`：完整App真实API收据。
- `output/playwright/editor-experience/`：分栏、字符托盘、手机输入、来源阻塞。
- `before-after/`：相同后端材料、相同视口的基线与改版截图。
- 本目录最终summary收录命令、通过状态和仍待人工验收的项目。

CI 的既有 `backend-unicode` 作业无筛选执行统一浏览器 runner，覆盖 `editor` 和
`workbench`（含真实资料包导入）组；后端 `suites.json` 仍只登记后端集成套件。
CI 成功前核对新增截图和最终 JSON 收据非空，`frontend-quality-browser` artifact
保存完整 `output/playwright/` 和本目录 `before-after/`。前后对照属于本次已审查的
历史产物，CI 仅核对并归档，不重新拍摄基线或声称重新完成对照。浏览器失败时仍保留已产生的截图。

## 当前验收限制

自动化和桌面浏览器视口模拟不代表3名校对者/2名管理者真人试用完成，也不代表iOS/Android原生输入法、真实读屏体验已验证。操作清单见 [完整交付说明](../../UX_REDESIGN.md)，待填写的试用记录见 [人工验收登记表](human-acceptance.md)。未完成这些项前，不将候选标记为已完成发布验收。
