# 拼音方案归一化引擎（#189 内核）

本文件说明 `backend/scheme/` 的流水线、数据形状、加载器的拒绝面，以及**哪些决定被有意留在引擎之外**。

一句话定位：这是一个**没有装真实规则**的转换内核。**目标端**的清单已经有了——`data/hinghwa_canonical.json` 是莆仙乡音社拼音（莆田城里口音）的声母 15 / 韵母 44 / 声调 7，含逐条 IPA、例字与出处，由 `LoadScheme` 加载校验；**源端**仍然没有：每本书凡例写的符号与它自己的 IPA 要逐本登记，在此之前往 `segment_map` 里填任何一条对应表都等于凭空推断，正是 #114 §7 与 #189 非目标禁止的事。本包交付的是 #189 点名的结构、状态机与门槛，规则是数据，材料已有的那半已经落地。

## 流水线

`Convert(input, adapter)` 走 #114 §6 的六级，每一级都在 `convert.go` 里单独可测。表里第 5 级同时写明了**它在代码里的实际查表时机**——两者故意不一致，理由与补偿机制都写在那一行，不留给读者猜：

| 级（§6 编号） | 做什么 | 失败时的状态 |
| --- | --- | --- |
| 1 Unicode 规范化 | 只做 NFC。不做 NFD/NFKC——那会把 `ɑ` 与 `a`、预组合鼻化与裸附标之间的区别抹掉 | — |
| 2 音节解析 | 声母/韵母/声调三段，最长匹配优先，顺序固定不依赖 map 遍历 | `UNSUPPORTED` |
| 3 分段映射 | `segment_map` 逐段查；命中一对多即停 | `AMBIGUOUS` |
| 4 上下文规则 | 只在指定邻接下改写，用于凡例三.2 那类「一个字符串两层音系」。邻接必须至少写一个、且必须是源清单里真实存在的片段，否则这条规则永不命中——加载即拒 | — |
| 5 例外表 | 整条覆盖，承载人工复核结论（#190 第 4 条的反哺落点）。**查表发生在第 1 级之后、第 2 级之前** | 取其声明状态 |
| 6 目标合法性 | 产出的每一段都必须在目标清单里 | `UNSUPPORTED` |

例外表前置是有意的：人工结论存在的理由恰恰是「前面几级处理不了这个写法」——`sa533` 的声母 `s` 没有任何映射规则，按 §6 的顺序它会在第 3 级就被判 `UNSUPPORTED`，例外永远轮不到（`TestConvertCoversAllFourStatuses` 里那条用例的名字就是这个）。

代价很实在：这条出口绕开了第 2 级的拆解与第 6 级的清单核对，而它偏偏是唯一允许携带 `EXACT`/`REVIEWED` 的出口——下游把这两个状态当作确定值，再也分不出「查过的」和「没查过的」。所以那两道检查没有取消，只是**从运行时搬到加载时**：`LoadAdapter` 用与第 2 级同一个拆解函数（`splitSyllables`），把每一条例外的 `canonical_pronunciation` 对着**目标**清单走一遍，拆不成「一个声母 + 一个韵母 + 正好一个调值」就整文件拒绝。这比第 6 级还严一点：它要求整串消费干净，第 6 级只查各段是否在清单里。

第 2 级有一条硬规矩，与 `scripts/scheme/tone.py` 同源：**一个音节位上的数字串必须正好是一个合法调值**。`533453` 不拆、不猜、不"取最长"，直接判解析失败——字母丢光是损坏，不是留给程序解的题。

## 数据形状

结果就是 #114 §5 那七个字段，不改名不合并：

```
source_scheme_id / source_pronunciation_proofread /
canonical_scheme_id / canonical_pronunciation /
normalization_status / normalization_rule_version / normalization_trace
```

`normalization_status ∈ {EXACT, REVIEWED, AMBIGUOUS, UNSUPPORTED}`。

两条不变式，各有测试钉住：

1. **只有 `EXACT` 与 `REVIEWED` 能带 `canonical_pronunciation`。** `AMBIGUOUS` 带一个猜出来的值，下游就再也分不出它和确定值——所以 `TestDeclinedResultsNeverCarryACanonicalValue` 对每个拒绝用例都断言该字段为空。
2. **`normalization_trace` 必须点名每一条实际生效的规则 ID**，包括触发歧义的那条。#189 要的是"规则升版后能列出受影响记录"，只记 `rule_version` 做不到这件事。
3. **不存在静默失效的规则。** 一条规则要么可能在运行时生效、要么在加载时被拒。第 2 条成立的前提是「进了 trace 的规则就是被查的那条」，而规则文件是手抄数据，最容易出的不是报错而是写一行永不生效的对应关系：同键两行、`part` 拼错、邻接拼错，全都属于这一类。

### 两份数据文件

