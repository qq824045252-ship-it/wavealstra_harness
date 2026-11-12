# Work 动作审批与共享资源隔离（已退役）

## 现状

Issue #21 决定**移除项目内的共享资源隔离，以及与它配套的 Work 动作授权、审批、规则保存和审批续跑**，恢复普通任务与个人 Bot 的可用性。本文记录退役后的实际契约；历史设计见 §退役前的机制 与 `docs/bot-work-phase3-execution-plan.md`（该文档描述的是已删除的实现）。

退役范围（代码已删除）：

- 执行链：`WorkResourceGate`、`WorkToolResourcePolicy`、`WorkManagedResourceBoundary`、`WorkResourceRecovery`、`WorkResourceRecoveryControl`、`WorkResourceEffectReview`、`WorkResourceSettlement`、`WorkResourceBlockers`、`platform/managed-resources`。
- 动作审批：`WorkActionApprovals`、`WorkAutonomyPolicy`、`WorkDecisionLedger`、`WorkActionClassifier`、`WorkDecisionJudge`、`WorkApprovalIpc`、`shared/bot-work-action|approval|autonomy`。
- 审批续跑：`WorkDeferredActions`、`DurableDeferredAction`、`db/bot-work-deferred-schema`、`DurableToolPolicy` 的 defer 分支、`AppDatabase` 的延迟表初始化。
- UI/IPC：`ResourceEffectReview`、`BotWorkApprovals`、`bot-work:decide-action|list-autonomy-rules|revoke-autonomy-rule` 通道、Bot 设置里的“已保存的授权规则”、`phase3Control` 的资源核对 kind。

## 现在的执行契约

Issue #21 之后，用户又要求全面取消应用内权限系统及 Work 预算（#24）。以下是当前契约，不能用退役前的文档恢复旧门禁：

- `DurableToolPolicy` 不再用 `default` / `readonly` / `auto` 决定工具审批或拒绝；`requestApproval` 直接通过。旧字段可作为兼容输入存在，但不是一个可恢复的审批入口。
- Work 的旧 `authorization`、`delegatedScope`、目标白名单与有效期不再是逐动作放行条件；旧只读授权不能继续卡住用户要求的写任务。任务/成员身份、归属、工作目录绑定、输入版本、负责人 epoch、明确暂停/取消和真实执行绑定仍然保留。
- 业务目标明确为“只读取并核验既有成果”的任务仍按其业务目标执行，例如只读事件检查及未知效果回读。它不是旧 scope 审批，也不创建审批卡。
- 真实工具能力和输入校验仍存在。工具不存在、页面失效、目录不存在或网络失败要返回真实错误，不能替换成共享资源隔离或授权等待。
- 工具执行保留原生 Pi Durable 边界、工具可用性、效果意图/回读、真实 `execution_attempts` 与失败记录。未知效果不能靠重放历史动作或伪造成功来消除。
- 成果采纳、业务验收、通知、记忆与任务数据保持业务语义。`work_action_admissions` 记录执行身份与结果，不再依赖退役审批放行。Work 预算已另行退役，参见 `docs/work-budget-retirement.md`。
- 不再运行 host 级共享资源租约、隔离或跨 Work 屏障。桌面后端的进程内输入队列、任务自己的按住状态及取消释放保留；它们不会持久隔离无关的搜索、文件或 Bot 任务。
- 浏览器按键操作在异步焦点检查后再次检查取消，已经发出的 DOWN 即使返回异常也会尝试配对 UP。停止一个浏览器任务不建立跨任务 quarantine。
- 外部服务或第三方 Agent 协议自身的权限要求不属于本项目退役机制，不能假称已删除。

## 数据迁移

`src/main/db/work-isolation-retirement.ts` 在每次启动（`AppDatabase.migrate`）幂等执行：

- `DROP TABLE IF EXISTS` 退役专用表：`work_resource_*`（leases/waiters/recovery/denials/fingerprints/opaque_observations/observation_clock/effect_preparations/effect_reviews）、`work_action_approvals`、`work_action_approval_claims`、`work_autonomy_rules`、`work_decisions`、`work_deferred_actions`。
- 删除只由本机制写入的 blockers：`work-approval:*`、`resource-dispatch:*`、`resource-recovery:*`。真实 `continuation:*`、用户输入等 blocker 保留。预算与未知效果 blocker 的后续迁移分别由 `work-budget-retirement.ts`、`work-effect-retirement.ts` 负责，不能把这些历史失败改写为业务成功。
- 先删除有外键的子表，再删除其父表；旧索引和表内触发器随专用表删除。整个退役包含在启动迁移事务中，失败可回滚。
- 清理确有变化时输出 `[AppDatabase] work isolation retired`，只记录删除的表名与 blocker 数量，不记录账号、载荷或文件内容。
- 不提升 `user_version`（提升会触发整库备份重建），不删 Work、admissions、子项成果、缺口覆盖、执行回执、Bot/任务/会话/消息/记忆。旧审批不会被重放，也不会被改写成成功。

## 验证边界

- `test:work-isolation-retirement` 使用真实 SQLite 文件覆盖旧 host quarantine、带真实父子外键的专用表、旧 pending/queued/running outbox、退役索引/触发器、三类旧 blocker、业务逐行保留、事务回滚、部分迁移、已清理 profile、全新 profile 和重复启动。检查 `quick_check`、`foreign_key_check` 和 schema 版本；不复制用户数据库。
- `test:durable-tool-policy` 覆盖真实磁盘读写、原生子代理与 Code Mode、旧审批不阻塞，以及有副作用的已完成/失败操作重启后不重放。这些使用受控模型，不是真实在线模型验收。
- `test:work-permissions-retired` 覆盖历史 scope/有效期/路径规则不再阻塞，同时保留身份和暂停。
- `test:browser-automation-recovery` 覆盖异步焦点期间取消、失败 DOWN 的 UP 清理和独立后续调用。`test:linux-native-backend` 覆盖并行排队时停止旧任务、旧任务释放完成后新任务继续、新任务持有的输入不被旧清理释放。这些是注入式行为测试，不代表真实物理输入已验收。
- 真机、真实模型与 Windows 验收必须各自给出日期、SHA、命令和证据；不得由上述 fixture 或 typecheck 推导通过。2026-11-12 专项进展见 `docs/reviews/work-isolation-21-2026-11-12.md`。
