# #122 / #310 本地运行时合成实测

2026-11-06。全部输入由 `ocr/runtime-benchmark.py` 原创生成，只使用仓库已分发的字体；没有读取真实词典、个人资料或待授权语料。原生 PDF 为 4 页、11 行，包含普通拉丁文字、IPA、组合附加符、扩展区 `𠮷` 与空页；扫描 PDF 是同四页渲染后仅含图像的副本。已实际查看 `synthetic-page-preview.png`，字体与布局可读。

这是一种**单列“原文”输入形状**的运行时工程验证，不是多列词典分列验收，不代表真实书籍或生产识别质量合格。尤其扫描样本的 4 个难字全部误识，**尚未达到防静默替换要求**，不能以每行 `needs_review` 代替逐格弃权质量证据。正式运行时因此采用 text-only：默认拒绝任何含图像的页，扫描只可在离线实验容器显式设置 `OCR_ALLOW_SCANNED_TEST=1`；主站后端还会独立拒绝 Tesseract/含图结果，不能由实验开关开启发布。没有改 gold、删除难字或改写引擎输出。

## 可复现入口

```sh
# 临时 Python 环境另装 reportlab、fonttools、brotli；系统需 pdftoppm、Docker。
python3 ocr/runtime-benchmark.py --image wanyu-ocr-validation:local
python3 ocr/score.py --gold docs/evidence/issue-122-310/native-gold.csv --test docs/evidence/issue-122-310/native-output.csv
python3 ocr/score.py --gold docs/evidence/issue-122-310/scanned-gold.csv --test docs/evidence/issue-122-310/scanned-output.csv
```

脚本建立 loopback 临时 worker，限制为 1 CPU / 768 MiB / 256 MiB tmpfs / 64 PID、UID 10001、只读根、全部 capabilities 移除、禁止提权，结束销毁容器。镜像 ID、每页真实返回、HTTP 状态、耗时、模型 SHA-256 和 PDF SHA-256 均在 `runtime-summary.json` 与 `*-page-*.json`；CSV 是对应 rows/cells 的直接投影。空页也保留，不从分母排除。另加 `mixed-native-title-plus-scan-image.pdf`：有原生标题和扫描正文，默认与实验模式都必须 422，不计入原 gold 或打分分母。最终镜像的这两类拒绝探针见 `productionDefaultProbe`。

生成器使用正确 UTF-16BE ToUnicode surrogate pair，避免 ReportLab 默认 `%04X` 对补充平面字符生成无效 CMap（例如 `<20BB7>`）。此修正只用于构建合法输入 PDF，不修补识别结果。字体由仓库 Liberation Sans、Charis 及 Rare Han 子集派生嵌入；CFF 转换后的临时字体另命名，仅在临时目录使用。许可沿用仓库 `frontend/public/pdfjs/standard_fonts/LICENSE_LIBERATION`、`frontend/public/fonts/phonetic/OFL.txt` 与 `frontend/public/fonts/rare-han/OFL.txt` / `SourceHanSans-OFL.txt`，未引入系统私有字体。

## 九项 score.py 指标

每种输入均为 11 行、4 个难字，按唯一物理字段“原文”、原行序比较。

| 指标 | 原生文本层 | 扫描图像 |
| --- | ---: | ---: |
| 字级错误率 CER | 0 | 0.0490 |
| 字级准确率 | 1.0000 | 0.9510 |
| 列归属准确率（此处仅一列） | 1.0000 | 0.7273 |
| 行对齐率 | 1.0000 | 1.0000 |
| 生僻字覆盖 | 1.0000 | 0 |
| 静默替换率 | 0 | 1.0000 |
| 集外字可表示性 | 1.0000 | 1.0000 |
| 合并未分离检出率 | 无案例 / 分母 0 | 无案例 / 分母 0 |
| 弃权质量 | 无 PUA/IDS 弃权格 / 分母 0 | 无 PUA/IDS 弃权格 / 分母 0 |

完整计数保存在 `native-score.json` / `scanned-score.json` 以及直接执行 `score.py` 的文本输出。`集外字可表示性` 只按 score.py 的“未被删除”定义计算，**并不表示认对**；扫描发生常见字替换仍可得到该指标 1.0。score.py 以 PUA/IDS 字符识别弃权格，不读取 runtime 的 `status`；空页 `abstained` 与整行 `needs_review` 不会变成该指标中的有效弃权，不能据此报满分。扫描第 3 页的误识原样在 JSON、CSV 与 `scanned-hard-character-errors.json` 保留，按 score.py 的同一 Levenshtein 回溯逐项为：

| gold 难字 | 实际结果 | 码位 |
| --- | --- | --- |
| ɑ | a | U+0251 → U+0061 |
| ɡ | g | U+0261 → U+0067 |
| 组合重音 ◌́ | & | U+0301 → U+0026，整格 `COMBINING á` → `COMBINING &` |
| 𠮷 | & | U+20BB7 → U+0026 |

## 资源与性能

本次 8 次串行单页请求全部 HTTP 200，失败率 0；总 API 等待约 10.01 秒，合计约 0.80 页/秒，p50 约 1.02 秒、p95 最近秩约 2.86 秒。原生 4 页约 0.10 秒（空白页保留为空串弃权，不调用 OCR），扫描 4 页约 9.91 秒。容器 `memory.peak` 为 319131648 字节，约 304.3 MiB，包含进程与子进程的整次容器峰值；不是某一引擎自身 RSS。固定 Docker VM、缓存、字体和 8 页小样本使这些值不代表大书吞吐、并发能力或生产 SLA。默认拒绝与混合页探针不混入该 8 次性能分母。

实际引擎：Poppler `25.12.0-r1`，Tesseract `5.5.2-r0`。语言模型实际在 `/usr/share/tessdata`，Alpine 模型来源为 `tessdata 4.1.0`（不是 tessdata_fast）：

- `eng.traineddata`：`daa0c97d651c19fba3b25e81317cd697e9908c8208090c94c3905381c23fc047`
- `chi_sim.traineddata`：`fc05d89ab31d8b4e226910f16a8bcbf78e43bae3e2580bb5feefd052efdab363`

本次最终镜像 `sha256:38551c2242f688e419db094156fc02950ceb387a72bfd28714263a6978c464e4`（Go 1.27.3 / x/net 0.62.0）。`productionDefaultProbe` 已实测原生页 200、扫描页 422、混合原生标题+扫描正文 422；显式实验模式下混合页仍为 422，8 次评分请求才启用扫描实验。真实授权、多列 gold 的双方核定、扫描难字质量、真实书级容量与 R2 CODEOWNER 复核仍是后续验收，不能由本份合成报告替代。
