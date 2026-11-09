# 万语校坊优化实施与验收交接

**2026-11-09 用户决定：正式容量验收保留待办。** 当前暂无隔离测试机，分机 60 min × 3、生产参考规格及资源／恢复预算验收待环境就绪后执行；已有本地验证结果保留，正式容量要求与发布门禁不变。

本轮已在独立工作树完成 WP00–09 的代码实现及多项本地验证，保留 Vue 3 / Reka、JavaScript、Go / PocketBase / SQLite 与既有纸墨界面。**尚未 push、创建远端 PR、合入 main 或发布；没有生产写入、重启或部署。**

最终业务实现已在 `8de31fa4b9d37184bc7b511a60039090379aac16` 完成全量本地验证；容量协议修正冻结为 `0d27b29d5cb1697ee161b30940f55e96154f677d`。两者仅差容量夹具及其测试两个文件，业务 Go、hooks、迁移和前端源码均未改变。精确分布的新检查、故障和混合短测结果在下文单列；历史结果不覆盖、不改名为新结果。

## 版本、环境与证据边界

- 原实施基线及本轮核实的远端 main：`6a306ea1f47d4ae666b97ac3c34cd3ff97f670a5`。代码工作树为 `wanyu-maturity`，分支 `feat/product-maturity-20261108`；原项目目录的旧分支未改写。
- 本轮只读盘点的现网版本为 `4a838b2657e066cc67e6605012c5f4a45fc75bc7`；参考规格是 **4 个逻辑 CPU、约 3674 MiB、与其他服务共驻**。这是正式验收目标，8 GiB 只作对照。
- 已执行容量测试的实际主机是 macOS、10 logical CPU / 64 GiB，后端与生成器同机。`GOMAXPROCS=2`、`GOMEMLIMIT=768MiB` 是运行时软预算，不是容器硬限，也不证明生产参考规格达标。
- 按用户选择的共享 3674 MiB 目标，另提供独立 `capacity-shared` overlay：后端 2 CPU／1 GiB、GOMEMLIMIT 768 MiB，前端 0.5 CPU／128 MiB。这是隔离测试的起始预算，未覆盖或修改生产部署；原 8 GiB 预算仅作对照，不能代替共享规格验收。
- 全套浏览器及前端 Nginx 镜像检查在 `f354550` 完成；已核对 `git diff f354550..8de31fa -- frontend` 为空。`8de` 另实际执行了组件故障套件和两个负载浏览器。该关系不把旧浏览器运行冒称新 SHA 全套重跑。
- [validation.json](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/evidence/product-maturity-20261109/validation.json) 记录命令、源版本与日志。容量历史结果应读取 [capacity-before-exact-fixture.json](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/evidence/product-maturity-20261109/capacity-before-exact-fixture.json)；[capacity-final.json](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/evidence/product-maturity-20261109/capacity-final.json) 单独记录精确夹具的新结果，未拿历史文件改名补齐。

## WP00–09 的六项状态

“真实浏览器”表示 Playwright 驱动实际浏览器；资料及账号仍为合成夹具，不等于真人或真实业务验收。下表中的自动化通过均限各自记录的源版本。

