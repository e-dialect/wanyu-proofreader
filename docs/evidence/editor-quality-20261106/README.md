# 校对编辑器、字体与键盘证据（2026-11-06）

这些是本地真实浏览器操作生成的**合成数据证据**，不包含真实志愿者试用记录、真实语料裁定或生产数据。改前来自已合并基线 `49cb45adbaadaf6895d35937b5c50c0f6bc5aa8f` 的只读临时副本；改后来自本 PR 工作区。原始完整过程素材留在根 `output/playwright/backlog-editor/`，本目录仅保留验收画面与机器收据。

## 同一合成任务的前后对照（#269、#379）

每次先领合成任务，再改「字词」，第一次提交返回 503，保留输入后再次提交成功并自动打开下一条。请求中的 `rowJson` 两次逐字相同；租约 token 使用符合实际长度契约的合成值，不绕过本机租约校验。

| 阶段 | 1280 改前 | 1280 改后 | 1440 改前 | 1440 改后 |
| --- | --- | --- | --- | --- |
| 打开 | [截图](before/proof-1280-opened.png) | [截图](after/proof-1280-opened.png) | [截图](before/proof-1440-opened.png) | [截图](after/proof-1440-opened.png) |
| 编辑 | [截图](before/proof-1280-edited.png) | [截图](after/proof-1280-edited.png) | [截图](before/proof-1440-edited.png) | [截图](after/proof-1440-edited.png) |
| 提交中 | [截图](before/proof-1280-submitting.png) | [截图](after/proof-1280-submitting.png) | [截图](before/proof-1440-submitting.png) | [截图](after/proof-1440-submitting.png) |
| 下一条 | [截图](before/proof-1280-next.png) | [截图](after/proof-1280-next.png) | [截图](before/proof-1440-next.png) | [截图](after/proof-1440-next.png) |

提交失败：[1440 改前](before/proof-1440-failed.png) / [改后](after/proof-1440-failed.png)，[390 改前](before/proof-390-failed.png) / [改后](after/proof-390-failed.png)。改后弹窗内直接显示失败原因及输入保留说明，并把焦点恢复到可重试的确认按钮。

四态补充：正常态见打开截图；空态 [改前](before/state-empty.png) / [改后](after/state-empty.png)；加载错误 [改前](before/state-error.png) / [改后](after/state-error.png)；租约失效禁用 [改前](before/state-disabled.png) / [改后](after/state-disabled.png)。改前加载失败会显示「页面不存在」；改后区分错误并提供重试，浏览器测试实际点击重试恢复编辑。

[改前流程收据](before-flow-results.json)、[改后流程收据](after-flow-results.json)、[改前 API 日志](before-requests.json)、[改后 API 日志](after-requests.json) 可复核实际状态和请求。这里没有宣称像素零差异：同一 PR 的 #379 明确增加状态反馈，#270 明确改变字段字体；这些是本次授权的行为改进。#269 的结构搬迁保留 props/emits、本地草稿、本人只读、租约与盲校边界；没有新增全局 store。

## 字体保真（#270）

合成字段精确为 `𢶀ɡ⁵á\n  乙`，其中 acute 是独立 U+0301。三引擎先加载仓库字体，再以新浏览器 context 屏蔽实际 `/fonts/phonetic/*` 请求。

| 引擎 | 字体就绪 | 请求被阻断 |
| --- | --- | --- |
| Chrome | [截图](fonts/chromium-font-ready.png) | [截图](fonts/chromium-font-failed.png) |
| Firefox 156 | [截图](fonts/firefox-font-ready.png) | [截图](fonts/firefox-font-failed.png) |
| WebKit 26.6 | [截图](fonts/webkit-font-ready.png) | [截图](fonts/webkit-font-failed.png) |

[真实请求仍未完成时的 pending 截图](fonts/chromium-font-pending.png) 明确显示字形正在加载。此图仅关闭 Playwright 默认的截图前字体等待，以免工具把 pending 等成失败或就绪；应用的字体检测没有被 mock。

三引擎均断言原字段 `textContent` 与选区文本逐码位等于输入。Chrome 还实际执行复制并读取系统剪贴板，随后用 CDP 查询该 DOM 的用字形字体，断言 `Fangji Rare Han` 与 `Fangji Phonetic` 都真正渲染了字形；不能仅以字体已下载代替字形选择。结果见 [改后机器收据](after-flow-results.json)。

`AppFieldValue` 统一换行、断行、精确命中片段和受保护字符加载提示。`fieldValueLanguage()` 只给明确 IPA 列名 `und-fonipa`；其他字段继承页面语言或使用调用者提供的语言，不从任意拉丁字符推断英语或方言。覆盖清单有测试精确关联 shipped manifests，原有 CSS/资源哈希测试继续核对实际字体子集。

## 键盘闭环（#265、#295、#379）

[机器收据](keyboard/results.json) 覆盖 1280、1440、390 的 Tab/Shift+Tab、Enter 展开帮助、Enter 插字符并恢复字段光标、确认框焦点环绕、Esc 返回触发控件、退回 503 后理由与依据不丢失并恢复确认焦点、Enter 重试后下一条。移动端明确钉住字符 dock，再从末字段进入总览，没有新增多任务规则。

代表画面：[390 确认框](keyboard/390-submit-keyboard.png)、[390 退回失败](keyboard/390-return-failed.png)、[本人只读回看](keyboard/readonly-own-review.png)。只读用例实际拦截网络并断言没有 claim、lease、draft、submit 或 return 写请求，快捷键不会重新提交。

键位说明以 `keyboardGuide()` 和当前键盘定义为单一数据入口；[生成文档](../../keyboard-guide.md) 与应用相同，测试要求 192 个实际插入值逐一覆盖且不归一化。只有 5 项与仓内有来源的莆田城里 IPA 清单精确匹配；其余项明确保留「尚无经核对的本项目读音／例词依据」。组合符和上标的输入演示不冒称方言例词。

## 可复跑与剩余人工项

在已有 Playwright runtime 与浏览器可用的环境，启动前端后执行：

```sh
REVIEW_BASE_URL=http://127.0.0.1:5173 node frontend/tests/browser/font-feedback.cjs
REVIEW_BASE_URL=http://127.0.0.1:5173 node frontend/tests/browser/editor-keyboard-flow.cjs
REVIEW_BASE_URL=http://127.0.0.1:5173 node frontend/tests/browser/editor-states.cjs
node --test frontend/tests/fontAvailability.test.js frontend/tests/keyboardGuide.test.js frontend/tests/proofreadSubmission.test.js
```

`FONT_ENGINES=chromium` 可供只安装 Chromium 的 CI；本次本地字体证据已实际跑三引擎。`BROWSER_CHANNEL=chrome` 可复用系统 Chrome。49 条定向原有与新增单测通过；新增异步回归直接执行生产提交函数，验证任务切换或卸载失效后的迟到响应不能清草稿、续领或导航。

仍须真人完成的验收没有被填写为完成：#295 需要负责人补齐尚缺读音／例词依据及一名新志愿者独立找到说明；#379 需要记录一名真实试用者的停顿／错入口及改后表现。本目录不能替代这些记录。#269 的管理员到导出／上传完整链及项目整体检查由同 PR 的总体验证证据承接；这里仅证明校对侧的合成流程。
