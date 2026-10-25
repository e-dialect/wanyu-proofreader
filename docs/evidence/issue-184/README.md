# #184 自动化验收记录

2026-10-18，Windows x64，Go 1.27.2、Node 24.19.0、Python 3.13.7、PocketBase 0.40.5，Playwright 使用已安装的 Edge。全部语料和身份均为自动生成的合成测试数据，不含真实语料、凭据或生产数据库。

Human verification: **Not manually verified**。以下为自动化证据，不能代替维护者对真实资料及部署环境的人工签认。

## 2026-10-25 评审修复验证

- P1：下载响应显式暴露 `X-Export-Count`、`X-Export-Content-Bytes` 和 `Content-Disposition`。新增浏览器回归从独立端口页面调用生产 `fetchProjectExport`，直连临时后端，触发真实 Authorization 预检及浏览器响应头过滤，不代理或 mock API。修复前稳定复现“导出响应缺少完整性信息”，修复后 CSV / JSONL 都通过完整性检查，并得到完整 Unicode 文件名。默认服务端集成也检查三项响应头均被暴露。
- P2：Unicode 集成不再引用删除的前端 CSV 模块，改从真实导出端点下载两种文件。CSV 由 Python 标准库独立解析，逐行核对生僻字表头、组合符号、最终/原始字段及条目 ID；校验 BOM、UTF-8 解码、字节数、行数与文件名。进程重启后再验一次两种导出，原导入、两人校对、仲裁与边界长度 note 的持久化断言保留。
- 本轮通过：Go 单测、vet、gofmt；前端 238/238、ESLint、production build；真实服务导出集成及上述跨域浏览器/既有下载 UI 验证；`run_rare_characters_integration.py` 的完整工作流和重启验收；18 项 migration up/down/up；套件清单、版本、行尾、空白、Compose 结构及六种 Compose config。
- 本轮没有重跑性能测量、全默认集成、竞态检测或 Docker 镜像构建；下文 2026-10-18 的记录仍是历史结果。本机没有 GNU Make，逐项执行等价检查。工具自测复现下文记录的 Windows 限制（scripts 5 个失败项、backend tooling 4 个错误、ops 1 个错误），UI debt 仍只有既有 inline_styles=28/27 warn。未将 `make check` 报告为全绿。

复现本轮关键回归（Go、Node、Python 在 PATH；浏览器测试另需已构建的 frontend/dist、Playwright 与 Edge）：

```powershell
$env:PYTHONUTF8='1'
python backend/tests/run_rare_characters_integration.py
$env:PROJECT_EXPORT_BROWSER='1'
$env:PROJECT_EXPORT_EVIDENCE='output/pr333-review/after'
python backend/tests/run_integration.py project_export_integration.mjs
```

## 12,000 行对比

相同数据库行，每行两列（生僻字/组合符号和重复合成释义），不含 withheld/importing，确保旧新路径行数相同。单次观测，不是性能 SLA；运行环境同时可能有其他本地测试。新文件更大，因为包含 provenance 及自说明元数据。原始数值保存在 [server-memory.json](server-memory.json) 和 [browser-memory.json](browser-memory.json)。

| 测量 | 历史路径 | 新路径 |
| --- | --- | --- |
| Go HeapAlloc 峰值增量 | 215,264,320 B（205.3 MiB） | 3,362,848 B（3.21 MiB） |
| 服务端耗时 | 728 ms | 2,406 ms |
| 服务端输出大小 | 28,044,920 B | 37,069,203 B |
| 浏览器 JSHeapUsedSize 峰值增量 | 260,471,436 B（248.4 MiB） | 88,564 B（86.5 KiB） |
| 浏览器取数至 Blob 耗时 | 3,143.5 ms | 2,480.6 ms |
| 浏览器输出大小 | 28,044,920 B | 36,781,203 B |

Go 对比为同一真实 PocketBase 数据库：历史留存 CSV 的全记录加载/行数组/完整字符串，对照新实现的统计、计长、流写三遍（写 io.Discard）。每次先 GC，1 ms 采样 HeapAlloc，记录相对该次基线的峰值。它测的是 Go 堆，不是进程 RSS 或网络下载耗时。

浏览器对比使用完整迁移后的真实 HTTP 服务及相同 12,000 行：重放旧 `getFullList` 分页与 CSV 生成，对照生产 `fetchProjectExport` 下载函数。每种路径独立页面、先 GC，通过 CDP 每 10 ms 采样 JSHeapUsedSize。旧函数同步拼接时保留历史中间对象 50 ms 供采样（该等待不计入耗时）。不计 Blob 原生内存、网络缓冲或浏览器 RSS；新路径仍持有约 35 MiB Blob，不能将 86.5 KiB 解释成浏览器总内存。两组测试的元数据/数据库夹具不同，文件大小不要求跨组一致。三遍扫描明显增加服务端 CPU/耗时，换取有界堆及精确截断检测。