| 工作包 | 代码实现 | 自动化 | 真实浏览器 | 真人／真机 | 生产同规格 | 实际发布 |
| --- | --- | --- | --- | --- | --- | --- |
| WP00 基线与夹具 | 隔离实例、真实工作流模板、源／构建摘要、20k 数据；精确状态分布已修正 | 精确 20k 分布、引用及原种子保留已验证 | 已有合成基线 | 真实操作节奏待采样 | 待验 | 未发布 |
| WP01 账户安全与恢复 | 永久 ID 初始化绑定、字段白名单、账户恢复页、旧邮件桥、令牌代际、logout-all、离线维护恢复 | 8de 原生 API／重启通过；精确镜像维护恢复 11 项、初始化身份 13 项通过 | 账户页和旧邮件桥通过 | 实际 SMTP、邮件客户端、密码管理器待验 | 待验 | 未发布 |
| WP02 安全事件与本机草稿 | 三范围事件含本人成功／拒绝／失败，限速与失败写入预算；本机资料管理、退出先保存 | 权限、事务回滚、保留清理、账号隔离通过 | 草稿退出 7 场景通过 | 受限存储、跨标签和 IME 人工确认待验 | 待验 | 未发布 |
| WP03 后台作业 | 共享 GET／快照／计时器，身份代际、离线、退避、deadline、标准状态 | 注册表与协议回归通过 | 挂载组件及实际作业路径通过 | 真机后台切换和长作业走查待验 | 待验 | 未发布 |
| WP04 管理工作区 | 按 ID 深链、分页、例外定位、未保存保护；401/403 清敏感快照，404 区分项目与对象 | 分页、权限、迟到响应、冲突回归通过 | 深链、刷新、后退、dirty guard、安全失效通过 | 管理员实际业务试用待验 | 待验 | 未发布 |
| WP05 预检与帮助 | CSV 前 20 条只读预览及独立行号；文字层能力说明；虚构 CSV／完整 Bundle／三页 PDF 练习 | CSV／Bundle 合成预检通过 | 桌面／窄屏及人工闸门通过 | 两位校对者和管理员完整练习待完成 | 待验 | 未发布 |
| WP06 视觉与可访问性 | 公共控件、反馈、焦点、响应式、PDF 稳定加载及生命周期修复 | 布局／组件／字符保真门禁通过 | 多尺寸及全套回归通过 | 原生 200% 缩放、读屏、中文 IME、触屏待验 | 待验 | 未发布 |
| WP07 编选到交付 | 权威范围／正文摘要、UUID 幂等、按入站批次版本链、旧包兼容；默认关闭原生入口 | 范围、许可、幂等、文件回滚、历史与迁移通过 | 合成编选至出包通过 | 同一真实批次、真实接收方与双方回执待验 | 待验 | 未发布 |
| WP08 观测与运行保护 | 脱敏日志、真实业务时点、运行／连接池采样、读模型和查询优化、PDF 截止时间 | 日志、遥测、读写语义、采样和 Nginx 合同通过 | 标准 Web Vitals 已实际采样 | 合成小样本不能签线上 p75 | 硬资源／共驻／生产栈待验 | 未发布 |
| WP09 容量、故障与恢复 | 同机及分机入口、混合负载、集中提交、逐条摘要／审计关联、故障和整目录恢复 | 本地短测、独立故障和恢复按源版本分别留档 | 两名校对者实际走领取、原文、编辑与提交 | 独立双人、管理员与消费方验收待验 | 分机 60 min × 3／目标环境故障与恢复待验 | 未发布 |

## 技术架构与关键约束

详细职责、接口和评审切面见 [PRODUCT_MATURITY.md](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/PRODUCT_MATURITY.md)、[DESIGN.md](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/DESIGN.md)、[REVIEW_HANDOFF.md](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/evidence/product-maturity-20261109/REVIEW_HANDOFF.md)、[账户安全](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/account-security.md) 和 [ASVS 覆盖映射](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/security-asvs-mapping.md)。本轮没有引入第二套认证、全局项目 store 或新前端框架。

| 层次 | 本轮实际选型 | 约束 |
| --- | --- | --- |
| 前端 | Vue 3 / Router / Pinia / Vite，JavaScript + 公共 JSDoc，Reka 2.11.0 与 App 组件 | 原生 CSS / 语义令牌、原 textarea / 字库，不做全仓 TS 或主题重建 |
| 服务端与数据 | Go 1.27.3 / PocketBase 0.40.6 / JS hooks / SQLite | 模块化单体，事务内同一 core.App，不新增 PostgreSQL、Redis 或微服务 |
| 作业与附件 | 持久作业 + 现有 worker，私有附件与派生缓存 | 读取先授权，取消／时限／状态与数据分别验证 |
| 观测与测试 | slog JSONL、标准 web-vitals@6.2.3；Go / Node / Python / Playwright | 复用 suite inventory / CI；压力驱动为 Node 原生 HTTP + Python 编排 |
| 部署 | Compose / Nginx / Traefik、精确提交镜像 | 本地镜像通过单列；正式镜像 digest、迁移兼容、备份与发布授权另验 |


