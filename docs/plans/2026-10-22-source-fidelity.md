# 来源忠实性核验与分流实施记录

本次扩展涵盖固定来源与约定、完整字段核对、问题反馈、字段判断、状态导出以及隔离采集与离线评价工具。开发起点：`a49bc63`。

下列功能均已完成合成材料验收。全部验收使用临时数据库、虚构账号和明确标注的合成材料，不连接生产数据；测试结果不代表实际用户的正确率或处理时间。

## 实施顺序

| 步骤 | 功能 | 当前状态 | 实现及复用证据 |
| --- | --- | --- | --- |
| 1 | F01 固定来源与约定 | 完成 | `source_fidelity.js` 保存不可改写约定、来源文件清单、物理页和输入快照；`TaskVerificationPanel.vue` 与仲裁台展示同一依据。复用项目权限、PDF 与列角色。已引用 PDF 禁止原位替换和删除。 |
| 1 | F04 声调合法形式 | 完成 | `source_comparison.js` 为唯一定义；`sync_source_comparison.py` 生成前端副本并检查漂移。匹配、差异、弱标签及研究评价共用版本，原始值不变。 |
| 2 | F02 提示说明与定位 | 完成 | 扩展 `findings.js`、`assist_writer.js`、`fieldHints.js` 与 `findingMessages.js`；定位绑定分析输入，失配撤去偏移，保留字段提示。复用原门控、最多 200 条读取和每字段密度折叠。 |
| 2 | F03 完整核对与合法空白 | 完成 | `ProofreadEditorView.vue` 和提交接口要求当前依据及逐字段核对声明；保留／修改／未完成另存事件。允许单字段空白；整条空来源通过管理端确认及撤回，不计成品。 |
| 3 | F05 报告及未完成工作 | 完成 | 私有服务端草稿、旧版本草稿归档、最小问题报告、`MyProblemsView.vue` 和按现有租约恢复任务。报告不增加完整提交数，也不开放他人答案。 |
| 3 | F06 集中处理及反馈 | 完成 | `SourceFidelityView.vue` 提供人工合并／拆分、五种状态、技术负责人和跟进位置、实际处理及影响范围。只在同项目／来源／配置版本范围关联；公共说明与私有报告分开。 |
| 4 | F07 字段来源正误 | 完成 | 扩展 `ArbitrationView.vue`，逐候选与最终实际值分别判断，允许两份都对、两份都错重填、暂缓及撤回。一致或已提交记录走管理端来源核验入口，不制造仲裁。 |
| 4 | F08 历史及失效 | 完成 | 追加 `verification_events`，关联操作者、时间、理由、字段、attempt、来源／约定／输入／机器版本；变更保留旧快照并使相关依据失效。旧数据明确未记录。 |
| 5 | F09 统计及弱标签 | 完成 | `source_fidelity_stats.js`、个人页与 `scripts/assist` 分开匹配、采用、已判对错、未核实数量。整行统计要求全字段覆盖；明确判断与弱比较的规则分母分开。 |
| 5 | F10 内容及过程导出 | 完成 | `source_fidelity_export.js` 提供全量、业务完成、全字段明确来源复核三种 CSV 和全关联 JSON。现有 Go 全量导出补状态与回退标识；保留 CSV 安全处理及合法实际写法。 |
| 6 | R01 实际呈现与过程 | 完成 | `ResearchTelemetry.vue` 记录实际 DOM、视口／焦点、折叠、展开、定位及会话序列。`machine_analysis` 留原始输出及零输出证据；缺失不补零，人工投入模板另采。 |
| 6 | R02 条件与材料冻结 | 完成 | `source_research.js` 固定版本、来源、材料划分／种子、最多四人职责和 current／new 策略。研究人为放行显式留档，配置漂移停止旧条件采集。 |
| 6 | R03 独立参照及评价 | 完成 | [`scripts/research/README.md`](../../scripts/research/README.md) 的 freeze／package／seal-reference／evaluate；盲包不含导入答案、提示及提交，校验 PDF 摘要、参照职责与密封版本。评价按实际 study／condition 提交关联，保留无提示、未完成及不可判读分母。 |
| 7 | A01—A12、迁移与兼容 | 完成 | 下表与复现命令；32/32 后端集成、261 前端单测、迁移往返及真实 Chrome 桌面／移动端验收通过。 |

