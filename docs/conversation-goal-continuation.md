# 对话 Goal 自动续跑（B 层）

状态：已实现（P1 + P2；P3 的多 Goal/团队边界见 §14）。
参照：Codex `codex_goal_extension`（`ext/goal/src/{extension,runtime,steering,accounting,api,tool}.rs` + `app-server/src/request_processors/daemon_continuation.rs`）。
前置：`renderConversationGoalSection`（`src/main/agent/ConversationGoalPrompt.ts`）已经把 Goal/验收条件/停止规则注入每轮系统提示词。本方案只补"会不会再点一次火"。

## 1. 目标与非目标

目标

1. 前台会话存在活跃 Goal 且仍有未满足验收条件时，本轮回答结束后由**宿主**再起一轮，而不是等用户手动催。
2. 续跑有硬上限（次数 + 可选 token 预算），可被用户、暂停、重启、失败随时掐断（deferral）。
3. 记账按"工具完成即累加"，预算一超立刻熔断，不等整轮结束。
4. 续跑在历史和 UI 上是**带标记的宿主输入**，不伪装成用户手打的话。

非目标

- 宿主不判完成。验收事实仍只能由用户确认（`WorkService.attestCriteria`，`src/main/agent/work/WorkService.ts:823`）；续跑不写 criteria、不关 Work。
- 不做无限循环、不做跨会话搬运、不替代 `watch`（watch 是后台 bot 的调度，本方案只覆盖用户前台对话）。
- 不改 `CURRENT_DATABASE_SCHEMA_VERSION`（当前 36）：状态表走幂等 additive 建表（先例见 `AppDatabase` 的 `ensureConversationBranchTables` 注释与 `WorkAutomaticRecovery.ensureAutomaticRecoveryTables`）。

## 2. Codex 机制 → MyBuddy 落点

| Codex | 作用 | MyBuddy 落点 |
| --- | --- | --- |
| `thread_goals` 表（thread_id 主键，六态） | 状态权威 | 不复用新表：Work 已是权威（`works` + criteria + 版本守卫），只新增"续跑账本" |
| `thread_goal_continuation_deferrals` | 让位开关 | 同一个账本表的 `state/defer_reason` 列（1 goal = 1 work = 1 行） |
| `daemon_continuation.rs` idle 调度 | 点火 | `DurableBotService` 的 `onSettled` 回调（`AgentService.ts:1247`）+ 启动对账 |
| `steering.rs`（有 turn 就 steer） | 并发合并 | 点火时若 runtime 仍 busy，用 `submit(..., whenBusy: "steer")`（`DurableBotRuntime.ts:679`） |
| `accounting.rs`（tool finish + turn stop） | 计量 | `onTool` 回调（`AgentService.ts:1256`）+ `observedUsage`（`AgentService.ts:1257`）做 delta 累加 |
| `update_goal` 只能 complete/blocked/paused | 权限切分 | `conversation_goal_update` 已禁止模型写验收事实；本方案不新增模型可调状态 |
| user 角色消息 + `content_item_kinds: goal.internal_context` | 标记宿主注入 | `mybuddy.user` 条目 + `mybuddyInput.goalContinuation` 标记 + `displayText` 短标签 + `announceUserMessage: false` |
| `goals/continuation.md`（6KB 长文） | 承载契约 | 不需要：契约在系统提示词里，nudge 只写 200~400 字 |

## 3. 状态模型

新文件 `src/main/agent/work/GoalContinuationStore.ts`（构造时 `ensure...Tables(db)`，与 `WorkAutomaticRecovery` 同构）：

