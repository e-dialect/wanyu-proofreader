# 服务端结果导出契约

`GET /api/fangji/projects/{projectId}/export` 是管理端、脚本和后续交付流程共用的只读下载入口。通过现有 `Authorization` 鉴权，仅项目所有者（无需另有 membership）、项目 manager 和平台管理员可用；普通校对成员与非成员均为 403，避免绕过盲校。未登录为 401，首次登录强制改密限制仍生效。导出不更改条目、不创建 `project_artifacts`、不生成公开或永久 URL。

## 参数与范围

| 参数 | 含义 |
| --- | --- |
| `format` | `csv`（默认）或 `jsonl` |
| `status` | 可选，使用 pages 的现有状态词表；`importing` 不允许导出 |
| `quality_state` | 可选，`candidate`、`validated`、`withheld`；空旧值视为 candidate |
| `since` | 可选，带时区 RFC3339 时间，按条目 `updated >= since`，不是校对完成时间 |
| `include_withheld` | 默认 0；仅显式 1 才包含 withheld，仍受管理权限约束 |

不传 status 表示所有可导出状态，并不表示全是已完成校对。状态和质量筛选取交集。`quality_state=withheld` 未同时传 `include_withheld=1` 返回 400。未知、重复、无效参数均为 400；没有符合条件的记录也为 400，返回可展示的错误说明，不下载空文件。数据库时间精度为毫秒，since 的更细下界向上取整到毫秒，防止包含早于起点的记录。

## 文件与字段

业务列按 `page_number,id` 顺序遍历，各行遵循 `row_headers_json`，缺失表头的额外键按共享解析器补齐，项目级列序取首次出现的并集。超过 2,000 个业务列会在响应开始前明确拒绝，绝不截列；行数没有分页上限。

CSV 为 UTF-8 BOM + CRLF：`pdf_page`、`field:原业务列名`、下表其余字段、`exported_at`、`schema_version`、`export_metadata`。所有业务列统一加 `field:` 前缀，防止同名业务列覆盖来源字段；引号、换行、逗号转义及公式前缀保护由 Go 共享实现负责。JSONL 第一行是 `type=metadata` + `export_metadata`；其余行为 `type=entry`，含 `pdf_page`、有序 `fields` 对象及同一份 provenance 字段。JSONL 保留业务值原貌，不进行电子表格公式前缀处理。

| 字段 | 数据依据 |
| --- | --- |
| `entry_id`、`status` | pages 本地 ID 与持久化状态 |
| `content_basis` | 未完成为 `original_not_final`；approved 的结构化最终行为 `final_proofread`；纯文本最终行为 `final_proofread_text`；缺失最终行回退原文为 `original_fallback_missing_final` |
| `source_system` / `source_id` / `source_version` | pages 的来源字段，未知保持空串，不根据项目名猜测 |
| `source_entry_id` / `import_job` | 来源条目键与入站任务引用 |
| `quality_state` | 共享质量状态枚举，空旧值归为 candidate |
| `proofread_rounds` / `proofread_count` | 分别为持久化 proofread_round 和 proofread_count，轮次不等同于人数 |
| `consensus` | 非 approved 为 `not_final`；approved 有 arbitrated_by 为 `arbitrated`，其余为 `unanimous`，读取工作流结果而不重算文本一致性 |
| `arbitrated_by` / `arbitrated_at` | 持久化仲裁人引用与时间，未仲裁保持空值 |
| `normalized_reading` / `normalization_rule_version` | 预留空串；#114 接入后由同一投影输出，目前不宣称已经转换 |
| `exported_at` / `schema_version` | 同一请求统一的 UTC 时间、`WanyuExport/v1` |

approved 优先最终结构化行，缺失时回退原始结构化行；两者均无时使用最终纯文本或原始文本。未完成记录始终用原始内容。此结果不包含逐位校对者的全文历史或字段级 decision_ref 审计链。

`export_metadata` 在每条 CSV 行重复，JSONL 则集中于首行，包含：

- 项目 ID、项目总数、实际导出数、项目导入中数、项目 withheld 总数；项目计数均来自同一快照，包含筛选范围之外的记录。
- `source_covered_count`（导出行中三个来源字段都非空）和 `source_missing_count`，二者相加等于导出数；这不等同于来源登记、权利许可或可发布性已通过。
- `is_partial`（导出数是否小于项目总数）、完整 filters、业务 `field_order`、现有 `column_roles_json` 的角色映射。
- `sampling=false`、`sampling_rule="none; all rows matching the declared filters"`、`extrapolatable=false`。本接口不抽样，无抽样比例；筛选子集不得被解释成随机样本或全量。
- normalization 为 `not_implemented_pending_114`，以及 schema / 导出时间。

## 完整性、资源与审计

同一并发只读数据库事务内依次扫描三遍：统计范围和列序、计算确切文件字节数、逐行写响应。只保留一行、列序及 32 KiB 缓冲，不缓存整个项目；快照保证中途数据修改不会使计数、表头、长度和正文错位。排序固定，重复导出仅 exported_at 变化（没有数据更新时）。三遍扫描用计算时间换取有界内存和完整性检测；慢客户端下载期间持有读快照，可能延长 SQLite WAL 保留，部署时仍应监测磁盘和请求时长。

响应提供 `Content-Length`、`X-Export-Content-Bytes`、`X-Export-Count`；管理端检查实际 Blob 长度后才触发下载，并在离开页面时取消请求。流开始后若数据库或网络失败，服务端记录失败，不向文件尾追加 JSON 错误；客户端必须将截断视为失败。浏览器仍需持有下载 Blob，降低的是 JavaScript 行对象和 CSV 字符串内存，不承诺浏览器总内存恒定。

`Access-Control-Expose-Headers` 显式列出 `X-Export-Count`、`X-Export-Content-Bytes` 和 `Content-Disposition`，使通过 `VITE_PB_URL` / `PB_ALLOWED_ORIGINS` 分开部署的前端也能读取完整性信息与 UTF-8 文件名。

`Cache-Control: private, no-store, no-transform`，`nosniff`，带 ASCII 回退和 UTF-8 filename* 的下载文件名。服务日志记录 operator/project/filters/count/exported_at 及完成字节数，失败有错误日志；不记录语料正文或 token。代理需保留完整性响应头，并避免压缩或改写该下载响应。

## 兼容、部署与后续接口

旧 `POST /api/fangji/projects/{id}/exports/csv` 保留 #123 的留存产物行为和旧业务表头，供既有留存/下载流程使用；它不是新 GET 的别名。共享内容投影、CSV 转义和默认 withheld 排除，显式包含也需 `include_withheld=1`；超过旧的 200,000 行上限会拒绝，避免旧接口静默截断。需要筛选、provenance 或大项目时使用 GET。

管理端已删除生产浏览器 CSV 拼装路径。`listAllProjectPages` 仍用于批量操作选择待处理 ID（仅 id/status/page_number），不是导出；测试目录的 legacy_csv_oracle 仅用于历史回归与内存对比。

此变更新增 `export` 领域 scope，不新增 migration、配置或环境变量。前后端应一起部署；新 GET 的 CSV 表头及 JSONL 元数据首行是明确的新机器契约，消费者必须按 WanyuExport/v1 读取。回滚前后端代码即可，无需回滚数据库。#114 标准化、#185 审计链、#315 编选采用和 #316 交付发布的跨系统验收各自保留，不由本接口宣称完成。

本次为 R2（来源/权限与对外文件语义），自动化证据见 [验收记录](evidence/issue-184/README.md)；合并及真实资料人工核验由维护者执行。