表内未写目录前缀的服务端库位于 `backend/pb_hooks/lib/`，界面位于 `frontend/src/` 的对应 `components/editor/` 或 `views/`；入口路由为 `source_fidelity.pb.js`、`source_research.pb.js` 和原 `proofreading.pb.js`。

## A01—A12 验收结果

主要证据：[`source_fidelity_integration.mjs`](../../backend/tests/source_fidelity_integration.mjs)、[`source_fidelity_browser.cjs`](../../backend/tests/source_fidelity_browser.cjs)、比较／草稿／来源标签前端测试。所有以下结果都是功能演示。

| 场景 | 结果及观察 |
| --- | --- |
| A01 固定来源与盲校权限 | 通过；成员不能修改约定、受保护来源或读取同轮他人答案、草稿及私有报告。 |
| A02 原文与导入均为空 | 通过；单字段保持空白可正式提交，全空来源另外确认不适用。 |
| A03 导入缺漏可补抄 | 通过；未提示字段也能修改，保存实际值、字段动作和来源位置。 |
| A04 两种合法声调 | 通过；`ka533`／`ka⁵³³` 匹配，两个原始提交均保留，明确判断可以都正确。 |
| A05 真实声调差异 | 通过；不同数字、字母、顺序和缺数字不被等价规则吞并，非记音字段不套用。 |
| A06 两错重填或暂缓 | 通过；候选可都判错并输入来源支持值；pending 不进入正误分母、不伪装完成。 |
| A07 三人集中报告 | 通过；人工合并和拆分保留三份报告、位置及变更事件，无他人答案泄漏。 |
| A08 维护反馈 | 通过；报告者可查看实际反馈并恢复任务，维护完成不批准内容。 |
| A09 撤回及版本失效 | 通过；约定／来源输入变更、撤回、重算保留旧判断与分析输入，失效判断不计当前正误。 |
| A10 采用与正误分开 | 通过；合法未采用值可计正确，两种合法写法原样导出；来源分母为零时结果为 null。 |
| A11 未完成和旧版导出 | 通过；全量标记状态及 imported_fallback；业务完成排除阻塞、待处理、失效和不适用记录。过程包保留草稿和历史。 |
| A12 真实呈现与缺失 | 通过；Chrome 实测 3 条直接渲染、1 条密度折叠；current 无提示条件导出 render=0 及未完成草稿；中断与未知呈现保留 null，点击不推断阅读。 |

## 使用入口

1. 管理员在项目详情进入「来源核验与问题处理」（`/admin/projects/:id/verification`）。先使用原有项目文件、物理页映射和列角色配置，确认来源，再保存约定的新版本。声调等价仅选已明确标为记音的字段。
2. 校对者仍从校对项目领取任务，逐字段对照来源 PDF。需要帮助时「提交问题」或「保存未完成工作」，从「我的问题与草稿」（`/tasks/problems`）查看反馈和恢复；完整提交须勾选来源核对声明。
3. 管理员受理问题，按共同原因及适用范围关联，记录实际处理和反馈；涉及全局缺陷时填写技术负责人和跟进位置，继续使用原平台权限。内容仍逐条核对。
4. 分歧走原仲裁入口；一致通过或已有提交走「来源核验」。字段判断和最终采用分开；缺少依据可保存并暂缓。来源变更后重新核验当前依据。
5. 从管理工作区下载三种内容 CSV 或关联过程 JSON。业务完成不要求每条再做独立研究盲读；研究参照另用离线工具，不输入生产提示或自动批准。
6. 采集前使用隔离实例和固定的实际提交 SHA／构建摘要，按工具说明冻结材料、分配职责及独立参照。版本标识必须指向实际固定提交或构建。