```sql
CREATE TABLE IF NOT EXISTS conversation_goal_continuations (
  work_id             TEXT PRIMARY KEY REFERENCES works(work_id) ON DELETE CASCADE,
  task_id             TEXT NOT NULL,
  intent_revision     INTEGER NOT NULL,
  attempts            INTEGER NOT NULL DEFAULT 0,
  tokens_used         INTEGER NOT NULL DEFAULT 0,
  tokens_budget       INTEGER,
  time_used_seconds   INTEGER NOT NULL DEFAULT 0,
  usage_cursor        INTEGER NOT NULL DEFAULT 0,   -- 上次采样的累计 token（delta 基准）
  progress_fingerprint TEXT,                        -- 复用 WorkContinuationProgress 的 digest
  last_token_at       INTEGER,
  last_continuation_at INTEGER,
  state               TEXT NOT NULL DEFAULT 'idle'
                      CHECK (state IN ('idle','igniting','deferred','exhausted')),
  defer_reason        TEXT CHECK (defer_reason IN
                      ('user_interrupt','turn_aborted','run_failed','restart','no_progress','manual_stop','budget')),
  deferred_at         INTEGER,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_goal_continuations_task
  ON conversation_goal_continuations(task_id, state);
```

不变量

- 一行只对应一个 `work_id`；Work 结案/取消时行保留（审计），但 `state` 不再参与点火。
- `attempts` 只在**点火成功**时 +1，重置条件是 `intent_revision` 变化（用户改要求）或用户显式"继续"。
- `tokens_used` 只由 delta 采样写入，永不回写、永不估算。
- `state = 'igniting'` 是"本轮是我点的火"，用于重启对账；settle 回到 `idle`。
- 暂停（Work `paused`）/完成/取消不写本表状态，点火前读 Work 即可（单一权威）。

## 4. 点火器

新文件 `src/main/agent/work/GoalContinuationService.ts`。

### 4.1 输入事件

| 事件 | 来源 | 处理 |
| --- | --- | --- |
| 一轮结束 | `onSettled(taskId, snapshot)` | 主判定入口。**必须挂在 `AgentService` 现有 handler 的 `if (outcome === "aborted") return;` 之前**，否则 aborted/failed 的 deferral 写不进去 |
| 工具完成 | `onTool({phase:"finish", taskId, conversationId})` | 记账 |
| 用户发新消息 | 任务提交成功（`PromptExecutionCoordinator` / `announceUserMessage`） | 清 deferral（`user_message`） |
| 用户中断 | `outcome === "aborted"` 或 abort 入口 | 写 deferral `user_interrupt` |
| 用户暂停/恢复 Goal | `updateConversationGoal`（`resumeWork` 路径） | 暂停 → 清账本活动；恢复 → 清 deferral 并尝试点火 |
| Work 结案/取消 | `ConversationGoalService` publish 钩子 | 停止 |
| 应用启动 | `resumePersistedTasks()` 之后 | 对账：`igniting` → deferral `restart`；`idle` 且满足条件 → 不自动点火（见 4.4） |

### 4.2 `onSettled` 判定顺序（短路，任一命中即停）

```
1  bindingForTask(taskId) 存在          → skip binding（后台 worker 有自己的契约）
2  getLive(taskId) 为空                 → skip no_goal
3  goal.status === "paused"             → skip paused
4  criteria 全部 met/waived             → skip complete_pending（UI 提示可提交结论）
5  账本 state ∈ {deferred, exhausted}    → skip deferred/exhausted
6  snapshot.status === "waiting_input"   → skip waiting_input（已有 request_user_input 待答）
7  snapshot.queued > 0 || snapshot.busy  → skip user_turn
8  snapshot.compacting                  → skip compacting（压缩结束会有新 settle）
9  snapshot.outcome === "aborted"        → defer(user_interrupt) + 不点火
10 snapshot.outcome === "failed"         → defer(run_failed) + 不点火
11 attempts >= maxAttempts               → defer(budget/exhausted)
12 tokens_budget 且 tokens_used >= 预算   → defer(budget)
13 否则                                   → ignite
```

每条 skip 打结构化日志（对齐 Codex 的可观测口径）：
`[GoalContinuation] skip task=<id> work=<id> reason=<code> attempt=<n>`。

### 4.3 ignite

