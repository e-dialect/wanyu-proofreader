# 交付能力验收证据（2026-10-18）

范围与未完成项见 [交付说明](../../release-delivery.md)。本目录只含临时服务生成的合成资料，不含真实语料、凭据、token 或授权文件。它证明 W 侧能力，不替代 D 原生接入、独立导出或 X 侧 dry-run。

## 实物

- `server-synthetic-result.zip`：真实 W 服务生成并经鉴权下载。夹具走 ReviewBundle 导入、两名校对员提交、一次分歧仲裁，再交付。批次三条，清单分类采用／范围外／待处理各一条；断言使用服务端读回的行与真实归属计算，不用手工构造导出结果。
- `server-synthetic-result.sha256`：下载时不可改写的包记录提供的整包摘要；离线重放后逐字节相同。
- `server-synthetic-handoff.json`：本次合成交接文件，只在相应临时库内可用。D 分类来源是人工交接，未伪装成原生 D 表。
- `manual-synthetic-receipt.json`：与上面**同一包／同一版本**关联的真实服务人工冲突回执，含责任人与 D 线。`manual_synthetic_test`、`x_side_dry_run=NOT_PERFORMED` 明示证据性质。

## 界面

以下均加载真实构建产物与临时真实 PocketBase，无 API mock；账号与资料均由测试生成。自动浏览器操作不是 Human verification。

| 证据 | 场景 |
| --- | --- |
| [空状态](01-empty.png) | 未生成包，明确显示空状态 |
| [回执三态与未回执](02-receipt-states.png) | 尚未回执与整体失败可区分、待办可见 |
| [检查失败](03-reconciliation-error.png) | 清单数量与库内完整批次不符，没有生成按钮 |
| [检查与人工决定](04-preflight.png) | 三类数量、来源覆盖、范围外比例；未人工勾选时按钮不可用 |
| [移动端失败回执](05-mobile-failed.png) | 390×844 视口；失败与上游待办可见，无横向溢出 |

## 实际执行

Windows PowerShell，Go 1.27.2／Node 24.19.0／Python 3.13.7。Go 已加入 PATH，Python 命令使用 `PYTHONUTF8=1`。浏览器使用可用的 Playwright 包（`PLAYWRIGHT_PATH`）与已安装 Edge。没有触碰真实 `pb_data`。

| 命令 | 实际结果 |
| --- | --- |
| `cd backend; gofmt -l .`、`go vet ./...`、`go test ./...` | 通过，gofmt 无输出 |
| `cd backend; go test -race ./...` | 通过 |
| `npm --prefix frontend test` | 237/237 通过 |
| `npm --prefix frontend run lint`、`npm --prefix frontend run build` | 通过 |
| `python backend/tests/run_all.py --jobs 4 delivery artifact_export review_bundle quality_state project_access` | 5/5 通过；另外的需独立 runner／浏览器环境的套件由工具明确跳过，未冒充全套通过 |
| `python backend/tests/run_integration.py delivery_integration.mjs --env DELIVERY_SAMPLE_DIR=docs/evidence/issue-316 --env DELIVERY_BROWSER=1` | 通过，生成本目录包与截图；覆盖五身份（owner 无 manager 成员行）、未知许可与第三方传输、缺来源／withheld、缺人／缺行／重复行、错误数量、过期预览、回执三态、上游处置、重发关系、权利影响／停用／通知、原成果不可变、失败不产生业务库变更 |
| `python backend/tests/check_migrations.py` | 全部 19 个迁移 up／down／up 与初始 schema 拒绝回滚检查通过 |
| `python -m unittest discover -s backend/tests -p test_nickname_migration.py` | 通过；修正旧测试对「昵称迁移永远是最后一个」的假设 |
| `python backend/tests/check_test_inventory.py` | 36 个集成套件清单与 CI／磁盘一致 |
| `python backend/tests/check_runtime_versions.py`、`python scripts/check_compose_structure.py` | 通过 |
| 三个 Compose 入口各自及叠加 `docker-compose.named-volume.yml` 的 `docker compose ... config --quiet` | 六种组合通过，无需运行 Docker daemon |
| `python scripts/check_ui_debt.py` | 返回 0，既有 inline style 总数 28／基线 27 的非阻断警告；本 PR 没有新增行内样式 |
| `git diff --check`、`git diff --cached --check`、`python scripts/check_line_endings.py` | 通过 |
| `cd backend; go run ./cmd/delivery-replay ../docs/evidence/issue-316/server-synthetic-result.zip <sha256文件中的值> ../output/issue316/replayed.zip` | 在临时服务停止后离线运行，通过；两份 ZIP 的 SHA-256 相同 |

