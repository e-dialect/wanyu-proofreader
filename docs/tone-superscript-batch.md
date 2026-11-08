# 已有调值数字的批量上标候选

入口：项目 → 校勘 → 调值上标。此工具改变排版，不将调类序号映射成调值，不判断资料属于哪种方言，也不替代人工校对或来源核验。

## 操作与作用数据

1. 明确选择导入行，或只取 `status=approved` 的最终采用行；填写条号范围（不是 PDF 页码）。
2. 从项目当前 `reading` 列中选列。每列声明为「音节＋调值」或「仅调值」，并选择登记集合或自定义完整合法调值集合，填写资料依据。
3. 明确声明数字是已有调值，再生成逐格预览。歧义、不支持、混排、编号等情况整格保持原值并列出原因。
4. 查看预览后明确确认下载候选 ZIP。请求仍可取消；失败保留预览与配置，可人工重试，不自动重发。

没有默认方言。现有登记来源为 `scripts/scheme/data/tone_notation.json`；其莆田、仙游集合均不含53。明确自定义包含53时，`ka53`可形成`ka⁵³`候选；仅调值列的`53`可形成`⁵³`候选。音节列的裸数字、`第13页 qa533`、`a533 (编号21)`不转换。普通数字与上标混排整格拒绝；合法`@`缺字登记号原样保护。0为完整轻声值，不混入其他调值串。

原始Unicode、组合符及合法空白不 normalize、不 trim。最终采用行中的空字符串、纯空白、显式空对象和缺失字段分别处理，不回退导入值。旧纯文本成果仅在导入结构与最终结构均为空时按最终文本形成「内容」列，且此列仍须明确标为 reading 才能处理。原值包另保留 `raw_final_text`。

## API、权限与快照

- `GET /api/fangji/projects/{projectId}/tone-superscript`：当前记音列、登记规则与范围提示。
- `POST .../tone-superscript/preview`：只读预览。
- `POST .../tone-superscript/download`：同配置加预览返回的 `expected_basis`，重新读取一个只读事务快照后生成ZIP。

三个入口均要求项目管理权限并阻断首次强制改密。范围沿用工作文件边界：排除 importing，默认排除 withheld；包含 withheld 必须显式选择，仍不表示获准外发。每批最多1000条、10列、8MiB源数据，配置请求最多64KiB；超限返回413，要求缩小范围。读取和下载支持取消。

凭据绑定操作者、项目、条号范围、模式、选列、完整字段角色、全部原值/最终文本/列序及版本、规则文档、键盘定义与启用关系。变化或缺失返回409，需重新读取配置与预览；不能将旧预览自动套用新依据。前端另以项目/账号/请求代际和AbortController保护迟到结果，在读取Blob及触发下载之前检查当前身份。下载使用`Cache-Control: no-store`和准确Content-Length。

本功能不新增数据库表，不创建后台写作业，不写pages或normalization字段，不修改原文、校对状态、质量、来源判断或既有归一结论。多列上标排版不复用单列source→IPA→target归一槽，也不绕过其生产规则与expected_basis门槛。关闭工具或丢弃候选即可回退，不涉及项目数据回滚。

## 候选包

- `original.csv` / `candidate.csv`：同范围完整字段；前三个追踪列名称在manifest登记，发生名称冲突时安全改名。
- `original.jsonl` / `candidate.jsonl`：精确字段值，包含条目标识、条号、PDF页码；原值另保留原始结构/纯文本。
- `report.json`：逐格原值、候选、状态、异常原因、选择与依据。
- `manifest.json` / `README.txt`：范围、规则、快照及用途说明。

CSV沿用现有工作文件的公式防护，以公式字符开头的值会加单引号；JSONL保留精确字段值。候选包不是正式交付或质量通过凭据。人工核对后可按现有材料导入旅程使用；导入新材料会新建条目，不能将其理解为原项目原位覆盖。

## 规则与验证范围

生产镜像不依赖Python。Go内核嵌入规则的逐字节副本，现有Python unittest验证同步；两语言共用合成夹具，保留旧codec接口并为产品另加保守上下文护栏。镜像构建复制并测试tone包。

合成测试只证明实现与已登记集合、声明和安全边界一致，不代表完成任何方言的真实语言验收。canonical规则文件中关于莆田调值2的历史统计/说明与当前集合存在矛盾；本功能保留原文件，按明确列出的集合运行，不改写依据或声称重新核定。

可复跑：`go -C backend test ./...`、`python3 -m unittest scripts.scheme.test_tone`、`python3 backend/tests/run_frontend_quality_browser.py --only workbench`。后者的tone-batch真实App测试使用独立临时账号与数据；截图和结果在`output/playwright/tone-batch/`，随既有frontend-quality-browser artifact上传。