```ts
const request: AgentPromptRequest = {
  taskId,
  text: continuationNudge(goal, book),      // 模型可见正文（短）
  displayText: `Goal 自动续跑 #${attempt}/${max}`,  // 气泡/历史可见短标签
  userMessageId: `goal-continuation:${workId}:${intentRevision}:${attempt}`,
  assistantMessageId: `goal-continuation-answer:${workId}:${intentRevision}:${attempt}`,
  announceUserMessage: false,               // 不广播“用户发消息”补丁
};
await this.bots.submit(request, { goalContinuation: { workId, intentRevision, attempt } });
```

**steering 的适用范围（与 Codex 的差别，别照抄）**：Codex 在 turn 进行中也续跑，所以必须 steer。我们不需要——判定时 `busy/queued` 一律跳过（用户这一轮 settle 后会重新判定，信息更全）。只在“判定通过 → 提交前”这段窄窗口里会话又变忙时，才用 `whenBusy: "steer"` 交付，避免把已经决定要做的一轮丢掉；提交失败则写 `defer('run_failed')`，不重试。

- `userMessageId` 同时是提交的 `requestId`。宿主的幂等不靠 `DurableBotService.admit`：它的 `findSubmissionRecord` 重放检查只在 `binding(taskId)` 存在时生效（`DurableBotService.ts:620`），前台任务不命中。真正的幂等来自 pi-durable 本身——"A retried submission with the same `requestId` returns the existing submission instead of submitting twice"（`node_modules/@earendil-works/pi-durable/README.md`）。所以键必须是 `work + revision + attempt` 三元组，不能用时间戳或随机 id。
- 提交前在同一事务里 `attempts+1`、`state='igniting'`，提交失败回滚并 `defer(run_failed)`。

### 4.4 点火器不是无限自主

- **重启不静默续跑**：应用启动对账把 `igniting` 行改成 `defer('restart')`，UI 显示"Goal 已暂停（重启）· 继续"，点一下恢复。理由：用户关机/崩溃后再次烧 token 不是他能预期的行为（pi-goal 的 reload→paused 同理）。
- **用户插话优先**：`queued > 0` 时不点火；用户消息 settle 之后自然重新判定。
- **暂停一律压过自动续跑**：Work `paused` 时账本不活动。

### 4.5 nudge 文本（模型可见）

契约已在系统提示词（`## 对话 Goal`），nudge 只负责"换一口气继续"：

```
（宿主自动续跑 #2/3）继续推进「对话 Goal」里仍未满足的验收条件：
先做下一步可执行的动作，再汇报进展与剩下的项。不要以计划、口头说明或"等你确认"收尾；
确实卡住时，写清已完成项、卡在哪、需要什么输入。
```

不给 token 预算时省略末行；预算将尽时追加"预算剩余 N token，本轮只做收尾与交接"。

## 5. 记账（工具完成即记账）

`onTool` → `GoalContinuationStore.account(workId, conversationId)`：

```sql
UPDATE conversation_goal_continuations
SET tokens_used = tokens_used + :delta,
    usage_cursor = :cumulative,
    time_used_seconds = time_used_seconds + :elapsed,
    last_token_at = :now,
    state = CASE WHEN tokens_budget IS NOT NULL AND tokens_used + :delta >= tokens_budget
                 THEN 'exhausted' ELSE state END,
    updated_at = :now
WHERE work_id = :workId AND state IN ('idle','igniting')
RETURNING tokens_used, tokens_budget, state;
```

- `delta = max(0, cumulative - usage_cursor)`，`cumulative` 来自 `observedUsage(taskId, conversationId)`（`AgentService.ts:1257`），已含 input/output/cacheRead。
- 采样点：每个 tool finish + 每个 settle（Codex 是 tool finish + turn stop，一致）。
- 熔断：SQL 里原子翻 `exhausted`；服务看到 `exhausted` 就不再点火，并在下一次 settle 发一条"预算用尽，本轮收尾"的 nudge（与 Codex `budget_limit.md` 同义）。
- 预算来源：P1 只支持全局默认（`null` = 不限），P2 在 Goal 芯片加 `tokenBudget` 可选项（DTO 已有 `version` 做并发保护）。

## 6. Deferral 语义

