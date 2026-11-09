# PR 发布与 issue 同步记录（2026-11-09）

用户授权创建 PR、全面检索并更新 issue。本轮已发布 11 个同仓库线性 Draft PR，未合并、未启用 auto-merge、未发布生产。以下是发布交接记录；原 IMPLEMENTATION / REVIEW_HANDOFF 中的本地验证仍按原始源版本解释。

## 版本与依赖

- 审视／实现基线：`6a306ea1f47d4ae666b97ac3c34cd3ff97f670a5`。
- 发 PR 时的 main：`03b3bea6f11b4f8684ab24f29072eca48189f6fe`，保留其 Vue 3.5.45 / Vite 8.3.6 补丁和精确 web-vitals 6.2.3。
- 原实现与所有旧验收记录的锚点：`314630c94dacc88922492f71eb0cf52b29cc08f2`，已独立推送 `feat/product-maturity-20261108`；原工作树不改写。
- 初始发布顶层：`0991fab18b8e80c27744a707fa1614dbd34528ab`，已保存 `archive/maturity-stack-initial-20261109`。其树与原实现只差两个前端依赖文件。
- 修复后代码验收快照：`2ed3373978d023f0620a8188d709d69260e1e921`。本记录之后的顶层提交仅添加发布文档，不将文档提交冒称重新执行了容量测试。
- 每层一个实现快照提交，顶层另加本次文档提交；无 merge commit。因初次 CI 发现真实失败，修复以线性级联重建并按旧 head 使用 `--force-with-lease` 更新。初始和原实现历史均保留。

