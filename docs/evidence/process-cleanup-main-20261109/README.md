# #420 — 进程清理在新 main 上的复验

基线为已合并 #404–414 的 `c728b49c2a075c12e7aeadcef2f1473019066d4e`。
旧提交只顺序移植 `4c8f5c9`、`32fc977` 本提交，分别生成 `c777c5e`、`cafca08`，没有带入旧父分支。
随后 `902eebf7f890405565b9c9775e46e6d3915380cf` 移除无 registry 时按扫描 PGID 补杀的兼容分支。
全部原工作树和历史回执保留；本目录记录新基线上的实测，不复用旧 SHA 的通过结果。

## 归属与异常边界

- 没有 registry 时，无论父进程仍运行还是已经退出，一律拒绝且不发送进程组信号。
- 有 registry 时，仍未回收的直接 `Popen` 子进程保持其 PID 身份；detached 子树只由存活 guardian 向自己的组发信号。控制器只写 nonce 停止请求，不向历史 PID/PGID 补杀。
- 私有目录、nonce、票据、OS 出生身份和关闭门禁校验保持；错误票据不能跳过其他可确认归属的组。归属或清理无法确认时为 incomplete；既有业务失败仍为 fail。
- fault suite 顶层使用 SIGINT 给既有 finally 清理窗口，真实后端 PID 与有意重启操作保持不变。Playwright 的 argv、环境、cwd、fd 3/4 与 detached 语义保持。
- 仅固定测试子树收到 Node preload。不会扫描并清理其他工作树、Docker、任意已存在服务或生产数据。

## 实际验证

三组 Python 测试对应 `902eebf` 的最终代码，共 **41 项通过**：14 项进程归属（包括真实 Chrome 正常关闭及父 SIGKILL）、9 项故障包装器、18 项 remote 协议/边界。14 项归属与以下功能 smoke 在干净提交上复跑；另外两组在提交前相同运行时和套件文件上通过。覆盖 PID 复用、检查后身份变化、无响应、闭门后延迟启动、超时、KeyboardInterrupt、故障退出码、nonce/目录/软链接、无票据零信号及脱敏错误。

```sh
CAPACITY_OWNERSHIP_PLAYWRIGHT=1 NODE_PATH=/private/tmp/wanyu-playwright-runtime/node_modules BROWSER_CHANNEL=chrome python3 -m unittest discover -s backend/tests -p test_capacity_process_ownership.py -v
python3 -m unittest discover -s backend/tests -p test_capacity_faults.py -v
python3 -m unittest discover -s backend/tests -p test_capacity_remote.py -v
```

通过现有 `run_capacity_faults.controlled_run`，每项 timeout=300 秒、GOMAXPROCS=2，实际执行：

1. `python3 backend/tests/run_scheme_conversion_integration.py`：中断转换、真实重启、游标恢复和规则变化，17.070 秒，退出码 0。
2. `python3 backend/tests/run_frontend_quality_browser.py --only components`：实际 Chrome 控件、offline/online/auth 恢复及管理端失效回归，41.739 秒，退出码 0。

复跑可在已安装锁定前端依赖和 Playwright/Chrome 的开发机上，用上述环境变量执行以下现有包装器；输出目录应为本次自建目录：

```python
import sys
from pathlib import Path
sys.path.insert(0, 'backend/tests')
from run_capacity_faults import controlled_run
root = Path.cwd()
output = root / 'output/maturity/process-cleanup-repeat'
output.mkdir(parents=True, exist_ok=False)
for name, script, arguments in [
    ('restart', 'run_scheme_conversion_integration.py', []),
    ('components', 'run_frontend_quality_browser.py', ['--only', 'components']),
]:
    code = controlled_run([sys.executable, str(root/'backend/tests'/script), *arguments],
                          root, output/(name+'.log'), timeout=300)
    if code:
        raise SystemExit(code)
```

实测前后源码 manifest 一致，dirty diff 为空。包装器登记的 **6 个进程组均无存活成员**，其私有登记目录均已删除；最后只读检查本工作树相关 Node/Python/backend 进程为零。两次 Chrome 退出模式也各自断言登记组清空。详细本地脱敏日志位于 ignored `output/maturity/process-cleanup-main-20261109/`，提交的 JSON 只保留计数、提交与文件摘要。

这证明合成数据下的清理与实际 runner 接线；**不是正式 15 分钟故障验收、正式容量、Docker 清理或远端 SSH 验收**。没有部署。将来新建独立会话的 Python/native 子树必须显式登记，不存在全局 subprocess 接管。此证据文档提交不改变上述运行时代码。
