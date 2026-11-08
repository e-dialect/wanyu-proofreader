# PR #394 复审与修复

本轮检查在隔离合成数据上进行。产品验证提交为 `25c568c10271a94923f57e7af6e412e22393410e`；后续线性重放仅变更提交父链，须验证产品文件保持一致，并以最终 head 的远端 CI 和 CODEOWNER 审批决定合并。

## 已修复的两处问题

1. 新增 Python `convert_product_cell` 对不超过128位的数字串仍调用旧递归枚举器。`a` + 40个 `1` + `2`、合法集合 `["1", "11"]` 无法完整分割，结果数量上限不能约束失败路径；修前回归5.011秒超时。产品入口现在统一使用动态规划，同一回归0.166秒通过，拒绝时整格保持原值。44项Python测试、59组Go/Python共享夹具及6558组有限新旧对照通过；旧 `convert_cell` 接口保持。本次耗时只是失败回归的有界性证据，不是通用吞吐基准，生产Go内核不涉及此缺陷。
2. 记音列在首次预览前被另一会话改为非记音用途时，服务返回400；旧界面仅为下载409提供重读入口，无法在当前页面更新选列。实际浏览器新增断言修前失败。现在错误区和无错误时的标题区均有显式重读操作，仍可直接编辑保留的配置。重读清除旧预览、展开配置并要求重新声明，不自动提交。完整tone脚本通过400/409、角色恢复、503、取消、旧账号迟到响应与390px断言。

## 最终本机复验

- `make check`通过：Go全包、前端492项、155项工具自测、57项后端harness自测、31条迁移up/down/up、格式/ESLint与Compose/OCR守卫。
- 生产构建、Python44项、全历史redacted Gitleaks通过。
- 独立只读API探针通过权限、快照变化、COUNT和取行间并发写入、行/字节/列上限、精确JSONL与损坏原值保留；探针采用临时初始schema加必需字段，完整迁移另由make check及真实浏览器harness验证。
- 非字符串JSON大整数原本即通过 `UseNumber` 保留；本次再次验证 `9007199254740993` 在候选JSONL精确保留，没有为此改产品代码。

最新 [result.json](result.json) 与桌面/手机PNG来自修复后的真实浏览器脚本，保留合成数据标记。实际日志：`/private/tmp/wanyu-tone-preview400-before.log`、`/private/tmp/wanyu-tone-preview400-after.log`、`/private/tmp/wanyu-pr394-review-{check,build,python,gitleaks,api-probe}.log`。未进行真实语言核定、原生手机验收或部署。
