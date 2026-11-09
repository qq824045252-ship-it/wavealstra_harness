# Bot / Work — Phase 4 执行规划（供 Codex / agent 实施）

> 2026-11-09 产品变更：Work 额度/预算模块已删除。本文旧有的共享预算、额度预留、用量结算阻塞、续期与预算控制要求均已被 [无预算运行约定](bot-work-no-quota.md) 取代，不应按旧条款重新实现。原生用量遥测、授权/审批、未知外部效果防重与上下文容量限制仍保留；已有数据库中的预算历史仅保留为惰性记录，不自动删除或清库。

> 状态：**P4-00～P4-08 已实施并完成后续加固；六项 Phase 4 行为专项、Phase 3 九项前序专项与类型检查通过。本轮 Linux 完整门禁仍受 AT-SPI socket EPERM 阻碍（两轮 344 passed / 1 failed，基线同样复现）。Phase 4 整体验收仍未完成：控制按钮的 dev 点击、原生桌面/移动端/发行包和真实外部连接器证据尚未取得。**
>
> 确认日期：2026-11-07（Asia/Shanghai）。实施与证据：2026-11-07，见 [Phase 4 复核](reviews/bot-work-phase4-2026-11-07.md)。
>
> 后续加固：已针对来源水位、暂停/离线回放、未知预算核对与恢复测试完成修复；当前环境的真实门禁及平台阻碍见 [Phase 4 加固复核](reviews/bot-work-phase4-followup-2026-11-07.md)。本条不将阶段提前改为整体验收完成。
>
> 执行任务：[GitHub Issue #16](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/16)，由 agent 按本文件连续完成并回填证据。
>
> 审核代码基线：[`main@e454341ae3268e7a2ab1cdbc55d84231171f0aa3`](https://github.com/qq824045252-ship-it/wavealstra_harness/commit/e454341ae3268e7a2ab1cdbc55d84231171f0aa3)，提交本规划前已核对 GitHub 远端。
>
> 范围：持续跟进订阅、按源版本合并、离线补处理、时区/DST/时钟跳变、承诺到期唤醒、因果防环、协作者共享预算、防饥饿和有界背压；覆盖 **BW-A36～BW-A41**。

本文件是本阶段的执行任务书。产品语义以 [冻结设计](bot-work-design.md) 第 4、6、7、8、10、11、13、14 节、[冻结验收](bot-work-acceptance.md) BW-A36～BW-A41、[UI 规范](bot-work-ui.md) 和 [AGENTS.md](../AGENTS.md) 为准。沿用 [Phase 3 执行规划](bot-work-phase3-execution-plan.md) 的工程格式；最新代码事实和验证边界见 [Phase 3 加固复核](reviews/bot-work-phase3-followup-2026-11-07.md)。

M1～M3 是同一阶段内的依赖顺序，agent 应连续完成 P4-00～P4-08 并统一交付。不得把提交本文、创建任务、添加表或通过组件测试描述为 Phase 4 已完成。Phase 5 的完整渠道、跨端与全部端到端故事仍保留，不因本阶段完成而宣称 BOT-WORK-1.0 总体验收通过。

## 0. 不可突破的约束

1. **latest-source 不能被 last-arrival 替代。** 同一来源目标的 v4 先到、v1 后到，v1 不得覆盖 v4；来源时间戳、字符串大小和 Git SHA 字典序都不是通用源版本顺序。无法比较时必须权威回读或明确阻碍。
2. **合并等待有硬上界。** `merge_deadline_at = first_received_at + max_merge_wait_ms`，首接收时间取可信宿主时钟；新输入不能顺延截止时间。到期先冻结批次，后续事件进入下一批；派发还须服从暂停、授权、资源和预算门控，不能用“到期”绕过这些门控。
3. **each 义务不静默丢失，容量限制覆盖整条接纳链。** 执行队列满时持久记录 `blocked` 与背压阻碍；溢出区也必须有事件数/字节数上限。达到持久接纳上限后应拒绝接纳并要求来源保留、重试或回查，不能一边 ACK 成功一边丢弃，也不能无限追加 blocked 行。
4. **离线事实如实展示。** 宿主退出、休眠或来源连接不可用期间不能标“持续运行”。保存离线区间及检测依据，按持久 `latest / each / skip` 策略恢复；不可回查的区间显式报告缺口。`skip` 只跳过错过的历史触发，正常在线新事件照常处理。
5. **时钟、timer 和时间边界可注入。** Cron、DST、回拨/前跳、离线、合并上界、预算窗口和承诺到期不得用真实长 sleep 验证。同一逻辑计划槽位有数据库唯一身份；同一个宿主权威控制所有调度。
6. **自身事件按因果判断，不全忽略也不无限自激。** 可信根事件、动作身份、输入快照、业务状态指纹、因果深度/跳数和总预算共同约束新工作。必要下游状态变化可继续；同状态循环与专家乒乓形成可解释阻碍。
7. **未知用量不是零。** 未拿到可信回执的真实调用保留 `reserved` 或 `unknown` 占额；框架合成的零、失败、超时、停止均不构成零消费证明。真实已发生用量完整记账，不钳制成预估值。
8. **预算属于 Work 与持久窗口。** 主负责人、专家独立根和 owned children 共用一个池；重试、恢复、重启、交接不重置额度。只有保存的策略允许且持久窗口边界已到，宿主才可原子打开唯一新窗口；不得前跳一次补发多个窗口额度。
9. **复用现有权威与恢复系统。** SQLite / `WorkService` 保存业务事实，Pi Durable 保存执行/checkpoint；接入既有 Inbox、Outbox、`WorkDispatchQueue`、原生结果结算和投影，不另造 worker、执行日志或第二个权威调度器。外部 Hook 是事实，不是授权。
10. **保护前序边界。** 保留 Phase 3 单调 fencing/attempt、输入释放证明、同输入不重复派发、`pending_adoption` 与一次用量结算。预算/因果耗尽只禁止新增工作，不能阻断原执行结果、迟到用量、停止清理和交接接纳。

## 1. 基线事实与复用位置

以下为 `e454341` 的实际代码。新增设计字段和接口在后文明确标为待实现，不能把草案中的名字当作现有 API。

| 现有入口 | 已有事实 | Phase 4 原位扩展 |
| --- | --- | --- |
| [bot-work-schema.ts](../src/main/db/bot-work-schema.ts) | 已有 `work_source_events`、`work_events_inbox/outbox`、`work_subscriptions`、`work_budget_reservations`、`work_host_lease` | 扩现有字段并新增本阶段账本，接入 [AppDatabase.ts](../src/main/db/AppDatabase.ts)；遵守当前 schema 版本与备份重建策略 |
| [WorkService.ts](../src/main/agent/work/WorkService.ts) | 已有 `addSubscription`、`ingestSourceEvent`、`tick`、`listDueInbox`、`completeInboxEvent`；已有注入 `now` / `computeNextWake` | 服务入口委托统一 ingress/scheduler；真实来源及宿主启停接线；不能仅增加可被测试手动调用的类 |
| [WorkRepository.ts](../src/main/agent/work/WorkRepository.ts) | 已有来源去重、订阅查询、`mergeLatestInbox`、Inbox/Outbox、reservation CRUD | 补分目标版本比较、统一路由回执、批次冻结 CAS、窗口账本和一致投影 |
| [WorkPausedBacklog.ts](../src/main/agent/work/WorkPausedBacklog.ts) | 原 Inbox + `work_paused_source_routes` 保存暂停积压；latest 恢复要求权威回读 | 与活跃态/离线共用一个接纳和消费状态机；保留真实回读语义，当前没有可直接提炼的通用源版本比较器 |
| [WorkDispatchQueue.ts](../src/main/agent/work/WorkDispatchQueue.ts) | `drainSourceEvents` → `pausedBacklog.consume` → `applyObservedSources` → `work.source_dispatch_requested` → `prepareSourceIntents/enqueue` | 复用这条持久派发链，补不可变批次与到期跟进身份；不绕过同输入恢复去重 |
| [WorkSchedule.ts](../src/main/agent/work/WorkSchedule.ts) | 已用锁定依赖 `croner` 的 `Cron`，导出 `cronNextWake`、`nextWakeForRule` | 保留现有 Cron 语法和依赖，增加逻辑槽位、DST 明确政策、枚举游标与跳时处理；`Intl.DateTimeFormat` 用于本地时间规范化 |
| [WorkHostAuthority.ts](../src/main/agent/work/WorkHostAuthority.ts)、[AgentService.ts](../src/main/agent/AgentService.ts) | `work_host_lease.heartbeat_at/released_at` 与既有权威/执行适配器启停 | scheduler 归同一权威宿主管理；先保存旧活跃水位，再续租/接管；接入系统 suspend/resume |
| [WorkExecutionAdapter.ts](../src/main/agent/work/WorkExecutionAdapter.ts) | 实际拥有 `wakeWork` 与持久执行恢复 | scheduler 只生成可恢复业务意图并唤醒既有适配器，不直接启动第二份执行 |
| `WorkService` 预算接口、`WorkRepository` | `reserveBudget`、`commitBudgetUsage`、`openBudgetWindow`；`getReservation/listReservations/updateReservation` | 新 `WorkBudgetService` 承接原职责并统一所有调用；当前不存在 `reserveUsage/commitUsage/releaseUsage/getBudgetReservation` |
| [EvidenceBudget.ts](../src/main/agent/EvidenceBudget.ts) | 自动注入 Memory/Project/Library 补充上下文的字节预算；耗尽不得禁用工具 | **保持其职责**；供应商 token 共享池不得写进这个上下文裁剪器 |
| [DurableBotRuntime.ts](../src/main/agent/durable/DurableBotRuntime.ts)、[DurableBotService.ts](../src/main/agent/durable/DurableBotService.ts)、[ModelInvocationAdmission.ts](../src/main/agent/ModelInvocationAdmission.ts) | 真实 provider 请求、compaction、owned-child 用量和 `workExecutionPort` | 真实请求前预留、请求身份持久化、可信用量回执与原生汇总对账 |
| [WorkCollaborationService.ts](../src/main/agent/work/WorkCollaborationService.ts) | 协作类型、参与者权限、回复链、交接；引用链已有深度检查 | 增加跨事件/消息/执行的可信因果链；不能只在 Hook 入口防环 |
| [BotWorkspacePage.tsx](../src/renderer/src/components/pages/BotWorkspacePage.tsx)、[共享 IPC](../src/shared/bot-work-ipc.ts) | 权威 Work 详情、阻碍与投影流 | 增加订阅、离线、队列和预算窗口监控；路径含 `components/pages/` |

### 1.1 草案必须校正的细节

- `lifecycle` 属于 `works`，不在 `work_subscriptions`；匹配必须关联 Work 并要求 `work.lifecycle IN ('active','paused')`、`subscription.stopped_at IS NULL`。停止时间用空值判断，不能用真假值漏掉 `0`。
- 基线没有 `recordInboxEvent`、`enqueueInboxEvent`、`checkDeadlines`、`findDueSubscriptions`、`findDueWorkItems`。可新增等价查询，但必须明确接入既有方法；`WorkService.tick/ingestSourceEvent` 的存在不证明生产调用链已经接通。
- `works` / Work DTO 尚无承诺用的 `deadline_at/deadlineAt`；授权 `expiresAt` 与预算 `windowExpiresAt` 不能冒充业务承诺期限。
- `work_blockers.kind` 当前只允许 `external_effect / backpressure / write_conflict / operational`。本阶段保留分类，新增稳定 `reason_code` / `reasonCode` 和结构化详情：如 `backlog-overflow` 属于 backpressure，`causal-loop-guard`、`budget-exhausted`、`unqueryable-offline-gap` 属于 operational。同步 schema、DTO/Zod、仓储与 UI，不直接向现有 CHECK 填非法 kind。
- `work_budget_reservations.tokens` 目前是预留量，不能当已消费量求和；当前 `reservedTokens` 包含 unknown，拆桶后不能重复扣减。`unknownUsageCount` 是笔数，不是 token 数。
- `WorkPausedBacklog.consume` 当前在权威回读分支把 Work 的 `inputSnapshotId` 写进 `lastProcessedSourceVersion`；本阶段必须拆开 provider 源版本和输入快照。each 消费也不能仅改变一个事件 hash，而不给实际 worker 原事件内容。
- `watchRule.subscriptions` 现有创建/同步逻辑主要按 source 使用，`addSubscription` 又有混入 subscriptionId 的路径；新增严格规范化契约时统一这个边界，不能让来源名与订阅主键继续混用。

### 1.2 继承的 Phase 3 验证边界

`671574ab8e5bfddbdce6e97866c82c6775623ee7` 为加固代码冻结提交，`e454341` 为报告冻结提交。最新报告记录 typecheck 与九项 Phase 3 headless 专项通过；**完整 `test:all` 是 338 passed / 1 failed，退出码 1**，唯一失败是 `test:atspi-transport` 的 Unix socket `EPERM`，在未修改原基线亦可复现，失败白名单没有改变。

最新 dev 尝试在开发编译后被 Electron singleton socket `EPERM` 阻断，未进入页面。真实 Windows BW-A31、Linux/Omarchy 原生桌面、移动端和发行包没有获得新的通过证据。不得把旧记录中的 336 项通过或 dev 通过改写为本次加固环境全绿。

实际脚本为 `scripts/bot-work-phase3-focus-gate-test.ts`、`scripts/bot-work-phase3-handoff-test.ts`、`scripts/bot-work-phase3-dev-test.cjs`；草案中的 `*-focus-gate.ts`、`*-handoff-gate.ts`、`*-dev-test-matrix.ts` 不是当前文件。正常 `handoffOwner()` 已原子写入 owner/epoch 和 adoption；`pending_adoption` 保护的是迟到或缺 adoption 的边界，不意味着正常交接分成两个事务。

## 2. 身份、schema 与状态契约

### 2.1 不能混淆的身份

| 身份 | 组成与责任 |
| --- | --- |
| 来源事实 | 可信来源命名空间 + 稳定 `source_event_id`；来源命名空间必须隔离连接/仓库等权限范围 |
| 路由回执 | 来源事实 + `work_id` + `subscription_id`，需要时绑定持久规则 revision；一个 Work 已处理不能吞掉另一个合法订阅 |
| 来源目标与版本 | `source + target_key` 定义可比较分区；版本比较器由可信来源适配器声明；不同目标不互相覆盖 |
| 合并批次 | 稳定 batch/event 身份、首接收时间、固定 deadline、冻结快照和 claim/version；恢复沿用原身份 |
| 定时实例 | `subscription_id + schedule_revision + logical_slot_key` 唯一；不能用本次发现时间或 ownerEpoch 作身份 |
| 承诺实例 | `work_id + deadline_revision + deadline_at` 唯一；修改期限是显式规则变化，重启/交接不是 |
| 因果链 | 可信 chain/root、父事件/动作/消息、业务指纹、输入版本、深度与全链派发计数；不同引用命名空间要显式映射 |
| 预算预留 | 稳定实际调用/attempt 身份 + 原 `work_id/window_id`；恢复回放复用，确实发出新请求的 retry 单独占额 |

`received_at` 使用宿主接纳时钟，来源自报时间另存为 `occurred_at`；外部 payload 不能通过伪造时间、actor、因果根或订阅 ID 改变准入。相同幂等身份携带不同规范化请求体必须冲突，不能静默改写历史。

### 2.2 Schema 落点

新增 `src/main/db/bot-work-phase4-schema.ts`、`src/shared/bot-work-phase4-contracts.ts`；从 `AppDatabase.ts` 初始化接入。新表的逻辑外键、CHECK、唯一索引和查询索引必须进入真实 SQLite 门禁。新 schema 使用仓库当前版本机制；不实现旧数据库迁移/双读兼容，不破坏旧库改名备份契约。

| 表 / 对象 | 必需状态与约束（待实现） |
| --- | --- |
| `work_schedule_ticks` | tick 身份、订阅、规则 revision、逻辑槽位、本来计划时间、实际生效时间、状态、关联 Inbox/离线缺口；唯一 `(subscription_id, schedule_revision, logical_slot_key)`，与入队同事务 |
| `work_offline_gaps` | gap/宿主会话/订阅身份，`offline_gap_from/to`，检测依据，策略快照，回查能力、游标、补入/合并/跳过计数、未知范围及处理状态；恢复重复扫描不产生重复缺口 |
| `work_causal_chains` | chain/root 与父引用、可信 origin、目标/订阅、输入快照/版本、规范化状态 hash、depth/hops、准入结果/阻碍和幂等身份；保存逐次准入事实，不能仅用内存计数器 |
| `work_budget_windows` | Work、稳定 window 身份、政策 revision、scope、起止边界/时区、上限、续期政策、状态和三桶累计；唯一 Work + 政策周期；历史窗口不可重用 |
| `work_subscription_cursors` | 按 `(subscription_id, source, target_key)` 保存最高已接纳/已消费版本、来源 replay 游标与计划枚举水位；单一 `last_processed_source_version` 不能代表多目标水位 |
| `work_watch_host_state` | 单权威宿主最近已完成扫描/活跃水位、session/authority、停止/休眠证据和恢复游标；与租约分责，先保存旧水位再更新本次心跳 |
| 既有 `work_subscriptions` | 规则 revision、明确来源目标/过滤与比较策略、Cron/DST 政策、有限队列/溢出容量、补处理政策和下次唤醒；配置必须能通过真实受守卫入口保存 |
| 既有 `work_source_events`、`work_paused_source_routes` | 复用来源事实与 per-subscription 路由身份，将路由状态机扩展到在线/暂停/离线；不再仅凭全局来源 `sourceNew` 判定所有路由都已处理，不另建平行 payload 真源 |
| 既有 `work_events_inbox` | 分目标批次、固定合并截止时间、不可变冻结快照/claim 版本、处理原因、来源/规则/因果身份；保持 pending/merged/skipped/blocked/processed 兼容语义，冻结认领用独立字段或严格扩展状态 |
| 既有 `work_budget_reservations` | 保留预留量，增加实际报告量、计量单位/可信状态、原调用/原生 binding/child/attempt 身份及幂等回执键；明确 reserved/unknown/committed/released 互斥转换 |
| `works`、Work DTO / 控制契约 | 新增持久承诺期限与 revision、预算周期政策及 watch 状态投影；不借用授权到期字段；控制更改保留可信 actor + operationId + 三元版本守卫 |
| `work_blockers` 与投影 | 稳定 reasonCode、来源/订阅/窗口/因果引用和详情；相同持续问题只更新同一阻碍，不按每条事件刷屏 |

窗口累计和 UI 摘要是同一账本的事务投影，必须能从持久 reservation/receipt 重算。审计、tick 与去重数据制定有限保留/压缩政策；压缩后必须保留可证明的高水位/去重屏障，不能删除唯一键后允许历史事件再次执行。

### 2.3 统一消费与事务边界

1. 来源适配器在事务外验证来源/解析事件，读取历史或当前状态也在事务外完成；禁止在 SQLite 写事务中做网络、文件读、模型推理或等待。
2. 在短 `.immediate()` 事务内再次检查 authority、Work 生命周期/版本、订阅归属、来源/过滤、因果、容量，保存来源事实和每个合法路由的接纳结果。真实 ACK 只能发生在对应持久结果提交后。
3. 到期时原子认领并冻结批次。异步权威回读返回后必须以原批次 token/version、订阅 revision、Work 输入/版本重新验证；不能将期间被新事件更新的行一并标 processed。
4. 消费回执、处理水位、输入事实变化与持久派发 Outbox 一并提交；实际 worker 启动仍走已有 Outbox/dispatch 恢复链。事务失败全部回滚，恢复复用原批次/请求。
5. 每个来源、订阅和 Work 的单轮扫描/回填均有限额并轮转，避免一个持续高流量订阅阻塞其他 Work、deadline、结果结算或预算核对。

## 3. 开发前准备（P4-00）

- 同步并记录执行时最新 main 的完整 SHA、工作区状态及与本审核基线的差异。保护别人的未提交改动；保持仓库 main 单主线，不擅自建分支/worktree。
- 阅读 AGENTS、冻结设计/验收、Phase 3 followup 和真实调用链。仅支持当前锁定 Pi 版本；`EXPECTED_PI_VERSION` 与 schema 版本从代码读取，不硬编码新数字或引入旧 Pi shim。
- 记录依赖和环境是否满足现有门禁，区分原基线失败、新回归及环境阻碍。已有 socket EPERM 不得通过改失败白名单变绿，也不能预设所有新失败都属环境。
- 确定 schema、事件/批次/因果/预算身份、clock 和来源 adapter 契约后再并行实现 M1/M2/M3；共享契约由同一集成责任人维护。
- 本规划提交只做文档、路径和内容核对；代码实施后才跑功能门禁。本任务不授权升级版本、发布 build/pack/dist、安装或快捷方式修改。

## 4. M1 — 真实来源、多订阅扇出、按源合并与有界背压

覆盖 **BW-A36、BW-A41**。新增 `WorkWatchIngress.ts`，从 `WorkService.ingestSourceEvent()` 委托进入，和 `WorkPausedBacklog` 共用持久接纳/消费内核。

### 4.1 来源 adapter 与完整扇出

- 定义来源能力：可信 source namespace、目标键、事件身份/冲突 hash、版本比较或权威读回、可回查区间/游标、ACK/重投能力和 payload 上限。至少把仓库已有文件/Git 观测与一个真实已支持的业务事件入口接到宿主；外部连接器按现有可用入口接线，不凭空承诺不存在的公网 webhook 服务。
- `WorkSourceObserver` 当前能真实回读的来源和不支持的 `external_input` 要分别处理；不支持的 adapter 显式阻碍，不能靠测试 mock 说成生产通用订阅。
- 正常入口和显式 subscriptionId 入口都校验 source、filter、Work 归属、当前用户范围、停止状态与生命周期。关闭/closing/停止订阅不得新建执行义务；暂停 Work 只积压，不派发。
- 一份来源事实可在同一事务内命中多个合法 Work。来源级去重只避免复制原始事实，路由级去重逐一判断；崩溃重投和部分路由背压不得使已接纳路由重复或未接纳路由被吞。
- 去重默认依赖稳定来源事件 ID；相同 source_version 只有在 adapter 明确它代表同目标同逻辑变化时才可判重复。each 下不同事件即使版本相同，也不能无条件合并掉业务义务。

### 4.2 latest-source、冻结批次与防饥饿

- 所有比较限于同一 `source + target_key`。对结构化单调序号使用明确比较器（例如 v10 大于 v9）；Git revision/hash/ETag 不按字典序排序，采用可证明的 ancestry/供应商序列或权威当前状态回读。缺失、不可比或分叉版本必须保守处理。
- 权威回读显式返回分开的 `providerSourceVersion`（允许缺省/不可比）和 `observedInputSnapshotId`。来源 cursor / `last_processed_source_version` 只保存前者；没有来源版本时不能用快照 hash 顶替，输入快照另行绑定实际观测证据。若回读观察到冻结事件之后的新状态，记录实际观察版本和批次覆盖关系，不能顺手消费下一批尚未认领的义务。
- 比较最高已消费、已冻结和当前 open 批次水位。旧版本保留 skipped/审计原因，不回退 payload、输入快照或水位；合法新版本只更新同目标的 open 批次，递增 merged_count。
- 首条被接纳事件设定截止时间，新事件不延期。`now >= merge_deadline_at` 后，ingress 即使先于调度器运行也不能继续改写到期批次；原子冻结该批，后续到新批。已认领/正在回读/已有派发意图的快照不可变。
- 只因相同当前状态而跳过执行时，仍保存检查事实和消费回执；需要执行才提交持久 Outbox。latest 的合并批次、实际执行和通知是三个不同决定。
- 满足执行门控的到期批次在下一次有界扫描被派发；若资源、预算、暂停或在途执行阻挡，投影明确原因和 readySince，不再通过延长 merge_deadline 伪装仍在等待合并。

### 4.3 each 队列、持久溢出与来源背压

- `max_queue_depth` 约束可调度未完成义务，统计包含 pending、合并待处理和已冻结/认领项；不能只数 pending 而漏掉实际占用。逐事件处理顺序由 adapter 的稳定源游标定义；无可排序序列时记录可信接纳顺序及能力限制，不声称已恢复任意来源因果顺序。
- 每个 each 义务的不可变 payload/持久引用、source identity、source version 和路由身份必须绑定到 dispatch/binding 的执行输入，worker 实际收到对应事件内容，结果回到同一义务。不能只逐条读取“当前源状态”、替换输入 hash 或重复 title/description/criteria 来冒充逐事件业务处理。
- 满队列后在有限溢出区保存每条已接纳事件的 blocked 身份，并原子打开 `kind=backpressure, reasonCode=backlog-overflow` 阻碍；该订阅状态、数量/字节数、最旧等待和回填游标进入投影。
- 持久溢出区也有保存的 `max_backlog_events/max_backlog_bytes` 限制，容量核对覆盖 source payload、路由与 Inbox，不能把无界增长移到 `work_source_events` 或 routes 表。
- 达到硬上限后返回明确未接纳/容量错误，停止拉取、延后 ACK 或依来源协议 NACK/重投；不要先写“已完成来源去重”导致下一次重投永远被吞。部分扇出成功时保存 per-route 结果，重试只补未接纳路由。
- 无历史、无可靠重投且不可背压的来源，必须在订阅准入/UI 中明确不能保证 each 完整性；发生缺口记录范围和未知数量，绝不把不可恢复丢失计成处理成功。有限存储不能保证无限输入下无条件全量接纳。
- 消费后按原身份有界回填，低水位时恢复来源并清理已解决阻碍。暂停/离线/在线共用同一容量和回填规则；停止订阅保留已存在义务的处置证据。

## 5. M2 — 时区调度、离线补处理与承诺唤醒

覆盖 **BW-A37、BW-A38**。新增 `WorkWatchScheduler.ts` 并扩充 `WorkSchedule.ts`；scheduler 负责产生业务事件，不接管 Durable 执行。

### 5.1 注入时钟、逻辑计划与宿主接线

- 统一 `WorkClock { now(): number }` 和可注入 timer；增加单调 elapsed-time 观测用于区分墙钟跳变与经过时间。WorkService、dispatch、host、ingress、窗口与 scheduler 使用同一 clock，避免深层 `Date.now()` 漏出虚拟时钟。
- scheduler 从 AgentService 真实启停流程注册，在权威 lease 内运行；应用退出停止本实例 timer/订阅。系统 suspend/resume 经现有主进程生命周期入口唤醒 scheduler；多个 renderer、重连客户端或非权威宿主不能自行 tick。
- 复用锁定 croner 的语法解析与候选计算，按已保存 IANA timezone 解释；无效时区/Cron 拒绝配置。不要仅依赖库默认 DST 行为，必须用下列行为测试锁定规范化结果。
- **春季缺失时间**：应落在缺失本地区间的计划合并到跳变后的首个有效时刻一次；保留原逻辑槽位和合并范围。若多个缺失槽位/正常槽位映射到同一实际时刻，记录覆盖关系并按既定策略合并，不制造重复业务工作。
- **秋季重复小时**：同一当地日历槽位仅采用首次出现；logical_slot_key 不因 UTC offset 改变而变成第二个业务槽位。timezone/Cron 修改增加 schedule_revision，显式设置新规则起算游标，不擅自重放旧规则历史。
- tick 唯一键、Inbox 与 next_wake/枚举游标在同一事务提交。记录前/后、提交后未唤醒前均做崩溃注入；重启恢复原 tick，不能重复执行。
- 墙钟回拨不倒退已持久计划水位、不重复已存在槽位、不让已冻结合并批次重新等待；前跳以 catch-up 策略扫描错过区间。原进程中的最长等待使用单调耗时保护；重启后用持久截止/离线证据处理不确定性，不能给新一轮完整等待预算。
- 长离线和高频 Cron 使用有限页大小、最大扫描工作量和持久 continuation cursor，下一轮继续；禁止逐分钟扫描任意多年历史或在一次写事务内灌入全部 tick。

### 5.2 离线事实与恢复政策

- 旧 `heartbeat_at`、最后成功扫描游标、显式 suspend/shutdown、启动会话/恢复时间共同形成检测证据。**在 acquire/start 覆写心跳前读取旧状态**，保存 `offlineGapFrom/To`。有证据的休眠/退出与仅推测的扫描停顿分别标明；只见 wall clock 前跳不能断言整段时间宿主离线。
- 宿主在线不等于每个外部来源在线。来源连接/权限/网络故障单独保存该订阅 gap；恢复采用来源真实历史能力，不能把本地空 Inbox 当成“离线期间没有事件”。
- 每个 gap 保存当时政策/规则 revision、来源游标与恢复状态。重启中断分页、回查成功后事务失败、多个恢复通知重复到达都沿用原 gap 和事件身份。
- `latest`：回读当前权威目标或比较历史中的最高可比版本，合并为一次补检查；与新在线事件统一比较，不能让迟到历史覆盖当前版本。
- `each`：从可信历史/缓存按稳定游标有界补入；已处理/已接纳身份跳过，超限进入第 4.3 节的背压流程。没有枚举完的部分保留 continuation，不能提前推进最终水位。
- `skip`：持久记录错过区间与可知跳过数量，直接等待未来 next_wake；恢复时刻之后的新在线事件仍正常处理。来源历史不可枚举时 skipped_count 为未知/范围，不能虚构精确数量。
- 无历史回查能力时建立 `unqueryable-offline-gap` 阻碍，即使 latest 能读取当前状态也不抹去“中间历史未知”的事实。UI 分别显示当前状态已核对和历史缺口未能恢复。

### 5.3 零外部 Hook 的业务承诺到期

- 新增受守卫创建/修改的业务 `deadlineAt/deadlineRevision`（以及确有声明的跟进窗口），独立于授权/预算到期。创建、修改、取消与关闭均持久化，并使旧期限实例失效。
- scheduler 每轮有界扫描仍未完成且期限到达的 Work，原子记录唯一 `event_type='deadline_expired'` 系统 Inbox 与跟进意图，即使外部事件数为零也能唤醒负责人整理缺口。
- **不能伪造新 inputSnapshotId 来避开现有同输入不重跑守卫。** 使用绑定 deadline 实例的只读跟进/continuation 意图，允许整理已有成果和未完成项，不重跑原业务副作用；同期限重启/回拨/交接只产生一次逻辑跟进。
- 暂停 Work 记录到期事实和待跟进，不擅自恢复执行；closing/closed 不启动新工作。授权/预算耗尽则记录到期/缺口阻碍，必要 UI 事实仍可展示，不借到期续权或增配额。已完成后迟到的期限事件只结清历史实例。

## 6. M3 — 因果防环与协作者共享预算

覆盖 **BW-A39、BW-A40**。新增 `WorkCausalGuard.ts`、`WorkBudgetService.ts`，原位接入控制、真实执行和回执链。

### 6.1 可信因果链和专家互调

- 链路必须闭合：来源/系统事件 → 准入 → 冻结输入/派发 → binding/owned child → 工具动作/外部效果 → 回流 Hook 或协作消息 → 再次准入。保存 `causal_event_id`、来源动作/回执身份、`origin_work_id/origin_bot_id`、输入快照与业务 `target_state_hash`。
- origin、root 和父引用由可信宿主/适配器验证；外部 payload 或模型不能自报新 root 清零计数。内部动作遗漏引用时从持久 binding/action 恢复，无法证明关联则报告 attribution unknown 并保守限制，不默认为全新无限预算链。
- `causalMessageId/replyToMessageId` 和 `causalEventId` 分属不同命名空间，通过统一 chain 账本桥接。检查 `WorkCollaborationService.send`、新派发准入、工具动作回流和 owned-child/专家独立根，不能仅守 Hook 入口。
- 指纹只取相关业务状态和输入版本，排除 eventId、随机值、接收时间等噪声。同链相同 `(work_id, subscription_id/协作目标, inputSnapshotId, target_state_hash)` 再次请求新执行，形成 `causal-loop-guard`；不同 Work/订阅的合法扇出不被全局去重吞掉。
- 状态确实推进的自身事件可继续，同时受保存的 max_causal_depth、全链 hop/派发总量和共享预算约束。默认专家互调最多 4 跳，统一保存/读取该政策，不在多层各加一份额度；高扇出也必须有总量界限。
- 幂等回放不增加 hop。新 hop、准入事实和持久派发意图同事务，崩溃、重启、handoff 不重置链；同状态换消息 ID、不断变状态的乒乓、并行分支均不能逃出上限。
- 触限只挡新增工作。accepted/result/blocked/cancel、用量核对、原资源清理和 adoption 等结算事实仍能落盘；通知服从既有权限和语义去重，不能因每次拦截向用户重复报警。

### 6.2 同一 Work 的共享预算与真实请求准入

- WorkService 现有预算方法委托 WorkBudgetService，派发、协调者、所有 delegate/owned child 和独立专家根都解析到同一 Work/window。子任务不是新配额，前台受 Work 约束的决策消费也不能绕开。
- 在短 SQLite `.immediate()` 事务中检查 authority、当前政策/窗口、合法请求身份、授权上限及可用额度，再持久预留。相同 reservation ID/请求体重放返回原回执；同 ID 改 Work、窗口或金额必须拒绝。
- 三桶互斥，统一单位并验证非负安全整数：

  `available = windowLimit - committedActualTokens - reservedTokens - unknownReservedTokens`

- 当前 reservedTokens 已包含 unknown 的旧投影必须统一改成上述互斥语义；不能再减一次导致重复冻结。窗口摘要与逐行账本在同一事务更新，UI 不能自算另一份可用额度。
- 预留必须进入**每次真实 provider 请求前**的边界：generation、compaction、自动继续、owned child、独立 root、provider retry 和受管 inline 模型调用。`WorkDispatchQueue` 当前整执行最多 4096 的预留不能成为硬预算证明；派发预留与逐请求预留明确采用父 envelope/子分配或统一替换，不能重复扣两遍。
- 每次可能新增消费的 request/attempt 有持久身份。恢复同一次调用不重复占额；真正重发新供应商请求则新增占额，旧未知请求不释放。compaction 从 checkpoint 恢复也检查最终请求，不能只依赖可能不再执行的 beforeCompact hook。
- `estimatedTokens` 不是天然上界。采用可核对输入量 + 供应商可强制的输出/请求上限；不足时发请求前原子补额，补额失败阻断新调用。不能约束的计量范围明确展示并拒绝宣称硬成本上限；实际超额完整入账并阻止继续消费。
- 额度拒绝生成稳定 `budget-exhausted` 阻碍，并保留原业务输入/派发身份；不能通过重试造新 Work/window 增额。provider 网络请求在事务外执行。

### 6.3 unknown、迟到回执与一次结算

- 请求前未提交：可以凭可靠证据释放；请求可能已送达：保持 reserved 或置 unknown；供应商可信回执到达：按原 reservation/window 结算为 committed。单看 cancelled/failed/stopped、空 usage 或合成零都不能释放。
- 明确区分可信 `reportedTokens=0`、已证明未发送和框架异常合成的 0。用量缺失、流中断、回执迟到和提供方不支持完整计量各有原因/核对状态。
- 账本保留预留上界与实际量，可信回执幂等去重；同回执或原生 Inbox 重放不重复累计。实际量大于预留不裁剪，差额完整记录并冻结后续准入。
- 原生 root+owned children+compaction 汇总和新增逐请求账本只形成一份费用事实；汇总用于对账，不能把已经逐请求结算的用量再加一遍。保留原始回执、统计范围和尚未归属的差异。
- handoff、`pending_adoption`、强杀恢复、旧窗口迟到回执均按原身份结算；没有成果 adoption 也不丢失已发生用量，不因补齐预算信息重复派发业务动作。

### 6.4 持久窗口与受控滚动

- 保存 `scope=work/window`、周期定义、边界/时区、limit、policyRevision 和 `autoRollover`；与当前 `allowNextWindow` 明确规范化映射。单次总预算默认没有自动续期；不借用授权过期时间生成新窗口。
- window 身份由 Work + policyRevision + periodStart 等稳定键生成，不使用随机 UUID、ownerEpoch 或启动次数。窗口边界按保存政策计算；本地日/周周期需用 IANA 时区，不能把 DST 日强制写成固定 24 小时。
- 即使当前使用量为 0，未到持久 window_end_at 也不得打开新窗口；无期限总预算不因调用 openBudgetWindow 获得新额度。autoRollover=false、回拨到旧周期均不得重开。
- 到期且政策允许时，原子创建唯一下一有效窗口。墙钟跨越多个周期只进入当前合法周期，跳过的额度不累积；重复 tick/重启只得到同一个 window。
- **默认保留现有保守规则：存在 reserved/unknown 时不自动发放新窗口额度，先对账并展示阻碍。** 如实现显式跨窗 carry 政策，必须保存用户授权，原 reservation/window 不变，未结责任继续扣减新准入额度，回执对原窗结算且 carry 只释放一次；不允许跨窗失踪。
- 用户明确修改预算政策须走可信 actor、operationId 和版本守卫，且受授权上限约束；模型不能提交任意新 windowId/maxTokens 自授额度。策略变更、handoff、续期都不清空历史用量和因果链。

## 7. IPC、UI 与真实监控（P4-07）

- 扩展共享 DTO/严格 schema、现有 IPC/preload 和权威投影，而不是 renderer 直接访问 SQLite。订阅创建/修改/停止、承诺期限和预算政策均需当前身份及版本守卫；只读监控不提升权限。
- [BotWorkspacePage.tsx](../src/renderer/src/components/pages/BotWorkspacePage.tsx) 展示订阅来源/目标、在线或暂停状态、策略、时区、下一唤醒、最近实际检查时间、当前规则 revision；没有真实宿主心跳不能显示在线运行。
- 离线卡片显示 `offlineGapFrom ~ offlineGapTo`、依据/不确定性、当前回查/补处理状态、已补/合并/跳过/未知数量和不可回查原因；不能把恢复后的最后检查时间画成离线期间连续在线。
- 队列显示 ready/frozen/blocked 数、容量/字节上限、最旧义务、固定合并 deadline、等待执行原因与来源重试状态；阻碍恢复后随同一投影清除。
- 预算显示 window 起止/时区、上限与 committed/reserved/unknown 三桶、可用额、原窗口迟到回执和续期阻碍；未知费用范围明确，不能展示 0 消费。
- 因果阻碍提供触发原因、相关业务步骤/状态与负责人的下一步；默认界面解释业务含义，专业细节放可展开区。保持原有成果、Memory、项目与证据入口。
- 新状态变化进入既有 projection journal、水位补读与重连机制；窗口重启后仍能看到同一缺口/阻碍/预算。React 渲染和真实 dev IPC 流程分别验收。

## 8. Codex / agent 执行清单

以下任务中 P4-00～P4-07 已实施并有门禁证据；P4-08 的实现与本地门禁已完成，GitHub Issue #16 回填由主会话执行。完成一项只勾该项，全部实施和必要证据满足后才能更新阶段状态。

- [x] **P4-00 基线、schema 与共享契约**：记录最新 main；新增 Phase 4 schema/contracts，扩承诺期限、路由/批次、来源水位、预算回执与阻碍字段；统一 clock/adapter/身份契约；schema 备份重建行为继续通过。
- [x] **P4-01 真实来源与多订阅扇出**：实现 WorkWatchIngress，生产 adapter 接入，修复全局来源去重吞路由、目标分区与 source-version 排序；统一活跃/暂停/离线状态机与受守卫配置（BW-A36）。
- [x] **P4-02 合并硬截止与完整背压**：固定首次 deadline、到期冻结/CAS、不可变派发、each 容量/有限溢出/上游重试/回填、公平扫描和可观察阻碍（BW-A41）。
- [x] **P4-03 时钟、IANA/DST 与承诺唤醒**：实现 WorkWatchScheduler，接 AgentService/权威/系统恢复；唯一 tick、跳时保护、期限字段与幂等只读跟进；零 Hook 能真实唤醒（BW-A38）。
- [x] **P4-04 离线补处理**：旧活跃水位保护、宿主/来源 gap、有限分页与恢复游标、latest/each/skip、不可回查缺口及 UI 事实（BW-A37）。
- [x] **P4-05 因果链与专家互调**：实现 WorkCausalGuard，贯通事件→派发→动作→回流与协作消息；同状态防环、深度/总量/共享预算边界、结算通路保留（BW-A39）。
- [x] **P4-06 共享预算与窗口账本**：实现 WorkBudgetService，真实 provider 请求预留、root/child/compaction/重试统一归属、unknown/迟到/原生对账、受控窗口和重启/交接继承；保持 EvidenceBudget 原职责（BW-A40）。
- [x] **P4-07 IPC/投影与 dev 监控**：订阅/期限/政策保存与恢复，订阅/时区/离线/背压/因果/窗口三桶展示、重连补读和真实 dev 流程；不能仅做假数据卡片。
- [x] **P4-08 联合门禁与交付**：注册六个专项脚本和必要集成/dev 用例，通过分类审计；执行 typecheck、完整 test:all 和相关前序回归，冻结实现 SHA，写独立审查报告、更新实施记录与执行 Issue；缺失实机/网络证据如实列出。（GitHub Issue #16 回填由主会话执行；本工作区未提交。）

依赖顺序：P4-00 → P4-01/02 与 P4-03/04；P4-05/06 在共享身份冻结后可并行，最终由 P4-07/08 串联验证。任务拆分不减少 M1～M3 的联合验收责任。

> 2026-11-07 实施结果：六项 Phase 4 专项、Phase 3 九项前序专项、真实 Pi 原生结算回归与完整 headless 门禁通过。最终 `pnpm -s typecheck` 通过；`pnpm -s test:all` 为 **343 passed / 0 failed / 0 known failed / 0 new regressions**；`--audit` 为 headless 345 / GUI 54 / NETWORK 29 / DATASET 2 / pending 0。剩余未运行/blocked 项、故障修复与实现 SHA 见 [Phase 4 复核](reviews/bot-work-phase4-2026-11-07.md)。

## 9. 验收矩阵与必须观察的行为

下列 `scripts/bot-work-phase4-*-test.ts` 已实现并注册为 `test:bot-work-phase4-*`（2026-11-07）。测试全程用虚拟时钟/可控 timer 推进时间，真实 SQLite 与真实原生集成义务不能被源码字符串检查替代。

| 验收 | 注入条件 | 必须观察到的判定结果 | 脚本 |
| --- | --- | --- | --- |
| BW-A36 | 同 Hook 扇出多 Work；重复、部分路由背压、崩溃重投；v4→v1、v9→v10、同版本不同义务、多目标/不可比版本 | 各合法路由恰好一次；latest 目标快照不回退；each 义务不被版本去重吞掉且 worker 分别收到对应不可变事件内容；回读期间新事件不被旧消费误标完成，源版本不被快照 hash 替代 | `scripts/bot-work-phase4-hook-fanout-test.ts` |
| BW-A37 | 宿主退出/休眠、来源断连、重复 resume、补读中重启；三种策略与不可回查源 | 原离线区间/游标保留；按政策有界恢复；skip 不忽略在线新事件；未知历史明确缺口；UI 不宣称离线持续执行 | `scripts/bot-work-phase4-offline-catchup-test.ts` |
| BW-A38 | 上海/洛杉矶/伦敦时区；春季缺口、秋季重复小时；回拨、前跳多周期、规则变更；零 Hook 的期限到达 | 唯一逻辑 tick/持久意图；首个有效/首次重复政策正确；冻结截止不被回拨复活；期限只触发一次缺口跟进，不重跑原副作用；暂停/关闭规则正确 | `scripts/bot-work-phase4-schedule-clock-test.ts` |
| BW-A39 | 自身动作推进状态、同状态换 ID、专家 A→B→A、并行扇出、删/伪造因果引用、准入后崩溃 | 合法下游执行一次；同状态及变化状态乒乓均有界；合法多订阅不过滤；重启/handoff 不清零；触限后用量/结果/清理仍结算 | `scripts/bot-work-phase4-causal-guard-test.ts` |
| BW-A40 | 两个 SQLite 连接争最后额度；root+多个 child+独立专家+compaction；真实 retry/恢复 replay；缺字段/延迟/合成零/明确零；重启/handoff/跨窗 | 并发预留不重复分配；实际请求都有持久占额；unknown 不释放；原窗口一次结算且不重复加原生汇总；未到期/无期限/禁止续期/回拨不能重开；超预留用量如实入账 | `scripts/bot-work-phase4-shared-budget-test.ts` |
| BW-A41 | 连续输入跨多个合并周期；冻结/回读竞态；each 队列和溢出区都满；来源重试与慢消费、多订阅竞争 | 首批 deadline 固定且按期 ready/派发或明确阻碍；新事件进新批；所有接纳存储有上界，超限不 ACK 成功；回填无漏无重；其他 Work/deadline/结算不饿死 | `scripts/bot-work-phase4-backpressure-test.ts` |

### 9.1 故障与真实性要求

- **事务故障**：来源保存、路由扇出、冻结、Outbox、tick、gap 游标、预留、用量结算和窗口打开，各选持久边界前后注入；关闭并重新打开数据库/存储后检查身份、行数、状态和真实效果次数。
- **真实竞争**：预算最后额度、相同 tick/route、同链 hop、窗口 rollover 使用独立 SQLite 连接或受控进程争用；单线程依次调用不能代替并发准入证据。
- **执行完整链**：真实来源入口 → Work → Inbox → 派发 → Pi Durable → owned child/工具动作 → 原生回执 → 投影至少有集成故事；不能全部用假执行器覆盖。网络能力缺失时明确 blocked。
- **计费完整链**：真实请求边界的预留、compaction 恢复、默认零与明确零、迟到旧窗回执、超预留报告、parent/child 汇总不重计，均断言实际请求次数和账本重算一致。
- **dev/GUI**：使用隔离临时用户配置运行 `pnpm dev`，验证 IPC 保存、宿主状态、离线缺口和三桶展示。纯 React 测试不等于 preload/IPC/页面联调通过；真实 Windows/Omarchy 桌面缺失不得用 headless 代替。

### 9.2 联合门禁与报告

1. 新测试注册 `package.json` 和 `scripts/test-all.mjs` 对应分类，执行 `node scripts/test-all.mjs --audit`；新增 IPC 按既有 inventory 规则核对，不能从改后源码重写基线来掩盖变化。
2. 运行六个 Phase 4 专项、受影响的 schema/Work/派发/订阅/预算/投影回归、Phase 3 九项专项和适用的原生集成。重点保留 Phase 2 unknown/owned-child 用量、同输入不重跑及 Phase 3 pending_adoption 一次结算。
3. 执行 `pnpm -s typecheck`、`pnpm -s test:all`。门禁有失败就记录实际退出码；不增加失败白名单，不用静态关键词或缩小断言替代行为。不把之前的 EPERM 自动当成新提交所有失败的解释。
4. 最终验证绑定一个冻结的实现 SHA；测试后若再改源码，按影响重跑并更新冻结点。审查文档单独提交，指明它验证的实现提交，不能写报告提交的 HEAD 冒充受测源码。
5. 产出 `docs/reviews/bot-work-phase4-YYYY-MM-DD.md`，写实际环境、命令/退出码、BW ID、注入点、Work/operation/submission/window/causal 身份、关键数据库终态、provider/外部效果计数、passed/failed/blocked/not-run 及证据路径。
6. 更新 [实施记录](bot-work-implementation.md)、本任务清单和执行 Issue。代码实施完成与全部场景验收通过分开记录；缺失必要平台/集成证据时明确阶段仍未整体验收。

## 10. 交给执行 agent 的指令

从执行时最新 `main` 开始，以本文件和冻结设计/验收为唯一 Phase 4 范围，完整实施 P4-00～P4-08。先读 AGENTS 和 Phase 3 followup，核对真实接口；按共享契约拆分工作，最后统一跑通事件、调度、因果、预算、原生执行与 UI。不要只完成 P4-00～P4-03，不要在添加表/函数后停止，不要把规划状态提前改成完成。

遵守 `main` 单主线及本任务的提交/推送授权，完成实现后把代码、准确门禁和审查记录推送主线；不创建额外发布，不升级版本，不 build/pack/dist、不安装或改快捷方式。存在真实阻碍则保留工作与原始失败证据，在 Issue 中明确剩余条件；不得改冻结验收或扩大失败基线制造完成。

规划文档和 GitHub 执行 Issue 是可复查的任务入口。仓库当前只配置验证 CI，推送/创建 Issue 本身不证明外部开发 agent 已启动；只有实际 agent 任务/运行回执才能将“待执行”改成“执行中”。