- 账户敏感变更在事务内重验请求身份与 token generation，成功审计与变更同事务；失败审计有单实例写入预算，不声称逐请求无损取证。前端换账号或权限失效清理旧视图，并拒绝迟到响应；安全跳转不受 dirty 确认框阻挡。
- `useJobObserver({projectId, kind, job, read, panel})` 内部构造五段身份 key，返回 `job/connection/lastFetchedAt/refresh` 并兼容旧消费。活动 2 s、隐藏 15 s、离线暂停、失败 2/4/8/15 s，GET deadline 10 s。CSV validated 是待确认；未知总量不显示假百分比；刷新只重读原作业。
- CSV 第一版预检只读。练习材料明确虚构，来源、许可及交付回执始终保留人工决定；不会自动创建真实记录、替人确认或暴露另一校对者结果。
- 原生交付仅支持规则明确指定的**单个完整入站 Review Bundle**。服务端先核验全项目 `scope_digest`，再构造本包范围；`preview_sha256` 绑定生成依据，UUID 请求号保证同体重放返回同包。旧 ZIP、摘要及 previous 不回写；跨 job 不自动拆包，CSV/OCR 不能冒充该闭环。
- 观测只记录固定路由、错误码、时间和必要资源计数；不记录原始 URI/query、token、密码或正文。`source_visible` 取实际图像／canvas 就绪后的绘制时点，不用 API 返回代替。PocketBase 默认非 dev，显式 `--dev=true` 在打开数据库前拒绝，避免开发 SQL／邮件原始日志泄漏。

## 性能修复及精确夹具短测

字段摘要只增加索引后，真实 HTTP 仍为 1.4–1.5 s，因此将计划中的条件 TTL 缓存适配为**同事务、只计数的读模型和 8 个 SQLite 触发器**，并逐步对账原 SQL；该夹具中新增约 13.7 MiB，不复制正文。这样避免缓存旧计数及依据漂移；触发器缺失期间发生写入时，必须先重建、对账，不能直接重启用旧计数。这一变化及空间口径见 [字段摘要实测](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/evidence/maturity-field-summary-20261108/README.md)。

本人回看直接按当前轮提交取导航字段。管理分页和队列使用固定 reader 的只读一致快照，减少占用唯一 writer。领取按每批 64 条 keyset 扫描，64 是单批上限，不是总复杂度承诺。队列覆盖索引避免读取大正文；大厅合并统计与分页遍历，按项目预聚合，仅分类可领取候选。所有这些改动都保留权限、排序、NULL 语义和完整响应对账。

早期临时二进制曾运行在 PocketBase DEV 模式，其成绩保留为历史诊断；不能与生产模式结果作单变量比较，也不能将全部延迟／RSS 改善归因于某一索引。数据 reader 默认 8/4、辅助 reader 2/2，各数据库另有单连接 writer；历史实际 reader 仅开 4–5 个且无等待，不能把旧高 RSS 解释为默认 120 个连接已全部打开。

`f354550` 扩展混合短测因 hall p95 1154 ms 失败，原结果保留在 [capacity-before-hall-fix.json](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/evidence/product-maturity-20261109/capacity-before-hall-fix.json)。后续 `8de31fa` 的短测全部通过（964 次提交对账，大厅 p95 267 ms），但当轮保留种子未扣预算，状态为 10001／4001／3000／2998；历史结果单独保存在 before-exact-fixture 文件。此偏差已在 `0d27b29` 修正，严格保留原种子、逐类扣减预算，状态不支持或超额时在写入前拒绝，生成后再核对分布及 SQLite integrity；失败完整回滚。12 项定向 SQLite／配额测试通过 3.573 s。

最终精确夹具 `0d27b29`：**全部已执行短测门禁通过，full_acceptance=false**。负载为 20,000 条、30 actor、180 s；初始分布严格为 10000／4000／3000／3000。

| 最终指标 | 样本 | p95 | 当轮门槛 |
| --- | ---: | ---: | ---: |
| 大厅 | 121 | 262.44 ms | 500 ms |
| 领取 | 961 | 173.23 ms | 800 ms |
| 提交 | 959 | 341.75 ms | 800 ms |
| 仲裁 | 713 | 348.78 ms | 800 ms |
| 字段摘要 | 441 | 90.45 ms | 1000 ms |
| 本人已校导航 | 331 | 285.60 ms | 500 ms |
| UI 提交确认 | 327 | 275.35 ms | 800 ms |
| 原文 cold_browser | 4 | 895.99 ms | 3000 ms |
| 原文 hot_browser | 2 | 116.80 ms | 1000 ms |
| LCP | 6 | 736.00000 ms | 2500 ms |
| INP | 4 | 40.00000 ms | 200 ms |
| CLS | 6 | 0.09018 | 0.1 |

领取／提交／仲裁 p99 分别为 373.66／731.53／552.87 ms。959 次确认、新 attempt、唯一 submission event、请求 row SHA-256 全部一一对应；重复为 0，SQLite integrity=ok，意外 HTTP／超时为 0；第二项目实际导入 200 行。24/24 集中提交成功，起发跨度 26.341 ms 是生成器同步指标，不是产品响应时间。

