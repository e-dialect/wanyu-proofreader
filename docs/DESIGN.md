# 界面契约

本文件是 `frontend/src` 的可核对界面真源。只记录已经落在代码里的决定；还没做的事指向对应 issue，不在这里讨论。

行号以 `main` 的 `937eb3d`（2026-10-05）为准。令牌补齐（#266）合入后，以本文件「令牌」一节的更新稿为准，旧行号不再引用。

核对方式：下面每一条都能用文中给出的 `file:line` 或 `grep` 复现。没有「适当美化」这类无法判定的句子。

## 基调

活跃界面的产品名是「万语校坊」。`grep -rn 方辑 frontend/src` 为 0 命中。字体族名仍是拉丁写法 `Fangji Phonetic` / `Fangji Rare Han`（`frontend/src/style.css:31`、`frontend/src/rare-fonts.css:3`），那是历史资源名，不是界面句子。

视觉基调是档案校勘工作台：纸色底、墨色字、朱砂点缀。对应令牌是 `--paper`、`--ink`、`--accent`（`frontend/src/style.css:14-17`）。本文件不重新定义配色。

校对员界面不出现「一校」「二校」。`grep -rn "一校\|二校" frontend/src` 在 `937eb3d` 为 0 命中。轮次只出现在管理员仲裁台（`frontend/src/views/admin/ArbitrationView.vue:16`）。

## 令牌

定义位置只有 `frontend/src/style.css` 的 `:root`（`:6-35`）。下表是该处全部自定义属性。用途按引用处归纳，不是新设计。

| 名称 | 值 | 用途 | 定义 |
| --- | --- | --- | --- |
| `--primary` | `#315f68` | 主操作、链接、进度 | `:7` |
| `--primary-dark` | `#234850` | 主按钮悬停 | `:8` |
| `--primary-light` | `#e5eff0` | 选中底、浅强调 | `:9` |
| `--secondary` | `#648b7d` | 校对入口顶边 | `:10`，引用见 `.capability-card--proofread` `:162` |
| `--danger` | `#b7433f` | 危险按钮与强疑点边 | `:11` |
| `--warn` | `#b86432` | 警告按钮、草稿点 | `:12` |
| `--success` | `#3f7b5b` | 成功按钮 | `:13` |
| `--paper` | `#f6f3ec` | 页面底 | `:14`，`body` 用它（`:34`） |
| `--paper-deep` | `#eee8dc` | 印章、头像底 | `:15` |
| `--ink` | `#24343a` | 标题字色 | `:16`，`h1-h4`（`:45`） |
| `--accent` | `#ad4f32` | 朱砂：印章、已改字段 | `:17`，`.field-change-label` `:530` |
| `--gray-50` … `--gray-900` | `#f9fafb` … `#111827` | 中性色阶，一步一档 | `:18-27` |
| `--radius` | `10px` | 卡片、按钮、输入框的默认圆角 | `:28` |
| `--shadow` | 见 `:29` | 卡片阴影 | `:29` |
| `--shadow-lg` | 见 `:30` | 悬停与登录卡片 | `:30` |

`:root` 同时把 `font-family` 设成无衬线栈（`:31`），`font-size: 15px`（`:32`），`color: var(--gray-800)`（`:33`），`background: var(--paper)`（`:34`）。

### 今天没有、不能假装有的令牌

下列名字在 `937eb3d` 的 `:root` 里不存在。引用它们等于静默走 fallback。补齐归属 #266，不在本文件里先写一个「将来的值」。

| 缺失 | 证据 |
| --- | --- |
| `--surface` | `frontend/src/components/editor/DocumentReviewWorkspace.vue:205` 写了 `var(--surface, #fff)`。`grep -rn -- "--surface" frontend/src` 只有这一处引用、零处定义 |
| 间距刻度 `--space-*` | `:root` 无 `--space-`。`grep -c "\-\-space-" frontend/src/style.css` 为 0 |
| 字号刻度 `--text-*` | `:root` 无 `--text-`。字号是字面 `rem`/`px` |
| 字体别名 `--font-ui` / `--font-display` / `--font-mono` | 衬线栈在 `style.css` 内逐字复制。`grep -c "Fangji Phonetic" frontend/src/style.css` 为 20，分布在 `:31`、`:46` 以及其后 18 处 |
| 圆角刻度 `--radius-sm/md/lg/pill` | 只有 `--radius`。非令牌 `border-radius` 的不同字面值由 `python3 scripts/check_ui_debt.py --only border_radius_literals` 计数，基线上限 15（`scripts/ui_debt_baseline.json`） |
| 层级 `--z-sticky/overlay/modal` | `z-index` 字面值 8 种：`1`、`2`、`5`、`8`、`9`、`10`、`100`、`500`（`python3 scripts/check_ui_debt.py --only z_index_literals`） |
| `--focus-ring` | `.form-control:focus` 使用 `outline: none` 与 `box-shadow: 0 0 0 3px var(--primary-light)`（`:97`）。`--primary-light` `#e5eff0` 对 `.form-control` 的 `background: #fff`（`:95`）对比度约 1.17:1，低于 WCAG 2.2 SC 1.4.11 的 3:1。全局 `:focus-visible`（`:100-102`）用调色板外的 `rgba(59, 111, 212, .35)`，且被 `:97` 的更高优先级 `outline: none` 盖住 |
| 语义状态底色 | `.alert-error/warning/success/info`（`:114-117`）与 `.badge-*`（`:196-203`）使用调色板外的十六进制，没有 `--danger-bg` 这类名字 |