复现（仓库根目录；Go、Python、Node 在 PATH，Playwright 和 Edge 可用）：

```powershell
npm --prefix frontend run build
$env:PYTHONUTF8='1'
$env:EXPORT_MEASURE_PATH='../output/issue184/server-memory.json'
Push-Location backend
go test -run '^TestProjectExportScaleEvidence$' -count=1 -v
Pop-Location
python backend/tests/run_project_export_measurement.py
$env:PROJECT_EXPORT_BROWSER='1'
$env:PROJECT_EXPORT_EVIDENCE='output/issue184/ui-evidence'
python backend/tests/run_integration.py project_export_integration.mjs
```

如果 Playwright 不在 Node 默认查找路径，设置 `PLAYWRIGHT_PATH` 为其包的绝对路径；浏览器可通过 BROWSER_CHANNEL 覆盖默认 msedge。measure 脚本的输出可用 PROJECT_EXPORT_MEASURE_OUT 指定。token 仅通过进程 stdin 传给测量页，不进入命令行、报告或截图。

## 功能证据

`project_export_integration.mjs` 经真实 ReviewBundle 入站、两人独立校对和一次仲裁建立夹具，逐列对照数据库与 CSV/JSONL 来源、轮次、质量及仲裁值。覆盖：默认 withheld 排除/显式包含、owner 无 membership、manager、平台管理员、校对成员、非成员、无登录；状态/质量/since 筛选、无效/重复参数、空结果；Unicode/组合符号/公式/引号换行；业务名与来源名冲突；未知来源留空；不写库/不落产物；重复导出只变 exported_at。Go 快照测试在统计后并发更新数据库，证明正文和计长仍来自同一快照。旧留存接口也验证默认排除与显式包含。

[server-synthetic.jsonl](server-synthetic.jsonl) 是真实服务返回的合成子集，包含 metadata 及四条数据（全项目六条，含一条 withheld、一条 importing，故 is_partial=true）。CSV 精确 BOM/CRLF 字节在集成测试中校验，未将 CRLF 下载件提交进要求 LF 的仓库。

实际构建页面直接连接临时后端、没有拦截 API 的浏览器验证：

| 证据 | 内容 |
| --- | --- |
| [01-csv-download.png](01-csv-download.png) | CSV 真实下载和四条结果提示；同时检查 Unicode 文件名、BOM |
| [02-withheld-error.png](02-withheld-error.png) | 暂缓外发筛选未显式包含时，服务端错误可见 |
| [03-mobile-download.png](03-mobile-download.png) | JSONL 显式包含后下载一条 withheld，390px 无横向溢出 |
| [04-empty.png](04-empty.png) | 空项目提示没有可导出的条目 |

## 实际检查结果

- `go test ./...`、`go vet ./...`、`go test -race ./...`、gofmt：通过。
- `npm --prefix frontend test`：238/238；lint、build：通过。
- `python backend/tests/run_all.py --jobs 3 project_export artifact_export project_access quality_state review_bundle`：5/5。
- 全部默认集成 `run_all.py --jobs 4`：31/32；assist_baseline 原有 URL.pathname 在 Windows 生成 `C:\C:\...` 且保留百分号编码，CLI 无法定位脚本，本次未修改该套件。其余 31 组（含导出/权限/仲裁/来源/列角色）通过。4 个非默认套件未在该运行执行；本次另行执行上述导出浏览器验证。
- 18 个 migration 的 up/down/up 与初始 schema 拒绝检查、36 项套件清单、运行时声明、六种 Compose config 和结构检查：通过。
- UI debt 棘轮返回成功；原有 inline_styles=28 超过 warn 基线 27，其他种类通过，此 PR 未增加内联样式。
- 本机没有 GNU Make，未直接执行 `make check`；以上逐项执行可用原生命令。工具自测存在已有 Windows 限制：scripts 130 项中 5 个失败项（2 个 POSIX 路径显示断言、发布镜像脚本的 Docker wrapper 用例含子项）；backend/tests 50 项中 4 个错误（备份符号链接权限/重命名及两个 /bin/sh 用例）；ops 6 项中 1 个符号链接权限错误。未把这些报告为全绿。
- Docker daemon 未运行，镜像构建未执行。没有部署、启用自动合并或合并 PR。

实际资料人工核验、目标部署的代理响应头/取消下载行为、Linux CI 和维护者合并仍需跟进。#114 标准化及编选/交付跨系统验收不属于本 issue；接口预留字段与契约已经说明。
