# 一次性 Docker 账户维护恢复演练

入口仅接受可信的本地后端镜像和空输出目录；不接受现成容器、卷、数据目录、URL 或凭据。

```sh
python3 backend/tests/run_account_recovery_container.py \
  --image fangji-backend:ci \
  --output output/maturity/account-recovery-container
```

脚本通过本机 Docker socket 创建随机命名的数据卷和非 root 后端容器，固定只读根文件系统、cap-drop ALL、no-new-privileges、CPU/内存/PID 上限，所有容器使用 `--network=none` 且不发布端口；通过容器内 `curl --config -` 访问固定 loopback 地址执行真实 HTTP，认证头和 JSON 请求体只走 stdin。合成 bootstrap 密码通过环境变量传入；恢复密码只经关闭回显的 PTY 送入原维护包装器，再由包装器通过 stdin 送入恢复命令，不放入 argv、环境或报告。

演练直接调用 `scripts/recover_account.py`，依次验证：运行中的后端被拒绝；后端停止但有活跃共享挂载时被拒绝；停止所有使用者后恢复成功；重启后旧密码、旧 token 失效，新密码可用且必须首次改密。恢复前将合成管理员降为普通用户并把 verified 改为 false，重启后核对 ID、邮箱、角色、verified 与用户总数均保持，证明旧 bootstrap 配置不会重新提权。最终只清理自身创建并记录身份的资源，不创建或修改 Docker 网络。

CI 已接入现有 `Containers` job，紧跟后端镜像构建，并始终上传脱敏 `report.json`。收据仅含布尔断言、固定状态、不可变镜像 ID、实际构建版本及脚本哈希；不保存原始账户资料、密码、token 或容器日志。构建版本来自实际镜像标签与后端启动日志，不根据镜像 tag 推断。

实际结果：2026-11-09 本地演练全部 11 项 gate 通过，见 [脱敏回执](report.json)。使用不可变镜像 `sha256:8fadc8921943aea78636da99582fe52cb0f380d1e18f3323e341fb460f322589`，镜像标签和实际后端启动版本均为 `a8d44dd1ab5906ad8ca35dd6b6af6da967b23bc2`；维护包装器包含独立限额提交 `c4c99a7`。回执记录两份脚本哈希，未把此版本混同于主集成树的容量测试版本。

早期网络方案的失败保留在 [尝试回执](earlier-attempts.json)：前两次在创建默认网络时失败，第二次用固定类别诊断确认 Docker 默认地址池耗尽；第三次内部网络未提供 loopback published binding，在业务验证前失败。三轮均成功清理。最终 `network=none` 方案不依赖默认地址池；结束后按专用标签只读核查，容器、卷和网络剩余均为 0，没有修改或清理既有 lab 资源。

本次另通过 7 项既有维护守卫单测、真实 PTY 无回显对话检查、CI YAML 接线及套件清单检查。本记录仅覆盖合成数据的本地 Docker 维护恢复，不代表生产数据恢复、真实 SMTP 或容量验收。
