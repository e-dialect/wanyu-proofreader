# #422 后续：容量工具的 POSIX 导入兼容

关联 #423，原评审：[fcntl 导入回归](https://github.com/e-dialect/wanyu-proofreader/pull/422#discussion_r4510348652)。

main 基线 `39e2d652644ce67b526b66c105b674f0ad7d0f1b`；运行源码 `e3bcdc5732303172c26d4e1aba6ed72f203f41ac`。
测试开始时是同内容的未提交工作树；三份源码 SHA-256 见 `validation.json`。本证据提交只增加文档。

## 修复

`fcntl` 仅在 POSIX 文件锁操作内导入，且在打开文件之前执行；容量 driver 和测试模块因此可在没有该模块的解释器中加载。
进程组入口在非 POSIX 平台统一抛出 `generator_process_groups_unsupported`，先于路径、umask、进程启动、poll 或信号操作。
缺失 registry 的错误优先级仍为 `generator_registry_required`；POSIX 文件锁、nonce、guardian 和清理协议保持原实现。

新增两个平台无关回归：在独立解释器中主动阻断 fcntl，对三个测试模块执行 unittest discovery 并检查 loader.errors，随后运行现有平台无关用例；以及模拟非 POSIX 后检查入口拒绝且没有副作用。

## 实际验证

- 在 main 原模块上拦截 fcntl：稳定得到三个模块加载错误；修复后同缺失条件可发现测试并运行平台无关用例。
- `python3 -m unittest discover -s backend/tests -p 'test_capacity_*.py' -v`：85 项通过，1 项可选真实浏览器测试跳过。
- 启用真实 Chrome 的 ownership 命令：16 项全部通过，包含正常关闭和父进程 SIGKILL 后的清理。
- `make check`：全部门禁通过，包括 Go 单测、590 项前端、168 项 scripts、24 项 ops、166 项后端 Python（1 项可选 Chrome 跳过）、43 个迁移 up/down/up 和六组 Compose 配置。
- `git diff --check`：通过。独立 agent 对三个源码文件复核无阻断，未独立运行测试。

完整命令及日志摘要哈希见 `validation.json`。完整检查仍输出已有 SQLite 连接的 ResourceWarning；无测试失败。

## 范围与回退

这是缺少模块和平台门禁的模拟，不是 Windows 实机验证，未新增 Windows 进程组清理支持。
未执行正式容量、15 分钟故障、远程 SSH、生产恢复或部署；合成测试使用临时数据。
R1，仅测试工具；可回退本次代码提交，无数据库迁移。Human verification: **Not manually verified**。
