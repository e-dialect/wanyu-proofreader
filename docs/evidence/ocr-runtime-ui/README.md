# 本地 OCR 的真实浏览器联调

只使用程序生成的单页原生 PDF 和临时账号/数据库；Poppler/Tesseract 来自本地隔离 worker 镜像。没有向外部识别服务发送资料，没有使用真实词典或把合成材料当成双人 Gold。

本轮实际通过：超过200页的范围在发起前明确拒绝；一次网络503后保留页码/本次请求并可重试；真实引擎生成2行；前端显示处理页数、三态与工件入口；人工修正值 ` 𠮷\uE000⿰木木 a̤̍⁵³³ ` 的首尾空格、PUA、IDS、组合符和上标逐码位保存；原识别 metadata 不变；管理权限下载的原始 JSON 仍含原识别文本；刷新可恢复最新作业；POST已提交但202响应丢失时，requestId与会话恢复只取回原作业，不重复入册；390px不出现整页溢出。页面运行异常为0。

- [桌面识别结果](ocr-completed-desktop.png)
- [移动端结果](ocr-completed-mobile.png)
- [机器记录](report.json)

运行：先按项目说明安装前端、构建 SPA 并安装 Playwright/Chromium，然后执行 `python3 backend/tests/run_ocr_browser.py`。未给 `OCR_BROWSER_IMAGE` 时从本 checkout 构建 worker；给出时使用调用方刚构建的镜像。CI 从本次前端镜像提取真实 dist，以本次 worker 镜像执行同一脚本。

该用例验证工程链路。扫描质量、九项评分和资源记录在 OCR benchmark 专项中；是否足以用于真实方言词典，仍须代表性获准样本和双人核定真值。