## 验证与复现

2026-10-22 验证结果：

- `make check` 通过：Go 单测、261 项前端单测、ESLint、运行版本、137 项工具守卫、6 项存储检查、49 项后端工具自测、全部迁移 up／down／up 与 Compose 静态结构检查。
- `make test-integration JOBS=4`：32/32 套件通过，含原有领取、盲校、仲裁、权限、提示、门控、导出等兼容测试。
- 前端生产构建通过；比较器生成一致性检查和 `git diff --check` 通过；UI 债务棘轮无新增。
- 研究模式 API／打包／密封／评价演示通过；真实 Chrome 在发布 CSP 下的桌面、390px 移动端及两个条件验收通过，另实测空记录确认与撤回对话框。
- 本机未安装 Docker，`make check` 明确跳过 Docker Compose 运行检查；未执行镜像构建或部署。Compose 静态断言及 Docker 构建上下文守卫已通过。

```sh
make check
make test-integration JOBS=4
npm --prefix frontend run build
python3 scripts/sync_source_comparison.py --check

python3 backend/tests/run_integration.py source_fidelity_integration.mjs \
  --env FANGJI_RESEARCH_MODE=1

# 使用本机安装的 Playwright；NODE_PATH 按运行时实际位置设置。
BROWSER_CHANNEL=chrome python3 backend/tests/run_integration.py source_fidelity_integration.mjs \
  --env FANGJI_RESEARCH_MODE=1 \
  --env FIDELITY_BROWSER_FIXTURE=/private/tmp/wanyu-source-browser-fixture.json \
  --env FIDELITY_BROWSER_SCRIPT="$PWD/backend/tests/source_fidelity_browser.cjs"
```

浏览器截图写入已忽略的 `output/playwright/source-fidelity/`，包括管理问题列表、候选及最终判断、空记录对话框、移动端报告／反馈、实际提示折叠和 current 无提示条件。未将这些虚构数据或测试用参照写入生产库。

可随代码评审的合成界面证据：

- [桌面端候选与最终值分别判断](../ui-evidence/source-fidelity-source-judgments-desktop.png)
- [移动端报告与任务继续核对](../ui-evidence/source-fidelity-proofreader-mobile-report.png)
- [移动端本人问题与反馈](../ui-evidence/source-fidelity-my-problems-mobile.png)

## 数据与兼容策略

- 新增迁移；旧提交保留原值，新增依据缺失时明确标记旧版／未记录。
- 项目核验约定采用追加版本。提交、判断和报告保存当时来源文件、物理页、导入快照、约定及机器规则标识。
- 比较键只用于匹配，声调规则只接受明确记音字段中、由分隔符隔开的可辨识音节末尾数字；不使用 NFKC。
- 普通校对者的完整核对声明、字段操作、管理员来源判断、独立研究参照分别存储和统计。
- 通用问题报告不复用 `blocked_reason` 或 `finding_dismissals`。维护完成不改变条目审批状态。
- 新规则按项目显式启用；旧 API 和旧数据维持可读兼容，界面始终发送完整核对声明。
- 研究功能只在显式启用的隔离环境使用。演示验收不代表真人研究已完成。

新增迁移为 `backend/pb_migrations/1792627200_source_fidelity.js`，扩展项目、条目、提交和 finding，并新增约定、事件、问题事项、原始报告、私有草稿、研究快照和研究会话七个集合。新集合通用 API 关闭，业务路由执行项目权限、任务租约与职责检查；引用过的来源文件需新增版本并重新关联。

为兼容追加迁移，历史昵称迁移测试按目标迁移定位回滚数量，避免再假设昵称迁移永远最后一条。CI 保留原集成 runner，只有 source_fidelity 矩阵显式启用研究演示。

## 回滚

先备份完整数据目录。新迁移的 down 删除新增集合与字段，包含新记录；不会改写历史提交的 `row_json`。
移除运行代码后再回滚迁移。来源文件版本保留，变更来源采用新增文件与重新关联，避免覆盖已引用文件。