后端 38 个完整资源样本的离散 RSS 峰为 **347.85 MiB**，实际 dev=false；326 次原文读取保留 unknown 分类。资源预算／回落容差、实际参考硬件、独立生成器和三轮长测门禁仍为 incomplete；不能由这轮短测推出正式容量通过。

[最终机器可读容量结果](capacity-final.json)；完整 HTTP、资源时间序列和各门禁在忽略的 `output/maturity/capacity-exact-final-20k/`。`run-1/summary.json` 是 HTTP 生成器摘要，综合结论读取 `run-1/acceptance.json` 与根 `manifest.json`。

这些都是本地合成短测；未叠加 OCR 负载。大内存同机测试、离散资源峰值、少量 Web Vitals 和原文冷热样本，均不能用于生产参考容量、稳定线上 p75 或真机总体声明。逐条对账限定行摘要和审计关联，不替代全部 consensus 业务测试。历史、不利结果和 unknown 缓存分类继续保留。

## 已执行命令与回执

以下为实际执行记录，源版本分别列出；`0d27b29` 与 `8de` 的业务源码相同。工具环境为 Node 24.11.0、npm 11.6.1、Python 3.13.16、Go 1.27.3、PocketBase 0.40.6；该轮浏览器通道为本机 Edge。完整日志在 validation 指向的 `/private/tmp/wanyu-maturity-*` 及忽略的 `output/maturity/`。

| 验证 | 源版本与结果 | 证据／限制 |
| --- | --- | --- |
| `make check` | 0d27b29 pass：前端 586、迁移往返 43、backend Python 147、scripts 168、ops 24、suite 清单 49、Compose 6 入口；Go 使用有效缓存 | [validation.json](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/evidence/product-maturity-20261109/validation.json)；部分 Python fixture ResourceWarning 仍存在，不声称零警告 |
| `RACE=1 make test-go` | 8de 整包新跑 506.851 s；0d27b29 业务源码不变，有效缓存复核通过 | 同版 bootstrap 定向 race 43.612 s；capacityprobe 构建专项 race 3.725 s，分别记录 |
| `make test-integration JOBS=2` | 8de 默认套件 41/41 通过 | 专用 runner 不混入默认套件数量；早期临时服务未就绪失败保留 |
| `run_account_security_integration.py` | 8de 实际 HTTP／离线恢复／重启通过 | 原生管理 API 改邮箱，不伪造邮件 token，也不证明 SMTP |
| `run_frontend_quality_browser.py` 全套 | f354550 pass；前端源码至 0d27b29 无 diff | 不是 8de 全套重跑；不是 IME／设备／读屏签字 |
| 实际前端 Nginx 镜像 | f354550 pass，字体缓存／304／CSP／账户页／旧桥／默认关闭入口／实际日志哨兵 | [frontend-image.json](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/evidence/product-maturity-20261109/frontend-image.json)；路由检查的 API 502 不证明超管 API 已关闭 |
| `run_capacity_faults.py --profile full` | 0d27b29 pass，1005.4940 s、45 次执行、源冻结一致 | [faults-final.json](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/evidence/product-maturity-20261109/faults-final.json)；五类独立套件，不是向 30 个活动用户同时注入故障 |
| `run_capacity_baseline.py --profile smoke --submit-burst --entries 20000 --users 30 --duration 180 --repeats 1` | 0d27b29 精确分布全部短测 gates pass；full_acceptance=false | [最终容量回执](capacity-final.json)；正式共享规格和长测仍待验 |
| `run_restore_business.py` | 8de pass，附件哈希、原账号／项目／页面／PDF、领取／提交／仲裁／导出通过 | [restore-final.json](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/evidence/product-maturity-20261109/restore-final.json)；离线开始至全部业务验证 9.6683 s，恢复开始至全部验证 9.6255 s，均为约 2.26 MB 小夹具 |
| 精确后端镜像维护恢复 | 8de 11/11 gates pass | [account-recovery-final.json](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/evidence/product-maturity-20261109/account-recovery-final.json)；运行中／共享挂载拒绝、停机恢复、旧凭据失效、身份不变、清理均验证 |
| 精确镜像初始化身份修复 | 8de 13/13 gates pass，超管数量 1→1，原 ID／绑定保留 | [bootstrap-final.json](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/evidence/product-maturity-20261109/bootstrap-final.json)；旧镜像 1→2 的反例保留，不覆盖其失败 |