| 文件 | 是什么 | 谁加载 | 真材料 |
| --- | --- | --- | --- |
| adapter（`testdata/adapter_*.json`，将来的 `data/*.json`） | **源方案**的规则：源清单、目标清单、`segment_map`、`context_rules`、`exceptions` | `LoadAdapter` | ❌ 只有合成件，源端要逐本登记凡例 |
| scheme（`data/hinghwa_canonical.json`） | **目标方案**的清单：每个 notation 的 IPA、例字、出处、取回日期 | `LoadScheme` | ✅ 莆田城里口音一份 |

分开的理由是 #114 §7 让转换走 `source notation → documented IPA → target notation`，两端都要记自己的 IPA。源端逐书不同、目标端全场一份；把目标端折进每个 adapter 文件就是同一件事抄 N 份，而抄本正是会各自漂的东西。

`Scheme` 给出两个接口：`Inventory()` 返回 `Adapter.Canonical` 要的那三个列表，`Pronunciations()` 返回 `part:notation → IPA` 的对照（零声母在 `onset:` 下）。**本包还没把目标端接到 adapter 上**：`Adapter.Canonical` 今天仍从 adapter 文件里读，接过去不改任何规则语义，属于下一步。

## 加载器的拒绝面

`LoadAdapter(path)` 只接受显式路径，**没有默认值**（#193/#195 的教训：默认值会把某个人的家目录发布出去）。以下情形一律返回 `ErrInvalidRule` 而不是半生效：

- `schema_version` 不是 1；
- 源方案与目标方案同名；
- 缺 `rule_version`（没有它 trace 无意义）；
- `annotation_system != tone_value`——《文读字汇》的 1–7 是**调类**，与大词典的**调值**同形不同义，字符串层面无法区分，所以必须由登记方声明，程序不猜；
- 规则 ID 重复；某条映射的目标值不在目标清单里；一对多规则同时写了 `to` 与 `candidates`；
- **同一个源片段写了两条规则**（`part`+`from` 相同，含一对一与一对多混用）。运行时按 `part:from` 查表，两行同键必然有一行永不生效、也永不出现在 trace 里——那正是「没人知道它已经死了」的形状，而 #189 要的是反过来：升版时能点名受影响记录；
- 分段规则的 `part` 不是 `onset`/`rime`/`tone`；一对多的 `candidates` 里有目标清单外的值（复核员面对一个根本不该出现的候选）；
- 上下文规则**永远不可能命中**：既没写 `when_onset` 也没写 `when_rime`（引擎没有「无条件改写」这个概念），或写的邻接在源清单里不存在。它与「`rewrites nothing`」是同一个缺陷的两半，过去只拦了后一半。至于 `rewrite_*` 是否在目标清单里，**故意不在这里查**——它只在特定邻接下才触发，静态证不了，留给第 6 级（`testdata/adapter_illegal_rewrite.json` 与 `TestTargetLegalityRejectsAHandBuiltIllegalSyllable` 钉的就是这件事）；
- 例外条目声明了 `AMBIGUOUS`/`UNSUPPORTED`（例外是人工结论，只能断言确定值），或 `REVIEWED` 却没写 `basis`；
- **例外的 `canonical_pronunciation` 拆不成目标方案能拼的音节**（见流水线第 5 级：这条出口在运行时绕开了拆解与合法性两级，只能在这里补回来）；例外条目规范化后撞在同一个源形上（两行只能有一行被查到）；
- 例外条目的键与值都以 NFC 存储。源侧真实材料本就 NFC/NFD 混排，值不规范化就会以手抄的字节形式出门，第 6 级又正好被绕开。

`LoadScheme(path)` 同样只接受显式路径，返回 `ErrInvalidScheme`。除上面同形的几条（`schema_version`、ID 与名称、清单非空）外，目标方案文件另有四条，前三条是为「经 IPA 转换」这件事准备的：

- **缺 `accent`**：莆仙不止一个口音，一份为某个口音登记的清单静默套用到另一个口音上，比没有清单更坏；
- **缺 `provenance`**（每条 `what`+`locator` 都要有，`retrieved` 要是 `YYYY-MM-DD`）：#189 卡住的从来不是缺一张表，而是缺「表在哪」的记录——这也是「零材料」能在清单早就公开的情况下持续一个月的唯一原因；
- **IPA 在每一 part 内必须唯一**：两个目标 notation 记成同一个读音，经 IPA 解析的源段就有两个同样说得通的目标，而文件里没有任何依据可挑。那正是 `AMBIGUOUS` 在规则层存在的理由，不该被烤进清单里让复核员永远看不见。notation 同样按 part 唯一；零声母是唯一允许 notation 为空的条目，且只能有一条；
- **notation / IPA / 调符必须是 Unicode NFC**，与例外值同一条理由（同形不同码）。这条比 adapter 严：adapter 对例外值是**规范化后落库**，这里是对**文件**直接拒绝。差别在来源——例外值是人手输入的运行时数据，目标方案文件是逐字抄来的、要被人对着出处核的成品；一个必须被改写才能参与比较的形式，宁可当场退回也不要静默替换掉。

