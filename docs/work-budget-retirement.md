# Work 额度/预算模块退役（#24）

基线：`af4390b`（2026-11-09 公开 main）。Work 额度/预算运行时已移除。2026-11-12 用户明确要求仅支持当前格式：不兼容数据库直接删除重建，原先的旧版本原地迁移和 discarded 备份策略已取消。

## 适用范围与保留决策

本文合并了原 `bot-work-no-quota.md` 的无预算边界，保留 2026-11-09 的退役决策及后续清理说明。独立 Bot/团队写操作本身已于 2026-11-17 退役，当前范围以 [Bot 退役边界](bot-retirement.md) 为准，不能据此恢复旧入口。

- 供应商原始用量是遥测，不是 Work token 额度，不用于冻结预算或推断外部效果；缺少 usage 不应阻塞已确认执行结果。
- 上下文/证据材料裁剪、原生 reasoning token 参数和供应商自身限流，不属于已删的 Work 预算模块。
- 当时移除预算没有取消执行身份、工作空间边界、外部效果核验与因果防环，也不恢复已退役的审批/共享资源隔离。
- 当时请求授权与隐藏重试的撤权检查仍有独立契约；这段是历史边界，不是对已退役 Bot 创建/团队写接口的现行授权。
- 旧回执仍按稳定操作身份查询；只忽略可精确归属于旧预算或用量缺失的阻碍，未知外部效果不能被归为预算问题而抹去。
- 2026-11-09 的“不主动删除旧预算数据”证据属于当时版本，已被 2026-11-12 的当前格式清理规则替代。历史日志不改写为今天行为。

## 清理映射

| 来源 | 处理 | 说明 |
| --- | --- | --- |
| `work_budget_windows` | DROP TABLE | 预算窗口账本 |
| `work_budget_requests` | DROP TABLE | provider 请求预留/结算 |
| `work_budget_request_sequences` | DROP TABLE | 预算请求序号 |
| `work_budget_reservations` | DROP TABLE | 执行预留与 in-flight 计费 |
| `works.budget_json` | DROP COLUMN | 旧 Work 预算投影 |
| `works.budget_policy_json` | DROP COLUMN | 旧预算策略 |
| `work_execution_bindings.reservation_id` | DROP COLUMN | 执行到预算预留的绑定 |
| `work_blockers.window_id` | DROP COLUMN | 仅预算 blocker 使用的窗口引用 |
| `work_blockers.reason_code` = `budget-exhausted` / `budget-rollover-pending` / `budget-reconciliation-conflict` | DELETE | 只由预算模块写入的 blocker；真实失败/未知外部效果保留 |
| `work_blockers.blocker_id` 以 `budget:` / `usage:` 开头 | DELETE | 旧预留耗尽与用量核对 blocker；`external_effect` 不匹配 |
| `work_causal_chains.decision = blocked-budget` | DELETE，并重建表 CHECK | 只由预算拒绝产生的账本行；其余 admitted/loop/depth/hops 记录逐行保留 |
| `work_team_executions.error` 中的预算/额度造成准备失败 | 置空（仅无执行绑定的行） | 旧团队预算失败不再阻塞成员启动；真实执行失败、已绑定失败保留 |
| `work_dispatch_requests` 的预算错误与 blocked 状态 | 重置为 pending/attempts=0/error NULL（仅无原生绑定） | 旧预算拒绝不再阻塞独立 Work 派发；真实失败保留 |
| `durable-provider-budget-gate` / Phase 4 shared budget 专项测试 | 删除 | 对应运行时已不存在 |

运行时不再读写预算：`WorkBudgetService`、Work DTO 的 `budget`、Phase 4 的预算窗口投影、`set-budget-policy` / `reconcile-budget-reservation`、provider 预算准入、团队共享预算与 UI 预算控件均已移除。

## 当前格式清理

- 由 `src/main/db/work-budget-retirement.ts` 执行；`AppDatabase.migrate()` 的 SQLite 事务包住全部 DDL/DML。
- 在当前 schema 中只删除预算独占结构/记录。Work、Bot、会话、消息、团队身份/依赖、成果、文件、验收证据、真实失败、未知外部效果保留。
- 幂等：重复启动和全新库均可执行；列级清理逐列检查。
- 原子：任一语句失败会随 `AppDatabase.migrate()` 回滚；失败时构造函数抛错，不会留下半迁移结构。重启后重新执行。
- `AppDatabase` 只保留 `CURRENT_DATABASE_SCHEMA_VERSION`。确认版本不符时先删除旧 sidecar，再删除主库并重建空库，不运行旧版本兼容迁移。
- 迁移前后记录日志：`[AppDatabase] work budget retired: {...}` 只在确有变化时打印删除的表/列/blocker/因果行数，便于从主进程日志核对影响范围。

## 不兼容数据

- 不再生成 `app.db.discarded-*`。旧数据库内容不会导入新库。
- 当前格式的幂等、执行恢复和未知外部效果核对仍保留。读取或删除失败会中止初始化，不能假装已完成清理。

## 验证

- `pnpm -s test:work-budget-retirement`：新库无预算表/列；当前 schema 中的预算残留被删除，业务关系、真实失败与未知外部效果保留；覆盖事务回滚、派发和重复启动。`test:db-schema-discard` 验证不兼容旧库直接清理。
- 相关专项：`test:bot-work-team-recovery`、`test:bot-work-team-service`、`test:bot-work-phase2*`、`test:bot-work-phase3*`、`test:bot-work-phase4-*`、`test:bot-work-phase5*`、`test:db-schema-discard`。
- 历史全量门禁（2026-11-09）：`pnpm -s test:all` 以 399/399 通过；不作为本次格式策略更改的验证结果。
- 真实 Electron：`pnpm -s test:bot-work-recovery-dev` 在临时 HOME + 本地 HTTP 模型夹具下通过单独 Work 恢复，确认预算删除没有破坏真实桌面恢复链路。
- 当前实现不提供旧 profile 的数据迁移或兼容升级。
