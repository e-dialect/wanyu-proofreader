# 拼音方案归一化引擎（#189 内核）

本文件说明 `backend/scheme/` 的流水线、数据形状、加载器的拒绝面，以及**哪些决定被有意留在引擎之外**。

一句话定位：这是一个**没有装真实规则**的转换内核。莆仙乡音社方案（#114 指定的转换目标）在本仓库与全部本地材料里都没有清单，所以此刻往里填任何对应表都等于凭空推断，正是 #114 §7 与 #189 非目标禁止的事。本包交付的是 #189 点名的结构、状态机与门槛，规则是数据，等材料。

## 流水线

`Convert(input, adapter)` 按 #114 §6 的顺序走六级，每一级都在 `convert.go` 里单独可测：

| 级 | 做什么 | 失败时的状态 |
| --- | --- | --- |
| 1 Unicode 规范化 | 只做 NFC。不做 NFD/NFKC——那会把 `ɑ` 与 `a`、预组合鼻化与裸附标之间的区别抹掉 | — |
| 2 音节解析 | 声母/韵母/声调三段，最长匹配优先，顺序固定不依赖 map 遍历 | `UNSUPPORTED` |
| 3 分段映射 | `segment_map` 逐段查；命中一对多即停 | `AMBIGUOUS` |
| 4 上下文规则 | 只在指定邻接下改写，用于凡例三.2 那类「一个字符串两层音系」 | — |
| 5 例外表 | 整条覆盖，承载人工复核结论（#190 第 4 条的反哺落点） | 取其声明状态 |
| 6 目标合法性 | 产出的每一段都必须在目标清单里 | `UNSUPPORTED` |

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

## 加载器的拒绝面

`LoadAdapter(path)` 只接受显式路径，**没有默认值**（#193/#195 的教训：默认值会把某个人的家目录发布出去）。以下情形一律返回 `ErrInvalidRule` 而不是半生效：

- `schema_version` 不是 1；
- 源方案与目标方案同名；
- 缺 `rule_version`（没有它 trace 无意义）；
- `annotation_system != tone_value`——《文读字汇》的 1–7 是**调类**，与大词典的**调值**同形不同义，字符串层面无法区分，所以必须由登记方声明，程序不猜；
- 规则 ID 重复；某条映射的目标值不在目标清单里；一对多规则同时写了 `to` 与 `candidates`；
- 例外条目声明了 `AMBIGUOUS`/`UNSUPPORTED`（例外是人工结论，只能断言确定值），或 `REVIEWED` 却没写 `basis`。

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
| 莆仙乡音社方案清单（声母/韵母/调号） | **零材料**。仓库、`WanYu-Docs` 全部文件、执行手册 docx 内均无「乡音社」三字；它只出现在 #114 的正文里 |
| 大词典「拼音方案 ↔ 国际音标对应关系」 | 凡例三.1 明写「请参见附录」。扫描版正文是 606 页，末页 p601–606 仍是 Z 段词条，**附录不在这个文件里** |
| 文读字汇方案清单 | ✅ 有。其凡例 p10–11 给了 18 声母 / 36 韵母 / 调类 1–7 全表 |
| 大词典罗马字清单 | 🟡 隐式。正本 `拼音` 列 + 键盘 `dictionary-romanization` 段可反推，但缺显式清单 |

拿到前两项之前，本包能且只能保持合成规则状态。`testdata/adapter_synthetic.json` 里每一条 basis 都写着 `synthetic`，就是为了让人一眼看出它不是语言学结论。

## #190 需要在这个包之上补什么

- 存储：`normalization_*` 字段落库与迁移（本包不碰 schema）；
- 作业面：`conversion_jobs`、批次游标、四行汇总；
- 复核队列：`AMBIGUOUS` 的 `candidates` 与 `trace` 已经在结果里，队列只是把它们摊开给人看；
- 反哺：人工结论写回 `exceptions`，本包的 `REVIEWED` 状态与 `basis` 字段就是为此留的形状；
- **部署**：`backend/Dockerfile` 目前只 COPY `*.go`、`reviewbundle/`、`pb_migrations/`、`keyboards/`。真实规则文件一旦放进 `backend/scheme/data/`，必须同步加一条 COPY，否则镜像里读不到——这是本包故意把路径交给调用方、不写死默认值的另一个原因。
