# 已有调值的上标排版内核

本包只改变**已声明调值**的数字排版，不识别某书使用的方案，不把调号推成调值，不改变文字、组合符或合法空白，也不表示音节、来源或质量已经通过核验。

## 接口

- `Rules() (RuleDocument, error)`：读取全新、可直接 JSON 序列化的规则文档，保留来源依据和所有现有字段。真源仍为 `scripts/scheme/data/tone_notation.json`；`scripts/scheme/test_tone.py` 验证 Go 嵌入副本逐字节同步。
- `doc.ToneValueScheme(id) (SchemeRules, error)`：仅允许 `annotation_system=tone_value`，明确拒绝调类方案。现有莆田、仙游调值集合不包含 `53`；不能因数字外形而推断其层次。
- `ValidateLegal([]string) ([]string, error)`：显式自定义集合仅允许完整轻声 `0` 或1–6位 ASCII `1`–`5`，输入最多64项，原顺序去重；不 trim 或自动修正声明。
- `SuperscriptMap([]string) map[string]string`：传入键盘中的**单个字符**；只返回可输入的 Unicode 上标数字。复合按键值应由调用方先拆成字符集合。Go 标准库没有 Unicode 名称查找，本包按 Unicode `SUPERSCRIPT ZERO` 至 `NINE` 的固定码位枚举；跨语言夹具及 Python 的 Unicode 名称推导共同校验它。
- `Convert(value, legal, superscripts) Conversion`：记音字段模式。每个非占位号数字串必须是 ASCII，并紧接 Latin/IPA 字母或其组合附标。页码、汉字编号、裸数字、混合普通/上标数字及脱离音节的数字整格拒绝。附标须追溯到可用字母，不能用汉字加附标绕过上下文保护。
- `ConvertToneOnly(value, legal, superscripts) Conversion`：明确声明为纯调值的字段，只接收一个完整合法值；保留首尾 Unicode 空白。已全上标且压平后合法的值为 `NO_TONE`；内部空格、记音正文、说明、混合数字均拒绝。仅显式自定义集合含 `53` 时，裸 `53` 才可转换。

占位号外的普通数字与上标数字只要在同格并存，哪怕位于不同片段，也整格拒绝并标记 `mixed_tone_notation`。`qa⁵³³@12345` 的登记号不参与混排判定。

`Conversion` 的 JSON 字段为 `text/status/tones/reason`。状态沿用 `EXACT/AMBIGUOUS/UNSUPPORTED/NO_TONE/EMPTY`。只有 `EXACT` 返回实际读到的调值串；其他状态逐字保留原值且不返回半转换调值。一个数字串本身不合法，即使能拆成一个或多个合法调值，也只能作为损坏/歧义报告，不猜拆分。长串的组合数计算采用动态规划，最多报告四种，不递归展开所有可能路径。

## 接入边界

调用方负责权限、账号与项目隔离、字段角色、选列和合法集合的依据声明、源数据快照、预览确认及下载凭据。本包不读数据库、不改原条目、不写归一结论，也不调用 Python。部署镜像只需包含 Go 包与嵌入数据。

`testdata/codec_cases.json` 全部为合成算法夹具，由 Go 和 Python 同时验证，并包含与现有 `convert_cell` 一致的记音用例。它们不是方言语料试用或真实语言验收证据。Python 的 `convert_product_cell` 和 `convert_tone_only_cell` 为独立产品入口，既有 CLI `convert_cell` 行为保持。
