# 前端工具链与图标决策（#271）

核对日期：2026-11-08。实现基线为已合并的 `main@e821e0a`（PR #389）。本文件把已经实施的取舍集中登记，不以旧 issue 中的「未实现」描述推断当前状态，也不在这份决策记录中新增工具或替换实现。界面约定仍以 [DESIGN.md](DESIGN.md) 为准。

| 决策 | 结论与范围 | 替代方案和已知代价 |
| --- | --- | --- |
| D1 样式门禁 | 使用仓内 `scripts/check_ui_debt.py`、基线 JSON 及解析器单测；九类均为 fail 棘轮。暂不引入 Stylelint。 | 专门检查令牌、内联样式、原生表格、提示角色等既定债务，不能替代完整 CSS AST、浏览器层叠或可及性判断；复杂语法造成可复现漏检时再单独评估 Stylelint。 |
| D2 组件挂载 | 使用现有 Vite 构建真实 Vue 组件、Playwright 在真实浏览器中操作。测试入口集中为 `backend/tests/run_frontend_quality_browser.py`，包括 Reka 公共控件、编辑器、模态、来源复核和真实隔离后端的工作台旅程。 | 不增加 Vitest、Vue Test Utils、jsdom/happy-dom 或另一套 Playwright CT 配置；纯函数继续 `node --test`。浏览器方案启动较慢，需要浏览器运行时，换取真实布局、焦点、选区和网络行为；测试夹具不能替代真人或原生手机键盘验收。 |
| D3 格式 | 固定 Prettier 3.9.10，只检查本 PR 改动的 `frontend/` JS/Vue/CSS/浏览器脚本，配置为根目录 `.prettierrc.json`。ESLint 继续承担正确性规则。 | 不清扫无关历史代码、不扩张 ESLint 格式规则。修改到旧文件时需同时格式化该文件，可能增加该文件的 diff；在单一 PR 中查看并评审。 |
| D4 图标 | 使用仓内原创 `AppIcon.vue` 内联 SVG 路径，装饰图形统一 `aria-hidden="true"`，可操作按钮/链接保留可访问名称。品牌「万」保留为品牌标识。 | 不新增图标库、不 vendored 第三方图标、不引 CDN；代价是少量路径由仓内维护。新图标先加入同一组件；若实际数量与维护成本形成瓶颈，再另立选型，不把字体字符当通用图标体系。 |

## 组件原语补充

本轮用户已明确选择 Reka UI；PR #389 固定 `reka-ui@2.11.0`，封装为 `AppSelect` 与 `AppDropdown`。`AppButton` 仍使用原生 button，真实字段仍保留原 textarea、IME、选区与草稿实现。Reka 提供交互原语，产品外观由仓内 CSS 令牌决定，不引入另一套主题框架。依赖变化均通过正常锁文件和审计，不使用远程脚本。它更新了早期 #271/#272「不引组件库」的阶段限制；没有重新打开 Tailwind 或整站批量替换。

## 依赖与许可载体

当前 `frontend/package-lock.json` 中，Reka 的普通 `dependencies` 递归闭包如下（包含 Reka 本身共 18 项；不含 peerDependencies，不表示 18 项均是相对旧版本新增）。应用既有 peer `vue` 当前锁定 3.5.44，满足 Reka 声明的 `>=3.4.0`。

| 包 | 锁定版本 | 锁文件许可字段 |
| --- | --- | --- |
| `reka-ui` | 2.11.0 | MIT |
| `@floating-ui/core` | 1.8.0 | MIT |
| `@floating-ui/dom` | 1.8.0 | MIT |
| `@floating-ui/utils` | 0.2.12 | MIT |
| `@floating-ui/vue` | 2.0.1 | MIT |
| `@internationalized/date` | 3.12.4 | Apache-2.0 |
| `@internationalized/number` | 3.6.9 | Apache-2.0 |
| `@swc/helpers` | 0.5.24 | Apache-2.0 |
| `@tanstack/virtual-core` | 3.19.11 | MIT |
| `@tanstack/vue-virtual` | 3.13.52 | MIT |
| `@types/web-bluetooth` | 0.0.21 | MIT |
| `@vueuse/core` | 14.4.0 | MIT |
| `@vueuse/metadata` | 14.4.0 | MIT |
| `@vueuse/shared` | 14.4.0 | MIT |
| `aria-hidden` | 1.2.6 | MIT |
| `defu` | 6.1.7 | MIT |
| `ohash` | 2.0.12 | MIT |
| `tslib` | 2.9.1 | 0BSD |

D3 的直接 devDependency `prettier@3.9.10` 为 MIT，锁文件中没有普通传递依赖。D1、D4 没有新增 npm 依赖。D2 在 CI 的临时工具目录安装固定 `playwright@1.62.1` 和其浏览器，不写入应用 package-lock、不进入前端运行时依赖；本机可通过 `NODE_PATH` 使用已安装的兼容运行时，验证记录应注明实际浏览器与工具版本。

这些 npm 包通过 `package.json`、`package-lock.json` 与包内上游元数据登记，遵循 [ASSET_BOUNDARIES.md](../ASSET_BOUNDARIES.md) 的载体分工，无须把整个 npm 依赖树重复抄进第三方资产手工表。D4 没有新增第三方素材，因此无需新增资产登记行。锁文件的许可字段不是完整的产物合规审查；分发者仍须针对实际镜像核对并保留适用的上游声明。

## 本地、CI 与维护位置

| 检查 | 本地入口 | CI 落点与边界 |
| --- | --- | --- |
| D1 债务及解析器回归 | `make check` → `verify-static` → Python 守卫单测与 `check_ui_debt.py` | `.github/workflows/ci.yml` 的 `Static analysis` 与 `Frontend` 使用相同脚本、基线；不把数值达标当实际界面验收。 |
| D2 纯函数 | `make check` → `test-node` → `npm test` | `Frontend` 的 `test:coverage`，并保留已有后端集成检查。 |
| D2 组件与旅程 | `python3 backend/tests/run_frontend_quality_browser.py`；先安装 frontend 依赖、Playwright 与浏览器。开发可用 `--only` 定位。 | `Backend Unicode workflow` 安装临时 Playwright 后运行同一入口，不传 `--only`，失败即失败；挂载组件及旅程证据随 artifact 上传。`make check` 明确不启动浏览器；本地要获得该组同等覆盖，必须另跑此命令，不能把 `make check` 成功写成浏览器成功。 |
| D3 格式 | `make check` → `verify-static` → `scripts/check_prettier.py --base …` | `Frontend` 同一脚本，以 PR base 比较；只检查改动文件。需要修复时显式运行脚本的 `--write`，不依赖 `make format` 自动运行 Prettier。 |
| D4 图标 | 组件通过 ESLint、Vite build，并在真实页面/控件浏览器回归中验证；新增操作图形仍需检查按钮名称。 | 复用 `Frontend` 与挂载组件/旅程检查，没有独立图标生成服务或字体下载。 |

前端 PR 依赖审计位于 `Frontend` 的 `npm audit --audit-level=high`；已有每周 `dependency-audit.yml` 继续记录 npm/Go 漏洞与过时依赖。这些位置可从源文件复核，不保证未来任何时点都无漏洞；以对应提交的实际审计结果为准。CSP 保持 `script-src 'self'`，上述组件、原语、图标与样式都经本地构建打包。

由此，四态组件已有真实挂载层，棘轮使用仓内可测试检查器，图标采用同一原创 SVG 组件；#271 原来登记的三条耦合不再需要等待另一轮选型。真人可用性、原生设备和完整读屏体验继续单独验收，不由工具选择代签。
