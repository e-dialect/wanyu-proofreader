# 分机入口本地传输验证

完整隔离两端编排、真实 HTTP、两个浏览器、目标端 Node 静态代理与临时数据库对账的功能演练。未执行外部 SSH、访问生产或使用真实分机。脱敏回执见 [local-transport.json](local-transport.json)，实现与边界见 [capacity-remote.md](../../capacity-remote.md)。

第二轮 200 条/8 actors/12 秒，UI 提交 13/14 次，27 次确认均与数据库行摘要和审计链一致。mixed_status=pass；总体仍 fail，因为同机分离 gate 失败，预算空值与旧基线实际 runtime 字段缺失等 gate 为 incomplete。helper 退出 0，目标清理通过，runtime build_sha 与实际 HEAD 一致，二进制 SHA 保留。第一轮输入线程退出缺陷与样本耗尽错误保留原结果，未追改为通过。

第二轮之后只补强了 detached 生成器后代清理、严格 JSON 非有限数/重复键拒绝及相应负面测试，未再次重跑混合负载；完整执行源摘要随回执记录。该证据不满足正式 20k/30/60min×3、参考硬件、真实 Nginx、共驻竞争或容器硬限验收。
