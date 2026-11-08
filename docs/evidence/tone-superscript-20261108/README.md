# 调值上标候选验收

本次为合成数据与程序边界验收，不是真实方言语言核定。基线 `83ab4f7`，专用分支 `feat/tone-superscript-batch-20261108`。

- Go全套测试通过，内核另通过race测试；两语言共用59组夹具，其中29组保持旧codec行为。
- Python调值测试43项通过；前端Node测试490项通过，构建、定向ESLint、Prettier、UI债务与Docker构建目录守卫通过。
- 新tone-batch.cjs通过隔离临时后端与完整App实际执行。覆盖登记/自定义调值53、纯调值与记音模式、0轻声、占位号、混排整格拒绝、Unicode空白、最终空值/缺键/旧文本、权限、快照变化、409显式重读配置、失败重试、模态内取消及旧账号迟到响应丢弃。
- 使用合法字段大小的合成记录，分别验证1001条、8MiB源字节与64KiB配置的413上限。项目原文、校对与质量状态未被转换工具改写。
- 桌面1440×900与手机390×844；手机具名表格区域内部横滚，原值至少130px，无整页横向溢出。预览后配置折叠但输入DOM保留。截图为实际预览视口，无图像加工。

`result.json`由最终浏览器脚本生成。截图及结果的运行时真源在 `output/playwright/tone-batch/`，新脚本已挂到默认workbench组，CI显式要求这三份产物并随frontend-quality-browser artifact上传。复跑入口：`python3 backend/tests/run_frontend_quality_browser.py --only workbench`；本地最终tone脚本由同一harness单独运行，原workbench其他入口已分别通过，累计堆叠仍由发布候选执行一轮。

功能、API和规则限制见[调值上标说明](../../tone-superscript-batch.md)。本次未覆盖项目原位修改，也未进行部署。