`reviewbundle` 单测还逐个翻转整 ZIP 的每个字节，独立摘要都拒绝；重新计算外层摘要但破坏 sidecar 时，离线重建比较仍拒绝。相同快照排序变化、不同生成时间、必填人／数量／字段的反向用例均已执行。

## 未通过／未执行

- `make check`：机器没有 GNU Make，无法直接运行；上表逐项调用对应可运行的检查，**不宣称 make check 通过**。
- `python -m unittest discover -s scripts -p test_*.py`：130 项中 5 个 failure；未改动的语料探测路径用例使用 POSIX 斜线假设（2），release 脚本的 Docker 夹具校验失败（3 个 failure 含 subtest）。
- `python -m unittest discover -s ops -p test_*.py`：6 项中 1 个 error，创建符号链接被 Windows 权限拒绝（WinError 1314）。
- `python -m unittest discover -s backend/tests -p test_*.py`：50 项中 4 个 error；未改动的备份测试遇到符号链接／目录 rename 权限（2），build-stamp 测试要求 `/bin/sh`（2）。本 PR 新增迁移导致的昵称测试顺序问题已修正，单独验证通过。
- 未构建 Docker 镜像：本机 Docker Desktop Linux daemon 未运行；配置六组合已独立验证通过。
- 未运行生产／staging、未传输真实资料给 X、未取得双方签字与人工 R2 验收。没有把合成回执叫作 X dry-run，没有将尚未完成的 #316 关闭。

CI 与独立评审结果以 PR 最新提交为准；上述是实际本机验证记录，不替代维护者的 R2 门禁。

## PR 评审修复回归（2026-10-18）

四项评审问题已补充回归证据；不改变原有 #184／#315／X 侧及人工验收缺口：

- 真实再导入一个含旧来源键和新来源键的不同批次，验证 completed 任务入站总数为 2，但新任务实际关联行数为 1。新行经真实双人校对完成后，仍不能以这个子集检查／出包；失败不增加包或事件。恢复的同一任务归属齐全时仍按完整数量校验。
- 模型层在同一写事务中核对父记录引用并继续删除，防止校验后并发出包的时间窗口。正常 owner 删除项目、原始 superuser 删除项目／操作者账号均拒绝，项目、包及事件数保持不变；原包仍可鉴权下载且 SHA-256 一致。另建的无交付记录项目可正常删除。没有修改 migration，relation 本身不是限制性外键。
- 冲突事件第一次处置成功后，再次提交返回 400，历史事件没有增长；另一个退回事件的两个并发处置请求仅一个 201、另一个 400，最终只有一条处置凭据，待办为空。
- 离线重放单测覆盖小写、大写、混合大小写摘要；同时实际执行 CLI，直接使用 PowerShell Get-FileHash 产生的大写 SHA-256，重放 ZIP 与原归档摘要一致。逐字节篡改拒绝测试继续通过。

本次执行 `go test ./...`、`go vet ./...`、gofmt、套件清单、空白与 LF 检查通过；`run_all.py --jobs 4 delivery project_access review_bundle volunteer_accounts` 为 4/4 通过。完整 Go 竞态检测和带竞态检测的真实服务 delivery 套件结果在对应 PR 更新中记录。界面、迁移与包格式没有变更，本轮未重跑前端截图、迁移往返或 Docker 构建，沿用前述证据及限制。

## PR 评审修复回归（2026-10-20）

本轮修复最新三项评审意见，并补齐当前代码中上一轮已解决线程对应的三项修复：

- **E2.3／E5.1**：`scope_changed` 比较完整声明 ID 并集，新增、移除或分类／理由变化均计数；单测分别覆盖 adopted／excluded／pending 的增删、不同批次替换、理由变化及仅重排不变。采用正文的 added／removed／changed 口径保持不变。
- **E4.2／E14.2**：部分冲突、失败回滚、退回与停用的责任人先去除首尾空白；处置凭据同样规范化。真实 API 对空串、空格、制表换行、全角空格逐一返回 400；包的事件历史不变，空凭据不能解除待办或允许重发。
- **E2.3／E4.2**：可直接使用管理界面显示的 package_id 重发；服务端解析并保存同一最新包记录 ID。真实服务验证 package_id 与记录 ID 的预览摘要相同、重发关系正确、旧 package_id 被拒绝。
- **E6.2**：CLI 对输入先 stat 并限制实际读取到 20 MiB 加一个检测字节，拒绝超限；输出以私有临时文件替换。Windows 与实际 Linux 测试均覆盖 20 MiB 边界、超限拒绝、新建／覆盖、失败保留原内容和临时文件清理。Linux 测试在 WSL 的 Linux 临时目录中确认已有 0644 输出被替换为 0600。实际 Windows CLI 使用 Get-FileHash 大写摘要重放合成包，输出逐字节相同；错误摘要拒绝且保留原输出。
- Docker 构建目录检查发现未拷贝 cmd/delivery-replay，现已补齐 COPY，让镜像内测试包含 CLI 回归。

