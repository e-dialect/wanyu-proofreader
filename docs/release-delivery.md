# E 侧交付包与人工回执

本实现对应 #316 的可独立运行部分。项目管理页「导出结果 → 交付包与回执」提供发布前检查、人工决定出包、鉴权下载、人工回执、退回上游、处置与停用通知凭据。对账不会产生「可发布」状态。

## 本轮交接边界与缺口

本轮按用户确认的范围先交付 E 能力，保留前置项缺口，**不关闭 #316**：

| 依赖／验收 | 当前情况 |
| --- | --- |
| #315 原生用途编选、D 权威数量与理由分布 | 尚未接入。接受管理员人工核查的整批交接清单；`selection_authority=manual_handoff_pending_315` 随包保留。数据库核实条目归属、完整覆盖、来源与成果；采用分类来自清单，**不是从 D 的权威表独立读取**，不能据此宣称完成 D／E 对账验收。 |
| #184 统一独立文件导出与来源列 | 尚未接入。CSV 和结果包共享 `exportRowObject`／`orderedRowHeaders`；浏览器旧 CSV 路径保留给 #184 整合。旧 CSV 不是交付包，也不能当作独立可追溯成果验收；E1.4 仍未完全满足。 |
| 范围外正文的更高权限交付 | 当前五种身份均拒绝 `include_outside=true`。只声明标识、状态和同源理由；不猜测 D 的高权限策略。该能力仍待 #315。 |
| 来源／导入类型 | 首版每包只覆盖一个完整成功的 ReviewBundle 导入批次；CSV／OCR 缺少来源键时拒绝，不合成来源或冒充结果包。多批次交付需后续适配；包内明确标识此范围。 |
| X 侧与签字 | 未执行 X 侧真实 dry-run；不代签 X／W 语义确认。合成手工回执明确标注 `x_side_dry_run=NOT_PERFORMED`，不得替代 11-30 检查点回执，也不将 #96 算为四段打通。 |
| 度量 | 有每包三类数量、正文数、来源覆盖、范围外比例、出包数、回执三态、未回执数量／等待时长、当前权利影响数、已停用数、待通知数。仅统计已生成包；失败检查次数、全生产线周吞吐与 D 的全量理由分布尚未持久化／接入，不报零充数。 |
| 上游回流 | 已有包的冲突／失败／人工退回有 A／D 线责任人、原因、待办与追加处置记录；出包前被拒的清单仍需人工转交上游，尚无跨工序任务系统。 |

## 人工交接清单

管理员从 D 接收并核查 JSON 文件，通过界面选取它。不是在 E 内要求管理员对全量条目逐条审批，也不新增 D 的逐条状态字段。原生 D 接入前，这是显式的文件交接适配器，格式尚不构成 D 的冻结契约。

示例见 `docs/evidence/issue-316/server-synthetic-handoff.json`（全部由临时测试服务生成，标识只能在那次测试库中使用）。字段：

| 字段 | 要求 |
| --- | --- |
| `import_job` | 本项目 `mode=bundle`、完整成功的导入作业。其整个当前条目集必须在清单出现一次。 |
| `selection_ref`、`selection_rule`、`confirmed_by` | D 提供的凭据编号、可读规则、确认人；每项必填、最多 200 字、不可换行。确认人是经当前操作者核查的署名，不冒充系统认证的 D 签名。 |
| `recipient`、`purpose` | 接收方标识与来源登记用途；用途词表读取 `source_usages` 的字段定义。 |
| `reviewer` | E 侧本次人工核查者，界面要求重新填写。操作者由当前认证账号写入，不能由清单冒名。 |
| `expected` | D 文件声明的 `adopted`／`excluded`／`pending` 数量；与服务端按库内条目核对后的清单分类、结果正文数对账。 |
| `entries` | 每项 `page_id`、`scope`，范围外及待处理另有 `reason`。不接受重复、跨批次或遗漏条目。理由读取现有 `pages.blocked_reason` 词表，不另造平行词表；完整的 C／D 理由适配仍待前置项。 |
| `previous`、`change_reason` | 首包留空。再次出包必须指向同项目／接收方／用途的最新包，可使用界面显示的 `package_id` 或包记录 ID；服务端统一保存包记录 ID，并要求写明变更依据。前包仍有冲突、失败或退回待办时拒绝，需上游先完成并登记处置凭据。 |

