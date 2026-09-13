# Asset and Data Boundaries / 资产与数据边界

The root AGPL declaration applies only to original software code that
e-dialect is authorized to license. It does not grant rights to material merely
because that material is uploaded to, stored by, exported from, or bundled
beside the application.

| Path or material | Boundary |
|---|---|
| Original application code, tests, migrations, hooks, and configuration authored for this repository | Software license in [`LICENSE`](./LICENSE), subject to authorship and path-level exceptions |
| `frontend/public/pdfjs/**` | Third-party PDF.js distribution and path-level notices; see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) |
| `frontend/public/fonts/**` | Third-party font software and subsets under their adjacent OFL notices; names and subsets do not transfer copyright |
| Synthetic test fixtures | Test code/data only; they must not contain production documents, accounts, or real personal data |
| Imported PDFs/CSV, dictionaries, corpora, proofreading projects, annotations, and user content | User/operator assets; not licensed by the repository software license and require their own lawful source and terms |
| PocketBase runtime data, `pb_data`, backups, caches, and logs | Operational data; excluded from the repository software license and subject to access, retention, privacy, and security controls |
| Review bundles and generated exports | No automatic new license; rights depend on their inputs, contributors, contracts, and applicable data terms |
| Recordings, voice samples, model weights, and generated audio/data | Require separate speaker/voice, model, data, and output-rights review |
| `乡声万语`, `万语校坊`, historical `方辑` branding, logos, and visual brand assets | No trademark or brand permission is granted by the software license |

Moving an external asset into this repository does not change its ownership or
license. A future data, document, media, or voice contribution must identify
source, provenance, consent where relevant, and an explicit asset/data
agreement. The code CLA is not a substitute for those permissions.

---

根 AGPL 声明只覆盖 e-dialect 有权授权的原创软件代码。文档、语料、词典、录音、标注、
用户内容、运行数据库、模型、生成物或品牌资产不会因为被软件上传、存储、导出或与软件
一同放置就自动获得代码许可证。相关材料须分别确认来源、权利、同意、隐私与适用条款；
代码 ICLA 不能代替数据、媒体、说话人或声音合成授权。
