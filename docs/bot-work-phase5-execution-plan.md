# Bot / Work — Phase 5 执行规划（供 Codex / agent 实施）

> 最新状态（2026-11-08）：**剩余代码功能与生产原生十步故事已完成，整体验收仍待实机/真实账户证据。** 实现冻结 **[fff50d77538654565a562b2122109fea302576a7](https://github.com/qq824045252-ship-it/wavealstra_harness/commit/fff50d77538654565a562b2122109fea302576a7)**；最终完整门禁 **353 passed / 1 failed / 0 known failed / 1 new regression（158.45 秒，exit 1）**，唯一 AT-SPI socket EPERM 在基线 `ac03fd5` 亦复现。真实 Gateway 出站、独立负责人汇总、桌面评审/反馈/关闭和两次真实原生 SIGKILL 恢复已补齐，详见 [功能补全与原生验收复核](reviews/bot-work-phase5-completion-2026-11-08.md)。[第一轮加固](reviews/bot-work-phase5-followup-2026-11-08.md) 与 [首轮 Windows 证据](reviews/bot-work-phase5-2026-11-07.md) 保留为历史记录。
>
> 确认日期：2026-11-07（Asia/Shanghai）。
>
> 审核代码基线：[`main@57e6fbbdf7977d46ac2d9bf0d606b26da3bb6fe4`](https://github.com/qq824045252-ship-it/wavealstra_harness/commit/57e6fbbdf7977d46ac2d9bf0d606b26da3bb6fe4)，提交本规划前已读取 GitHub 远端确认。
>
> Phase 4 实现冻结 SHA：[`3153cf09125f946eb6d1a3fad7f634d132f242ee`](https://github.com/qq824045252-ship-it/wavealstra_harness/commit/3153cf09125f946eb6d1a3fad7f634d132f242ee)。规划时 schema 为 33，应用版本为 0.1.107，预计 Phase 5 schema 为 34；首轮实现使用 schema 34，本轮功能补全升至 schema 35，应用版本仍为 0.1.107；旧库按既有策略改名备份后重建。
>
> 范围：成果验收与稳定结果卡片、通知回执与 unknown、多专家汇总、桌面/移动重连、分层诊断与证据、冻结验收第 9 节十步故事，以及前序遗留实机证据收口。专项覆盖 **BW-A42～BW-A46**，终局核对 **BW-A01～BW-A46、R09/R10 与 UI-01～UI-10**。

产品语义以 [冻结设计](bot-work-design.md) 第 4、6～14 节、[冻结验收](bot-work-acceptance.md) 第 8～10 节、[双页面 UI 规范](bot-work-ui.md) 和 [AGENTS.md](../AGENTS.md) 为准。最新实现与门禁边界见 [功能补全复核](reviews/bot-work-phase5-completion-2026-11-08.md) §4～§7；前序 [Phase 4 加固复核](reviews/bot-work-phase4-followup-2026-11-07.md) §5.1 的待补证项继续保留。前序资源与交接边界见 [Phase 3 加固复核](reviews/bot-work-phase3-followup-2026-11-07.md)。

M1～M3 是同一个收官阶段内的依赖顺序。后续实施应连续完成 P5-00～P5-08，不能只交付表结构或 P5-00～P5-03。实施完成、headless 通过、原生集成通过、实机通过和 BOT-WORK-1.0 总体验收是不同结论，必须分别记载。

## 0. 不可突破的八条约束

1. **成果与通知意图原子落盘，通知恢复不得重跑工作。** 在既有 SQLite `.immediate()` 业务事务内完成成果接纳、必要的 Work 状态推进、唯一语义卡片、通知意图及投影日志。事务提交后、实际通知发出前崩溃，恢复只处理原投递义务；同一成果事件重放不能新建逻辑工作、执行 binding 或重复卡片。同一控制操作回放、同一结果事件回放和用户提出新的工作须分别处理，不能放松原版本守卫来制造幂等成功。（F07/F13、BW-A42）
2. **外部投递保证服从真实渠道契约。** 请求可能已发送但回执丢失时，按真实幂等/回查能力恢复；不能将“暂时查不到”视为未发送。不可回查且不能证明幂等安全的投递保持 `unknown`，保留原尝试与证据，不盲目自动重发，不宣称严格恰好一次。用户明确重发是新的授权投递尝试，不是抹掉原 unknown。（F07/F13、BW-A43）
3. **当前主负责人组织用户信息，阅读不控制事项。** worker/expert 的中间结果、冲突探测、限流补试和资源排队保留内部账本；当前 `ownerBotId` 汇总实质成果、变化与待决项。影响用户的持续阻碍必须可见，不能以降噪为名吞掉。查看卡片只更新阅读状态/阅读水位，不改变 Work 的 `stateVersion / intentRevision / ownerEpoch / lifecycle`，不创建执行。（F04/F11/F13、BW-A44）
4. **重连后以宿主持久事实为准。** 桌面和手机携带 `epoch / sequence / scope` 读取 Work 投影日志；连续增量追平或原子全量替换，清理墓碑、关闭范围外事项及失效绑定。跨 epoch 的本地高版本也不能压住服务端新快照。不得把客户端缓存、SSE 事件 ID 或本地已读时钟逆向写成业务真源。（F06/F13/F14、R10、BW-A45）
5. **主视图可决策，展开视图可追证。** 默认只呈现目标、当前负责人、当前有效结论、未决阻碍和下一步；展开查询关联 `(workId, intentRevision, inputSnapshotId, ownerEpoch)`、`bindingId`、执行回执、产物版本、资源/因果/预算与未验证范围。历史证据可见但不能冒充当前结论，截断或缺失证据必须标识。（F12/F13、BW-A46）
6. **十步故事运行真实持久层与原生执行链。** 同一套临时数据库、同一路径 Durable 存储和真实业务服务连续驱动故事，重启必须重开这些存储。模型/效果可用可控 fixture，执行内核不能全换成假代理，不能用 SQL 直接拼终态或绕过守卫。业务 fixture 的“Omarchy 通过”不等于真实桌面验收。（冻结验收 §1、§9）
7. **如实保留门禁与环境边界。** 不新增失败白名单、不缩小断言、不把 blocked/未运行改成 passed。Phase 4 历史冻结报告的两轮全量均为 **344 passed / 1 failed，exit 1**；第一轮 Phase 5 加固的历史全量为 **348 passed / 1 failed，exit 1**；本轮功能补全的最终全量为 **353 passed / 1 failed / 0 known failed / 1 new regression（158.45 秒，exit 1）**；D-Bus/Unix socket EPERM 的基线复现只解释该次失败，不预先解释后续所有失败。Windows、Omarchy、移动端、真实连接器等缺证据时阶段不能宣告整体验收完成。
8. **沿用唯一权威、既有控制入口及当前版本策略。** Work 事实归 SQLite/WorkService，执行与 checkpoint 归 Pi Durable；不另建 Work/Goal、执行恢复器、控制服务或通知发送账本。允许增加有唯一键、能回溯事实的派生 `work_result_cards`，它不能成为第二套 Work 状态。复用受控 IPC/Remote 接线；必要的新方法须进入既有 API 和库存审查。不引入旧数据迁移/旧 Pi 兼容层，保留数据库不兼容时改名备份后重建的契约。

## 1. 已核实的基线事实与原位演进

下表是 `57e6fbb` 的代码事实；“待完成”不是已有能力或测试通过声明。链接指向仓库实际路径，新增文件在后文以代码路径标明。

| 现有位置 | 本基线已有事实 | Phase 5 待完成 |
| --- | --- | --- |
| [WorkService.ts](../src/main/agent/work/WorkService.ts)、[WorkRepository.ts](../src/main/agent/work/WorkRepository.ts) | `acceptDeliverable/closeWork` 已经由 `runWorkControl → transaction().immediate()` 保护；有操作回执、成果、证据、当前投影 | 在原事务补齐语义卡片和投影；维持原 operation/body/version 校验，不能笼统把新验收请求改成无条件成功 |
| [bot-work-schema.ts](../src/main/db/bot-work-schema.ts)、[bot-work-phase3-schema.ts](../src/main/db/bot-work-phase3-schema.ts) | `work_notifications.semantic_key` 已唯一且有 `read_at`；另有 `work_notification_identity` 与 `work_notification_attempts` | 新卡片关联既有投递账本；区分卡片、逻辑投递、物理 attempt、provider 幂等键；不再另建同义通知队列 |
| [WorkNotificationDelivery.ts](../src/main/agent/work/WorkNotificationDelivery.ts) | 发送前短事务认领、不可变 `payload_json`、原 attempt 回查、发送前版本/产物检查、交接后发送者重验 | 原位补渠道能力、稳定效果键、payload hash、异步认领/结算 fence、手动重发和生产投递循环 |
| [AgentService.ts](../src/main/agent/AgentService.ts)、[NotificationService.ts](../src/main/notification/NotificationService.ts)、[GatewayService.ts](../src/main/gateway/GatewayService.ts) | Work 投递对象已实例化，但未接入生产宿主的通知 drain/渠道注册；桌面统一通知和 Gateway 各有既有职责 | 把投递接入同一宿主 authority 的启动、恢复、唤醒和退出；桥接真实渠道与偏好，不让测试 adapter 代替生产接线 |
| [WorkCollaborationService.ts](../src/main/agent/work/WorkCollaborationService.ts) | 已有协作消息、版本、参与者和接管记录；执行结果归 Work | 当前负责人按当前输入汇总，复用消息/子项账本，区分内部进展与需人裁决事项 |
| [WorkProjectionJournal.ts](../src/main/agent/work/WorkProjectionJournal.ts)、[bot-conversation.ts](../src/shared/bot-conversation.ts) | 实际类名为 `WorkProjectionJournal`；Work 协议是 `epoch/sequence/scope`，每页最多 200 条、`hasMore`、`resync_required`、remove 墓碑；每用户保留 10,000 条事件 | 卡片/阅读事实进入同一日志；同 Work 控制版本的展示变化也可同步；完整快照与增量水位一致 |
| [botWorkSync.ts](../src/renderer/src/store/app/slices/botWorkSync.ts)、[activeContext.ts](../src/renderer/src/store/app/slices/activeContext.ts) | 已有分页回读和旧异步请求隔离；snapshot 仍与旧本地投影按 `stateVersion` 合并 | 修复跨 epoch/scope 快照被旧本地高版本遮蔽；清理选择、负责人绑定和诊断缓存，使用服务端阅读回执 |
| [RemoteAccessServer.ts](../src/main/remote/RemoteAccessServer.ts)、[RemoteAccessService.ts](../src/main/remote/RemoteAccessService.ts)、[RemoteAccessController.ts](../src/main/remote/RemoteAccessController.ts)、[RemoteEventBus.ts](../src/main/remote/RemoteEventBus.ts) | 已有配对/鉴权/SSE；事件总线可转发 Work patch，但没有完整 Work 同步/详情/反馈产品链 | 新增受认证 Work 路由与能力校验；SSE 只唤醒读取持久 Work 日志，不能作为权威游标 |
| [remote-contract.ts](../shared/src/remote-contract.ts)、[RemoteClient.ts](../app/remote/src/api/RemoteClient.ts)、[remoteStore.ts](../app/remote/src/store/remoteStore.ts)、[remotePatch.ts](../app/remote/src/store/remotePatch.ts) | 共享 Remote 契约位于 `shared/src/`；移动端未具备 Work cursor/reducer 与完整导航 | 补真实客户端 API、store、Bot/Work 页面、反馈/已读与断线恢复，保持 Task 状态隔离 |
| [durable-sync.ts](../shared/src/durable-sync.ts) | 这是 Durable 对话消息的 `epoch/revision` 协议 | 可复用同步原则，不能与 Work 的 sequence 或 SSE Last-Event-ID 混用 |
| [WorkRepository.ts](../src/main/agent/work/WorkRepository.ts)、[TaskDiagnosticsRepository.ts](../src/main/agent/TaskDiagnosticsRepository.ts) | 已有要求快照、执行/子项、交接/接管、资源、因果、预算及有界诊断读取；实际投影由 `WorkService.project` 组装 | 受权查询层分离 summary 与按需 diagnostics；完整历史从事实表读取，不能把有界投影日志当审计历史 |
| [BotWorkspacePage.tsx](../src/renderer/src/components/pages/BotWorkspacePage.tsx)、[botConversation.ts](../src/renderer/src/store/app/slices/botConversation.ts) | 有 Bot/Work 页面、资源/验收/协作、Phase 4 监控、unknown 预算核对及 closed 事项入口 | 精简主视图，卡片寻址、外部 unknown、阅读同步、诊断抽屉、全历史与专家配置审阅 |
| [AppDatabase.ts](../src/main/db/AppDatabase.ts) 与 Phase 2～4 schema | 当前 `CURRENT_DATABASE_SCHEMA_VERSION = 33`，不兼容库改名备份后新建 | 注册 Phase 5 schema；以执行时常量为准选择下一版本，测试不硬编码数字 |

### 1.1 草案中需要避免的误述

- 仓库没有 `WorkProjectionJournalService.ts`；实际为 `WorkProjectionJournal.ts`。Work 的游标类型在 `src/shared/bot-conversation.ts`，不是 `src/shared/durable-sync.ts`。
- Phase 4 的真实脚本是 [hook-fanout](../scripts/bot-work-phase4-hook-fanout-test.ts) 与 [offline-catchup](../scripts/bot-work-phase4-offline-catchup-test.ts)；本基线没有草案提及的 `phase4-hook-fence-test.ts` 或 `phase4-offline-replay-test.ts`。
- 当前渠道接口是 `idempotent: boolean` 加可选 `lookup`，不是已经存在 `supportsReceiptQuery` 或 `payload_hash`。通知 DTO 使用 `delivery: pending | sent | unknown | failed`、`sentAt`；语义有效性在 identity 中为 `active | superseded | cancelled`，不能把“过期”误写成现有 delivery 的 `invalidated` 状态。
- 现有每次 attempt 会产生新 `idempotency_key`，且该列唯一。规划要求安全自动重发时复用原效果键，必须同步调整该表示法/约束，不能只改 send 参数。
- `markNotificationRead` 已不修改 Work 控制状态，但入口需要补齐跨端身份校验和服务端回执；客户端 `Date.now()` 不能成为已读真源。
- `WorkProjectionDto` 当前含大量明细，未含新规划的 `unverifiedScope`；现有名称为 `uncoveredScope`。新字段应从版本化验收事实派生，不能制造一个由 UI 自行勾选的“已验证”状态。
- 有限 watch 的成功关闭已有限制：bot actor 不能直接调用成功关闭，需可信用户入口、停止条件和明确关闭说明。第九步沿用此守卫；现有 `stopSubscriptionsForWork` 已按 Work 停用订阅，后续重点验证/补强待唤醒清理和隔离。

### 1.2 继承的验证边界

下列是 **Phase 4 冻结报告的历史运行证据**，不是本次规划运行的结果：

| 项目 | 历史证据与限制 |
| --- | --- |
| 类型检查及专项 | typecheck 通过；Phase 4 六项、Phase 3 九项和 Phase 2 恢复两轮通过 |
| Linux 全量 | 两轮均 344 passed / 1 failed / 0 known failed / 1 new regression，exit 1；`test:atspi-transport` 在原基线同环境复现 D-Bus socket EPERM；未放宽失败白名单 |
| 恢复测试 | Linux 串行池 22.8s / 22.7s；不能替代此前 Windows 瞬时失败复验 |
| dev | 尝试真实启动 Electron 后因 Unix socket EPERM 受阻，未进入页面；新增表单点击仍 blocked |
| 其他缺口 | Windows BW-A31、Omarchy/Hyprland、移动端、外部连接器、真实供应商账单及适用发行包实机证据仍需分别取得 |

## 2. 身份、schema 与受控契约（P5-00）

### 2.1 稳定身份

| 身份 | 必须绑定的事实 | 不应导致身份变化的内容 |
| --- | --- | --- |
| 语义结果卡片 | `workId + intentRevision + inputSnapshotId + deliverableKind + canonicalOutcomeHash`；明确区分实质成果/阻碍/关闭结论 | ownerEpoch、stateVersion、通知重试次数、读时间、墙钟、文案润色 |
| 规范化 outcome | 验收结论、来源目标/稳定业务发生身份、当前产物/来源指纹、有效成果集合与实质待决项；字段白名单、稳定排序及格式版本 | 随机 ID、对象键顺序、非业务遥测；仅标题相同不代表同一成果 |
| 通知意图 | 稳定卡片 + 渠道/连接/接收目标的业务作用域；接在原通知账本 | 页面挂载、断线次数、worker 返回顺序 |
| provider 效果键 | 一次获准逻辑投递、准确目标与不可变 payload hash | 同一逻辑投递的网络重试或宿主恢复 |
| 本地 attempt | 原通知/逻辑投递 + 单调 ordinal/attemptId；保存不可变 payload、认领身份和原效果键 | 不能代替卡片键，也不能默认每次 attempt 创建新 provider 效果 |
| 阅读状态 | 已认证用户 + Work + 卡片，服务端持久 readAt/阅读水位 | Work 控制版本和客户端时钟 |
| 实测反馈 | 原 Work、要求/输入版本、被测 sourceRef、environment、artifactSnapshotId（适用时） | 不能在接收时自动替换成当前产物或当前 inputSnapshotId |

`semantic_card_key` 使用 SHA-256；编码采用带格式版本的规范化结构化元组或无歧义的长度编码，落实草案的五元组合意图，避免自由文本直接用冒号拼接产生歧义。主键可确定性派生自该键；不同时引入两套独立的 `semantic_card_id` 与 `semantic_card_key` 规则。

同一合法语义输入即使由不同回执路径重放，也只能命中同一卡片；不同产物、来源目标、合法业务发生或实质结论必须能区分。长期 watch 在相同要求/输入下的不同有效轮次可能都输出“检查通过”，不能仅 hash 摘要把它们误合并；业务发生身份来自持久来源/逻辑义务，重投递、重新合批和网络 attempt 不产生新的业务身份。要求/输入改变后旧卡片保留为历史，不能冒充当前结果；仅交接不生成第二张结果卡片。

### 2.2 Schema 落点

新增规划路径：`src/main/db/bot-work-phase5-schema.ts`、`src/shared/bot-work-phase5.ts`。从 [AppDatabase.ts](../src/main/db/AppDatabase.ts) 注册；基于本基线是 schema v34，若实施前 main 已前进，先核对常量与变更，不能覆盖其他 schema 工作。

| 对象 | 待实现的最小约束 |
| --- | --- |
| `work_result_cards` | 稳定主键及 `semantic_card_key UNIQUE`、Work/用户归属、语义类型、要求/输入/产物来源、canonical outcome hash、成果/证据引用、创建与阅读记录。ownerEpoch 可作创建来源证据，不能成为第二个当前负责人。当前性由持久事实判定或受控派生 |
| 既有 `work_notifications` | 引用同一卡片，保留唯一通知意图、delivery/渠道回执。多目标投递在既有账本演进，不能复制卡片充当每渠道投递；“卡片已存在”“渠道送达”“用户已读”分别投影 |
| 既有 `work_notification_identity/attempts` | 绑定真实渠道能力、不可变 payload hash、稳定 provider 效果键与 attempt fence；唯一约束防重复认领，同时允许安全重试复用原效果键。保留旧 unknown 的审计和迟到回执归属 |
| 阅读存储 | 明确 `work_result_cards` 为卡片阅读事实唯一写入点；既有 `work_notifications.read_at` 如需保留，只作同源派生/接口适配，不能两端独立写后互相覆盖。若桥接通用 `notifications` 表，须另行明确其显示/阅读映射，不能混同两张通知表。不增加另一套可控制 Work 的阅读表 |
| 既有投影 journal | 卡片生成、语义有效性、投递和阅读的独立事实变化进入同一 user stream，与事实同事务提交；不靠递增 Work 的控制版本来刷新已读 UI |
| 审计与索引 | 复用 `work_evidence`、操作回执、协作和现有诊断表。约束跨 Work/跨用户引用、正序 attempt、阅读对象归属；保留必要去重屏障与可寻址历史 |

投影日志的 10,000 条保留上限不是结果卡片或通知去重屏障的删除期限。归档/压缩历史时保留可证明的语义身份与审计引用；不得清掉唯一键后允许旧事件再次生成卡片或外部效果。查询和诊断分页有上限，不能无限拉取全库。

不为旧数据库写迁移/双读代码；仍须保护不兼容数据库改名备份，不得直接删除用户数据。schema 与行为测试读取当前版本常量。

### 2.3 查询、阅读与控制边界

服务内新增方法建议为 `markWorkCardRead(workId, semanticCardKey, readAt?)`、`getWorkSummaryProjection`、`getWorkDiagnosticsProjection(workId, options)`；名称可以等价调整，身份、事务和权限不能省略。

- IPC 优先扩展现有 [bot-work-ipc.ts](../src/shared/bot-work-ipc.ts) 的 `sync-works / list-works / get-work / mark-notification-read` 与受控操作联合类型。新服务方法不等于必需新 channel；确需补入口时同步 main/preload/API、鉴权和库存，不另建平行 Phase 5 控制器。
- 手机端的身份由已认证配对设备解析，检查用户、Work、目标渠道与能力；不相信客户端传入的 actor、grants 或 owner 身份。已读与诊断读取也必须检查归属，防止任意 card/notification ID 越权。
- 阅读可以在 closed Work 上执行。服务端生成/校验 readAt 并返回持久结果，重复请求幂等，倒序请求不倒退；不能用手机未来时钟永久压住其他设备。阅读水位与业务 `stateVersion` 分责。
- 用户手动重发、验收、要求修改、实测反馈和交接仍走各自受控入口；需要控制的请求保留 operationId、规范化请求体冲突检查及现有版本守卫。普通查询/已读不经一个会推进业务状态的“伪控制”操作。
- 结果、停止清理、预算迟到回执和旧通知回执仍能按原身份结算，不能因 Work closed、权限过期或预算耗尽就丢掉已经发生的事实；这不恢复新业务动作权限。

## 3. M1 — 原子成果交付、渠道回执与负责人汇总

覆盖 P5-01～P5-03、BW-A42～BW-A44。

### 3.1 成果接纳与唯一卡片（P5-01）

1. 复用 `acceptDeliverable` 的当前要求、输入、binding、委派接管、产物和必要验收检查。文件捕获/指纹核验等慢操作在事务外，短事务内重新验证原捕获身份及当前事实，不在写锁内运行模型/网络。
2. 在原 `.immediate()` 内提交 accepted 成果、Work 必要变更、规范化语义结果、唯一卡片、原通知意图、操作回执与 journal。任何一步失败全部回滚。
3. `closeWork` 复用同一卡片/通知编排：同一个已确认成果不能因 accepted 后又 closed 机械生成第二张同义结果卡；独立关闭决定如有新的实质语义，明确类型和关联卡片。运行完成、成果接纳、事项关闭仍各自有记录。
4. 同一 operationId 回放返回原回执；同一原生结果/Inbox 消费重放幂等；已 accepted 成果改用新的 operationId 请求再次验收仍按既有合法性检查处理，不能一律成功。
5. 崩溃恢复查回原卡片与原投递，禁止调用新的 `enqueue/wakeWork/submit` 来弥补通知。要求变更使旧成果 superseded；交接保留语义身份并由当前负责人重核发送者。
6. 测试单事务中间故障、提交前/后强杀重开、重复结果、双连接竞争插入同语义结果、accepted→closed 连续路径及关闭后恢复投递。断言数据库卡片/通知数、原逻辑检查次数、实际副作用计数和版本终态。

### 3.2 真实渠道能力与未知投递（P5-02）

显式声明 `deliveryGuarantee` 的高层分支（如 `idempotent-queryable / best-effort-unqueryable`），并以独立 `supportsIdempotencyKey / supportsReceiptQuery` 能力描述真实保证。仅幂等或仅回查的渠道不能被误标为“两者都有”。

| 实际能力/回执结果 | 恢复动作 |
| --- | --- |
| 支持回查，确认 delivered | 按原 attempt、payload hash、效果键补齐可信回执，投影既有 `delivery=sent / sentAt`；不再发送 |
| 支持回查，确认未投递且契约保证原尝试不会迟到生效 | 重新检查当前语义有效性、授权与认领身份后安全补发；支持幂等时沿用原效果键和原 payload |
| 支持回查，但暂时缺记录、查询超时或证据不完整 | 继续 unknown；不能把最终一致性暂不可见映射成“确认未投递” |
| 只支持持久幂等、不能回查 | 仅在键作用域、有效期限与同 payload 重放保证均成立时按原键恢复；不能伪造查询成功或换键盲重发 |
| 两者均不支持，且请求可能已发出 | 原 notification/attempt 保留 unknown，停止自动发送；展示证据和明确手动重发入口 |
| 有可信证据证明请求未发送/未产生效果 | 记录该证据，按有界政策重试；普通异常、超时或进程退出不自动构成该证明 |

实现要求：

- 认领、实际异步发送/回查、结算分开；网络等待在事务外。既有同步接口需适配真实异步渠道，返回后按 attemptId、认领代次、payload hash、渠道目标和 authority 核对，防止迟到回执结算到后来一次尝试。
- 先持久保存不可变尝试与可能发送的 unknown，再发请求。双连接/双 drain 不能同时发送同一逻辑投递；进程内 `Set` 不是跨进程 fence。
- provider 幂等键绑定准确目标和 payload；恢复同一效果不能因 ordinal、重启或交接而换键。不能用同一幂等键发送不同内容。原 unknown 未结清时，文案、接收目标或 owner 变化本身不授权新的外部发送；只有明确的新业务投递授权才可生成新效果身份，手动重发还须确认重复风险，否则只保留并核对原效果。
- unknown 回查应能结算原效果，即使语义随后变旧；尚未发出的过期完成通知不得再当作当前结论发出。已发送内容不承诺撤回。
- 手动重发必须明确提示“原投递仍可能已送达，重发可能重复”，记录用户、operationId、原因、原 unknown attempt 与当前版本校验。使用同一卡片、新的明确授权效果身份；原 unknown 与迟到回执仍按原 attempt 保存。不得重跑后台或把原 unknown 改成失败以绕过保护。
- 对禁止自动重发的 unknown，主视图显示“外部通知投递结果未确认（避免重复发送已停止自动重试）”；对允许回查/持久幂等恢复的 unknown，显示“等待回执核对/安全恢复”，与实际策略一致。应用内卡片可阅读不等于外部已送达，外部已送达不等于用户已读。
- `AgentService` 将投递 drain 接入原权威宿主启动/恢复/唤醒/退出，支持 closed Work 的未完成投递；遵循原有界重试/退避、单轮数量和公平性，不让一个 unknown 阻塞其他卡片，也不因每次 UI 查询触发发送。
- 使用既有 `NotificationService` 的偏好/去重及 Gateway 的连接/渠道体系。现有 Gateway 没有通用 Work send/query 端口，须补真实适配；某适配器使用 `client_msg_id` 不足以证明可回查契约。无接收人或无可用连接时留下准确状态，不能默认向所有渠道广播。

至少有应用内可靠卡片面和实际配置渠道的生产接线；真实连接器权限/能力不足时单列 blocked，不以本地 adapter 测试宣告外部渠道验收通过。

### 3.3 多专家汇总、降噪与阅读（P5-03）

- worker/expert 的 `result / blocked / question` 复用现有协作消息、子项结果、缺口与主负责人收件义务；不逐条进入用户独立通知流，不另建第二套协作事实。
- 当前负责人在 `(workId, intentRevision, inputSnapshotId)` 下汇总已确认成果、实质变化和待决项，写入时重新核对 ownerEpoch。旧负责人迟到汇总不能生成当前通知；有效 worker 成果按原 adoption 继承。核对既有 generic task-completed/桌面通知路径，Work 执行的内部完成提示不能绕过负责人汇总再次刷屏，普通 Task 原通知行为保持。
- 汇总依据持久成员结果与已处理水位，不能只用内存防抖。固定最长等待/明确完成条件，不能持续收到消息就永远延迟用户应知信息。
- 同一语义汇总只有一张卡片；专家返回顺序、相同结果回放和有界重试不产生新卡片。新增实质成果形成新的规范化 outcome，并与先前卡片关联；内部过程只进入诊断。
- `blocked / rejected / writeConflicts / isError` 完整保留；需用户处理的持续阻碍、授权或实测等待提升为负责人统一待决卡片，不能被静默过滤。
- 阅读请求只写卡片阅读事实与持久日志，断言 Work 各控制字段、执行数、验收和预算零副作用。重复/乱序阅读、用户越权、跨 Work 卡片、交接及 closed Work 均覆盖。
- 返回服务端持久 readAt/水位，桌面与手机通过 journal 传播；相同 Work stateVersion 的阅读变化不能被 store 丢弃，不为同步已读递增 stateVersion。

## 4. M2 — 桌面/移动重连与分层证据

覆盖 P5-04～P5-05、BW-A45～BW-A46、R09/R10。

### 4.1 Work 同步与全量重建（P5-04）

1. 保留 user-scoped 的 SQLite 一致读取边界。`snapshot` 必须对应同一事务内的 epoch/sequence；增量按 `from/sequence/hasMore` 连续应用，不得先发布新水位再丢未应用页面。
2. 同 epoch、同 scope 且游标处于保留窗口内，循环有界分页追平；重复页幂等，乱序/缺口/游标超前触发 resync，不能猜测跳过。
3. epoch 不符、scope 改变或保留窗口失效时，原子替换权威投影集合与水位。清除不存在的卡片/Work、旧负责人控制绑定和过期诊断缓存；旧本地更高 stateVersion 不能保留。普通文本草稿可保留，但原 Work/版本绑定必须重新验证，不能自动提交旧意图。
4. 每次订阅、scope 切换、账号/配对变化和重建都有客户端同步代次；旧分页/展开查询/已读响应不得覆盖新会话。沿用并扩展现有 refreshSequence，桌面和手机都测慢响应竞态。
5. same-epoch 内按 journal 序号接纳独立卡片/投递/阅读更新；Work stateVersion 不能单独决定整个投影的新旧。对独立事实建立同事务日志触发，避免状态没变而已读永远不同步。
6. 区分 `open` 的 closed 墓碑与 `all` 的历史保留：open 视图删除已关闭事项，all 视图仍可查已关闭成果/通知/预算证据。缺失或无权对象真正清除；不能把已关闭等同数据库删除。
7. `RemoteEventBus` 的 SSE 缓冲仅内存、最多 1,000 条/5 分钟，宿主重启事件编号重置；它只唤醒 Work 同步。不得以 Last-Event-ID 冒充 Work cursor 或以 Durable 对话 revision 冒充 sequence。
8. 生产接线覆盖 Remote Server/Service/Controller、[remoteSchemas.ts](../src/main/remote/remoteSchemas.ts)、[RemoteDeviceStore.ts](../src/main/remote/RemoteDeviceStore.ts)、共享契约、RemoteClient、remoteStore/remotePatch 和实际移动页面。给 Work 查询、反馈、阅读和允许控制明确能力边界；认证撤销后不得继续回传缓存诊断或控制事项。
9. 手机反馈调用已有 `recordUserFeedback`，绑定原卡片/实测版本的 `environment/sourceRef/inputSnapshotId/artifactSnapshotId`。离线旧卡片反馈不能默认验证最新产物；用现有规则拒绝或归档，返回可理解原因。
10. 最少覆盖断线期间多次 amend、accepted 结果、handoff、close 与归档清理，包含保留窗口内增量和 epoch 越界全量两条路径。真实 store/Remote 请求参与测试，不能只比较两个手工拼装 DTO。

### 4.2 主投影与展开诊断（P5-05）

在 WorkService/受权查询层组装，下层复用 WorkRepository、TaskDiagnosticsRepository 和现有专项服务。数据库仓储不能成为不鉴权的外部 API。

| 投影 | 内容与限制 |
| --- | --- |
| `WorkSummaryProjectionDto`（拟新增） | 标题、人类目标、当前负责人、当前有效成果/阶段结论、需要用户处理的阻碍/实测步骤、下一步、卡片引用及必要的通知 unknown。传输可带同步所需版本，但不默认加载/展示 binding、token 流水、内部重试和完整账本 |
| `WorkExpandedDiagnosticsDto`（拟新增） | 显式展开后按范围/游标有界读取，返回版本身份、证据关联、截断/缺失状态和下一页；不能只用 CSS 折叠已经一次性载入的全部明细 |
| `unverifiedScope`（拟派生） | 从当前验收条件、uncoveredScope、实际产物、对应环境反馈及证据状态计算；明确“自动已验证 / 当前版本待实机 / 历史版本已验证 / 无证据”，不由模型或 UI 单方面清空 |

展开至少包含：

1. **要求与来源链**：历次 intentRevision/inputSnapshotId、输入/代码产物来源、失效原因与被降级的历史成果。
2. **责任链**：ownerEpoch、handoff 原因/操作者、有效委派、`work_delegation_adoptions` 与 pending adoption。
3. **执行与产物链**：bindingId → task/store/native receipt/child，blocked/rejected/writeConflicts/isError、有效产物与指纹重验、缺口和定向 continuation。
4. **验收与未验证范围**：每项 criterion、证据/环境/sourceRef/artifactSnapshotId、实测步骤、历史反馈为什么不能验证当前产物。
5. **资源/主动性/预算链**：资源 fencing/释放与恢复证据；订阅/来源 accepted-frozen-consumed 水位及离线 gap；因果 hops；原窗口的 reserved/committed/unknown 与人工核销/迟到回执凭据。
6. **交付链**：语义卡片、通知意图、渠道能力、immutable attempt、payload hash、回查/人工重发与阅读事实。敏感凭据和其他 Bot 私有上下文不进入面向用户的诊断响应。

历史时间线读取持久事实表，有界投影 journal 只服务重建最新视图，不能保证完整历史。任何 `unavailable / unknown / truncated` 必须显式输出，不能将“没有拿到记录”渲染为“验证通过”。

### 4.3 双页面、专家审阅与完整交互

保持 [UI 规范](bot-work-ui.md) 的独立 Bot 模式、账户菜单位置、普通 Task/Bot 导航与草稿隔离，以及手机 Bot → 对话 → Work 详情的层级。结果卡片可按稳定键定位并把回复绑定回原 Work/版本；主视图不刷内部运行消息，诊断与账本放按需面板。关闭右栏、切换模式或普通状态查询都不创建后台工作。

R09 仍有产品接线义务：现有 Bot 专家 stage/adopt 已支持完整不可变配置，但缺完整审阅入口。复用 [BotExpertBindingService.ts](../src/main/agent/work/BotExpertBindingService.ts) 与 [BotRegistry.ts](../src/main/agent/work/BotRegistry.ts) 的真实职责（实施前再次核对路径/接口），通过已认证服务与受控 API 展示 pending 的提示词、技能包、MCP/connector 等差异，并显式采用原 `pendingVersion/snapshotId`。审阅 v2 期间 pending 变 v3 时拒绝旧确认；新前台轮次/新执行在约定边界采用，在途继续固定快照；保留跨 Bot 隔离和全局禁用规则。不得仅新增“采纳”按钮而绕过真实 ExpertService 装配。

## 5. M3 — 十步故事与前序缺口合龙

覆盖 P5-06～P5-08；此处的 fixture 情境不代表实际修改用户仓库、发布版本或实机测试已经完成。

### 5.1 有限 watch 关闭清理

复用现有 `closeWork → closeWithConclusion → stopSubscriptionsForWork`。当前仅设置订阅 stopped_at/updated_at；实施时核对并清除或失效该 Work 的有效待唤醒/未发来源意图，使后续 tick/drain/迟到 Hook 不再启动它的新检查。关闭、专属订阅停用、语义卡片与通知意图同事务；不要删除审计所需的来源、游标、已发生效果与预算账本。

主负责人汇总当前验收后，由已认证可信用户/授权入口依据已保存的 `watchRule.stopConditionText` 并携带明确 `closureSummary` 完成成功关闭；不在测试中冒用 bot actor、直接改 SQL 或撤掉现有 watch 守卫。没有当前版本实测、必需产物/副作用未确认、存在必要缺口时拒绝成功关闭。

Work B 作为同来源/同宿主的活跃 watch 对照：关闭 A 不改变 B 的生命周期、订阅、游标或预算窗口；后续 Hook 仍能驱动 B。A 的迟到执行/用量/通知回执仍按原身份完成结算，不等于重新开放调度。

### 5.2 真实运行栈与故障证据

`scripts/bot-work-phase5-e2e-story-test.ts`（拟新增）必须串联：

- BotRegistry、WorkService、WorkWatchIngress/Scheduler、WorkResourceGate、WorkCollaborationService、WorkBudgetService、WorkNotificationDelivery、WorkProjectionJournal；
- WorkHostAuthority、WorkDispatchQueue、WorkExecutionAdapter、DurableBotService/原生 Durable 运行端口、WorkNativeResultInbox；
- 实际桌面 reducer/同步动作、Remote 认证路由/客户端/移动 store，及可控模型与效果端点。

复用 [Phase 2 recovery](../scripts/bot-work-phase2-recovery-test.ts) 的原子 checkpoint、真实强杀/PID 退出与权威租约条件，以及 [Phase 3 native settlement](../scripts/bot-work-phase3-native-settlement-test.ts) 的真实 children、产物、缺口补跑和预算结算。重启沿用相同 SQLite 与 Durable 路径，不重建全新服务数据来伪装恢复；时间/事件可注入，不用硬编码 sleep 代替条件。

记录原 operation/binding/task/store/conversation/submission 身份、模型/效果请求次数、成功分支产物指纹、补跑身份与关键持久状态。第 4 步的原生提交回执丢失，与第 10 步的成果已验收但通知未发，是两个独立故障窗口；都必须覆盖。

### 5.3 十步连续断言

| 步骤 | 操作与故障注入 | 必须观察到的结果 |
| --- | --- | --- |
| 1 委托立项 | 创建“持续跟进此 Linux 修复，直到 Omarchy 实测通过”的有限 watch A，保存负责人、仓库/权限、停止条件和实测 criterion；创建同宿主对照 watch B | 两个独立 Work/订阅/预算身份，A 未提前通过实测；不存在假 Task/Bot 身份 |
| 2 Hook 与前台 | 经真实来源入口投递提交 A、重复和乱序 Hook；后台开始检查时前台查询状态/普通交流 | 一个对应逻辑检查，重复事件不新派发；前台及时读取持久事实且不新建后台查询任务；B 的合法路由也被保留 |
| 3 中途改要求 | 正式 amend“只检查 Linux，先别发布”，intentRevision 升至 2 | 受影响旧 binding/未发指令失效，当前快照冻结；已有在途效果如实结算；后续动作遵守新授权/约束 |
| 4 提交回执窗口强杀 | 原生 Durable 已接受修订版 submission、业务库尚未保存投递回执时强杀宿主，重开原存储；结果 Inbox 边界另测重放 | 找回原 task/store/conversation/submission，逻辑检查/实际效果不重复；不能创建第二个 root 补回执；恢复继续结算原执行 |
| 5 旧结果晚到 | 注入 intentRevision=1 的晚到真实结果事件 | 归档为历史证据，当前 revision=2 的成果/卡片/结论不被覆盖；旧结果不生成当前完成通知 |
| 6 部分成果与缺口 | 原生并行 children 至少一项有效成功，一项必要写入被冲突阻止；另保留 rejected 分支专项 | 完整保留 blocked/writeConflicts/isError 和成功产物；只为必要缺口创建新 continuation/计划，成功分支效果计数不变；run completed 不使 Work 成功关闭 |
| 7 等待实测 | 定向补跑与自动检查通过，尚无当前产物的 Omarchy 反馈 | 主视图显示“代码与自动检查通过，等待 Omarchy 实测”，步骤绑定 revision=2、inputSnapshotId、sourceRef 和产物快照；Work 仍 active |
| 8 手机失败与交接 | 经配对 Remote 反馈原测试卡片“第二步失败”；修复期间 handoffOwner，注入旧 owner 决定及仍有效 worker 成果 | 反馈接回原 Work/测试版本；旧 owner 控制被拒绝，有效 worker 成果经 adoption 由新 owner 继承；手机旧卡片不能验证修复后的新产物 |
| 9 当前版本通过并关闭 | 可信用户入口提交与最新产物相匹配的实测通过证据；负责人汇总后由可信关闭入口 closeWork | A closed、停止条件/验收已满足、专属订阅及有效唤醒停用；B active、游标/预算不被 A 清理且能继续接收 Hook；保留 A 历史账本 |
| 10 通知恢复与双端追溯 | 验收/关闭落盘后、通知发送前再次强杀重开；对可确认失败渠道注入首次失败并恢复，unknown 分支另测；两端分别增量/全量重连 | 用户看到唯一定址语义结果，恢复原通知、后台零重跑；不可回查 unknown 不盲重发；两端当前视图一致，展开可追要求、交接、补跑、预算与实际验证范围 |

同一故事应连续保留上下文和计数，不得拆成十个独立数据库各自造终态后称“全链路”。可以将隔离子进程、fixture 和断言拆辅助文件，但主剧本必须驱动真实生产边界。

## 6. Codex / agent 执行清单

以下按实现与实际验收证据逐项回填；缺少必要的真实 UI/设备/账户证据时保留未勾选，不能仅以文档入库或受控 fixture 代替验收。

> 执行进度（2026-11-08）：P5-00、P5-01、P5-03、P5-04、P5-06 已完成相应代码/组件或原生故事验收。P5-02 的五类 Gateway 生产适配已交付，真实账户证据仍缺；P5-05 的完整入口已接线，8 个真实 React 生命周期场景通过，实际 dev 启动因 socket EPERM 未进入页面；P5-07 最终完整门禁 **353 passed / 1 failed / 0 known failed / 1 new regression（158.45 秒，exit 1）**；P5-08 已更新 46 行矩阵和冻结证据，实机/真实渠道未取证。因此 P5-02、P5-05、P5-07、P5-08 仍未勾选，不宣称 BOT-WORK-1.0 整体验收完成。

- [x] **P5-00 基线、schema 与共享契约。**（2026-11-07 已实施：schema 33→34，`bot-work-phase5-schema.ts` / `shared/bot-work-phase5.ts`，身份与能力矩阵；2026-11-08 补全升 schema 35，新增不可变 Gateway 目标、summary/owner_summary 与前序卡片关联；证据见最新复核。） 记录执行时最新 main 和相对审核 SHA 的差异，读取 AGENTS；明确 schema、语义/投递/attempt/阅读身份、summary/diagnostics 与 Remote 权限契约；新增 Phase 5 schema/共享类型并接入真实数据库。验收：唯一约束、归属、备份重建与类型边界。
- [x] **P5-01 原子成果接纳与唯一语义卡片（BW-A42）。**（2026-11-07 已实施：原 accept/close/reportBlocker 事务内写卡片，`test:bot-work-phase5-delivery-dedup` 20 项；accepted→closed 复用同一 substantive 卡片。） 在原 accept/close 事务补齐派生卡片、原通知意图与 journal；保护重放/旧版本/交接，验收前后强杀不新派发。验收：事务回滚、双连接竞争和零重复效果。
- [ ] **P5-02 真实渠道投递与 unknown（BW-A43）。**（代码完成：Gateway 13、delivery 34 通过；真实账户/收件人、真实 UI 仍未取证。） 能力矩阵、稳定 provider 效果键、immutable payload/attempt fence、回查与手动重发；接入生产宿主 drain、现有桌面通知/Gateway、实际 UI。验收：两类渠道响应丢失、异步竞态、迟到回执与重启；真实外部能力单列证据。
- [x] **P5-03 负责人汇总与阅读隔离（BW-A44）。**（2026-11-08：独立 owner_summary/summary、固定最长等待与交接/待决语义，17 个专项场景通过；短事务阅读与 Journal 保留。） 多专家收敛、持久汇总水位/有界等待、内部噪音静默、必要待决可见；受权 markWorkCardRead 与服务端阅读同步。验收：交接时旧汇总拒绝、乱序阅读及零控制副作用。
- [x] **P5-04 桌面/移动持久同步（BW-A45、R10）。**（2026-11-07 已实施：journal 同事务、桌面快照原子替换、Remote 路由/契约/客户端/store/WorkPanel、SSE 仅唤醒；`test:bot-work-phase5-reconnect-diagnostics` 13 项 + `test:remote-work-sync` 8 项。） Work journal 与实际桌面 store、Remote 路由/能力/API/store/UI 全链接通；增量分页、epoch/scope 全量替换、墓碑和旧异步响应隔离。验收：多次要求/成果/交接/关闭后的双端重连，零旧缓存回写。
- [ ] **P5-05 分层诊断与完整 UI（BW-A46、R09、UI-01～UI-10）。**（代码完成；可信评审控制 11、React 生命周期 8 场景通过；dev 页面被宿主 socket EPERM 阻断。） 主摘要/按需证据分离，版本/产物/未验证范围/账本可追，语义卡片可定位；补 Bot pending 配置完整审阅/显式采用和双页面回归。验收：真实入口与版本竞态，不仅静态渲染。
- [x] **P5-06 十步故事（冻结验收 §9）。**（2026-11-08：新增同库生产原生故事，三个子进程、两次真实 SIGKILL、实际 child/write/Remote/双端状态；fixture 模型/通知传输范围及逐步账本见最新复核 §3；不代替 Windows/Omarchy 实机。） 单套持久库、原生执行、真实来源/Remote/同步路径；两类强杀、旧版归档、冲突补跑、实测等待/反馈、交接、有限 watch 关闭与 B 隔离、通知恢复。验收：逐步身份/状态/实际效果计数。
- [ ] **P5-07 专项与联合门禁。** 注册三项 Phase 5 测试及所需 dev/Remote 验证，执行分类自检、typecheck、受影响前序回归与完整 test:all。恢复/性能用例的串行约束保留，不修改失败白名单制造通过。
- [ ] **P5-08 全景证据、实机台账与冻结报告。** 更新实施记录、建立 BW-A01～BW-A46 逐项证据索引、R09/R10 与 UI-01～UI-10 联验、平台缺口台账；产出按实际日期命名的 Phase 5 review，冻结受测实现 SHA 与源文件指纹。未解决的失败/blocked 仍计为未完成。

## 7. 验收矩阵与测试接入

### 7.1 新增专项（均为拟新增，不是现有通过项）

| 验收 | 关键注入 | 必须断言 | 规划脚本 |
| --- | --- | --- | --- |
| BW-A42 | 成果/关闭单事务失败，提交后发送前强杀，重复结果，双连接同语义竞争 | 一卡片/一合法通知意图，原执行/实际效果计数不增长；原版本守卫不放松 | `scripts/bot-work-phase5-delivery-dedup-test.ts` |
| BW-A43 | 两类真实能力契约 fixture 已发但丢回执，查询暂不可见，重启/交接，手动重发及迟到响应 | 原效果/attempt 对账；unknown 诚实保留且无自动盲重发；手动重发有授权与旧尝试证据 | 同上 |
| BW-A44 | 多专家并发、重复/内部恢复、旧 owner 汇总、重复与乱序阅读 | 统一实质卡片、持续阻碍可见；读取只改阅读事实，Work 控制/执行/预算零副作用 | 同上 |
| BW-A45 | 两端离线多次 amend/accept/handoff/close；跨 200 条分页、10,000 条保留缺口、epoch/scope 变化及旧异步响应 | 持久增量或全量重建；本地高版本不能压住新 epoch；同 stateVersion 阅读/投递同步；墓碑正确 | `scripts/bot-work-phase5-reconnect-diagnostics-test.ts` |
| BW-A46 | 对比摘要/按需诊断、旧产物反馈、权限边界、分页截断与缺记录 | 目标/结论/下一步简洁；精确版本、原生回执和 unverifiedScope 关联；无越权/伪造通过 | 同上 |
| 第 9 节十步 | 同库、原生运行、两次真实强杀、缺口补跑、Remote 反馈、交接、关闭和投递恢复 | 十步连续状态、原身份/效果计数、B 隔离和双端全历史可解释 | `scripts/bot-work-phase5-e2e-story-test.ts` |

三个脚本分别注册为 `test:bot-work-phase5-delivery-dedup`、`test:bot-work-phase5-reconnect-diagnostics`、`test:bot-work-phase5-e2e-story`。同时更新 [package.json](../package.json) 与 [test-all.mjs](../scripts/test-all.mjs)：以 `-e2e` 结尾的名称会落入现有 GUI 兜底规则；本计划的 `test:bot-work-phase5-e2e-story` 不匹配该后缀，仍须显式登记 HEADLESS_TESTS 以固定只依赖临时存储/原生端口的真实分类。真实 Electron/桌面/远程设备验证单独归类，不可假归 headless 或为默认绿而排除业务恢复测试。

重型强杀故事若有实际资源争用证据，可与现有恢复套件同走串行池，保留 timeout/失败策略；性能用例仍放串行池最后。测试以行为、数据库终态、调用/效果计数为主，不能用源码字符串包含函数名代替接线证据。

### 7.2 联合回归与执行顺序

实施后执行，本文提交不运行功能门禁：

1. `node scripts/test-all.mjs --audit`、`--list` 核对分类与实际数量；`pnpm -s typecheck` 覆盖 main/web/scripts，Remote 应使用其真实类型/测试入口一并校验。IPC inventory 对原冻结基线比对，不能从改后源码重建基线掩盖新增通道。
2. 三个新增 Phase 5 专项、schema/Work/通知/阅读/投影/Remote 受影响测试。
3. 前序重点：`test:bot-work-phase2-recovery`；Phase 3 的 `native-settlement / partial-settlement / collaboration / handoff / recovery-control / resource-settlement / resource-gate / focus-gate / pause-backlog`；Phase 4 的 `hook-fanout / offline-catchup / schedule-clock / causal-guard / shared-budget / backpressure`，完整脚本前缀分别为 `test:bot-work-phase3-` 与 `test:bot-work-phase4-`。
4. 投影/UI 与控制回归：`test:bot-work-projection-retention`、`test:bot-work-foreground-contract`、`test:bot-work-read-lifecycle`、`test:bot-work-resume-dispatch`、`test:bot-workspace`、`test:bot-conversation-ui`、`test:db-schema-discard`、`test:ipc-channel-inventory`。
5. `pnpm -s test:all` 使用原分类、断言、timeout 与失败白名单；记录完整退出码、passed/failed/known failed/regression 和实际环境。发生具体失败再按影响复跑，不预设必须重复全量来取最好的一次。
6. 按 AGENTS 在隔离用户配置中运行 `pnpm dev`，补真实表单 → preload → IPC → SQLite → 页面回读；手机验证实际配对/Remote 路由与重连。开发模式不代替发行包证据。
7. 测试完成后冻结实现提交和源码清单/指纹；源码再变按影响重验。报告单独提交并引用实际受测 SHA，不能以报告提交 SHA 冒充实现冻结点。

### 7.3 BW-A01～BW-A46 终局索引要求

P5-08 必须逐项列出 **46 行**；下表是查证分组，不是已通过矩阵。每一 ID 最终填写测试/人工步骤、平台/版本、实现 SHA、场景输入身份、证据路径及 `passed / failed / blocked / not-run`，单条也可分 headless/native/实机子项。只通过 Phase 5 三项专项不能自动勾选前 41 项。

| ID 范围 | 必须回连的事实与既有阶段 |
| --- | --- |
| BW-A01～BW-A08 | 长期身份、跨入口 Work、普通交流/卡片引用、once/watch、操作幂等、Bot 停用、专家版本、协作资料隔离；包括 R09 完整配置采用 |
| BW-A09～BW-A13 | 前后台分离、原生 children、只读不派发、有界原生补试、单权威宿主 |
| BW-A14～BW-A20 | Outbox/submit/Inbox 崩溃边界、业务效果幂等/unknown、完整原生命名空间；结合十步第 4 步与 recovery 套件 |
| BW-A21～BW-A28 | 旧决定、遥测隔离、旧结果、取消、歧义、暂停积压、交接接管和发送前重验；结合旧卡片反馈及 ownerEpoch 竞态 |
| BW-A29～BW-A35 | 局部写冲突/真实资源 gate、桌面焦点/释放、仓库约束、部分成果/定向补跑、版本匹配实测和外部产物变化 |
| BW-A36～BW-A41 | 真实 Hook 扇出/水位、离线补处理、时区/时钟/期限、因果防环、共享预算 unknown/迟到账、合并与背压 |
| BW-A42～BW-A46 | 本阶段三项专项、生产通知/移动接线、真实 UI、卡片/重连/证据分层 |
| 额外闭环 | 冻结验收 §9 十步、R09/R10、UI-01～UI-10；不得因不在新增五个 ID 内而遗漏 |

### 7.4 实机待补证台账

| 项目 | 所需证据 | 缺失时的结论 |
| --- | --- | --- |
| Windows 恢复 | 原生持久存储的真实强杀/重开，PID/authority 与原执行身份，复验此前瞬时失败 | Windows 恢复未完成，不以 Linux 连跑替代 |
| Windows BW-A31 | 隔离真实窗口的聚焦/新鲜观测、受管输入、失联后原宿主释放证明 | 资源输入实机未完成 |
| Linux D-Bus / AT-SPI | 有权限的真实宿主运行 transport 与对应隔离会话，保留命令/退出码 | 完整默认门禁仍有失败/blocked；不修改 baseline |
| 真实 dev 点击 | Phase 4 unknown 核销/期限预算按钮及 Phase 5 卡片、已读、重发、诊断/配置采用，实际 preload/IPC 回读 | React 渲染通过不足以证明交互通过 |
| Omarchy / Hyprland | 隔离靶应用、当前源码/产物、真实输入链与版本化实测反馈 | 业务 fixture 不能算实机通过 |
| 桌面/手机 Remote | 真实配对、网络断连/宿主重启、能力撤销、要求/成果/交接/关闭后重连 | store/HTTP fixture 仅证明对应协议层 |
| 真实外部连接器 | 实际已授权目标、幂等/回查真实契约、响应丢失与对账证据 | 不能宣称外部恰好一次或送达 |
| 真实用量/预算 | provider 原始用量/原窗口、迟到/矛盾回执与人工核销凭据 | 本地计费 fixture 与真实供应商证据分开 |
| 发行包 | 仅在另行发布授权下验证实际包与桌面能力 | 不自动 build/pack/dist；未取得证据仍单列 not-run/blocked |

## 8. 报告与交付规则

实施后产出 `docs/reviews/bot-work-phase5-YYYY-MM-DD.md`（日期按 Asia/Shanghai 实际执行日），需要 latest 指针时引用同一受测实现。至少包含：

- 设计版本、审核基线、最终受测实现 SHA、实际变更范围、源码 manifest/SHA-256、对应文档提交。
- P5-00～P5-08 完成情况、BW-A01～BW-A46 逐项证据、R09/R10/UI 全景索引、十步顺序与关键数据库终态。
- 应用内卡片、原生工作、外部投递和阅读分别给出身份/计数/状态；unknown、历史/过期成果、未验证范围不得隐藏。
- 原始命令、退出码、环境、注入点、模型/效果次数和日志路径；区分源码审查、headless、native fixture、真实 GUI/设备/连接器与发行包。
- 尚未完成项的原因、需要的环境/权限、可执行复验步骤；有失败或必要 blocked 时明确“实现已完成/部分门禁通过，整体验收未完成”。
- 同步 [实施记录](bot-work-implementation.md) 和本清单，不改冻结验收条件来适配实现，不把历史运行结果冒充新冻结 SHA 的验证。

## 9. 交给后续执行 agent 的任务边界

**规划提交时的授权边界（历史）：** 当时用户要求“规划 Phase 5 并推送 GitHub”，只提交本文和实施索引。随后已获实施与修复推送授权，原始实现及本轮加固见本文开头固定 SHA 与报告；本节保留规划阶段对后续 agent 的要求，不能再据此把当前代码记作未实施。

后续获得实施授权后，从最新 main 核对本审核基线差异，按 P5-00～P5-08 连续完成。先统一共享契约、数据归属和故障边界，再并行实施并集成生产宿主、桌面、Remote、原生执行和证据。不得只添加可被测试调用的孤立服务，或只完成 M1 就宣称收官。

遵守仓库 main 单主线；保护已有改动，不擅自创建分支/worktree。不升级应用版本、不 build/pack/dist、不安装或改快捷方式；提交/推送实现按该实施任务的授权范围执行。遇到真实环境阻碍，完成可运行部分并保存准确证据与剩余步骤，不扩大失败白名单，也不提前宣称 BOT-WORK-1.0 已交付。

