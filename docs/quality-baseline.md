# 工程质量基线决策记录（#131）

基线：`upstream/main@37329e2`（2026-10-20）。本记录只覆盖 #131 第一轮可安全落地或必须明确暂缓的事项；未列出的条目仍以 issue 正文为准。

| # | 条目 | 状态 | 结论与理由 |
| --- | --- | --- | --- |
| 1 | 浏览器组件套件重写并接入 CI | 暂缓 | `frontend/tests/browser/review.cjs` 仍按旧的 `/pdf` 契约取数并等待 `.pdf-loading-mask`；当前契约是 `/pdf/descriptor` 和 `DocumentReviewWorkspace` 的 `.panel-loading`。重写需要真实 fixture、Playwright 与一个独立 CI job，本轮不把未验证的脚本接进门禁。触发条件：B 线界面冻结前，或新增专用浏览器 job 时一并重写并跑通。 |
| 2 | 前端覆盖率补齐 | 暂缓 | `node --test` 仍无法解析 `@/` 别名，也没有组件挂载层；在不引入 vitest 的前提下，`.vue` 内部逻辑无法可靠覆盖。本轮不把 vitest 作为 #131 的隐含依赖。触发条件：#271 D2 拍板组件测试方案，或把可判定逻辑继续抽到 `src/lib/` 后按纯函数补测。完成前不应声称前端已有组件级测试。 |
| 3 | 已死导出与被取代的资产 | 已处理 | 删除仅被测试引用的 `frontend/src/lib/diff.js`；移除无生产调用方的 `filterAdminPages`、`paginateItems`、`getDifferingHeaders`、`CSV_PAGE_FIELD_ALIASES`；`syncToBasePage` 在基线上已不存在。`backend/legacy_migrations/` 保留：README 与 `docs/dependency-upgrades.md` 仍把它作为历史参考，且它受 R2 保护，删除不会带来功能收益。 |
| 4 | CI 自身重复 | 暂缓 | 当前 token 读取 `main` 分支保护返回 404，无法确认 required checks；删除或合并 job 可能让受保护检查消失。触发条件：维护者能列出 required checks 后，再按 `backend/tests/suites.json` 合并重复矩阵。 |
| 5 | 安全与合规工具缺口 | 部分暂缓 | 仓库仍无 `SECURITY.md`，也未找到组织级同名文件；在拿到所有者确认的接收渠道与响应时限前，不编造安全联系人或承诺。trivy/grype、SBOM、secret 扫描需要先选定工具与 CI 预算；依赖审计仍按周排程，不是 PR 门禁。`member-candidates` 剩余的限速、游标分页与 `PUT /members/{userId}` 校验需要独立的安全 PR 和逐身份授权测试，不在本轮夹带。 |
| 6 | 文档与所有权遗留 | 部分完成 | `.github/CODEOWNERS` 中不存在的 `/DATA_LICENSE.md` 已删除；数据边界由 `LICENSING.md` 与 `ASSET_BOUNDARIES.md` 覆盖。Prettier 继续暂缓：一次性格式化会与在途 PR 大面积冲突，等春节合并潮后再做。`.github/workflows/release.yml` 已存在，release 工作流不再是缺口。 |

## 仍未完成

- 第 1 条：浏览器组件套件重写与 CI 接线。
- 第 2 条：组件测试层与前端覆盖率。
- 第 4 条：CI job 去重。
- 第 5 条：`SECURITY.md`、镜像/SBOM/secret 扫描，以及 `member-candidates` 剩余安全项。
- 第 6 条：Prettier 门禁化。

## 本轮验证

- `python3 backend/tests/check_runtime_versions.py`
- `python3 backend/tests/check_test_inventory.py`
- `npm --prefix frontend test`
- `npm --prefix frontend run lint`
- `npm --prefix frontend run build`
