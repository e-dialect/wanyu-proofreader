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