E 服务只读 B 的成果。采用正文必须来自 `status=approved` 的结构化最终校对行，`withheld` 拒绝；不会退回原始 OCR 内容冒充审校结果。业务列及顺序复用现有服务端导出投影。自动一致的出处使用真实 `proofread_round`；仲裁出处使用真实仲裁 attempt ID；每字段的 `confirmed`／`corrected` 从最终值与原始值比较得到。

完整性检查还要求 `import_job` 关联条目数等于入站任务的 `total_count`。不同批次重叠导入时，重复来源键会保留旧任务归属；此时新任务只有新增子集，无法据此证明完整批次成员，检查和出包均明确拒绝。需退回 A／D 核查完整来源范围，不能把新增子集作为整批交付。相同任务恢复后，全部条目仍归属该任务且数量匹配时不受此限制。

来源登记必须 confirmed，本用途和 `raw_third_party_transfer` 都必须明确 allow；内部研究或境内服务本身不豁免第三方传输。未知、禁止或缺登记均拒绝。双方许可争议及撤回处置需升级 Steering。

## 检查、出包与完整性

1. `POST /api/fangji/projects/{projectId}/deliveries/preflight` 接收清单，只读数据库。在一个事务中核对批次与行，输出 `reconciliation`、`can_generate` 和 `preview_sha256`。检查一致不等于授权发布。
2. 人工勾选核查确认后，`POST /api/fangji/projects/{projectId}/deliveries` 再次读取数据库，校验预览摘要，并重新检查权利、成果与最新包版本。数据变更／前包变化／对账不一致时拒绝，保存前失败不产生交付记录。
3. 包记录与受保护文件保存到 `release_deliveries`；所有普通 API 规则均 null，只能走本功能的鉴权路由。只有平台管理员、项目所有者、manager 可生成／下载／写回执；校对员及非成员拒绝。初始密码未修改的用户拒绝。owner 不依赖 manager 成员行。
4. `GET /api/fangji/deliveries/{id}/download` 重新检查权限、两种用途许可、停用事件及文件完整性。响应 `private, no-store`，带 `X-Checksum-SHA256`；不返回永久公开 URL，普通用户拿文件原始路径也不能下载。

ZIP 内四个文件：

| 文件 | 内容 |
| --- | --- |
| `manifest.json` | 复用 #182 `ReviewResultBundle/v0`，`result_of.bundle_id` 指回真实进入批次。 |
| `results.jsonl` | 现有 `entry_id`、`reviewed_fields[{field,value,decision,provenance}]`，只含采用正文。 |
| `delivery.json` | `wanyu-delivery/v1` sidecar：来源三元组、批次、接收方／用途、D 人工交接凭据、操作者／核查者、三类数量与理由、独立重放快照、范围与非抽样声明。明确 `human_required` 和不可外推。前包关系包含旧包 ID、独立 SHA-256、变更说明及自动统计的新增／移除／正文变化／范围变化数。范围外不保存正文。 |
| `checksums.sha256` | 上述三个文件的校验和。整 ZIP 的独立校验和落在不可改写的包记录与下载响应中。 |

差异统计中，`added`／`removed`／`changed` 比较采用正文；`scope_changed` 比较完整声明的 ID 并集，新增、移除、分类或理由变化的声明各计一次，覆盖范围外及待处理条目。仅重排声明不计变化。

同一快照与生成时间得到逐字节相同的 ZIP。排序固定为来源 entry ID，ZIP 成员顺序与头固定。改变生成时间只改变 manifest 的时间及由它派生的校验和／ZIP CRC；归一时间后逐字节相同。重放不需要 W 数据库：

```powershell
cd backend
go run ./cmd/delivery-replay ../docs/evidence/issue-316/server-synthetic-result.zip <独立记录的SHA256> ../output/issue316/replayed.zip
```

