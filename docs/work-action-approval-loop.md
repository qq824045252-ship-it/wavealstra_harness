# Work 动作审批与共享资源隔离（已退役）

## 现状

Issue #21 决定**移除项目内的共享资源隔离，以及与它配套的 Work 动作授权、审批、规则保存和审批续跑**，恢复普通任务与个人 Bot 的可用性。本文记录退役后的实际契约；历史设计见 §退役前的机制 与 `docs/bot-work-phase3-execution-plan.md`（该文档描述的是已删除的实现）。

退役范围（代码已删除）：

- 执行链：`WorkResourceGate`、`WorkToolResourcePolicy`、`WorkManagedResourceBoundary`、`WorkResourceRecovery`、`WorkResourceRecoveryControl`、`WorkResourceEffectReview`、`WorkResourceSettlement`、`WorkResourceBlockers`、`platform/managed-resources`。
- 动作审批：`WorkActionApprovals`、`WorkAutonomyPolicy`、`WorkDecisionLedger`、`WorkActionClassifier`、`WorkDecisionJudge`、`WorkApprovalIpc`、`shared/bot-work-action|approval|autonomy`。
- 审批续跑：`WorkDeferredActions`、`DurableDeferredAction`、`db/bot-work-deferred-schema`、`DurableToolPolicy` 的 defer 分支、`AppDatabase` 的延迟表初始化。
- UI/IPC：`ResourceEffectReview`、`BotWorkApprovals`、`bot-work:decide-action|list-autonomy-rules|revoke-autonomy-rule` 通道、Bot 设置里的“已保存的授权规则”、`phase3Control` 的资源核对 kind。

## 现在的执行契约

- 工具执行只经过原生 Pi Durable 边界：工具白名单、只读模式、MCP 副作用分类、`TaskFileAccessPolicy`、效果意图/回读、真实 `execution_attempts` 与失败记录。没有任何 host 级共享资源租约、隔离或跨 Work 屏障。
- 权限模式就是应用当前的权限模式：`auto` 直接执行，`default` 在原生边界弹出一次真实确认，`readonly` 拒绝写入与命令执行。Work 任务不再被强制设成 auto，也不会被 Work 专用审批卡挡住。
- 目录归属仍然生效：Work/团队绑定任务的工具目标（`read`/`write`/`edit`/`glob`/`grep`/`ls` 声明的 `path`/`file_path`）必须落在本次绑定工作区内（词法 + realpath）；成员 `delegatedScope` 仍是真实的业务范围（例如只读成员不能写）。这不是逐动作审批，也不会生成审批卡。
- 真实取消、停止、预算、成果采纳、业务验收、通知、记忆与任务数据保持原语义；`work_action_admissions` 只记录真实执行准入，不再依赖审批或 scope 放行。
- 未知外部效果的**业务**记录（`work_blockers.kind='external_effect'`、`execution_failures`）继续存在并如实显示，但不再阻塞无关任务或派发。

## 数据迁移

`src/main/db/work-isolation-retirement.ts` 在每次启动（`AppDatabase.migrate`）幂等执行：

- `DROP TABLE IF EXISTS` 退役专用表：`work_resource_*`（leases/waiters/recovery/denials/fingerprints/opaque_observations/observation_clock/effect_preparations/effect_reviews）、`work_action_approvals`、`work_action_approval_claims`、`work_autonomy_rules`、`work_decisions`、`work_deferred_actions`。
- 删除只由退役机制写入的 blockers：`work-approval:*`、`resource-dispatch:*`、`resource-recovery:*`。真实 `continuation:*`、预算、用户输入等 blocker 保留。
- 不提升 `user_version`（提升会触发整库备份重建），不删 Work、admissions、子项成果、缺口覆盖、执行回执、Bot/任务/会话/消息/记忆。旧审批不会被重放，也不会被改写成成功。

## 验证边界

`test:work-isolation-retirement` 用真实 SQLite 覆盖：旧 profile 打开时清表/清 blocker、业务数据与 schema 版本不变、迁移可重复、全新 profile 不建退役表、旧 blocker 不再拒绝新动作。`test:durable-tool-policy` 覆盖退役表与旧 pending 审批存在时真实读写与重启都不被挡住；`test:bot-work-phase2`、`test:bot-work-resume-dispatch`、`test:bot-work-team-native` 覆盖独立 Work 并发、无跨 Work 屏障、成员目录归属与只读成员边界。

真机验收（真实在线模型搜索/网页/读写、真实桌面 UI 点击、Bot 后备真实任务全链路、Windows profile）尚未在本轮执行，不能据此宣称 Issue #21 已整体验收通过。
