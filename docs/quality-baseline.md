# 工程质量基线决策记录（#131）

基线：`origin/main@49cb45a`；本次核对日期：2026-11-06。这里只记录实现、验证与明确取舍；GitHub 的合并、审核和 CI 状态为执行真源。

| 条目 | 本次结果与边界 |
| --- | --- |
| 浏览器组件测试 | `review.cjs` 更新为 `/pdf/descriptor`、受保护 PDF 回退、verification 与队列契约；保留桌面/移动、字符键盘、逐字段光标与跨断点断言，新增 mounted 草稿保存/恢复、租约失效保留草稿并禁写。`modal.cjs` 复用同一合成夹具，验证焦点循环、滚动锁、取消及返回焦点。两者本机 Chrome 通过。 |
| 原孤立脚本 | `run_frontend_quality_browser.py` 接入现有 required `Backend Unicode workflow`，默认执行 review/modal、字体、profile 会话、10k 分页和 Unicode 完整流程；字体 HTTP 缓存脚本在 `Containers` 的真实 Nginx 镜像执行。开发可用 `--only` 定位；CI 不传此参数、不静默跳过。默认整链入口已在本机 Chrome 完整退出 0；包含新字体/提交失败重试/键盘流程/四态三组 mounted 浏览器回归。 |
| 服务与组件接线覆盖 | pagesService 的 expand 成功、无 expand 失败、拒绝 expand 后保持原 scope/page 重试、二次失败显式传播，4 项原生 Node 测试通过；成员服务的数组兼容、精确标识缓存、跨项目隔离、游标编码及失败不授权，4 项通过。项目条目选择/顺序/导出与仲裁进度由现有及本次真实后端浏览器覆盖。源码拆分测试读取实际模块，未引入 Vitest。 |
| 死代码/历史迁移 | 已死导出在先前清理中移除；`backend/legacy_migrations/` 保留历史参考，仍受 R2 保护，不为降低文件数删除迁移。 |
| CI 去重 | 已实际读取 main 保护规则，保留全部 11 个 required check 名称与实际工作。专用 core/profile/project/column/PDF/source-fidelity 套件不再同时跑默认 PocketBase 矩阵；去掉重复普通 Go 测试，race 单测只执行一次、两条 race 集成仍保留。库存 guard 新增对真实消费 literal suite 矩阵的识别，23 项防假绿回归通过，47 套件登记校验通过。Node 24/26 是不同运行时覆盖，不合并。 |
| 依赖/镜像/secret | required Frontend 加 npm high/critical 审计与独立 Gitleaks CLI；required Backend 加 govulncheck；实测发现并修复 x/net 0.61.0 的可达 GO-2026-6860（升 0.62.0）及旧 Go 标准库漏洞（最低/构建补丁统一 1.27.3），新检查为 0 可达漏洞、0 imported package 漏洞，另 1 个 required module 未触达；完整 Go 测试通过。required Containers 对实际构建的三个镜像（含 OCR worker）做 Trivy high/critical 扫描并产出 CycloneDX SBOM。工具使用官方固定版本、固定 SHA-256 的独立归档，无付费服务。Gitleaks 已扫 515 个历史提交并通过；仅 3 个逐行确认的合成测试字面量按精确历史 fingerprint 排除。Trivy 本机下载仍受 GitHub 大文件传输中断影响，尚未取得本次镜像扫描/SBOM成功结果；CI步骤失败时阻止成功，不能据此声称镜像无漏洞。 |
| 安全报告/问题入口 | 仓库 private vulnerability reporting 已启用并 GET 验证，`SECURITY.md` 与 issue contact link 指向真实 GitHub 私密报告渠道。未编造邮箱或 SLA；关闭 blank issues，保留表单与贡献指南入口。 |
| 成员安全 | 候选用一条参数化集合 SQL，按 name/username/id 稳定游标分页；默认数组响应兼容。ProjectSettings 实际每批 50 条加载更多，失败保留选项与选择并重试原游标，新查找与切项目隔离迟到响应；3 项 pager 回归及 mounted Chrome 接线/截图通过。精确昵称/用户名查询全项目共享每账户 20 次/5 分钟持久限额（包括 PUT 直接查询），失败 PUT 不回滚预算。PUT 只接受已有候选/成员或匹配精确已知标识，不再凭任意 ID 添加。成员邮箱只对本人或已开启 emailVisibility 的账户返回。项目访问相关 filter 改为绑定参数。完整逐身份、游标、注入、任意 ID、邮箱与并发 429 集成通过；新增限速迁移包含 up/down/up 与索引验证（全 30 迁移通过）。 |
| Prettier/所有权 | 精确锁定 Prettier 3.9.10；`make verify-static` 与 required Frontend 检查本 PR 改动的 frontend JS/Vue/CSS，禁止借此全仓大格式化。所有 owner 完成后统一格式化改动文件。CODEOWNERS 不存在路径已在先前修复；release workflow 已存在，均不重复开发。 |