债务计数的口径写在 `CONTRIBUTING.md` 的「UI 债务棘轮」。`#fff` 在该口径下当前为 36 次。

## 共享组件

第二次需要同一块界面时用下表的组件，不在视图里再抄一份。组件本体都在 `frontend/src/components/`。

| 组件 | 做什么 | 调用点 | 允许再内联 |
| --- | --- | --- | --- |
| `AppErrorBoundary` | 渲染异常时整页 `role="alert"`（`components/AppErrorBoundary.vue:3`） | `App.vue:2` | 否 |
| `AppNavbar` | 顶栏、身份、出口 | `AdminLayout.vue:3`、`ProofreaderLayout.vue:3`、`WorkspaceHomeView.vue:3`、`ProjectDiscoveryView.vue:3` | 否 |
| `UserAvatar` | 用户头像 | `AppNavbar.vue:13`、`ProfileView.vue:15` | 否 |
| `AppModal` | 确认层：`role="dialog"`、`aria-modal`、Esc、焦点环绕（`components/AppModal.vue:3-16`，焦点算法 `lib/modalFocus.js`） | `ProofreadEditorView.vue:190`、`ArbitrationView.vue:181`、`ProjectDetailView.vue:596`、`ProofreaderOnboarding.vue:2` | 否。`.vue` 里的 `class="modal-backdrop"` 只允许出现在 `AppModal.vue`。`grep -rn modal-backdrop frontend/src` 还会命中 `style.css` 里的规则本体（`:559`）；判据是 `grep -rn "class=\"modal-backdrop" frontend/src --include="*.vue"` 只命中 `AppModal.vue:5`。棘轮 `custom_modals` 数的也是开始标签，不是 CSS 规则 |
| `ProofreaderOnboarding` | 可跳过的校对引导 | `ProofreaderLayout.vue:13` | 否 |
| `DocumentReviewWorkspace` | PDF 与字段的对照壳 | `ProofreadEditorView.vue:2`、`ArbitrationView.vue:2` | 否 |
| `PdfSinglePageViewer` | 单页 PDF | `DocumentReviewWorkspace.vue:48` | 否 |
| `FieldNavigation` | 字段进度与跳转 | `ProofreadEditorView.vue:184`、`ArbitrationView.vue:175` | 否 |
| `ProjectKeyboard` | 项目字符键盘。旧名 `IpaKeyboard.vue` 已不存在 | `ProofreadEditorView.vue:187`、`ArbitrationView.vue:178` | 否 |
| `RareCharacterNotice` | 缺字提示 | `ProofreadEditorView.vue:94`、`ArbitrationView.vue:51` | 否。字符层的进一步约定归 #270 |

还没有、本文件不预命名的组件：`AppField`、`AppDataTable`、`AppPagination`、`ConfirmDialog`、`AppStatusPanel`、`useAsyncResource`。它们分别归 #268 与 #267。在那些 issue 合入之前，表格仍是原生 `<table>`（棘轮 `bare_tables`），异步状态仍写在各个视图里。

## 四态

四态指一块区域在「还没跑完 / 跑完但没有 / 失败 / 不可逆」时怎么标记。统一组件归 #267。在那之前，沿用下面已经出现的结构，不要另起一套类名。

| 态 | 现有标记 | 文案例子 | 位置 |
| --- | --- | --- | --- |
| pending | 骨架：`skeleton-card` 且 `aria-hidden="true"`，容器 `aria-label="正在加载项目"` | 按钮文案用「正在…」 | `TaskHallView.vue:47-48`；字段区 `panel-loading` + `aria-live="polite"`（`ProofreadEditorView.vue:53`，样式 `style.css:481`） |
| empty | `empty-state` + `empty-state-text`，标记 `aria-hidden="true"` | 「当前没有需要你处理的项目」；来源页「还没有登记来源」 | `TaskHallView.vue:55-58`；`SourcesView.vue:23`；样式 `style.css:314-317` |
| error | `alert alert-error`。读屏要靠 `role="alert"` | 视图各自的失败句 | 类在 `style.css:114`。带 `role` 与不带 `role` 的清单由 `python3 scripts/check_ui_debt.py --only alerts_without_role` 列出，基线上限 30 |
| danger | `btn-danger`（`style.css:80`）；设置里的 `.danger-zone`（`:188`）；提交确认里的不可逆句用 `role="alert"` | 「提交后将完成条目…」一类永久保留的说明 | `ArbitrationView.vue:163`；校对确认框 `ProofreadEditorView.vue:204` |