| 写入 | 原因 | 何时清除 |
| --- | --- | --- |
| 用户中断本轮 | `user_interrupt` | 用户发新消息 / 点"继续" |
| 本轮 aborted | `turn_aborted` | 同上 |
| 本轮 failed | `run_failed` | 同上（失败原因在 UI 可见） |
| 应用重启 | `restart` | 用户点"继续"（或新消息） |
| 连续两轮无进展 | `no_progress`（P2） | 用户点"继续" / 改要求 |
| 次数或预算用尽 | `budget` | 改要求（新 `intent_revision`）或用户点"继续"（重置 attempts） |
| 用户暂停 Goal | 不写 deferral，Work `paused` 本身即停止 | 恢复 Goal（`resumeWork`）后清 deferral 并点火 |

`resumeGoalContinuation(goalId)`（新 IPC）做三件事：清 deferral、重置 `attempts`、若 runtime 空闲立即点火。

## 7. 投递与标记：不伪装用户消息

1. `shared/src/conversation-goal.ts`：`ConversationGoalDto` 增加可选
   `continuation?: { attempts; maxAttempts; tokensUsed; tokenBudget?; state: "idle"|"igniting"|"deferred"|"exhausted"; deferReason?; lastContinuationAt? }`。
2. `DurableInputMetadata`（`DurableHistoryProjection.ts:13`）增加可选
   `goalContinuation?: { workId; intentRevision; attempt }`；`DurableBotService.submit(request, origin?)` 把它合进 metadata。
3. 投影：`DurableHistoryProjection` 的 user 行带上 `goalContinuation` 字段 → 渲染层据此画"Goal 自动续跑"标记条，而不是普通用户气泡；`displayText` 已保证纯文本兜底（`DurableHistoryProjection.ts:106` 用 `displayText`）。
4. `announceUserMessage: false`（`PromptExecutionCoordinator.ts:52`）：不广播用户消息补丁，避免被当成用户输入。
5. 不新增 entry kind：`pi.user` / `mybuddy.user` 被多条投影硬编码为“用户消息”入口（`DurableHistoryProjection.ts:104`、`DurableTaskBranch.ts:33`、`DurableEvidenceProjection.ts:71`、`DurableSkillProjection.ts:67`、`DurableBotRuntime.ts:799/803/829` 的历史定位）。新增 kind 会让这些路径同时漏读续跑条目，所以这里必须"同 kind + metadata 标记"。

## 8. 与既有权威的边界

- **完成**：续跑永远不关 Work。全部 criteria 满足后只提示模型走 `conversation_goal_propose_complete`（`conversation-runtime-extension.ts:202`），用户确认后 `closeWork`，点火器随之停止。
- **暂停**：`updateConversationGoal({status:"paused"})` → `pauseWork`（`ConversationGoalService` 既有路径）；点火前读 Work 即可，无需双写。
- **改要求**：`amendWork` 抬 `intentRevision` → 账本按新 revision 重置 `attempts`/预算（旧账本作为审计保留在同一行，加 `intent_revision` 比较）。
- **无进展检测（P2）**：复用 `continuationProgress(works, work)`（`src/main/agent/work/WorkContinuationProgress.ts`）的 digest（已按 `intentRevision + inputSnapshotId + 产物 + 已完成子项` 计算）。连续 2 次点火后 digest 不变 → `defer('no_progress')`，UI 提示"看起来卡住了，给点信息或改要求"。这是宿主侧判断，不依赖模型自觉——比 Codex 纯 prompt 的 no-progress 条款更硬。

## 9. UI / IPC 改动清单

| 位置 | 改动 |
| --- | --- |
| `src/shared/conversation-goal.ts` | `continuation` DTO（可选，向后兼容） |
| `src/shared/conversation-runtime.ts` | IPC 通道 `resumeGoalContinuation` + 结果类型 |
| `src/main/index.ts:1137` 附近 | `ipcMain.handle(...)` 转发 `agentService.resumeGoalContinuation` |
| `src/preload/index.ts:679` 附近 | `resumeGoalContinuation(goalId)` |
| `src/main/agent/AgentService.ts` | 构造 `GoalContinuationService`；`onSettled`/`onTool` 接钩子；`activeGoal` 带 `continuation`；新方法 `resumeGoalContinuation` |
| `src/renderer/src/components/chat/ConversationGoalChip.tsx` | 显示 `#2/3 · 已暂停（重启）`；`deferred` 时给"继续"按钮；`exhausted` 时给"改要求"提示 |
| 消息渲染（`ConversationGoalChip` 之外的 user 行） | `goalContinuation` 标记 → 折叠成一条"Goal 自动续跑"窄条（P2；P1 靠 `displayText` 已可读） |

