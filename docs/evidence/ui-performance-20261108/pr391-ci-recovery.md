# PR #391 安全工具下载恢复

2026-11-08，`83ab4f7` 的 [CI run 42470396956](https://github.com/e-dialect/wanyu-proofreader/actions/runs/42470396956) 在 Frontend 的固定 Gitleaks 安装步骤遇到官方 release URL 持续HTTP504。重跑同样失败；53项成功，Frontend与依赖它的总门禁失败。安装未完成，不将其解释为扫描发现问题或前端行为失败。

从官方Release API查询的四个现有发布包版本、文件名与SHA均同原脚本；Linux Gitleaks包通过无凭据API下载实测8,230,402字节，SHA仍为 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`。备用API仅指向同一发布资产，不切换版本、镜像来源或校验值。

安装器仍先尝试原地址，失败后短暂退避，再尝试固定官方asset ID；每次重新计算续传偏移。所有下载仍在解包和执行前校验原SHA。全部失败明确退出，避免缺文件回溯掩盖下载原因。

验证：

- 五项隔离合成用例通过：主地址成功、官方API恢复/退避、部分下载续传、全部失败不安装、错误SHA不安装。
- 本机实际固定Darwin Gitleaks安装经历两次原地址504后从API恢复，校验通过并输出 `gitleaks version 8.30.1`；只写临时目录。
- `sh -n`、Git空白及完整 `make check` 通过。

工具版本、四个reviewed digest和扫描命令保持；没有关闭扫描、忽略结果或降低门槛。修复提交的远端CI结果另以当前head检查为准。