成功与进行中的提示用 `alert alert-success` 或无修饰 `alert`，角色应为 `role="status"`。`937eb3d` 上这条没有执行完：同一类标签有的写了 `role`，有的没写。缺角色的补齐归 #265，长期收口归 #267 的 `AppStatusPanel`。

状态不单独靠颜色。机器疑点芯片始终带文字，规则写在 `style.css:536-537`，芯片结构在 `:541`。

## 措辞

界面用词就用代码里已经出现的这些，不在文案里换同义词。

| 说法 | 用在 | 不要写成 | 证据 |
| --- | --- | --- | --- |
| 待校对原文 | 校对栏里对照用的原书字段 | 原文、源文、OCR 文本 | `ProofreadEditorView.vue:141` |
| 领取任务 / 重新领取任务 | 校对员拿到一条材料 | 抢单、接单 | `ProofreadEditorView.vue:72` |
| 仲裁 | 管理员处理不一致结果 | 审核、审批（那是条目状态名，不是这个动作） | `ArbitrationView.vue:16`、`DashboardView.vue:37` |
| 万语校坊 | 产品名 | 方辑 | 见上文「基调」的 grep |
| 校对员 | 做独立校对的人 | 一校、二校 | `grep -rn "一校\|二校" frontend/src` 为 0 |

条目状态的中文标签以 `frontend/src/constants/pageStatus.js` 为准，不在本文件复制第二份。

## 断点

宽度查询只有下面六档。语义按该档里实际改动的布局写，不按设备名称。

| 最大宽度 | 语义 | 位置 |
| --- | --- | --- |
| 1100px | 校对对照从左右两栏改成上下单栏；原文工具收进摘要 | `style.css:252`、`:884`、`:932` |
| 900px | 管理列表筛选与个人页统计改为单列 | `style.css:603`、`:830`；`ProfileView.vue:331` |
| 768px | `.grid-2`/`.grid-3` 单列；导航变窄；字段导航出现；编辑器控件至少 44px 高 | `style.css:229`、`:901`、`:914`、`:925`、`:943` |
| 700px | PDF 工具条改为横向滚动，不换页 | `PdfSinglePageViewer.vue:406` |
| 640px | 页边距收紧；确认框改为单列；快捷键提示隐藏 | `style.css:628`、`:851`；`ArbitrationView.vue:458` |
| 560px | 批量生成志愿者账号的表单改为单列 | `style.css:623` |

1100px 以下不是「所有页面都变单栏」。登录卡、来源表单没有自己的 1100px 规则。管理表格包在 `.table-wrapper { overflow-x: auto }`（`style.css:206`）里，窄屏横滑，不截断操作列。

动效：`prefers-reduced-motion: reduce` 时全局 `*` 把滚动、动画、过渡压到近乎零（`style.css:640-641`）。

## 可及性核销清单

这张表只记录「怎么判定通过」。没通过的项不在本文件里标成完成。执行与证据归 #265。

| 项 | 通过条件 | `937eb3d` |
| --- | --- | --- |
| 键盘焦点可见 | 焦点环相对相邻背景对比度 ≥ 3:1。PR 里写出前后色值与计算式 | 不通过。见上文 `--focus-ring` 行 |
| 动态消息有角色 | `grep -rn "class=\"alert" frontend/src` 的每一行都含 `role=` | 不通过。棘轮 `alerts_without_role` 上限 30 |
| 状态不只靠颜色 | 疑点标记带「疑」或等价文字 | 通过。`style.css:536-537` |
| 动效可关 | `prefers-reduced-motion` 规则仍在 | 通过。`style.css:640-641` |
| 模态不丢焦点 | Tab 留在对话框内，Esc 关闭，关闭后焦点回到触发控件 | 算法在 `lib/modalFocus.js`，测试在 `frontend/tests/modalFocus.test.js`。调用点都走 `AppModal` |
| 记音的 `lang` | 不在本清单里实施 | 归 #270。`grep -rn "lang=" frontend` 目前主要是 `frontend/index.html` 的页面语言 |

## 改动时要引用的小节

改 `frontend/src` 里跨视图的令牌、共享组件、焦点、断点或四态标记时，PR 描述点名本文件的对应小节（「令牌」「共享组件」「四态」「断点」「可及性核销清单」之一）。只改一个领域内部的文案或流程时，用那个领域的 scope，并在 PR 里写「不涉及界面契约」。scope 的取舍写在 `CONTRIBUTING.md` 的 `ui` 条目。