默认 Go 命令未启用 `FANGJI_PDF_RENDER` 与 `EXPORT_MEASURE_PATH` 两项额外证据采集，不计为通过；镜像 builder 未安装渲染工具，相关用例可跳过，运行阶段安装了工具。本机实际具备 pdftoppm/cwebp，并执行真实浏览器原文路径。详细范围见 validation.json。

独立五类故障是断网恢复、已接受 POST 的响应丢失、转换重启、撤权、存储写失败回滚；不混入正常延迟统计。完整目录恢复验证 14 个 manifest 文件与 2 个附件，恢复后重新登录原账号并执行业务；它不证明实际生产 RPO／RTO、异地加密或共享主机恢复能力。

历史依赖扫描也保留准确范围：`govulncheck@v1.9.0` 在 f354550 检出 0 可达符号漏洞、0 已导入包漏洞，另有未导入 OpenPGP 包所属模块的 GO-2026-5932 通报；Go 依赖至 8de 未变。`npm audit --omit=dev` 的运行时通报为 0，前端依赖未变。两者不是所有模块和开发工具链无告警的证明，也不是实时安全认证。

## 初始化、迁移、开关与回退

本次修复了实际隔离旧镜像可复现的初始化缺口：超管通过原生 API 改邮箱后，旧 ENV 重启会创建第二个超管。迁移 `1794204500_bootstrap_bindings.js` 和内部 helper 永久绑定原账号 ID；账号改邮箱、密码、角色、verified 后不被旧配置覆盖或重新提权。账号与绑定同事务，绑定写失败不能留下新管理员。

升级无绑定时，旧邮箱匹配只绑定、不改账号；不匹配且认证集合非空时拒绝猜测身份。只有已绑定原 ID 明确删除且旧邮箱未被他人占用，才允许重新初始化。绑定不依赖会过期的审计事件，有记录时拒绝 down。受信任 PB 超管的 schema／直接数据库管理仍是运维边界。

- 新迁移均追加，覆盖账户／邮件／保留索引、交付幂等和批次链、字段摘要投影、领取／队列索引与永久初始化绑定。详细清单见交接文档；迁移往返不代替生产数据副本升级演练。
- `ACCOUNT_EMAIL_ACTIONS_ENABLED=false`、`FANGJI_NATIVE_DELIVERY_ENABLED=0`、`FANGJI_TELEMETRY_ENABLED=0` 在生产 Compose／示例配置维持默认关闭；裸二进制未设原生交付开关的开发语义见交接文档，不能据此声称生产已关闭。邮件申请还需实际 SMTP 与 HTTPS AppURL；已发有效 token 的确认不因申请开关关闭而失效。旧邮件桥按既有保留期维护。
- 数据池参数重启生效但不约束总 RSS；GOMAXPROCS/GOMEMLIMIT 也不提供容器硬隔离。PDF 独立受限执行器仍是证据触发项，本轮没有将它写成已实现能力。
- 新交付链产生后，旧唯一索引的 down 可能明确拒绝；不删记录或凭据强行回退。异常先关闭新入口并前滚修复；有新增交付或外部回执后，不能用旧备份覆盖这些写入。
- 旧程序可能忽略 bootstrap 绑定，回退前须禁用旧初始化 ENV 并在隔离副本验证；不能仅保留绑定表就宣称安全。计数读模型缺表／触发器期间有写入时，也必须重建并对账后再启用。

实际 Linux/amd64 后端镜像 ID 为 `sha256:3646f7aba7fe4c696fdee8c96d02507df136a2962b5095d28fcd9f7fbb42c93d`，OCI revision 与实际二进制 commit 均为完整 `8de31fa…`，用户 `10001:10001`。见 [backend-image-final.json](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/evidence/product-maturity-20261109/backend-image-final.json)。这是本地不可变 image ID，不是注册表 manifest digest，也不是已上传的 CI 发布产物；该镜像的测试容器和卷均清零。

## 下一步执行与正式验收

