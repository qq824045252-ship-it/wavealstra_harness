# Bot 事项查询的分页契约

`work_query_status` 不再为概览加载所有 Work、执行、成果和协作历史。查询归属、筛选、计数和游标都在 SQLite 内完成，只有本页记录进入模型上下文。

- 概览：`{ "view": "summary" }`，默认 `status: "open"`（active / paused / closing），每页 20 项，最大 50 项。
- 历史：`status: "all"` 或 `"closed"`；也可直接指定生命周期。
- 搜索：`search` 在标题和目标中做字面子串匹配，`%` / `_` 不是通配符。
- 返回 `items`、匹配总数 `total`、相同搜索条件下各生命周期 `statusCounts`、`hasMore`、`nextCursor`、完整续页参数 `nextQuery`。
- 续页直接回传 `nextQuery`。游标绑定用户、Bot、status/search/workId，变更筛选须重新查询第一页。
- 固定按 `createdAt DESC, workId DESC` 排序。修改进展不会让旧事项在分页途中重复或漏失。新增、删除、权限和生命周期变化仍可改变后续查询的当前结果和总数；这不是跨多次调用的历史快照。
- 列表包含当前输入版本的最新 proposed/accepted 提交摘要及其原始状态，提交记录不是整项完成证明。列表文本在 SQLite 截短为摘要，不拉取完整目标、成果、证据、执行历史或协作消息。`workId` 精确查询保留原始详情数组及全文。
- watch 摘要包含 deadline、规则、当前未停止订阅的最早 nextWakeAt 与活动/停止订阅数量，不能把 watchRule 里的旧 nextWakeAt 当当前计划。
- 每页只为实际返回事项记录版本守卫。查看、计数和游标都不能越过用户与 Bot 的 owner/participant 边界。

## 旧调用的兼容边界

`{ "workId": "..." }` 保持原完整详情数组。`{}` 保持数组外形与 workId / lifecycle / versionGuard 等常用字段，但现在只给最多 20 项轻量摘要，不再承诺 WorkProjectionDto 的全部字段；首项 `queryPage` 明确提供总数、截断标记和 nextQuery。零项仍为 `[]`。需要原成果或 phase3 等历史的调用方必须显式查询 workId。已检查仓库内旧调用方并跑前台合同、团队访问和原 native 前台模型链测试。

这是对无参全量行为的有界迁移，不是维持无限列表。不能把返回的 20 项说成全部委托，也不能静默声称缺失的历史没有发生。

## 验证

`pnpm -s test:bot-work-query-scale` 使用真实文件 SQLite，12,001 条 Work、约 398MB（长目标/历史原文）、多用户与成员关系，覆盖：

- 列表禁用 Work hydration / projection 后仍可查询；有限响应、准确计数、状态与字面搜索。
- 时间戳相同的 1,500 条历史跨 30 页无重无漏，修改进展不打乱游标。
- 旧调用完整续页参数、筛选绑定、无效游标、跨用户游标、超出页大小限制。
- 稀疏成员查询和长目标搜索耗时；计数与子串搜索仍需扫描匹配库存，不声称严格常数时间。
- 当前阻塞 / 待用户输入、watch 当前订阅、按需完整长报告、归属隔离与守卫范围。

GUI、真实联网模型与 Omarchy 真机是独立验收；headless 回归不能冒充这些阶段。
