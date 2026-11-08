# 调值上标候选验收

逐PR复审后新增的两项修复及最终累计复验见 [review-fixes.md](review-fixes.md)。下文保留首次样板验收；浏览器JSON/PNG已刷新为修复后的结果。

本次为合成数据与程序边界验收，不是真实方言语言核定。基线 `83ab4f7`，专用分支 `feat/tone-superscript-batch-20261108`。

- Go全套测试通过，内核另通过race测试；两语言共用59组夹具，其中29组保持旧codec行为。
- Python调值测试43项通过；前端Node测试490项通过，构建、定向ESLint、Prettier、UI债务与Docker构建目录守卫通过。
- 新tone-batch.cjs通过隔离临时后端与完整App实际执行。覆盖登记/自定义调值53、纯调值与记音模式、0轻声、占位号、混排整格拒绝、Unicode空白、最终空值/缺键/旧文本、权限、快照变化、409显式重读配置、失败重试、模态内取消及旧账号迟到响应丢弃。
- 使用合法字段大小的合成记录，分别验证1001条、8MiB源字节与64KiB配置的413上限。项目原文、校对与质量状态未被转换工具改写。
- 桌面1440×900与手机390×844；手机具名表格区域内部横滚，原值至少130px，无整页横向溢出。预览后配置折叠但输入DOM保留。截图为实际预览视口，无图像加工。

`result.json`由最终浏览器脚本生成。截图及结果的运行时真源在 `output/playwright/tone-batch/`，新脚本已挂到默认workbench组，CI显式要求这三份产物并随frontend-quality-browser artifact上传。复跑入口：`python3 backend/tests/run_frontend_quality_browser.py --only workbench`；本地最终tone脚本由同一harness单独运行，原workbench其他入口已分别通过，累计堆叠仍由发布候选执行一轮。

功能、API和规则限制见[调值上标说明](../../tone-superscript-batch.md)。本次未覆盖项目原位修改，也未进行部署。

## 累计分支补验

在继承 OCR 与 UI 精修的累计实现（产品提交 `6fbfa2b`）上重新执行完整 workbench、components 组，均通过。实际覆盖工作台、条目、加入/继续/只读回看、Review Bundle、导入错误、Reka 焦点/展开保真与调值工具；使用临时真实后端、合成账号与 Edge/Playwright 1.65.0。三份证据由此次完整入口刷新，桌面和手机截图已经视觉复看。

最终 `make check` 通过：Go全包、前端492项、154项工具守卫、9项ops、57项后端守卫、31条迁移up/down/up、格式/ESLint及6组合Compose/OCR检查。生产构建及全历史redacted安全扫描通过。底层scope登记的文档更新未改变产品代码。

本机复跑日志：`/private/tmp/wanyu-final-stack-browser.log`、`/private/tmp/wanyu-final-stack-check.log`、`/private/tmp/wanyu-final-stack-build.log`、`/private/tmp/wanyu-final-stack-gitleaks.log`。远端CI仍以PR当前head为准；真人方言验收、原生手机输入法及上线未执行。
