# adapter v2：源侧 documented IPA 与两段箭头

本文件记录 `backend/scheme` 的 `schema_version: 2` 契约与落地形状，是 `2026-10-03-scheme-kernel.md` 在 #189 上的续篇。取舍的出处是 `2026-10-07-pinyin-pivot-interchange.md`（维护者访谈），本文只记落地。

## 为什么是两套独立映射

#114 §7 与 #189 把转换定义为：

```
source notation → documented IPA → target notation
```

v1 的 `Segment{from,to}` 只有一条边，把「源书怎么写」与「目标方案怎么写」压在同一行里。它无法回答两个不同的问题：

1. 这本书的凡例有没有登记这个片段？（源侧缺口，缺的是书）
2. 目标方案能不能拼出这个音？（目标侧缺口，缺的是清单）

压成一行之后，两种情况都是「没有规则」，复核员不知道该去翻书还是翻目标清单。v2 因此把两段分开，trace 也分开：

- 成功规则：`source_to_ipa:<rule id>`、`ipa_to_target:<rule id>`；
- 失败：`decline:source_to_ipa:<reason>` 或 `decline:ipa_to_target:<reason>`。

`Adapter.v2` 是未导出的编译结果，v1 路径完全不变；`Convert` 按 `adapter.v2 != nil` 分派。

## 文件形状

生产登记放在 `backend/scheme/data/source/*.json`，测试夹具在 `testdata/adapter_v2_*.json`，两者同构：

```json
{
  "schema_version": 2,
  "source_scheme_id": "puxian-dict",
  "canonical_scheme_id": "puxian-xiangyin",
  "rule_version": "puxian-dict-yanli-2026-10-18",
  "annotation_system": "tone_value",
  "rule_status": "test",
  "rule_status_basis": "…",
  "coverage": "…",
  "provenance": [{"what": "…", "locator": "…"}],
  "source": {
    "onsets": [{"id": "…", "notation": "b", "ipa": "p", "basis": "…"}],
    "rimes":  [{"id": "…", "notation": "ɑk", "ipa": "aʔ", "basis": "…"}],
    "tones":  [{"id": "…", "notation": "4", "category": "", "missing_category_reason": "…", "basis": "…"}]
  },
  "ipa_correspondences": [{"id": "…", "part": "onset", "from": "kh", "to": "kʰ", "basis": "…"}],
  "context_rules": [{"id": "…", "when_onset": "k", "when_rime": "ɑk", "rewrite_onset_ipa": "kʰ", "basis": "…"}],
  "exceptions": [{"id": "…", "source_pronunciation": "…", "canonical_pronunciation": "…", "status": "REVIEWED", "basis": "…"}]
}
```

关键约束：

- **目标清单只来自 `Scheme`。** v2 拒绝 `canonical` 与 `segment_map`：前者是同一份清单的第二份抄本，后者是 v1 的直接跳转。加载时目标 `Scheme` 的 `scheme_id` 必须等于 `canonical_scheme_id`。
- **`ipa` 与 `candidates` 互斥。** 一读多写是真实材料会有的事，结果给 `AMBIGUOUS`；同时写两者等于既确定又不确定。
- **零声母必须显式登记。** 空 `notation` 行的 `ipa` 必须是本项目的 `∅`。解析器把「没有声母」写成空串，引擎不据此推断 `∅`；缺这一行时转换在 `source_to_ipa:zero_onset_row_absent` 处 decline。
- **声调必须有 `category`，或写明 `missing_category_reason`。** 空 category 不会被补成任何东西，转换在 `source_to_ipa:missing_tone_category` 处停下。目标清单里同形的调值不参与判等。
- **`ipa_correspondences` 必须带 `basis`。** 它是材料明说「这两个写法是同一个音」时的登记，不是程序推断的等价。没有依据时宁可让二号箭头 decline。
- **`rule_status=production` 时，任何 `basis` / `provenance.locator` / `rule_status_basis` 以 `synthetic` 开头都被拒绝**，且必须至少有一条 provenance。
- 源侧 notation / IPA / candidates 在加载时做 NFC（手抄音标风险最高）；目标 `Scheme` 仍维持「非 NFC 直接拒绝」。

