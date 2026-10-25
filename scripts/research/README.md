# 来源忠实性研究工具

材料冻结、过程采集和独立参照工具只在 `FANGJI_RESEARCH_MODE=1` 的**隔离实例**开放；默认实例拒绝冻结和过程采集接口。复制经过授权的资料到隔离环境，使用独立数据目录启动后端，不在生产语料中制造错例。

这些工具提供材料冻结、盲读参照包和可关联评价。功能演示通过不代表真人研究已经完成，也不代表方法带来效率或正确率提升。

## 1. 冻结材料与条件

在项目管理的「来源核验与问题处理」中保存来源约定，明确记音字段和允许的声调形式。管理员准备如下配置；所有 ID 都换成隔离实例中的真实标识：

```json
{
  "name": "首轮比较",
  "implementation_version": "本次实际实现提交SHA或构建摘要",
  "demonstration": false,
  "materials": [
    { "page": "材料条目ID", "provenance": "original", "split": "test", "seed_group": "材料种子1" }
  ],
  "presentation": {
    "current": { "show_hints": true, "routing_help": false, "hint_policy": "production_gates" },
    "new": { "show_hints": true, "routing_help": true, "hint_policy": "production_gates" }
  },
  "assignments": [
    { "user": "校对成员ID", "page": "材料条目ID", "role": "proofreader", "condition": "current" },
    { "user": "参照成员ID", "page": "材料条目ID", "role": "reference", "condition": "current", "blind_attestation": true },
    { "user": "维护成员ID", "page": "材料条目ID", "role": "maintenance", "condition": "current" },
    { "user": "反馈成员ID", "page": "材料条目ID", "role": "feedback", "condition": "current" }
  ]
}
```

`provenance` 取 `original`／`constructed`；`split` 取 `development`／`practice`／`test`。同一种子的变体不得跨这些划分；同一项目已有快照也参与检查。最多四名参与者共同承担参照、校对、维护、仲裁与反馈，角色还可用 `arbitration`。同条材料的参照职责与其他职责隔离；已知有提交、草稿、报告或在手任务的人不能作为该条独立参照者。技术检查不能证明从未看过答案，仍需如实确认 `blind_attestation`。

```sh
node scripts/research/source-study.mjs freeze \
  --url http://127.0.0.1:8090 --project PROJECT_ID \
  --config /private/tmp/study-config.json --out /private/tmp/study.json
```

管理凭证通过 `PB_AUTH_TOKEN` 环境变量提供，不写入配置、输出或命令行参数。`--out` 必须是新文件，工具不覆盖旧快照。冻结会保存来源、物理页、导入内容、约定、规则、门控、材料清单、条件和匿名参与者分配。

`implementation_version` 填实际运行版本的固定提交 SHA 或构建摘要，不使用会移动的 `main`／`HEAD` 或未知 `dev`。正式采集前先固定实际实现版本；工具演示使用明确的演示版本标识并设 `demonstration=true`。

若生产门控使所有提示不可见，可在研究副本把相应条件的 `hint_policy` 明确设为 `explicit_research_release`。这属于**研究人为放行**，保存在快照和会话中，不能写成生产已部署。两个条件都要求完整逐字段核对；普通产品成员没有实验条件切换开关。

## 2. 实际呈现和过程记录

已分配的校对者在通常校对页领取指定材料。页面使用冻结的展示策略和提示身份，保留正常密度上限。

冻结后来源、输入、核验约定、键盘配置或程序规则版本改变时，须保留进度并重新冻结，不将变更后的任务继续混入旧条件。研究门控策略本身使用保存的快照；其人为放行与生产放行记录分开。

前端从实际 DOM 记录可见字段中的提示、视口内呈现、因密度折叠和因字段切换隐藏的提示。门控未放行数量另存；不能以服务器候选数替代实际呈现。页面不可见或焦点未知时，`presentation_known=false`、已呈现身份为 `null`。点击定位不表示阅读，打开 PDF 不表示已核对正确。

会话记录开始、暂停、继续、离开和正式提交；提交快照由服务端关联实际 attempt。事件有连续序号、服务端实际保存时间、客户端声明时间和幂等身份。中断、事件缺失或未结束会话保留未知；不从租约倒推工作时间，不估算单条提示耗时。

引擎执行另存 `machine_analysis`，包括分析输入、规则版本、产生的提示身份和原始数量。明确执行后输出零条与 `no_execution_record` 分开；旧数据没有执行记录时不补造一次“零输出”。

评价工具的可计算时长是服务端观测到的前台活动区间，包含事件传输误差，不能冒充纯人工操作时长。客户端时间和事件原始记录保留，研究者可以另行核查。未测量的人工维护、仲裁和反馈投入填写 `effort-template.json` 的实际起止；缺少任一端时 `measured_ms=null`，不填零。

管理员从「关联过程与研究记录 JSON」导出过程包，包含未完成、无提示、无修改、旧版和缺失记录。记录通过材料、字段、finding、attempt、判断、报告、处理事项、最终值、会话与条件标识关联。

## 3. 独立来源参照

管理员把有权使用的原 PDF 放到一个本地来源目录，文件名采用冻结快照中的 `context.source.file`。来源文件不得替换，打包时校验完整 SHA-256。

```sh
node scripts/research/source-study.mjs package \
  --study /private/tmp/study.json --sources /private/tmp/study-sources \
  --out /private/tmp/blind-reference
```

新目录包含原 PDF、`materials.json`、空的 `reference-template.json` 和人工投入模板。盲读包只列来源、物理页、字段及约定；不复制导入答案、机器提示或校对提交。管理员保管完整研究快照和过程导出，不将它们一并交给参照者。

参照者先真实判读并另存填写结果：

- `readable`：实际判读值；`alternatives` 只填来源支持的其他合法结果。
- `blank`：原文没有内容，实际值为空。
- `unreadable`：暂不能判读，值为空，保留原因。
- `unrecorded`：未记录，保持空值。

`read_at` 仅填写实际测量时间，未测量保留 `null`。工具不自动补内容、理由或判读时间。参照读完后先保存一份不可覆盖的版本，再比较：

```sh
node scripts/research/source-study.mjs seal-reference \
  --input /private/tmp/reference-filled.json --out /private/tmp/reference-sealed.json

node scripts/research/source-study.mjs evaluate \
  --study /private/tmp/study.json --reference /private/tmp/reference-sealed.json \
  --process /private/tmp/process-export.json \
  --effort /private/tmp/effort-filled.json --out /private/tmp/evaluation.json
```

修改参照需要另存新版本并重新密封。密封时间只是保存时间，不是假造判读时间。工具核对快照摘要、参照者分配和已知角色交叉；多位参照者不一致时保留待处理，不用多数票制造真值。

评价使用与产品相同的 `tone-suffix-v1` 比较实现。字段正确率只按有有效参照的字段计算；整条正确率要求所有字段都有有效判断。普通数字和上标声调可以均为合法答案；原文空白也可正确。未提交、来源不可判读、版本不符或记录缺失分别保留状态与分母。正式采用值另评，不把导入回退值当终稿。

研究独立参照不传给在线提示、分流、普通人员统计或业务自动批准。报告中的业务判断、弱比较与独立参照仍是不同来源。

## 4. 可重放的合成验收

```sh
python3 backend/tests/run_integration.py source_fidelity_integration.mjs \
  --env FANGJI_RESEARCH_MODE=1
```

套件生成明确标注的构造材料，覆盖冻结条件、研究放行、角色隔离、盲读打包、未知呈现、中断、未完成和关联导出。演示参照标为 `demonstration=true`；测试自动填写的教学答案不能作为真人数据。
