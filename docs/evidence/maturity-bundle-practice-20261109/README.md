# 虚构 Review Bundle 练习材料（2026-11-09）

基于 `03a3a3c` 的独立工作树。材料、账号及数据均为本地合成测试；没有生产写入、部署、外发、消费方验收或真人签字。

## 材料与入口

- `frontend/public/examples/review-bundle-practice-v1.zip`：14,216 字节，固定日期的 `ReviewBundle/v0`，3 条、3 页可读 PDF 和逐步说明；SHA-256 为 `52d59ff835d2d6c3ef2dcfe874366a349141ad8e6c247bf1292c049d8ef55a25`。
- 同名目录提供可单独下载的 PDF、说明、manifest 和 JSONL。manifest 仅列 JSONL；PDF 不会随 ZIP 自动导入，说明要求先单独上传 PDF。
- 管理员帮助链接到文件说明页的练习段落；CSV 练习仍作为轻量输入练习保留。
- 源码生成脚本使用既有 Bundle/v0 字段与标准 ZIP；`--check` 只读核对产物一致性。PDF 使用内置标准字体与明确虚构标签，不包含真实方言事实、身份或凭据。

## 人工闸门

来源登记与用途写入需平台管理员，独立校对需两个不同账号。说明保留来源状态及用途未知时的阻断，并分别说明编选用途与原始材料转交第三方的许可；不预填允许、来源判断、签名或确认框。普通构建可使用该流程，不要求测试转换规则，也不要求勾选“记音归一已定稿”。

编选只选同一个完整成功的 Bundle 作业，核对三类数量合计 3。可选第三条阻塞／排除练习不改变整个来源的用途；采用、排除、待处理的正文边界明确。交付预检之后仍由人决定是否生成，仅建议本地练习；未真正接收时保持待回执，不代签，不把下载成功当作外部验收。

## 已执行检查

- `review_bundle_integration.mjs` 向真实一次性服务的 `/api/fangji/bundles/validate` 上传这个公共 ZIP，返回 `ok=true`、`ReviewBundle/v0`、3 条、无错误；预检前后 projects/pages/import_jobs/users 数量相同。
- 真实 Chrome 1440×900 与 390×844：帮助入口、实际下载字节与公共 ZIP 一致、3 条预检、来源声明、确认框未勾选、导入按钮禁用、零入站作业。沿用同一脚本的原有不同合成包导入、幂等、Unicode、手机和 CSV 重试检查也通过。
- PDF 三页由 Poppler 渲染并目视检查；文本提取与三个 JSONL 字段一致。
- 前端 538 tests、lint、production build、49 项测试清单检查通过；生成脚本只读一致性检查通过。

公共样例在本次自动测试中只走只读预检及人工确认边界，没有用机器人代替它的双人来源判断／权限决定／交付确认。管理员按下载说明重放完整练习；真实业务、真实成员操作与外部接收仍需单独验收。

## 本页锚点定位的对照

测试可见性标准是练习标题进入 1440×900 视口上半部，而非固定 `y < 200`：段落靠近文档底部时，最大滚动量可能无法让它贴齐顶部。

移除本页定位处理后，直接打开带 `#review-bundle-practice` 的链接，等待 30 秒仍停在文档顶部；练习段落位于首屏以外，无脚本错误。对照截图为 `hash-without-local-positioning.png`。恢复后真实浏览器按上述标准通过，入口和内容见 `practice-guide-desktop.png`、`practice-guide-mobile.png`。

定位仅作用于本页这个 hash：等待渲染，在下一帧重新核对 hash 和元素是否仍连接，再滚入可视区。没有修改全局 router 的滚动策略、其他页面或任何输入状态。

## 复现

```sh
python3 frontend/scripts/build-review-bundle-practice.py --check
GOMAXPROCS=2 python3 backend/tests/run_integration.py review_bundle_integration.mjs
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
BROWSER_CHANNEL=chrome python3 backend/tests/run_frontend_quality_browser.py --only workbench
```

浏览器沿用仓库 Playwright 运行时；可通过 `NODE_PATH` 提供。此次定向执行现有 `frontend/tests/browser/review-bundle.cjs`，未重复运行整个浏览器组。截图和报告中的数据全部为合成测试，不是用户材料。