| 层 | PR | Base | 修复后代码快照 | 范围 |
| --- | --- | --- | --- | --- |
| 1 | [#404](https://github.com/e-dialect/wanyu-proofreader/pull/404) | `main` | `13bf463da56e` | feat(ops): add bounded runtime and experience measurement |
| 2 | [#405](https://github.com/e-dialect/wanyu-proofreader/pull/405) | `feat/maturity-01-observability` | `e57d67063fda` | feat(import): unify job observation and preparation guidance |
| 3 | [#406](https://github.com/e-dialect/wanyu-proofreader/pull/406) | `feat/maturity-02-job-workspace` | `42012c20a0cc` | feat(release): derive immutable packages from confirmed adoption |
| 4 | [#407](https://github.com/e-dialect/wanyu-proofreader/pull/407) | `feat/maturity-03-delivery` | `2fe4706a10e4` | feat(auth): add account revocation and recovery workflows |
| 5 | [#408](https://github.com/e-dialect/wanyu-proofreader/pull/408) | `feat/maturity-04-account-security` | `e477de7236b3` | fix(auth): enforce transactional permissions and preserve account drafts |
| 6 | [#409](https://github.com/e-dialect/wanyu-proofreader/pull/409) | `fix/maturity-05-permission-transactions` | `3605cb3e529b` | perf(pagination): bound task scans and isolate read snapshots |
| 7 | [#410](https://github.com/e-dialect/wanyu-proofreader/pull/410) | `fix/maturity-06-query-isolation` | `867476c017ed` | perf(pagination): cover queue reads and protect runtime state |
| 8 | [#411](https://github.com/e-dialect/wanyu-proofreader/pull/411) | `fix/maturity-07-runtime-guards` | `fa7bab1529c1` | test(ops): verify bounded recovery with real container images |
| 9 | [#412](https://github.com/e-dialect/wanyu-proofreader/pull/412) | `chore/maturity-08-container-recovery` | `b653f5183ce1` | perf(pagination): aggregate hall results from eligible candidates |
| 10 | [#413](https://github.com/e-dialect/wanyu-proofreader/pull/413) | `fix/maturity-09-hall-query` | `e338d6064f7a` | fix(auth): preserve bootstrap identity across account changes |
| 11 | [#414](https://github.com/e-dialect/wanyu-proofreader/pull/414) | `fix/maturity-10-bootstrap-identity` | `2ed3373978d0` | test(ops): enforce exact fixture quotas and record acceptance evidence |

各层有依赖，须从第 1 层依次评审。低层快照不代表最终安全／性能状态可单独发布。下层合并后须先级联 rebase，并对新 head 重新运行 CI 和评审。所有 PR 均标注 R2、AI 辅助及 `Human verification: Not manually verified`；不能以合成浏览器结果代替真人、真机或真实业务确认。

## 首轮 CI 暴露的问题与修正

| 失败 | 修正与所在层 | 验证边界 |
| --- | --- | --- |
| gitleaks 扫到两个已发布提交中同一条合成 action-token 测试字面量 | 第 1 层起仅加入两个精确历史指纹；第 4 层起给这一行添加合成 fixture 注释 | 不关闭扫描、不加路径／规则级豁免；本地未发布旧历史不扩大豁免。 |
| 第 2 层降低合法 UI 债务后，自测仍期待旧上限 7 | 将现有期待值 6 的修正前置到第 2 层 | 没有放宽实际门禁预算。 |
| 第 4 层账户限流测试因数百次假密码 bcrypt 超过分钟窗口 | 将已有快速拒绝 fixture 前置到第 4 层，仍走真实 HTTP 路由并核对调用数 | 原生密码验证由账户 API 测试覆盖；不修改限流或生产认证。 |
| profile 浏览器仍寻找已移除的直接邮箱编辑框 | 将昵称保持原 token、邮箱走确认流的现有测试前置到第 4 层 | 不更改账户接口来适配旧测试。 |
| 容器代理脚本仍按旧外部 IP 10/5 限额，并把静态邮件桥误当管理 UI | 第 4 层起核对 120/IP/min、10/身份/min、伪造头及精确静态桥边界；隔离和清理仅针对本次资源 | [实际 Docker 134 请求与镜像来源](../proxy-rate-limit-ci-20261109/result.json)通过。复用已验证镜像，不宣称新顶层全镜像构建。 |
| PDF.js 取消尚未就绪的 transport 时抛 Worker was terminated | 第 5 层起先以 AbortController + 代际读取已授权 Blob 原始字节，再进入公开 data API | [修前 3/3、修后 6/6 与原草稿 7/7](../pdf-termination-20261109/README.md)。不屏蔽 pageerror、不改 vendor、不增加假等待。关联 #415。 |

## 本地验证

`0991fab` 按锁文件安装后，`make check` 和完整真实浏览器已分别通过。该结果没有排除后来稳定复现的 PDF 竞争，因此另行修复并复验。

修复后的 `2ed3373978d0` 已在同一整合树使用锁安装运行 `make check` 和完整 `run_frontend_quality_browser.py`（Edge；Playwright 版本见本机运行记录）。精确命令、状态和日志摘要见 [publication.json](publication.json)。全套包含新 PDF 生命周期、账户／草稿、管理深链及其他既有浏览器组；构建由该入口执行。

首轮远端 CI 存在红项，修复后以每个 PR 的当前 head 检查结果为准。Draft 发布不代表 required checks、CODEOWNER 或人工验收已完成。不会把旧提交的通过记录回填为新 head CI 通过。

## Issue 审核与写入范围

- 完整分页枚举原 162 条 issue：44 开放、118 已关闭；不把 PR 算入 issue 数。
- 对 44 开放项结合拥有代码、关联提交／PR、历史讨论及待办依赖重写标题和正文，保留原负责人、标签和 milestone。独立回读核验 52 条写入（44 原有 + 首批 8 新建）正文／元数据无差异。
- 42 原有项继续开放；#299 以 `completed` 关闭，导航／搜索当前主线已实现，历史失败清单后补的流程偏差仍披露；#298 以 `not_planned` 关闭，遵循既有不建设独立用户消费页的产品决定，不能称作已经实现。
- 全部原 118 关闭项均核验未被重新打开；只对关联历史项深入复审，不宣称重做全部历史条目的代码完成审计。
- 新建 9 条：#396 账户安全合入、#397 作业／预检合入、#398 查询与队列优化合入、#399 观测／验收工具合入、#400 正式分机容量、#401 实际 SMTP、#402 生产规模恢复／异地备份／通知、#403 两项当前传递依赖告警、#415 PDF 生命周期修复。
- 因新增 PDF 实际 CI 问题，#415 单独记录稳定复现及修复证据；仅分支修复时保持开放，等待 #408 合入。工程合入项仅在相应 PR 合入时关闭；正式容量、SMTP、备份和依赖处置不会因建 PR 自动关闭。
- 同步后共 171 issue：51 开放、120 关闭。原始 bodies/comments 和完整用户资料仅存临时审计目录，不进入 Git；这里只提交最小摘要与回读哈希。

没有将仅分支实现写成 main 已完成；蒙古语既有真实规模结果保留，来源／许可与真实成果收口仍开放。CSV 20 行只读预览不冒充表内纠错完成，现有批量转换资格门禁、异常清单导出及同批 A→E 真人验收等缺口仍有独立责任项。

## 明确保留的验收与发布边界

用户已决定：暂无隔离测试机，正式容量验收保留待办（#400）。优先针对现有 4 核、约 3.7 GiB 且共驻服务的规格优化；同机短测不能代替分机 60 分钟 × 3 和生产同规格验证。

实际 SMTP、真人双人盲校、真实同批交付与回执、iOS/Android 输入法、读屏、原生 200% 缩放、异地备份与生产规模恢复仍按所属 issue 待验。没有生产压测、生产数据写入、重启或部署。此 PR 发布及 issue 同步不包含 merge 或生产发布授权。