## 10. 测试计划

新增 `scripts/conversation-goal-continuation-test.ts`（`pnpm -s test:conversation-goal-continuation`，纯 Node，默认进 headless 套件），复用 `scripts/agent-durable-fixture.ts`（确定性 provider、真实 AgentService/durable 存储）：

1. 建 Goal（两条 criteria），prompt 一轮模型直接收尾 → 断言 `requests.length === 2`（宿主点了火），第二次请求的系统提示词含 `## 对话 Goal` 与"不要以…收尾"，用户入口 metadata 带 `goalContinuation.attempt === 1`。
2. 第二轮仍不满足 → 第三次点火；`attempts === 2`；把 cap 调成 2 → 第三次不再点火，账本 `state === 'exhausted'`、`defer_reason === 'budget'`。
3. 用户点"继续" → `attempts` 归零、重新点火。
4. 暂停 Goal → 不点火；恢复 → 点火。
5. 全部 criteria 由用户确认满足 → 不点火，只提示 `propose_complete`。
6. 用户在排队（构造 `queued > 0` 或 `waiting_input`）→ 跳过并记录原因。
7. 本轮 failed/aborted → 写 deferral 且不点火；用户发新消息 → 清 deferral。
8. 记账：fixture 每请求 input=1/output=1 → 工具完成后 `tokens_used` 单调增加；设 `tokens_budget = 3` → 到预算立刻 `exhausted` 且不再点火。
9. 回归：`test:conversation-goal-prompt`、`test:bot-work-phase1`、`test:prompt-execution`、`test:durable-workspace-binding` 保持绿。

## 11. 分阶段

- **P1（本次要做的）**：账本表 + `onSettled` 点火 + `onTool` 记账 + deferral（interrupt/failed/restart/budget）+ `resumeGoalContinuation` IPC + DTO 字段 + 测试 1/2/3/4/5/7/8。
- **P2**：`no_progress` digest 判定、per-goal token 预算 UI、历史消息"Goal 自动续跑"窄条渲染、`exhausted` 收尾 nudge。
- **P3**：多 Goal/团队场景（`works` 一对多）与 watch 的边界梳理；远程端（`shared/src/remote-contract.ts`）续跑状态透出。

## 12. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 静默烧 token | 默认 `maxAttempts = 3`；重启即 defer；UI 常驻显示次数/预算；`announceUserMessage:false` 但有历史行可审计 |
| 与用户输入抢跑 | `isIdle()`（`DurableBotRuntime.ts:592`）+ `queued/pendingInputs` + `trackAdmission` 串行化 + 稳定幂等键 |
| 双份点火（settle 重放） | pi-durable 同 `requestId` 重放返回原子提交 + `state='igniting'` + `attempts` 事务自增 |
| 提示词缓存失效 | nudge 是新增 user 消息，系统提示词不变 → 前缀仍命中 |
| 上下文膨胀 | nudge 200~400 字，不重复 6KB 契约 |
| 语义越界（自判完成） | 续跑不写 criteria、不关 Work；完成仍要用户确认 |
| 开关回滚 | 设置项 `conversationGoalContinuation.enabled`（默认开）+ 环境变量 kill switch，关闭即退化为当前行为（只有提示词注入） |

## 13. 明确不做

- 不把续跑文本伪装成用户消息（不写 `announceUserMessage: true`）。
- 不在缺少证据时自动把 criteria 置为 satisfied。
- 不在用户暂停、Work 结案、或 `binding` 存在时点火。
- 不引入第二个完成权威（不新增“goal 状态表”与 Work 并行的真相）。
## 14. 实现记录（已落地）

