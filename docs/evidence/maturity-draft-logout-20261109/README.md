# 主动退出与本机草稿（2026-11-09）

仅修改当前 AppShell 账户菜单的主动退出流程。`AppNavbar.vue` 当前没有被主应用引用，未引入全局 logout 拦截；auth store、401/403 强制失效、改密与跨标签账号切换仍可立即清除身份。

- 编辑器向所属 AppShell 注册同步 flush、返回编辑位置和已确认导航回调，卸载时注销。草稿归属固定为编辑器挂载账号，旧编辑器销毁时不会写入新账号。
- 点击退出先同步保存尚处于 500 ms debounce 窗口中的输入；保存或本机资料读取失败时保留登录和页面，只显示“返回处理”。
- 当前账号存在草稿或历史版本时，显示“返回处理 / 前往本机资料 / 保留草稿并退出”。返回恢复原字段焦点及起止选区；前往本机资料保留身份，定位到现有账户安全页的草稿区。
- 确认前再次 flush，并核验同一会话代次。A→B→A、token 变化或强制 clear 都使旧确认失效；旧按钮的排队点击不能退出新账号。
- 主动退出与卸载使用保留已有副本模式。未编辑的页面不会因为旧清理逻辑而删除另一标签页刚保存的唯一草稿；不自动删除当前、历史或其他账号的副本。没有当前账号草稿时，保存成功后直接退出。
- 正常返回/取消不重置表单。只有已经确认前往本机资料的那次导航临时放行编辑器离开 guard；强制身份失效直接放行，避免第二次原生确认阻碍清私密界面。

## 验证

- 纯 JS/真实草稿存储函数：账号隔离与历史保留、保存/枚举失败、编辑器归属固定、A→B→A、确认前再次保存、无本账号草稿直接退出。
- `draft-logout.cjs` 挂载真实 App、Vue、auth store 与编辑器，API 和资料使用合成 fixture。七项浏览器检查见 `report.json`，包含同一浏览器任务内 input→logout→立即读取 storage（不能靠 500 ms 定时器事后通过）、取消焦点/选区、存储 quota 失败、另一标签页唯一副本、旧确认按钮跨账号失效、强制 clear、真实本机资料页。
- repository 浏览器组（原仓库回归、退出、来源保真、转换草稿）通过；截图已目视检查。没有新增忽略浏览器异常的过滤规则。

复跑：

```sh
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
BROWSER_CHANNEL=chrome python3 backend/tests/run_frontend_quality_browser.py --only repository
```

需要现有 Playwright 运行时（可通过 NODE_PATH 指定），backend 测试 harness 仅启动一次性本地实例。没有生产数据写入、远程消息或部署。

## PDF 快速离开生命周期补充

退出浏览器测试曾记录一次未处理的 `Worker was terminated`，未加入忽略规则。源码复核确认：`loadPdf` 检查代次后等待旧 worker 销毁，在这个 await 期间可能已经换来源或卸载；原来恢复执行后仍会创建新的 worker。现捕获旧 task，等待后重新校验代次，且只清理仍由该调用拥有的指针；新加载也通过本地 task 等待 promise。

两个执行生产函数的可控回归分别覆盖 pending destroy→unmount 和 pending destroy→新来源：前者不能再调用 `getDocument`，后者只允许当前来源创建 worker。全前端 535 项、lint、production build、49 项测试清单门禁通过；真实浏览器退出七项也在此修复后通过。此修复不吞掉 worker 异常，不更换 PDF.js，也不改变 PDF 内容或访问规则。
