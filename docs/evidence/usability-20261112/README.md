# 操作体验精修验收

日期：2026-11-12（Asia/Shanghai）。基线 `36043569fc977e309a74a13c6fe2e578a8c1923d`；工作分支 `feat/usability-20261112`。范围为前端操作与界面，三名 subagent 并行实现后由主线程集成。PR 已发布为 [#432](https://github.com/e-dialect/wanyu-proofreader/pull/432)，后续同流程改进继续放在本 PR。完整判断、国内官方对标来源、优先级、分工及三阶段计划见[优化方案](../../plans/2026-11-12-human-usability.md)。

## 发布后追加验收

- 来源复核和未处理成员事项已接入现有接口；真实合成项目显示12条来源待办，点击后列表也是12条。成员按事项计数，处理完成后退出待办，全部历史仍可切回。
- CSV 完成态合并重复摘要和刷新入口；过程信息折叠。后端在 `error_message` 中存放的正常编码说明保持中性，不误报为警告；实际错误、来源不一致、跳过行仍外显。
- 最终前端单测605/605；lint/build/变动文件格式、UI债务通过。CSV浏览器12类状态通过；来源问题浏览器通过待办/历史切换、保存后移除与草稿保留。
- 追加截图：[待办桌面](queue-complete-desktop.png)、[待办手机](queue-complete-mobile.png)、[CSV桌面](csv-focused-desktop.png)、[CSV手机](csv-focused-mobile.png)。均使用合成数据。
- 初版602项测试及下方截图保留作为前一阶段记录；最新流程输出见 [followup-summary.txt](followup-summary.txt)。

## 初版已验证

| 检查 | 结果与范围 |
| --- | --- |
| 前端单测 | 602/602，通过；包括待办目标范围、失效清空、返回页码、成功创建跳转与回执重复打开 |
| ESLint / Prettier / 生产构建 | 通过；Prettier 仅检查相对基线变动的前端文件 |
| UI 债务 / diff 空白 | 通过，没有新增硬编码颜色、圆角、无语义提示等登记债务 |
| job-observer 浏览器组 | 挂载真实组件、模拟 API：预览默认折叠、确认在前、20行原值保持、手机布局 |
| workbench 浏览器组 | 临时真实 API：领取/继续、返回上下文、本人回看、加入项目、管理工作台及手机壳 |
| review-bundle / import-errors 浏览器组 | 临时 API 与合成材料；覆盖资料包确认、错误分页、下载和移动布局；异常分支包含请求拦截 |
| delivery integration + browser | 临时真实 API：编选、生成、下载、回执和再发送；刷新/后退/未保存提醒、重复打开不丢输入；320/390px回执及390px编选无整页横向溢出 |
| 独立浏览器点击 | 帮助返回原项目的 CSV 入口；带搜索、质量、页码旧筛选的待办点击后显示1条真实仲裁任务；25行虚构CSV预检显示25可导入、预览折叠且尚未导入 |
| 视觉查看 | 桌面1440×1000、手机390×844、回执320×844；概览、待办、帮助、CSV、编选和交付截图已打开检查 |

复核修正：全项目仲裁计数链接原先保留旧筛选，现已清除；新队列在项目访问失效后清空统计。手机回执的单页历史不再显示无意义的禁用分页按钮。

校验均为本地合成数据。开始时交付测试因本机无 `python` 别名中断；显式使用 `python3` 后，旧合成记录导致重复来源 ID，随后改用全新临时数据库，最终完整通过。不是线上数据故障，也未降低测试断言。

## 可检查的截图

| 页面 | 桌面 | 手机 |
| --- | --- | --- |
| 项目概览 | [1440px](overview-desktop.png) | [390px](overview-mobile.png) |
| 待办队列 | [1440px](queue-desktop.png) | [390px](queue-mobile.png) |
| CSV 预检 | [1440px](csv-preflight-desktop.png) | [390px](csv-preflight-mobile.png) |
| 角色帮助 | — | [390px](guide-mobile.png) |
| 编选已创建 | [1440px](adoption-created.png) | [390px](adoption-created-mobile.png) |
| 交付详情 / 回执 | [详情1440px](delivery-detail.png) | [回执390px](receipt-390.png)、[回执320px](receipt-320.png) |

截图中的项目、收件方与材料全部为虚构。截图证明布局和当时状态，不证明真人理解正确。下方初版CSV截图的重复状态摘要已在发布后追加中精简；两版截图分别标识，不冒充同一版本。

## 复验入口

```sh
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
python3 scripts/check_prettier.py --base 36043569fc977e309a74a13c6fe2e578a8c1923d
python3 scripts/check_ui_debt.py
git diff --check
```

浏览器沿用现有 `backend/tests/harness.py` 的临时数据库及真实前后端，执行 `frontend/tests/browser/{job-observer,workbench,review-bundle,import-errors}.cjs`。交付集成执行 `backend/tests/delivery_integration.mjs`，设置 `DELIVERY_BROWSER_SCRIPT=frontend/scripts/test-delivery-workspace.cjs` 的绝对路径、输出目录与 `PYTHON=python3`；依赖及环境按项目现有浏览器运行器配置。Vite 缓存设在临时目录，避免多个工作树共享缓存相互影响。

最终摘要见 [validation.json](validation.json)，流程输出见 [browser-summary.txt](browser-summary.txt) 与 [delivery-summary.txt](delivery-summary.txt)。临时认证 fixture、数据库和账号口令不纳入本证据目录。

## 尚未完成

真人独立完成、原生手机输入法、真实读屏、专业字符示例的语言专家核定，以及真实接收方交接仍待执行。现有[真人验收表](../workbench-experience-20261107/human-acceptance.md)保持待验；没有以 AI 操作代填。已发布PR并追加提交，未合并、未部署，未扩展整体可靠性专项。