## 转换流水线

1. NFC + TrimSpace；整条发音例外优先（trace 记 `exception:<id>`）。
2. 用源声/韵/调最长优先切分；失败 → `decline:source_to_ipa:source_parse_failed`。
3. **一号箭头**：声母/韵母 notation → 各自登记的 IPA；`candidates` → `AMBIGUOUS`（候选翻成目标写法）；调 notation → `category`，缺 → `UNSUPPORTED`。
4. **上下文规则**：按文件顺序匹配源 notation 的邻接，改写**源 IPA**。同一 part 被改写成不同值 → `AMBIGUOUS / source_rewrite_conflict`。
5. **二号箭头**：先查 `ipa_correspondences`，再查目标 `Pivot()`。0 个 → `UNSUPPORTED`；多个 → `AMBIGUOUS` 并填 `Result.Candidates`。调类经 `ToneNotationsByCategory()` 得到目标调号，同样处理 0/多。
6. 按目标清单做合法性检查（`target_legality:<part>:<value>`）。

`Result` 形状不变；`Candidates` 始终是目标写法候选。

## 词汇表

一号箭头：`source_parse_failed`、`zero_onset_row_absent`、`no_source_onset_ipa`、`no_source_rime_ipa`、`no_source_tone`、`source_segment_one_to_many`、`source_rewrite_conflict`、`missing_tone_category`。

二号箭头：`no_target_onset_for_ipa`、`no_target_rime_for_ipa`、`no_target_tone_for_category`、`target_segment_one_to_many`、`target_tone_one_to_many`、`target_legality`。

## 已登记的部分真实材料

`data/source/puxian-dict-preface.json` **只登记《莆仙方言大词典》凡例正文能直接确证的内容**：

- 声母 `b=p`、`d=t`、`k=kh`（原文 ASCII）、`l=l`；
- 韵母 `ɑk=aʔ`、`ou=ɔu`、`ô=ɒ`；
- 调值 `4`、`21`、`453`，**不带调类**，各附 `missing_category_reason`。

来源是凡例 §三.1 的 `腹肚 bɑk4dou453 ↔ [paʔ4tɔu453]` 与 §三.2 的 `骹肚 kô21lou453 ↔ [khɒ21lɔu453]`。§三.2 明说这两条是**连读变调后**的读法，文件各行已照实注明。

这份文件的 `rule_status=test`、`MayDriveRealJobs()==false`。它能通过加载、走到一号箭头，并在 `missing_tone_category` 处如实 decline——它证明的是「不猜」，不是一台可用的转换器。

## 明确没有做

- 词典附录的声韵调对应表（未提供）。覆盖之外的任何音节都 `UNSUPPORTED`。
- 调值→调类。凡例没有这张表；目标清单里恰好同形的 `4`/`21`/`453` 不得用来判等。
- 文读字汇 adapter：其凡例有 18 声母 / 36 韵母 / 7 调类，但**没有 IPA 栏**，不补写。
- `kh`（ASCII）与目标 `kʰ`（U+02B0）的静默等同。没有文献依据前不登记 `ipa_correspondences`。
- 仙游音系、55 调、轻声：目标没有对应调类，`UNSUPPORTED`。
- #289 的运行时目录注册、UI、迁移与真实作业放行。`backend/scheme_conversion.go` 仍通过 `LoadAdapter` 读 v1；接 v2 时改用 `LoadAdapterWithScheme` 即可。

## 验证

- `gofmt -l backend/scheme/`、`go vet ./...`、`go test ./...`；
- `go test ./scheme/ -run 'V2|Partial' -count=5`；
- `make check`；
- 变异验证：v2 分派、`canonical_scheme_id` 匹配、production 下 synthetic 前缀拒绝、空 category 必须有 reason、零声母不推断、调类查表改成 `Tone.Value` 等值、源 IPA NFC、冲突改写 `AMBIGUOUS`、部分文件 `MayDriveRealJobs()==false`。