1. 精确夹具修复已提交并冻结 `0d27b29`；20k 的目标与实际分布、源／binary／dist 摘要及新结果分别留档。下一轮修改代码或运行器后重新冻结版本，不能沿用旧 fault 作为新源通过证据。
2. 新版代码审查与自动化按实际改动范围执行；已经在同一冻结版本完成的检查不无故重复。完整命令入口及 reviewer 分组沿用 [REVIEW_HANDOFF.md](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/evidence/product-maturity-20261109/REVIEW_HANDOFF.md)。不要把 `run_all.py` 跳过的专用 runner 当成已跑。
3. **正式容量验收保留待办（2026-11-09 用户决定，暂无隔离测试机）。** 隔离验收机与独立压测机就绪后，重新冻结实际 SHA 和预算，在获授权环境复现 4 核／约 3674 MiB 共享规格，由另一台机器驱动正式 60 min × 3；冻结共驻负载、硬资源预算、恢复窗口、磁盘依据及人工节奏假设。8 GiB 只作对照。目标环境五类故障、OCR 工作负载（若开启）与生产 Nginx／反代栈另外验证。
4. 由两名独立校对者和一名管理员完成同一真实批次，记录提示次数、误解、质量及返工；消费方实际导入并给真实回执。真机 IME、iOS／Android、读屏与原生 200% 缩放逐项签字。
5. 核验真实 SMTP 收信、过期／重复／旧桥；异地加密备份回读、24 h 最新备份及失败通知；按实际数据量恢复到新目录，对账附件与业务。小夹具 9.6683 s 不能证明生产 RPO≤24 h／RTO≤60 min。
6. 按 CODEOWNERS 和 required checks 准备可评审 PR stack，完成远端 CI、不可变镜像、配置和迁移审核；仅在获得发布授权和适用回执后上线。

后续验收命令从最终冻结 checkout 执行，输出目录须全新。以下是后续复跑模板，路径为全新的输出示例；SSH 目标只能填写获授权隔离验收机，不能填生产别名。

```sh
# 以下是下一轮复跑模板；先冻结实际 SHA，使用全新输出目录。
BROWSER_CHANNEL=msedge python3 backend/tests/run_capacity_faults.py \
  --profile full --output output/maturity-next/exact-fixture-faults
GOMAXPROCS=2 GOMEMLIMIT=768MiB BROWSER_CHANNEL=msedge \
python3 backend/tests/run_capacity_baseline.py --profile smoke --submit-burst \
  --entries 20000 --users 30 --duration 180 --repeats 1 \
  --fault-report output/maturity-next/exact-fixture-faults/faults.json \
  --output output/maturity-next/exact-fixture-smoke

# budget 需提前评审，不能按本轮观测倒推；两端源码须一致。
python3 backend/tests/run_capacity_remote.py \
  --ssh-target capacity-lab --target-repo /srv/isolated/wanyu-proofreader \
  --budget /path/to/reviewed-capacity-budget-v1.json --profile full \
  --fault-report output/maturity-next/exact-fixture-faults/faults.json \
  --output output/maturity-next/remote-full
```

依赖与协议见 [capacity-remote.md](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/capacity-remote.md)。本地可用 `NODE_PATH` 指向既有 Playwright 运行时；浏览器通道按验收机实际安装选择并记录。full 固定 20k／30 actor、2 浏览器、200 页约 20 MiB PDF、并行 CSV／慢导出、每轮 5/5/40/10 min、3 轮，以及稳态内一次 24 人集中提交。漏参与或生成器饱和不能靠重发业务 POST 补人数，不能为达标偷偷放慢或改变阈值。

同机 runner 的资源预算、空载恢复和分机 gate 仍 incomplete。remote 即使达到 `full_acceptance=true`，范围也只是 `isolated_protocol_reference_load`，不是自动批准真实生产栈／共驻／硬限发布。最后用 `ops/release_preflight.py` 读取实际 backup、remote-backup、restore、SMTP、notification、human、capacity 回执；当前 [release-preflight.json](/Users/sheeplin/workspace/e-dialect/.worktrees/wanyu-maturity/docs/evidence/product-maturity-20261109/release-preflight.json) 为 **not_ready**，七项回执未提供。这说明本轮没有相应发布凭据，不推断现网一定没有这些配置。

本报告依据实际命令与回执整理；文档提交与已测试提交分别记录，不将不同源版本的检查拼成正式发布通过。完整原始输出留在受控本地目录；数据库、账号凭据、令牌、正文及真实资料不进入 Git。

业务字节范围核对：`git diff 8de31fa..0d27b29 -- backend frontend` 仅列出容量运行器和新配额测试两个 Python 文件。已验证的后端镜像仍对应 8de，不冒称构建了 0d 镜像；正式发布须按实际候选 SHA 重新生成 CI 镜像与凭据。
