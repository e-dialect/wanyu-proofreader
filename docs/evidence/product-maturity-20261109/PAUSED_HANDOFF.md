# 暂停交接：2026-11-09

记录时间：2026-11-09T08:40:21.257028+00:00。用户明确要求完成手头工作后列出剩余任务并暂停。本记录用于继续执行时定位，不代表获准启动剩余事项。

## 当前已收口

- 原 #404–#414 已全部合入；后续 #421、#422、#424 也已合入。远端 main 为 `2c8e90b22dfafe84c3c3e8e5ec92134b004e064b`，未部署。
- #422 的 Windows fcntl P2 已由 #424 修复，精确 head 56/56 检查通过；原评审线程结案，#423 关闭。
- #425（CSV）：head `ed3865841aed8e073ab8626b9d0ac2d3b8299bd0`，56/56 检查通过、独立复核无阻断，CODEOWNER 及合入仍待完成。当前未解决评审线程为0。
- #426（原子发布）：与 #425 构成原生 [stack #427](https://github.com/e-dialect/wanyu-proofreader/stack/427)。代码、45 迁移、完整正常门禁、真实 Chrome 交付复验、Windows 交叉编译已完成；Windows 实机未验。
- 全量 Go race 通过：运行源码 `4525866`，主包1058.469s；所有包366个顶层测试通过。3项明确跳过为可选辅助规模探针、可选导出规模探针及浏览器专用Go入口；规模和真实Chrome证据另列。旧10分钟超时失败保留。
- #426 首轮 CI 的 column_roles 旧读取已修复：复用业务current ID与原stored行，原1/0及字符断言不变，普通和race真实HTTP均通过。
- 56项安全扫描命中经独立逐条重算确认为四份工程报告的源码SHA-256。仅加入56个精确历史指纹，不豁免路径或规则；当前24个新增提交复扫已通过。干净检出的实际远端全部历史409个提交、约17.15MB复扫也通过；扫描耗时8分29秒，最终新提交仍由增量复扫和远端新CI核对。
- 暂停提交仅包含这两项现存CI修复和交接证据，未再改产品Go/JS实现；最新推送将自动产生新CI，不能复用旧head检查。

## 恢复时的优先顺序

1. 读取 #425/#426 的最新精确head、CI、评审和未解决线程；#426 在暂停前推送了CI修复，最新远端CI仍须确认。
2. 处理最新检查或评审的剩余阻断，取得两条PR当前head的CODEOWNER批准；作者自审不能替代GitHub强制批准。按stack依赖顺序合入，不绕保护、不启用auto-merge。
3. 合入后回读main和issue关闭状态；#417/#419在此刻仍开放。此前授权仍是暂不部署。
4. #400：需要独立于生产资料的隔离测试机，按4核/约3.7GiB共享生产规格正式跑30人、20k、60分钟×3及独立15分钟故障；用户明确暂无机器，保留待办。
5. #401：真实SMTP、HTTPS邮件地址和实际收信，恢复/验证/邮箱确认生命周期。
6. #402：生产规模恢复、附件校验、异地加密备份、失败通知；实测RPO≤24小时/RTO≤60分钟。
7. #403：处置当前两项传递依赖告警。4个moderate受影响npm包属于同一minimatch告警，另有imaging low；不直接audit fix --force。
8. 真人/真机/辅助技术、中文输入法与原生缩放、真实同批Bundle完整交付及外部回执/签名；工程合成测试不代签。
9. 生产发布单独等待明确授权，并先完成适用环境、迁移、完整备份及镜像digest核对。

## 完成状态分开记录

| 项目 | 代码与本地自动化 | 真实浏览器 | 真人/真机 | 生产同规格 | 实际发布 |
| --- | --- | --- | --- | --- | --- |
| #424 fcntl修复 | 已完成并合入 | 真实Chrome ownership通过 | Windows实机未验 | 不适用容量结论 | 未部署 |
| #425 CSV预览 | 已完成；远端56/56 | 相关组合路径通过 | 未验收 | 未验收 | 未合入/未部署 |
| #426 原子发布 | 已完成；暂停前修复后新CI待确认 | 相关组合及交付通过 | 未验收 | 正式容量待环境 | 未合入/未部署 |