离线工具要求独立记录的 ZIP 摘要，接受大写、小写或混合大小写的 64 位十六进制 SHA-256（兼容 PowerShell Get-FileHash），先验证每个归档字节，再用现有 Bundle 校验器核对结果字段，重建并比较整 ZIP，额外文件／说明与正文不符也拒绝。校验和是完整性凭据，**不是身份签名**。单用旧 `/bundles/validate` 只验 #182 部分，消费方需用交付重放工具完成 sidecar 全验。

为兼容原校验器的资源限额，本轮限制每批 20,000 条、每文件 8 MiB、整包 20 MiB、请求清单 2 MiB。超限明确拒绝，不能截断后冒充全量。离线工具在读入前检查文件大小，并限制实际读取不超过 20 MiB 加一个检测字节；成功后以新建的私有临时文件替换输出，Unix 权限为 `0600`，覆盖已有宽权限文件时也收紧权限。

## 回执、返工与停用

`POST /api/fangji/deliveries/{id}/events` 仅追加 `release_events`：

| kind | 凭据 |
| --- | --- |
| `receipt` | 三态 `success`／`partial_conflict`／`failed_rolled_back`，影响条数、原因、人工核查者。全部成功条数须等于正文数；部分冲突须非零冲突数及 A／D 上游责任人；整体失败须回滚凭据及上游责任人。没有回执是 `awaiting_receipt`，不伪造失败。 |
| `return` | A／D 工序、责任人、原因、核查者，形成待办。 |
| `resolution` | `resolves` 指向同包仍待处理的冲突／失败／退回事件，附处置说明、核查者和凭据。在追加事务中核对完整历史；已关闭事件不能重复处置，并发请求最多成功一次。由此解除待办，重发以新包关联前包；不会改写旧回执。 |
| `withdrawal` | 追加停用，须责任人、原因、核查者及 Steering 升级凭据。永久阻止本包下载，即使许可后来恢复。 |
| `notice` | 停用之后才能登记，自动关联最近停用事件，须人工通知消费方停用的凭据。系统不自动向外发消息，也不把「待通知」报告成「已通知」。 |

责任人及凭据在写入前去除首尾空白；要求必填的事件不接受纯空格、制表符、换行或全角空格。拒绝请求不追加事件，也不解除待办或停用包。

`GET /api/fangji/projects/{projectId}/deliveries` 给出历史、待办、等待时长与上述已生成包度量。`GET .../deliveries/impacts?source_ref={logical_id}` 列出项目内该来源的历史包、批次、条数与当前权利阻断。权利变更会立即阻断新下载；由责任人查询影响、追加停用、升级 Steering 并通知消费方。**不会自动收回外部副本、不会删除旧包，也不声称已自动通知。**

两个集合的模型层禁止 update／delete（含原始 superuser API）；API 也没有改写入口。包的 status 不会改成可发布，B／C／D 成果不被修改。

## 迁移与上线前核查

新增 `1792281600_release_deliveries.js`，只增加两个集合及索引，不改已发布迁移，不回填或修改语料。部署需完整备份 `pb_data`。迁移幂等；relation 不级联删证据，但这本身不构成禁止删除父记录的外键约束。因此 Go 模型层另有明确守卫：项目存在交付记录、或账号作为包操作者被引用时拒绝删除，正常 owner 路由和原始 superuser API 均受限制。可停用账号、追加包停用与通知凭据；没有交付记录的项目仍可删除。不能靠删项目清空交付凭据。

回滚前先备份并保留受保护归档与凭据；down 删除两个集合，数据库历史会丢失，不能把它当作撤回包。先回滚应用至旧版本再执行迁移 down，恢复时用备份或迁移 up；不手改历史包。已在临时库验证全部 19 个迁移 up／down／up，**生产备份恢复和 staging 权限核查仍需负责人验收**。

本改动属 R2（迁移、权限、来源与对外交付）。AI 用于实现、测试、文档和自动浏览器操作；Human verification：**Not manually verified**，未有人类在 staging 实际走通；不将自动截图称为人工验收。相关负责人仍需核查五身份、真实 D 清单与许可、X dry-run、备份回滚并签字。冻结后（2026-11-30）两个 Bundle 字段表与导出列变更须走 Steering，不以 sidecar 绕过治理。

截图、真实服务生成的合成包及实际验证结果见 [验收证据](evidence/issue-316/README.md)。
