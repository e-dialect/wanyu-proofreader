# OCR 效率与页级反馈复核

基线：`83ab4f7`；独立分支 `perf/ocr-refinement-20261108`。材料全部来自仓内合成 PDF，没有使用真实授权语料，也不声称识别准确率提高。

## 本轮修复

- 默认路径先查图像。含图像的拒绝页只启动 `pdfimages`，不再先跑两次 `pdftotext`；扫描、原生标题加扫描正文、装饰图仍拒绝发布。原生页面仍保留两份文字/布局证据。
- 内部 HTTP client 仅在同一作业内复用，三页任务由三条 TCP 连接降为一条；下一任务创建自己的 client。逐页超时、输出上限、取消及原有原子发布不变。
- 页级失败明确实际 PDF 物理页，避免从第20页开始的作业把第二个失败请求写成“第2页”。前端展示保存的作业页段与首个未完成页，不推测 worker 当前页。

## 可复现实测

```sh
python3 ocr/preflight-benchmark.py --base 83ab4f7 --samples 20 \
  --output docs/evidence/ocr-refinement-20261108/engine-benchmark.json
```

需本地 Go 1.27.3 和 Poppler。可用 `GO_BINARY` 指定已安装的 Go。脚本在临时目录使用 Go overlay 构建旧实现，不切换或编辑 checkout。`engine-benchmark.json` 记录 fixture 哈希、平台、每组20次耗时和结果哈希；测量为本机串行执行，不推断生产容量。

| 所选物理页类型 | 旧中位数 | 新中位数 | 结论 |
| --- | --- | --- | --- |
| 合成扫描页，拒绝 | 233.98ms | 78.56ms | 仅拒绝路径，解析命令3→1 |
| 合成原生标题＋图像页，拒绝 | 235.23ms | 77.13ms | 拒绝规则保持，解析命令3→1 |
| 合成原生文字层 | 250.13ms | 239.10ms | 未减少提取命令；用于保真检查，不宣称吞吐提升 |

原生页面去除 `duration_ms` 后的完整 `Result` JSON SHA-256 前后一致：
`1f227d9181b25e5552615cad49d0aad8b66bb2c3fe14a03e2eeee188c2607c7e`。
比对包括原始文字、bbox XML、坐标、来源及三态。拒绝页提前返回错误，不再生成文字提取结果；HTTP错误协议及不发布条目的边界保持。

`TestOCRReusesWorkerConnectionOnlyWithinOneJob` 反向应用旧 `ocr_service.go` 时确实失败，报告首个三页作业创建3条连接；当前实现通过，连续两个作业共6次逐页请求、2条连接。测试仍逐次核对不可变 PDF 内容和内部鉴权。

## 回归

```sh
cd backend
go test ./ocrengine ./ -run 'Test(ImagePreflight|OCRReusesWorker|OCRPageFailures|OCRShutdown|OCRStoppedBefore|OCRWorkerFailure)' -count=1
go test -race ./ocrengine ./ -run 'Test(ImagePreflight|OCRReusesWorker|OCRPageFailures|OCRShutdown|OCRStoppedBefore|OCRWorkerFailure)' -count=5
go test -race ./ocrengine ./ -run 'OCR|Native|TSV|Command' -count=1
cd ..
python3 backend/tests/run_ocr_runtime_integration.py
OCR_BROWSER_IMAGE=wanyu-ocr-browser:refinement-20261108 python3 backend/tests/run_ocr_browser.py
```

上述专项已通过；前端 OCR 状态/页段/请求恢复7项 Node 测试、ESLint、Prettier、UI债务检查及生产构建通过。原生空页仍弃权，PUA/IDS/组合符/空白与坐标保留；显式离线扫描实验仍待确认，高置信度不提升为正确。race×5覆盖活动/排队停机、空闲退出、失败进度后重放的四种组合和再次失败。真实runtime覆盖权限、快照、并发幂等、未知请求恢复、失败清理、CSV隔离与重启。

真实浏览器保持原有校正、原始证据下载、网络失败、丢失202后的重试、刷新和手机断言，另验证混合图像PDF失败定位与0条目发布。使用生产dist及从 `frontend/nginx.conf` 读取的同一CSP；测试host不是Nginx容器本体。CSP违规和页面异常均为0。

容器验证复用已缓存的 `wanyu-ocr-browser:experience` 运行时，仅替换当前交叉编译的worker二进制（临时镜像 `sha256:e59daddd8148b9fbfc532f92c295bcff194b937c11321042323436517b7050cc`）。完整Dockerfile的离线构建未命中APK缓存，已中止，未安装或更新依赖。未推送镜像或部署。

本次本机日志：`/private/tmp/wanyu-ocr-runtime-refinement-20261108.log`、`/private/tmp/wanyu-ocr-browser-refinement-20261108.log`、`/private/tmp/wanyu-ocr-race-20261108.log`；浏览器报告与截图在本工作树的 `output/playwright/ocr/`。

## 保留的效率限制

每页仍传送整份不可变 PDF，也仍需各自解析原生文字与布局。消除此开销需要新的、受控的worker会话或逐页流式协议，以及超时、取消、文件生命周期和重启恢复审查；本轮没有用跨作业缓存绕过这些约束。既有扫描发布门槛、模型与语言配置不变。