| 文档条目 | 实际落点 | 差异与理由 |
| --- | --- | --- |
| 账本表 | `src/main/agent/work/GoalContinuationStore.ts`：`conversation_goal_continuations` + `conversation_goal_usage_events` | 用量另起一张幂等事件表。诊断表是"观察"，fixture 与只读/诊断不可用的启动里可能为空；续跑预算必须有可重放的实测来源。事件键 = `task:conversation:generation:timestamp`，同一消息被 live + projection + 重启重放只计一次。 |
| 点火器 | `src/main/agent/work/GoalContinuationService.ts`：`AgentService.onSettled`（在 aborted 早退之前）→ 下一 tick 串行评估 | 评估前重新 `inspect()`，不用 settle 快照做授权：用户可能在判定与提交之间重新变忙。`inspect()` 只开/刷新会话，不提交。 |
| 记账 | `AgentService.recordDurableUsage` → `noteResponse`（真实 provider usage） | `onTool finish` 仍会采样一次，但不再依赖 `TaskDiagnosticsRepository`。只有存在活跃 Goal 账本行时才记录事件，因此 Goal 的基线从创建时开始，不会继承更早花费。 |
| 幂等键 | `goal-continuation:<work>:<revision>:<attemptSerial>` | **不能只用 attempts**：显式"继续"会重置 attempts，复用编号会被 pi-durable 当成重复提交。账本新增单调 `attempt_serial`，永不回退；`attempts` 只用于展示与轮次上限。 |
| 重启对账 | `AgentService.resumePersistedTasks()` → `reconcileRestart()` | `igniting → deferred(restart)`；`idle` 不自动点火。 |
| 暂停/恢复 | `ConversationGoalService.onStatusChange` → `onGoalStatusChange` | 暂停只靠 Work lifecycle 拦截；恢复清非预算 deferral 并立刻评估（仍受 busy/queued 门控）。 |
| 无进展 | `recordSettledProgress`：Work 指纹 + 本轮工具调用数 | 只有"文字回复且 Work/验收事实完全没变"才计一次 stall；连续两次停止。工具调用视作发生过动作，避免把长工具链误杀。 |
| 预算用尽收尾 | `ConversationGoalPrompt` 的 exhausted 规则 | 不额外烧一轮"收尾 nudge"；预算用尽后只把停止事实注入下一次用户轮次的系统提示词，由用户决定是否"继续"。 |
| 每 Goal 预算 | `ConversationGoalUpdateRequest.tokenBudget` + `GoalContinuationService.setBudget` | 预算不是 Work 事实，放账本；`null` = 跟随全局默认。全局默认在 settings（`conversationGoalTokenBudget`）。 |
| 轮次上限 | settings `conversationGoalMaxAttempts`（1–10，默认 3）+ 环境变量回退 | 不写进每轮请求；评估时实时读取，测试与用户都可调。 |
| 历史标记 | `ChatMessageDto.goalContinuation`；`MessageItem` 渲染窄条 | 仍然是 `mybuddy.user` 条目，不新增 entry kind；`displayText` 只写短标签。 |
| 开关 | settings `conversationGoalContinuationEnabled`（默认开）+ `MYBUDDY_DISABLE_GOAL_CONTINUATION=1` | 关闭后退化为纯提示词契约。 |

验收：`scripts/conversation-goal-continuation-test.ts`（`pnpm -s test:conversation-goal-continuation`）驱动真实 AgentService/Durable/Work/账本，覆盖点火、请求契约、历史标记、轮次上限、显式继续（serial 不复用）、预算、无进展、用户消息清除、暂停/恢复、用户中断（等待输入时 abort）、重启对账与提示词 exhausted 规则。

P3 未做：一个对话目前仍只允许一个活跃 Work（`ConversationGoalService.create` 冲突即拒绝），因此"多 Goal"没有独立状态机；watch 模式与绑定执行显式跳过点火。远程端通过 `activeGoal` DTO 透传 `continuation`，没有新增续跑控制 IPC。