## 关于 #189 第 6 条「一套定义两处使用」

#189 要求目标方案合法性校验复用 #177 的 R6，并明确写了「跨 goja/Go 两个运行时做不到字面意义上的一套定义，请先在 PR 里写明选了哪条」。

**选 ①：把调值/声母/韵母词表与合法性判据导出成数据文件，两边各自加载。**

但**本 PR 不做导出**，理由是现在没有可导出的东西：要导出的核心是**目标方案**的清单，而目标方案没有定义。先建一个只有 `source` 侧的共享文件，等真清单到手时形状必然要改，那才是真正会漂移的地方。

当前状态与代价说清楚：

- 调值合法性今天存在于三处：`scripts/corpus_probe/detectors.py`（`LEGAL_LONG_TONES`）、`scripts/scheme/data/tone_notation.json`（每列一套，且已有测试与前者对齐）、`backend/pb_hooks/lib/assist_rules.js`（R6）。**Go 侧目前是第四处的空壳**——它不硬编码任何调值，只读 adapter 自带的 `canonical.tone_values`。
- 因此本 PR 不新增第四份词表，也**没有**消除已有的三份。消除它是拿到目标方案之后的独立一步。

## 材料缺口（阻塞真实规则）

| 需要的东西 | 现状 |
| --- | --- |
| 莆仙乡音社方案清单（声母/韵母/调号） | ✅ **目标端已有**，源端仍缺。`backend/scheme/data/hinghwa_canonical.json` 是莆田城里口音的 15 声母 / 44 韵母 / 7 声调，逐条带 IPA、例字、出处与取回日期，由 `LoadScheme` 加载并在载入期校验（重复 IPA、无 IPA、无出处、非 NFC 编码都会拒绝加载）。出处 `https://hinghwa.cn/pinyin`，清单原文在该页的构建产物 chunk `js/166.c91cbba4.js` 的组件 `data()` 里。**只登记这一个口音**——页面原文明写「下面介绍的拼音方案为莆田城里口音」，其它口音要另登记。**源端**（各书凡例的符号 ↔ IPA）仍要逐本登记，这半没有材料 |
| 大词典「拼音方案 ↔ 国际音标对应关系」 | 凡例三.1 明写「请参见附录」。扫描版正文是 606 页，末页 p601–606 仍是 Z 段词条，**附录不在这个文件里** |
| 文读字汇方案清单 | ✅ 有。其凡例 p10–11 给了 18 声母 / 36 韵母 / 调类 1–7 全表 |
| 大词典罗马字清单 | 🟡 隐式。正本 `拼音` 列 + 键盘 `dictionary-romanization` 段可反推，但缺显式清单 |

拿到前两项之前，本包能且只能保持合成规则状态。`testdata/adapter_synthetic.json` 里每一条 basis 都写着 `synthetic`，就是为了让人一眼看出它不是语言学结论。

## #190 需要在这个包之上补什么

- 存储：`normalization_*` 字段落库与迁移（本包不碰 schema）；
- 作业面：`conversion_jobs`、批次游标、四行汇总；
- 复核队列：`AMBIGUOUS` 的 `candidates` 与 `trace` 已经在结果里，队列只是把它们摊开给人看；
- 反哺：人工结论写回 `exceptions`，本包的 `REVIEWED` 状态与 `basis` 字段就是为此留的形状。写回的通道必须经过本包的加载与校验——例外值是全场唯一在运行时不做清单核对的出口（理由见流水线第 5 级），绕过校验直接改文件就等于把 `EXACT` 发给一个拼错的值；
- **部署**：`backend/Dockerfile` 的构建上下文是**白名单式**的（`COPY *.go`、`reviewbundle/`、`pb_migrations/`、`keyboards/`），只有列进去的目录才在镜像里。方案文件因此必须放在 `backend/scheme/` 之下——#289 给这份白名单补的 `COPY scheme/ ./scheme/` 是**整目录递归**的，`data/` 会跟着一起进去，放到 `backend/` 的其它目录则不会。`scripts/check_docker_build_context.py` 钉的就是这份白名单。今天缺这条 COPY 还不致命，因为 `main.go` 尚未导入本包、镜像里那句 `go test ./...` 碰不到 `scheme/`；有代码真正加载方案文件的那一刻起它就致命——这也正是本包故意不写死默认路径（`FANGJI_SCHEME_ADAPTER_DIR` 由调用方给）的另一面：路径由人给，就必须有人保证它在容器里可读。