本轮实际通过：

- `gofmt -l backend`、`cd backend; go test ./...; go vet ./...; go test -race ./...`。
- `python backend/tests/run_all.py --jobs 4 delivery project_access review_bundle`：3/3；`python backend/tests/run_integration.py delivery_integration.mjs --race`。
- `npm --prefix frontend test`：246/246；前端 lint 和 build。
- `python backend/tests/check_migrations.py`：20 个迁移 up/down/up 与初始 schema 拒绝回滚。
- 套件清单（38 个）、运行时版本、Compose 结构、Docker 构建目录、构建目录检查的 6 个单测、空白及 LF 检查。

本轮仍未直接通过 `make check`：本机没有 GNU Make。UI debt 为 0 退出并保留既有 inline_styles 28/27 警告。Docker Linux daemon 未运行，未构建镜像。没有变更界面／迁移／Bundle 字段，未新增截图；未重跑全部 Python 工具自测或全部集成套件。#184／#315／X 实际 dry-run、真实资料试点、双方签字、staging／备份恢复和 R2 人工验收缺口继续保留；合成测试不替代这些验收。

## PR 评审修复回归（2026-10-21）

本轮针对 head `44ade12` 上的三项评审意见，由 maintainer 在 macOS（Go 1.27.1、Node 24.16.0、Python 3.12.13）执行，全部使用临时库与合成数据：

- **仲裁证据批量预取（P2）**：`readDeliverySnapshot` 原来对每个已仲裁的采用页各发一次 `proofreading_attempts` 查询，最大批次下 preflight 与 create 各最多 20,000 次，且都发生在快照事务内。现改为整批一次查询（`kind = "arbitration" && project && page.import_job`）并按 `(page, round)` 建索引；批次内没有仲裁页时不发这次查询。仲裁由应用层保证同一 `(page, round)` 唯一，因此一页至多一条决定凭据，`provenance` 仍是真实 attempt ID，缺凭据照旧拒绝出包。
- **已处置冲突不再显示待上游处理（P2）**：`receipt_state` 是追加式的，处置完成后仍为 `partial_conflict` 而 `pending_actions` 变空。卡片文案改为按待办区分「部分冲突，待上游处理」与「部分冲突，已登记处置」，其余回执状态文案不变；服务端本来就允许处置后重发。
- **区分加载失败与真实空记录（P3）**：交付记录列表改用独立 `loadError`，与操作错误 `operationError` 分开，沿用 `SourcesView`／`GateRulesView` 的既有约定。加载失败时顶部给出「重新加载」按钮、列表区提示暂时无法读取，不再同时宣称「还没有交付包」；刷新成功清除旧的加载与操作错误；刷新失败保留已加载的记录。

新增 `frontend/tests/deliveriesView.test.js`：直接执行当前 SFC 的 `receiptLabel` 与 `load()`（mock 网络与 ref），覆盖上述后两条；`frontend/tests/errorStateSeparation.test.js` 增加本视图的 loadError／operationError 约定断言。

本轮实际通过：

- `make check`：**all gates passed**（本机有 GNU Make；`docker compose config` 因未安装 Docker 而 SKIP，由 CI 执行）。
- `cd backend; gofmt -l .`（无输出）、`go vet ./...`、`go build ./...`、`go test ./...`、`go test -race ./...`。
- `python3 backend/tests/run_integration.py delivery_integration.mjs` 与 `--race`：均通过，含真实服务生成归档后 `provenance == arbitration:<真实 attempt ID>` 的逐字段校验，即批量索引路径的实际回归。
- `python3 backend/tests/run_all.py --jobs 4 delivery project_access review_bundle`：**3/3**。
- `npm --prefix frontend test`：**259/259**；`npm --prefix frontend run lint`、`npm --prefix frontend run build`。
- `python3 scripts/check_ui_debt.py`：within baseline；`python3 backend/tests/check_test_inventory.py`：38 套件与 CI／磁盘一致；`git diff --check`、`git diff --cached --check`、`python3 scripts/check_line_endings.py`。
- 反向对照：把 `DeliveriesView.vue` 还原到修复前，新测试报红；再定向移除 `load()` 里的错误清除与列表的 `loadError` 分支，两个加载态测试报红。还原修复后 6/6 通过，确认断言不是恒真。

本轮没有改动迁移、Bundle 字段、导出列或对外契约，未新增截图（文案与错误态变化已由上述直接执行 SFC 回调的测试覆盖）。未跑 Docker 镜像构建、生产／staging、人类验收与 X 集成。Human verification：**Not manually verified**。#184／#315／X 实际 dry-run、真实资料试点、双方签字、staging／备份恢复和 R2 人工验收缺口继续保留，不关闭 #316。