## 全部开放 issue 快照

GitHub实际枚举：176条issue，48开放、128关闭，PR不计入。以下是暂停前快照，恢复时按GitHub最新状态核对；列出不代表要在本次继续执行。原标签、负责人、排期与语言学验收责任不变。

| Issue | 当前题目 |
| --- | --- |
| [#91](https://github.com/e-dialect/wanyu-proofreader/issues/91) | 2027 春节冲刺：真实资料、真人校对与可追溯交付总跟踪 |
| [#92](https://github.com/e-dialect/wanyu-proofreader/issues/92) | 资料来源与授权边界：完成真实试点资产与用途矩阵 |
| [#93](https://github.com/e-dialect/wanyu-proofreader/issues/93) | 莆仙真实资料试点：独立校对、仲裁与可追溯成果验收 |
| [#94](https://github.com/e-dialect/wanyu-proofreader/issues/94) | 蒙古语 20k+ 试点：归档已完成规模验证并收口来源与成果 |
| [#95](https://github.com/e-dialect/wanyu-proofreader/issues/95) | 真实校对者体验验收：核心旅程与阻断摩擦收口 |
| [#96](https://github.com/e-dialect/wanyu-proofreader/issues/96) | X/W Review Bundle v0：完成真实小批次往返与双方语义验收 |
| [#97](https://github.com/e-dialect/wanyu-proofreader/issues/97) | Trusted / Gold：冻结 evaluation-only 语料与可复现评测 |
| [#107](https://github.com/e-dialect/wanyu-proofreader/issues/107) | perf(pdf): 提升 PDF 预览速度并控制资料泄露 |
| [#114](https://github.com/e-dialect/wanyu-proofreader/issues/114) | feat(scheme): 莆仙拼音统一输出与真实规则闭环（tracker） |
| [#120](https://github.com/e-dialect/wanyu-proofreader/issues/120) | spike(ocr): 建立 OCR 与分列验收基线 |
| [#122](https://github.com/e-dialect/wanyu-proofreader/issues/122) | feat(ocr): 明确 OCR 部署与运行边界 |
| [#124](https://github.com/e-dialect/wanyu-proofreader/issues/124) | feat(import): 预览并修正识别结果 |
| [#125](https://github.com/e-dialect/wanyu-proofreader/issues/125) | feat(ocr): 提升 OCR 分列准确率 |
| [#171](https://github.com/e-dialect/wanyu-proofreader/issues/171) | feat(import): 统一资料位置与证据契约（春节后） |
| [#173](https://github.com/e-dialect/wanyu-proofreader/issues/173) | feat(pdf): 多原文引用与可复用页面资产（春节后） |
| [#182](https://github.com/e-dialect/wanyu-proofreader/issues/182) | feat(import): Review Bundle v0 契约与双方语义签认 |
| [#187](https://github.com/e-dialect/wanyu-proofreader/issues/187) | feat(quality): 可复现校对结果抽检（真实瓶颈触发，春节后） |
| [#188](https://github.com/e-dialect/wanyu-proofreader/issues/188) | feat(proofreading): 专家身份与争议委派（春节后） |
| [#189](https://github.com/e-dialect/wanyu-proofreader/issues/189) | feat(scheme): 补齐真实来源规则、IPA 依据与生产转换验收 |
| [#190](https://github.com/e-dialect/wanyu-proofreader/issues/190) | feat(scheme): 收口批量转换资格门禁、复核与可追溯输出 |
| [#191](https://github.com/e-dialect/wanyu-proofreader/issues/191) | feat(quality): 音频与说话人评测资产治理（春节后） |
| [#265](https://github.com/e-dialect/wanyu-proofreader/issues/265) | chore(ui): 收口键盘可用性与动态提示可及性 |
| [#272](https://github.com/e-dialect/wanyu-proofreader/issues/272) | chore(ui): UI 架构改造总跟踪 |
| [#295](https://github.com/e-dialect/wanyu-proofreader/issues/295) | docs(keyboards): 补充方言键盘使用说明 |
| [#296](https://github.com/e-dialect/wanyu-proofreader/issues/296) | feat(onboarding): 改进入门引导与纠错流程 |
| [#314](https://github.com/e-dialect/wanyu-proofreader/issues/314) | 产品目标：A→E 资料生产工作台与春节真实闭环 |
| [#315](https://github.com/e-dialect/wanyu-proofreader/issues/315) | feat(adoption): D 批次编选的理由、返工与真实交付范围验收 |
| [#316](https://github.com/e-dialect/wanyu-proofreader/issues/316) | feat(release): E 权威范围对账、真实交付回执与发布前验收 |
| [#317](https://github.com/e-dialect/wanyu-proofreader/issues/317) | feat(import): 资料接入与来源批次对账 |
| [#318](https://github.com/e-dialect/wanyu-proofreader/issues/318) | feat(proofreading): 原貌校对与可追溯成果交付 |
| [#319](https://github.com/e-dialect/wanyu-proofreader/issues/319) | feat(scheme): C 工序真实规则、异常交接与原值保护收口 |
| [#335](https://github.com/e-dialect/wanyu-proofreader/issues/335) | feat(scheme): 多口音／连读来源与候选规则资料集（2027 春节后） |
| [#361](https://github.com/e-dialect/wanyu-proofreader/issues/361) | feat(import): 核对 PDF 与 CSV 导入数量并定位错误 |
| [#362](https://github.com/e-dialect/wanyu-proofreader/issues/362) | fix(proofreading): 打通独立校对与仲裁的阻断问题 |
| [#364](https://github.com/e-dialect/wanyu-proofreader/issues/364) | feat(scheme): 核验真实规则与来源→IPA 链路并交接可用版本 |
| [#365](https://github.com/e-dialect/wanyu-proofreader/issues/365) | feat(scheme): 收口批量转换资格、异常理由与 C→D 同批交接 |
| [#366](https://github.com/e-dialect/wanyu-proofreader/issues/366) | feat(adoption): 合入原生 D→E 交接并完成同批范围验收 |
| [#367](https://github.com/e-dialect/wanyu-proofreader/issues/367) | feat(release): 合入权威编选出包并核对真实批次数量与来源 |
| [#369](https://github.com/e-dialect/wanyu-proofreader/issues/369) | feat(import): 提示蒙古语导入字段及编码错误 |
| [#371](https://github.com/e-dialect/wanyu-proofreader/issues/371) | feat(scheme): 导出与复核筛选一致的转换异常清单 |
| [#372](https://github.com/e-dialect/wanyu-proofreader/issues/372) | test(workflow): 同一获准真实批次贯通 A→E 并收口阻断 |
| [#379](https://github.com/e-dialect/wanyu-proofreader/issues/379) | chore(ui): 打磨桌面校对工作台的视觉层级与操作反馈 |
| [#400](https://github.com/e-dialect/wanyu-proofreader/issues/400) | test(ops): 保留现有共享主机规格的正式分机容量验收 |
| [#401](https://github.com/e-dialect/wanyu-proofreader/issues/401) | test(auth): 验收真实 SMTP 与账户邮件确认流程 |
| [#402](https://github.com/e-dialect/wanyu-proofreader/issues/402) | test(ops): 验收生产规模恢复、异地加密备份与失败通知 |
| [#403](https://github.com/e-dialect/wanyu-proofreader/issues/403) | chore(deps): 核查并处置当前两项传递依赖告警 |
| [#417](https://github.com/e-dialect/wanyu-proofreader/issues/417) | fix(assist): 原子发布全量重算批次并缩短写锁 |
| [#419](https://github.com/e-dialect/wanyu-proofreader/issues/419) | fix(import): 扩容并约束完整 CSV 预览持久化 |

Human verification: **Not manually verified**。无生产部署、无新增自动跟进任务；暂停后不继续处理余项。

最终安全复扫：固定gitleaks8.30.1，实际远端409个提交 `--all` 无发现；仅处理已验证56个源码摘要指纹，没有扩大path/rule豁免。新增提交的最终增量复扫结果随PR验收评论记录。
