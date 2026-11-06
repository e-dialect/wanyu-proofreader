# 编选历史分页验收

2026-11-06，1440 × 1000 浏览器视口，使用一次性、完整迁移的本地 PocketBase 和当前前端生产构建。所有账号、项目、批次和条目都是合成数据。

| 图片 | 验收内容 |
| --- | --- |
| `history-first-page.png` | 102 个批次，第一页 25 条，上一页禁用 |
| `history-page-error.png` | 浏览器拦截第二页请求并返回 503；原列表与第一页页码保留，提供重试 |
| `history-last-page.png` | 重试成功后翻到第五页，剩余 2 条，下一页禁用 |
| `history-oldest-details.png` | 打开第五页最旧批次，批次详情仍可读取 |
| `history-empty-project.png` | 空项目显示 0 批、第一页，两侧翻页按钮禁用 |

除故意模拟的 503 外，接口均由真实临时后端返回。浏览器还验证了 Vue 复用页面组件时，切换项目会回到第一页。迟到请求隔离和失败重试由 `frontend/tests/adoptionHistory.test.js` 覆盖。

`backend/tests/adoption_integration.mjs` 验证 102 个批次跨页无遗漏、无重复及各类用户权限。PocketBase 集合 API 自动生成创建时间，因此强制同时间的排序边界另由 `TestAdoptionHistoryEqualCreationTimes` 在临时数据库内制造 101 条相同 `created`，通过实际路由验证 `created DESC, id DESC`；截图本身不作为同时间排序或权限结论的依据。
