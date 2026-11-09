# 团队失败自动恢复（#25）

团队成员执行失败后，由原成员身份、原 task、原职责、原工作范围和原依赖继续完成未完成步骤；不把失败改写成成功，也不由 owner 冒名重跑整个成员分工。

## 持久化

`work_team_recovery_attempts` 记录每次恢复：

- 原成员：`task_id`、`bot_id`、`role`、`responsibility`、`scopes_json`；
- 输入身份：`intent_revision`、`input_snapshot_id`、`owner_epoch`；
- 失败来源：`source_key` / `source_binding_id`、`failure_class`、`failure_message`、`progress_hash`；
- 恢复代次与领取：`generation`、`operation_id`、`state`、`binding_id`、`claimed_at`、`dispatched_at`；
- 结果：`outcome`、`settled_at`。

`work_team_executions` 增加 `reported_binding_id`（按执行绑定报告结果）和 `original_input_json`（保留首次冻结输入）。恢复输入保留 `previousResults`、原成果、未完成步骤、失败类型和历史恢复代次。

## 行为

- 失败分类：已有完整可复用报告 -> 直接复用；未知外部效果 -> 只读核对；提交前失效 -> 安全重新准备；其余 -> 原身份继续。
- 单次领取：`(work_id, task_id, source_key)` 唯一；同一失败绑定、重启、重复事件只生成一个代次。新代次使用唯一 `operation_id`。
- 依赖：成员只消费真实结算结果；前置恢复进行中时等待，恢复停止时依赖成员不启动。owner 汇总在所有成员终止（成功/恢复/停止）后运行，并如实总结失败。
- 独立成员：parallel 计划中不依赖失败成员的成员继续执行；unknown effect 只阻止对同一效果的写入/发送，不冻结独立成员。
- 停止条件：已有报告复用、连续无新内容/重复输出、同一错误重复、达到 3 代上限后停止，保留已有成果并给出具体原因。
- 取消/变更：用户停止、取消、修改要求/输入或更换 owner 后，旧代次标记 `stopped/superseded`，不再派发，也不回写新任务。
- UI：团队卡片显示“自动恢复中（第 N 次）/已自动恢复/自动恢复已停止 + 原失败”，明确仍需负责人核对和用户验收。

## 测试与未覆盖项

- `pnpm -s test:bot-work-team-recovery`：同身份续跑、单次写文件、依赖推进、独立成员继续、unknown effect 只读、停止取消、无进展停止、重启去重。
- `pnpm -s test:bot-work-team-service` / `test:bot-work-team-native`：团队队列、原生适配器、依赖与 owner 汇总回归。
- `test:bot-team-ui`：恢复中/已恢复文案与“仍需验收”边界。
- 全量门禁：`pnpm -s test:all` 399/399 通过（0 失败、0 新增回归）。
- 真实 Electron：`pnpm -s test:bot-work-recovery-dev` 使用临时 HOME、真实 `pnpm dev` 页面和本地 HTTP 模型夹具，通过单独 Work 的失败恢复；这是本地测试模型证据，不是公网模型验收。
- 未执行：团队多成员任务在真实桌面 UI 中注入成员失败并连接公网真实模型的完整端到端验收；本轮团队证据来自原生适配器/团队 fixture，已单独标注，不冒充公网真实模型验收。