## 工具与预算依据

- [Prettier CLI](https://prettier.io/docs/cli) 的 `--check` 用作 touched-files 门禁；不清扫无关历史文件。
- [Gitleaks 独立 CLI](https://github.com/gitleaks/gitleaks) 为 MIT 工具；不用要求组织商业许可证的 action。完整历史扫描本机约 2 秒，redact 输出。
- [Trivy SBOM](https://github.com/aquasecurity/trivy/blob/main/docs/guide/supply-chain/sbom.md) 支持 CycloneDX；扫描只复用已构建的三个 CI 镜像，不另建镜像或接云平台。每条扫描最长 5 分钟，Containers 总预算 45 分钟（含三个镜像构建和真实 OCR 浏览器验证），报告保留 14 天。工具/漏洞数据库下载失败会使作业失败，不降级为成功。
- 原每周 dependency audit 继续负责 outdated 与趋势证据；PR 门禁直接执行漏洞审计。没有新增付费订阅或外部代码上传服务。

## Go 安全补丁

本次真实 `govulncheck` 在旧缓存 Go 1.27.0 / x/net 0.61.0 上发现 14 项可达结果。依据官方 [GO-2026-6860](https://pkg.go.dev/vuln/GO-2026-6860) 和 [GO-2026-6809](https://pkg.go.dev/vuln/GO-2026-6809)，将 x/net 升至 0.62.0、最低 Go 补丁及两个实际构建镜像统一为 1.27.3。新工具链完整 Go 测试通过，新的 symbol 级结果是 0 可达、0 imported package 漏洞；required module 中仍报告 `golang.org/x/crypto@v0.58.0 / GO-2026-5932` 未触达（[官方条目](https://pkg.go.dev/vuln/GO-2026-5932) 指向未维护的 OpenPGP 包，本项目没有导入；工具退出 0），没有将该报告写成“所有依赖零漏洞”。最低补丁 guard 同时覆盖 main 和独立 OCR worker builder，防止只升级其中一个镜像。

## 验证状态

已完成：#311 19 项列归属测试；本次 pages/member 服务及 candidate pager 11 项测试；完整 project_access 真后端集成；30 迁移 up/down/up；库存 guard 23 项自测；Gitleaks 515 个历史提交；review/modal 与 5 个原孤立脚本、成员分页、3 个 editor 脚本的统一 Chrome 入口全部通过（字体 HTTP 缓存脚本仍需真实镜像验证）。

本次 npm audit 的 4 条 moderate 都源于构建工具链同一 [minimatch 模式放大 DoS（CVE-2026-118764）](https://github.com/advisories/GHSA-g3hv-75wg-m249)：`eslint@10.14.0 -> minimatch@^10.2.6`、`@eslint/config-array@0.23.5 -> minimatch@^10.2.4`，再传递到 `@eslint/js`。官方当前仅修复 `11.0.1`，无 10.x 兼容补丁；npm 的自动方案是降 ESLint 主版本到 9.39.5。此处不使用跨主版本 override 或 force 降级来消除报告。glob 模式来自仓库配置，不接收产品用户输入；`npm audit --omit=dev` 已实测 0 漏洞。PR high/critical 门槛保持，周审计继续显式报告 moderate，等待上游兼容升级。

最终源冻结后已由根代理用 Go 1.27.3 通过 `make check` 全门禁、383 项 Node、lint/build、改动文件 Prettier 与 UI 棘轮；实际 OCR 浏览器包含落库后 202 响应丢失、F5 恢复和幂等不重复。尚待最终镜像的生产字体 HTTP 缓存、三镜像 SBOM/严格漏洞扫描与远端 required CI；OCR 最终镜像已有无网络 CycloneDX 1.7 清单（71 组件），这不等于漏洞扫描通过。最终 PR 不得把这些未完成验证描述为通过。R2 CODEOWNER 复核与合并属于维护者验收。
