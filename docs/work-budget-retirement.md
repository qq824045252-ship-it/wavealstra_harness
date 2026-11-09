# Work 额度/预算模块退役（#24）

基线：`af4390b`（2026-11-09 公开 main）。本轮移除了 Work 额度/预算运行时，补上旧库的一次性、幂等、事务性清理，并把 schema 升到 v36（唯一允许原地迁移的 v35 来源）。

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

## 迁移边界与安全

- 由 `src/main/db/work-budget-retirement.ts` 执行；`AppDatabase.migrate()` 的 SQLite 事务包住全部 DDL/DML。
- 只删除预算独占结构/记录，不重建或清空业务库。Work、Bot、会话、消息、团队身份/依赖、成果、文件、验收证据、真实失败、未知外部效果全部保留。
- 幂等：旧库、部分迁移库、重复启动和全新库都可重复执行；列级清理逐列检查。
- 原子：任一语句失败会随 `AppDatabase.migrate()` 回滚；失败时构造函数抛错，不会留下半迁移结构。重启后重新执行。
- `user_version` 35 -> 36 是唯一的原地迁移：`MIGRATABLE_DATABASE_SCHEMA_VERSIONS` 只放 35，其他不兼容版本仍走「备份 -> 重建空库」。因此：
  - 新版本可直接升级 v35 旧 profile，业务数据原地保留；
  - 旧版 v35 应用打开 v36 库时 `user_version` 不匹配，会走既有备份/重建路径，不会在已迁移结构上静默重建预算表。
- 没有用版本提升代替迁移：v35 -> v36 的清理逻辑就是本模块，版本号只负责阻止旧二进制回写。
- 迁移前后记录日志：`[AppDatabase] work budget retired: {...}` 只在确有变化时打印删除的表/列/blocker/因果行数，便于从主进程日志核对影响范围。

## 备份与恢复

- `AppDatabase` 现有的 `user_version` 不兼容处理仍会把主库/WAL/SHM 改名为 `app.db.discarded-<UTC 时间戳>`，该备份是完整旧库，当然也包含被退役的预算历史。
- 本轮退役迁移本身不创建永久副本；若要保留迁移前审计，请由用户自行对 `~/.mybuddy/app.db` 做一次性备份。恢复该备份后再次启动，会重新执行同一退役清理。
- 不要求、也不建议为了清理预算而恢复旧库；迁移只读业务行、只删预算独占事实。

## 验证

- `pnpm -s test:work-budget-retirement`：新库无预算表/列；构造带全部旧预算表、列、blocker、`blocked-budget` 因果行的 v35 旧库；升级到 v36 后业务行数/关系不变、`integrity_check` 与 `foreign_key_check` 通过、旧预算结构/记录/CHECK 文本消失；清理后可正常派发独立 Work；事务回滚、部分迁移、重复启动幂等。
- 相关专项：`test:bot-work-team-recovery`、`test:bot-work-team-service`、`test:bot-work-phase2*`、`test:bot-work-phase3*`、`test:bot-work-phase4-*`、`test:bot-work-phase5*`、`test:db-schema-discard`。
- 全量门禁：`pnpm -s test:all` 以 399/399 通过（0 失败、0 新增回归）。
- 真实 Electron：`pnpm -s test:bot-work-recovery-dev` 在临时 HOME + 本地 HTTP 模型夹具下通过单独 Work 恢复，确认预算删除没有破坏真实桌面恢复链路。
- 未执行项：真实用户旧 profile 的桌面升级验收（本轮没有上传/复制用户数据库；由 fixture 构造等价 v35 旧结构）。
