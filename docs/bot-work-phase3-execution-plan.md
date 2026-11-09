# Bot / Work — Phase 3 执行规划（供 Codex 实施）

> 2026-11-09 产品变更：Work 额度/预算模块已删除。本文旧有的共享预算、额度预留、用量结算阻塞、续期与预算控制要求均已被 [无预算运行约定](bot-work-no-quota.md) 取代，不应按旧条款重新实现。原生用量遥测、授权/审批、未知外部效果防重与上下文容量限制仍保留；已有数据库中的预算历史仅保留为惰性记录，不自动删除或清库。

> **已退役（Issue #21）**：本文描述的 `WorkResourceGate` 共享资源隔离、跨 Work 资源屏障与动作审批已整体移除，现状见 [work-action-approval-loop.md](work-action-approval-loop.md)。本文仅作历史实施记录，不再是现行契约。

> 状态：**已实施 / P3-00～P3-08 已接线，组件与 headless 门禁通过；BW-A31 真实桌面输入受阻，Phase 3 整体未验收**
>
> 实施与证据：[Phase 3 实施与验证记录](reviews/bot-work-phase3-2026-11-07.md)。该记录列出各 BW 场景的实际行为、故障窗口、门禁结果与未运行范围。
>
> 确认日期：2026-11-07（Asia/Shanghai）
>
> 审核代码基线：[`main@a6bb4a59e2f5fa107f4ad142ecd99a32436603f6`](https://github.com/qq824045252-ship-it/wavealstra_harness/commit/a6bb4a59e2f5fa107f4ad142ecd99a32436603f6)；规划确认时已核对远端 `main`。
>
> 范围：Phase 3 —— **跨执行资源门控、外部修改重验、部分成果与定向补跑、暂停在途结算、多 Bot 协作与负责人交接、通知发送前复核**。

本文件沿用 [Phase 2 执行规划](bot-work-phase2-execution-plan.md) 的工程格式，是可执行任务书。产品行为以 [冻结设计](bot-work-design.md) 第 **8、9、10、11、12 节**、[冻结验收](bot-work-acceptance.md) **BW-A26～BW-A35**、[UI 规范](bot-work-ui.md) 和 [Phase 1 复审的五阶段顺序](bot-work-phase1-review.md) 为准，并遵守 [AGENTS.md](../AGENTS.md)。[Phase 2 后续复核](reviews/bot-work-phase2-followup-2026-11-07.md) 是当前代码事实与验证范围的依据。

**本次只确认并提交规划，不表示 M1 已开始实施或 Phase 3 已通过。** M1～M3 是同一阶段内的依赖顺序；阶段完成须联合满足第 7 节。Phase 4 仍负责真实订阅源、完整离线补处理与用量，Phase 5 仍负责完整渠道、移动端与全部端到端故事。本阶段只完成 BW-A26、BW-A28 所必需的事件积压和通知正确性接线，不以此宣称后续阶段完成。

## 0. 不可突破的约束

1. **唯一权威和真实执行内核不变。** `WorkService` / SQLite 保存业务事实，既有 Pi Durable 保存真实执行、submission、owned children 与 checkpoint；复用单主 `WorkHostAuthority`、持久 Inbox / Outbox，不建立第二套调度器或恢复日志。只支持当前锁定的 Pi 版本，不引入旧 Pi、旧数据兼容层。
2. **局部守卫不是跨执行锁。** 保留单次 parallel dispatch 的 `write/edit` 守卫；跨 Work、root、dispatch 的共享资源由宿主 `WorkResourceGate` 管理。根派发准入、真实工具动作及写前版本复核必须连通；只修改 `resourceAvailable()` 不算完成。
3. **保护完整的有限读改写/观察后操作。** 可以持有有限临界区租约，也可以保存读取时的版本，取得排他权后校验同一版本。只把两次 write/click 排队不能阻止旧内容覆盖或过期窗口点击。模型长推理、等待用户和资源等待不得占用长 SQLite 写事务。
4. **租约过期不证明旧执行停止。** 持久租约必须绑定执行身份和资源 fencing 代次；过期、失联、宿主接管时先隔离资源并查回旧执行与在途动作。停止请求已发送、root 已终态，都不能单独证明子进程、已按下输入或后端队列已清理。
5. **资源锁的保证止于受管操作。** 外部用户/程序可以改文件或窗口。版本、内容哈希、平台观测与供应商回执用于发现变化；不把应用内锁或一次 hash 比较表述为对任意外部写入的原子 CAS。
6. **成果、验收与执行终态分开。** `completed`、成功项计数或批次 `isError` 不决定 Work 完成。保留已确认的有效部分成果；必要的 blocked/rejected/未启动项形成缺口，只补必要部分。外部效果 unknown 先核对，不盲重跑。
7. **恢复与补跑分开。** 普通 `pause → resume` 沿用 `a6bb4a5` 的同输入去重；不能借增加随机 operationId、伪造新输入或使旧 binding 失效来重复整项工作。定向补跑必须是有明确缺口、授权、预算和持久去重身份的新计划。
8. **交接不改变要求或抹去成果。** 同一事务切换 `ownerBotId`、增加 `ownerEpoch` 和 `stateVersion`，保存审计；不自动增加 `intentRevision`、更换输入快照、重置预算或重跑成果。旧负责人控制权与原 worker 的有效委派分别判断。
9. **不扩大权限或上下文。** 分支/worktree、工具、目标和转委派服从宿主授权及仓库约束；协作消息不能成为绕过准入、原生 child 递归限制、预算或 Memory 隔离的通道。
10. **开发与证据如实记录。** 不通过修改冻结语义、增加失败白名单、伪造实测或包装 unknown 为 passed 来交付。不自动升级版本、build/pack、安装或改快捷方式；按仓库工作流在获授权范围内提交/推送。

## 1. 已有基础与准确代码定位

以下能力均指 `a6bb4a5`，表中“Phase 3 工作”尚未实施。

| 现有入口 | 已有能力 | Phase 3 工作 |
| --- | --- | --- |
| [WorkExecutionAdapter.ts](../src/main/agent/work/WorkExecutionAdapter.ts) | `resourceAvailable()` 对可变 root 做保守宿主串行、允许已隔离的只读并行；原生 find/inspect/stop、持久结果消费 | 根调度使用资源计划；实际工具临界区使用同一 gate；等待与失联接管可恢复 |
| [DurableToolPolicy.ts](../src/main/agent/durable/DurableToolPolicy.ts)、[AgentService.ts](../src/main/agent/AgentService.ts) | Work 工具准入及 before/after 接线，覆盖主机工具、MCP、Code Mode 和 children | 传递经宿主解析的资源范围、读取版本、执行/工具调用身份；动作结束、失败、停止及恢复正确结算租约 |
| [DurableSubagents.ts](../src/main/agent/durable/DurableSubagents.ts)、[write-conflict.ts](../src/main/capabilities/subagent/write-conflict.ts) | 计划期 `auto/shared/worktree` 解析、单 dispatch 路径 claim、结构化 blocked/rejected/writeConflicts | 接授权与真实 workspace 创建边界；串行共享写须真正降低有效并发并如实返回隔离结果 |
| [WorkDispatchQueue.ts](../src/main/agent/work/WorkDispatchQueue.ts) | 同 `intentRevision + inputSnapshotId` 的 completed/failed/stopped 事实保留原身份；准备失败保留原请求 | 增加受守卫的缺口计划身份，不放宽普通 resume 与崩溃恢复去重 |
| [DurableWorkExecutionProjection.ts](../src/main/agent/durable/DurableWorkExecutionProjection.ts)、[WorkNativeResultInbox.ts](../src/main/agent/work/WorkNativeResultInbox.ts)、[WorkExecutionSettlement.ts](../src/main/agent/work/WorkExecutionSettlement.ts) | 原生冲突事实投影、统一 Inbox 结算、终态保护与精确 reservation 核销 | 扩展观察类型及 Inbox 严格 Schema，完整传递逐项状态/产物/依赖；缺口、预算及后续意图在同一业务消费事务内提交 |
| [WorkSourceObserver.ts](../src/main/agent/work/WorkSourceObserver.ts) | `refresh()` 权威读回 + CAS；`file()` 已有真实 SHA-256 读取 | 扩展多输入与产物依赖指纹、写前/验收前复核及可信系统调用入口，避免覆盖其他来源 |
| [WorkService.ts](../src/main/agent/work/WorkService.ts)、[WorkRepository.ts](../src/main/agent/work/WorkRepository.ts) | `handoffOwner()` 已事务更新 owner/epoch 并写 Outbox；已有参与者、验收、实测快照绑定、Inbox 策略与通知状态 | 补协作协议、交接准备与有效执行接管、暂停积压处理，以及发送前最新事实核验 |
| [MemoryContextProjection.ts](../src/main/agent/MemoryContextProjection.ts)、[BotWorkContextService.ts](../src/main/agent/work/BotWorkContextService.ts)、[MemoryService.ts](../src/main/memory/MemoryService.ts) | 既有 Bot / Work / 项目上下文及 Memory 查询/读写权限 | 按协作参与者与授权范围校验访问及投影，覆盖根与 owned child；明确阻止跨 Bot 私有记忆泄露 |
| [ComputerAutomationService.ts](../src/main/capabilities/ComputerAutomationService.ts)、[platform/computer-use](../src/main/platform/computer-use/index.ts)、[BrowserAutomationService.ts](../src/main/capabilities/BrowserAutomationService.ts) | 桌面兼容入口与实际平台 backend；Linux 已有任务归属观测、窗口/布局检查和输入清理 | 在实际执行入口组合资源租约与原生观测有效性；补可等待的停止/输入释放确认 |
| [BotWorkspacePage.tsx](../src/renderer/src/components/pages/BotWorkspacePage.tsx)、[共享协议](../src/shared/bot-work.ts)、[Phase 2 schema](../src/main/db/bot-work-phase2-schema.ts) | 权威投影、持久列表水位、通知卡片及有界事件保留 | 投影资源等待、部分成果、暂停结算和交接历史；保持稳定语义身份与补读协议 |

### 1.1 对提交前草案的事实校正

- 现有字段是 **`inputSnapshotId`**，不是 `inputsSnapshotId`；现有方法是 **`handoffOwner()`**，不是 `handoffWorkOwner()`。不要为规划中的误名新增同义实现。
- 现有文件是 **`MemoryContextProjection.ts`**。通知投递入口是 **`WorkService.deliverPendingNotifications()`**；不要凭空假定另有 `MemoryContextProjector.ts` 或 `WorkNotificationService.ts`。
- 已注册的新增回归文件为 `scripts/bot-work-resume-dispatch-test.ts`、`scripts/bot-work-foreground-contract-test.ts`、`scripts/bot-work-read-lifecycle-test.ts`、`scripts/bot-work-projection-retention-test.ts`。草案中的 `*-dedup.ts`、`*-contract-sync.ts`、无 `-test` 的 retention 路径不是当前文件。
- **不存在 `scripts/core-performance-baseline-gap-test.ts`。** 现有 `scripts/core-performance-baseline.ts` 的复核涉及性能和假 PTY PID 修复；它不是跨 Work 锁粒度测试。粗粒度资源缺口的依据是 `WorkExecutionAdapter.resourceAvailable()`、冻结设计第 9 节及 Phase 2 复核中的事实校正。
- `realpath` 不会将所有硬链接统一成一个路径，也不能代替文件系统大小写规则。资源身份按第 4.1 节处理；不能写成“调用 `realpathSync.native` 即覆盖软硬链接和大小写”。参见 [Node.js 文件系统说明](https://nodejs.org/api/fs.html#fsrealpathpath-options-callback)。

## 2. 身份、数据和事务契约

### 2.1 必须分开的身份

| 身份 | 职责 |
| --- | --- |
| `workId / intentRevision / inputSnapshotId` | 事项、有效要求与不可变输入；来源变化不自动等于要求变化 |
| `stateVersion / ownerEpoch` | 控制 CAS 与负责人代次；资源租约的 fencing 不能复用 ownerEpoch |
| `bindingId / operationId / reservationId` | 原执行绑定、逻辑业务操作与对应预算预留；重放使用原身份 |
| 完整原生执行引用 | `taskId + durableStoreKey + conversationId + workspaceBinding`，加 submission/child/工具调用身份；不能只用数字 conversationId |
| 资源身份与租约代次（新增） | 真实资源、持有执行、宿主 authority/epoch、单调 fencing token、有效期及在途动作 |
| 子项、缺口与补跑计划身份（新增） | 派发前确定的逻辑子项、必要覆盖范围、原产物/效果和后续计划；不是另一个 Work |
| 协作消息与通知语义身份 | 消息去重/回复关系与稳定结果卡片；传输 attempt 不取代业务身份 |

新增字段名可等价调整，但职责、唯一性和完整命名空间不得合并。模型不能提供可信 actor、fencing token 或擅自提高当前授权。

### 2.2 Schema 落点

新增 `src/main/db/bot-work-phase3-schema.ts` 并接入 [AppDatabase.ts](../src/main/db/AppDatabase.ts)。在当前 schema 规则内明确表结构、索引、外键与 CHECK；涉及现有约束变更时同步当前 schema 版本及测试，保留不兼容库备份重建契约，不写旧数据迁移兼容层。

| 存储 | 规划职责与约束 |
| --- | --- |
| `work_resource_leases`（新增） | 规范资源/访问模式、完整执行引用、宿主身份、fencing token、租约状态/时限、在途准入；多资源整组成功或整组失败，重启不直接清空失联租约 |
| `work_resource_fingerprints`（新增） | 读取时的路径/文件实体/内容或供应商 revision、对应执行/快照、产物与验收依赖；版本证据不等于新输入事件 |
| `work_subitem_results`（新增） | 稳定计划项 ID、原生 child/拒绝项引用、实际结果/冲突/产物、必要覆盖范围及依赖；保留 failed/stopped/unknown 等原始事实，不强行压缩成 succeeded/blocked/rejected 三态 |
| `work_collaboration_messages`（新增） | 八类消息、可信发送者/接收范围、Work 版本、回复/因果关系与成果引用，持久去重；执行引用按消息类型可空、单个或多个 |
| 既有 `work_dispatch_requests` / bindings / control receipts | 扩展缺口计划引用和唯一约束；同版本完整执行与明确 continuation 分开，重复恢复只能找回同一个计划/绑定 |
| 既有 `work_events_inbox` | 暂停积压的唯一事件事实源；增加 `queued_while_paused` 原因/元数据或等价状态，保留来源去重键、策略与处理水位 |
| 既有 deliverables / criteria / notifications / Outbox | 保存有效产物和证据、影响到的验收项、通知有效性及投递事实；不以子项结果表另建一套“已完成”真源 |

**不预设必须再建 `work_paused_backlog`。** 优先扩展现有 Inbox；若实现确需独立排队索引，只能外键引用原事件、同事务维护且可重建，不能双份保存事件内容或各自标记消费。通知的 `superseded/cancelled` 属于语义有效性；是否用独立字段表达须同步 DTO/schema，不能混同 `sent/unknown` 传输状态或用户已读。

当前 `WorkNotificationDto` 尚无 `inputSnapshotId/ownerEpoch`；P3-07 必须补充持久版本绑定，或明确通过不可变成果关系解析，不能假定字段已存在。现有部分 pending 作废以 `delivery=failed` 表达，实施时要使语义作废与真实渠道失败可区分，并同步索引、投影和 UI。

## 3. 开发前基线与验证准备

- 先确认当前 `main` 与 `a6bb4a5` 的差异，保留后来变更；读取 `AGENTS.md`、本计划及冻结验收。按 lockfile 使用真实 Pi 依赖。
- 在功能改动前记录 `pnpm -s typecheck`、`pnpm -s test:all --filter=bot-work`、`pnpm -s test:subagent-write-conflict`；通过 `node scripts/test-all.mjs --list` / `--audit` 核实分类，按能力运行涉及的 Durable、平台和浏览器基线。
- Phase 2 后续报告的 Linux 结果**不是全量 test:all 全绿**：报告记录 16/16 Bot/Work、typecheck 和单独性能补跑通过，全量仍有五项同基线可复现失败，涉及 D-Bus socket 权限、缺少运行产物和缺失 IPC inventory 基线。该历史结果不替代本阶段重新核实；不新增失败白名单、不生成当前输出伪造缺失基线。
- `AGENTS.md` 默认不授权发布构建。若测试依赖缺失产物或真实桌面，记录具体 blocker、所缺前提和受影响场景；不得为“全绿”擅自 build/pack。文档提交只检查文档一致性，不宣称已执行功能门禁。

## 4. M1 — 资源门控与外部修改检测

覆盖 **BW-A29～BW-A32、BW-A35**；新增 `src/main/agent/work/WorkResourceGate.ts`，复用宿主、权限与平台能力。

### 4.1 资源描述符与路径身份

- 描述符包含资源类型、宿主/设备/会话作用域、访问模式、规范化资源键和预期版本。类型至少覆盖文件、目录子树、Git worktree、仓库共享元数据、浏览器会话及桌面输入设备。
- 已存在路径使用 realpath 解析符号链接；同时保存可靠的文件实体身份（例如平台验证过的 `dev + ino` 或等价 file ID）识别硬链接。路径身份与实体身份同时检查，处理 rename/替换造成实体变化；不能全平台盲目转小写。平台差异放在 `src/main/platform/`，优先复用 [paths.ts](../src/main/platform/paths.ts) 和现有文件安全接口。
- 尚不存在的写目标通过最近存在父目录的真实路径加受校验相对后缀定位，创建前再查父目录/别名；目录锁按路径组件的包含关系判断，不用裸字符串前缀。无法证明别名或文件系统身份时降到可信的较粗范围或明确阻碍。
- Git 工作树文件与共享 common git dir、refs/index 等元数据分开声明；不同 worktree 不等于所有 Git 操作互不冲突。目录 rename、删除和批量写必须覆盖关联子树。
- Shell/MCP 的写范围来自宿主可信工具适配与受限参数解析，模型声明只能作为待核实输入。无法精确确定时使用工作区/宿主更粗排他范围；无法约束的操作拒绝或调整计划，不能声称任意 shell 已获文件级安全证明。

### 4.2 有界临界区、多资源准入与恢复

- 规范化、去重并按资源键确定顺序，在一次短 SQLite `.immediate()` 事务内检查冲突、当前 Work 授权/版本/宿主 authority，并原子获取整个资源集合；冲突即整组不授予。禁止持有一半资源再等待另一半，禁止共享锁升级形成循环等待。
- 动态扩展范围或升级不满足时整组释放/重新准入并重验；父 root 等待 child 时不得占着 child 必需资源，必须释放或使用经宿主验证的明确租约归属转交，不能形成父子互等。
- 读可共享，写/输入操作排他；只读执行也要受版本一致性规则约束，不能“只读 root”标签永久豁免。等待队列有稳定身份、取消/超时与可观察阻碍；不自旋、不跨等待持有数据库事务。无关资源的可变 Work 可以实际并发。
- I/O、hash、模型推理和外部进程调用在数据库事务外完成。准入获得的资源租约可以覆盖有限操作；较长推理先释放，随后基于**原读取版本**重新准入/重验。仅在写入前读取一个新的 hash 再立即写不算保护原读改写前提。
- 每次受管动作提交前检查绑定、当前授权、资源 token/代次与预期版本。续租、释放、结算必须带原 token；迟到旧持有者不能续新租约或释放新持有者资源。心跳不无意义推进 Work 控制版本。
- 失联租约进入待核对/隔离状态；恢复先查原执行和已准入动作，必要时停止并确认不会继续写入。未知效果保留 unknown 和有界核验阻碍；普通根终态不能替代被启动的子进程/外部动作核对。

### 4.3 接入真实工具与所有受管共享入口

- `WorkExecutionAdapter.resourceAvailable()` 使用可核实的资源计划进行调度；移除粗粒度限制前，确保实际工具边界已覆盖。不能用 root 开始时的一次布尔检查代替动作级保护。
- 扩展 `DurableToolPolicy.createDurableToolPolicy()` 的 before/after 与宿主准入回调，传入已验证参数、规范资源、读取版本、binding/child/tool-call/admission 身份，覆盖 `write/edit`、Shell、MCP、Code Mode 嵌套调用和 owned children。资源释放/回执在成功、异常、取消、重放和崩溃后均有定义。
- 普通 Task 或其他受管入口若能操作相同资源，也必须进入同一宿主 gate（使用其可信执行身份），或保守阻断冲突；不能只锁 Work 而允许普通任务绕过。应用外进程仍属于第 4.6 节的观测边界。
- 持久动作准入与暂停/取消/要求修改使用同一控制顺序；已获准动作结算不因暂停或旧 ownerEpoch 被跳过。工具、资源、预算守卫保持同一授权上界。

### 4.4 仓库约束、实际隔离与局部守卫

- 沿用 `authorization.allowGitBranchOrWorktree`，与更严格的仓库约束共同求有效权限。在计划阶段、`DurableSubagents.runChild → prepareSubagentWorkspace()` 实际创建/恢复阶段和适用的 Git 工具入口复核，不能只检查请求中的 `isolation` 字符串。
- 禁止分支/worktree 时，显式 worktree 请求返回计划调整阻碍；允许的替代方案必须在受守卫计划中明确采用串行 shared。`auto` 的最终结果、工作区身份、降级原因与有效并发写入持久计划及回执，禁止暗中创建分支或静默放行。
- **串行 shared 必须真的串行执行。** 当前局部路径 claim 持续整个 parallel dispatch，单纯让两个 child 的 write 排队仍可能被第二项认领冲突拦截。应在计划解析时将有效并发降为 1、采用有序 chain 或明确调整计划，不维持无保护 parallel 写入。
- 保留 `single / chain / parallel`、只读、单候选、并发上限为 1 和独立 worktree 的原有语义；链式必要项拒绝后停止后续依赖项。读取真实 resolved isolation/回执，不从最终成功数量反推隔离。

### 4.5 桌面/浏览器观测与安全接管

- 以实际桌面设备/会话和浏览器 profile/session 作为资源；多个用户或 Bot 对同一物理输入不能因 workId 不同而得到不同锁。浏览器动作若涉及 OS 焦点/键鼠，同时申请桌面与浏览器资源。
- 复用 `platform/computer-use` 的任务归属 observationId、窗口/布局/AT-SPI 代次校验，以及浏览器的会话/页面身份。新增单调 `observationSeq` 可作为统一信封，不能取代后端的窗口、导航、控件和目标新鲜度证据。
- 观察→有限动作在租约内，或动作前持租约重观测；目标窗口/页面/控件改变、导航、用户切换焦点、陈旧 observation 或跨任务复用时拒绝输入并重读。沿用 Linux AT-SPI / Hyprland / ydotool 设计，不引入截图/OCR 定位或旧后端回退。
- 接管协议必须拿到旧执行停止/失效确认、后端输入队列结束及该驱动持有的键鼠释放回执；现有 fire-and-forget 清理需补可等待证据。只释放本驱动持有的输入。清理失败保持资源隔离与 blocker，不因 `expires_at < now` 或 stop 返回就放行新输入。
- `key_down/mouse_down` 到对应 up/清理的跨调用区间继续占有实际输入资源；不能因单次工具返回就释放焦点租约，让另一个执行接管仍处于按下状态的输入。

### 4.6 外部修改、写前核验与重新验收

- 文件版本以真实内容摘要和实体身份为依据；`mtime/size` 只作为变化提示/优化，不能单独证明未修改。Git 已提交树用于对应提交；dirty/untracked 文件另做内容清单，不能用 HEAD/tree 代表未提交工作区。外部资源使用其真实 revision/ETag/回执契约。
- 写前持资源租约复核读取时的基准。发现受管或外部变化返回 `version_conflict`，保留待写内容和冲突证据，先重新读取/计划。需要强条件写保证时使用底层真实 CAS 或相应平台机制；文件外部进程仍可能在检查后修改，不能夸大单次哈希校验的原子性。
- 接纳成果、满足必要验收和发送结果通知前，核对相关产物/资源仍与证据一致；变化后受影响条件恢复待核验，历史证据可查。无法精确判断依赖时保守重验相关范围，不自动重跑全部工作。
- `WorkSourceObserver` 扩展必须区分**输入来源变化、应用自身已记录的产物变化、外部产物损坏**。真正输入变化经既有来源 CAS 更新 `inputSnapshotId`，保持其他源及权威顺序；仅产物变化不得伪造要求变更或无差别替换全部 goalSources。自动调用使用可信系统能力，不伪造 user actor。

## 5. M2 — 部分成果、定向补跑与暂停结算

覆盖 **BW-A26、BW-A33、BW-A34**。

### 5.1 逐项事实、有效成果与明确缺口

- 在派发前为计划子项保存稳定身份、必要覆盖范围/criteria、依赖与预期产物；拒绝发生在 child 创建前时仍有可追查项，不能为凑引用伪造 child/binding。
- 逐项信息经 `DurableSubagents → DurableWorkExecutionProjection → DurableBotService.workExecutionPort().inspect() → WorkExecutionAdapter → WorkNativeResultInbox → WorkService/WorkExecutionSettlement` 贯穿生产链；同步扩展 `WorkExecutionObservation` 与 Inbox 的严格 Zod Schema。读取原生 `details.results[*]`、rejected 明细、writeConflicts 及真实产物引用，不解析 `Parallel: 1/2 succeeded` 展示标题猜状态；保留原生 status、派发 outcome 与批次 isError 的不同含义。
- 在现有持久原生 Inbox 消费事务内幂等写入逐项事实、deliverable/evidence 引用、缺口和预算/后续意图。稳定键包含完整执行命名空间与计划项/原生事实；事务失败不提前推进消费水位，重放不重复产物或扣费。
- 成功子项经真实产物与依赖核验后可作为有效部分成果；原生 clean completed 也不是自动验收。blocked/rejected、链式未运行的必要项及未确认效果生成 `uncoveredScope`、原因、依赖、相关 criterion 和下一步；无法确认的项保持 unknown。
- 批次 isError 不撤销同批已确认成果。不得整批重跑或按底层 completed 关闭 Work；只有当前必要条件满足、必需效果已确认、缺口和在途义务处理完毕，才进入既有关闭流程。

### 5.2 缺口计划与恢复去重共存

- 增加受 Work 控制守卫约束的 continuation 操作/计划，记录 `continuationPlanId`（或等价）、来源 binding/plan、稳定 gap/item IDs、未覆盖范围、当前 `intentRevision + inputSnapshotId`、已接纳产物/效果引用及原预算窗口。
- 主负责人先核对是否仍有必要、依赖与外部效果是否明确，再以读取时的完整 CAS、授权及 operationId 提交。确认的后续计划可以自动派发；**仅看到 isError/blocked 不自动授权重做已有业务效果**。
- 同一补跑计划在并发请求、重复事件、恢复、暂停/恢复中只产生一份逻辑派发；唯一约束需覆盖缺口/计划身份，并防止不同 operationId 同时占用同一必要缺口。不同补跑 attempt 仍使用原逻辑身份及原生恢复契约，不叠加无条件重试。
- 保留 `WorkDispatchQueue.enqueue()` 默认路径与 prepare 前的同输入去重；另显式识别已受理的 continuation。不得简单删除 `retainsInput()` 检查或放宽 pending 唯一索引而没有等价约束。只新增缺口范围的绑定，不伪造新 `inputSnapshotId`/revision 绕过保护。
- 只有剩余部分确需新动作才分配新执行；已完成文件效果/发送/发布不再执行。若确实依赖新输入，按真实来源快照变更处理；旧成果重新核验适用性后复用。每次新执行精确预留自己的 reservation，不重置累计用量。

### 5.3 暂停与持久积压

- `pauseWork()` 提交后拒绝尚未获准的新业务动作；继续查回、停止、读回和结算此前已准入操作，保留成果/失败/unknown。暂停不是全部效果瞬时停止；投影显示“已暂停（正在结算在途操作）”及剩余义务。
- 暂停期间的可信 Hook/tick 通过现有 `work_events_inbox` 落盘和去重，不新派发。原生结果 Inbox 不被业务触发积压过滤器挡住；取消时也必须完成回执核对。
- 恢复使用已保存的 `catchUpPolicy`：`latest` 依据权威当前来源合并且有最大等待；`each` 保留逐事件义务、有界排队与背压；`skip` 记录跳过范围，不丢未来在线事件。不能按最后到达时间猜“最新版本”，不能仅把 pending 计数放进 resumed 事件就声称策略已执行。
- 处理积压、更新 Work、写后续 Outbox 与消费状态仍使用一个业务事务；暂停/恢复、要求变更、交接、崩溃重开及重复 Hook 均不得丢义务或重复效果。只有新来源/新业务事件或已批准缺口计划可以产生相应新工作，普通 resume 不能生成第二个完整 root。
- 本阶段提供可调用的真实持久入口并用来源 fixture 联调 BW-A26；完整 Cron/GitHub 等事件源、时区及离线来源回查依旧按 Phase 4 的 BW-A36～BW-A41 验收，不另建并行事件系统。

### 5.4 实测版本与必要验收

- 复用 `requiresRealEnvironmentCheck`、`requiredEnvironment` 和现有真实反馈入口。代码补跑/自动测试通过后仍显示“等待当前快照版本实测反馈”，不能由模型代填用户实测条件。
- 证据绑定被测 `inputSnapshotId`、代码/产物指纹和实际环境；A 的迟到反馈不能验证 B。若产物在同一输入快照内因补跑/外部修改改变，旧产物测试结果同样不能无条件沿用。
- 分别验证无反馈、旧版本通过、当前版本失败、当前版本有效通过和外部产物变化后的重验；真实 Omarchy 证据与 fixture 明确分开。

## 6. M3 — 团队协作、原子交接与通知

覆盖 **BW-A27、BW-A28**，回归 **BW-A08** 的 Memory 隔离。

### 6.1 结构化协作与受限上下文

- 新增 `WorkCollaborationService.ts`，复用 `work_participants` 和既有执行绑定。八类持久消息为 `delegate / accepted / question / result / blocked / change / cancel / handoff`；记录稳定消息 ID、Work、发送者与接收范围、版本、回复/因果关系、产物引用及实际执行引用。
- 还未派发的 delegate/question 和纯交接可没有 binding；关联多个执行时使用明确引用集合。不得要求每条消息虚构非空 bindingId；但 result/执行状态必须可核验到真正生产者和有效委派。
- 接收、去重与关联业务变化写入同一控制事务/持久入口；重复消息不重复委派、预算或通知。消息内容是事实/请求，不直接拥有修改要求、验收或创建新计划的权限；仍走 WorkService 的 actor、范围、版本与授权检查。
- 上下文经 `MemoryContextProjection.ts`、`BotWorkContextService.ts`、`EphemeralContextProjection.ts` 和现有 Memory 内核装配，仅包含获准的 Work 资料、有效项目事实和调用方自身合法范围。`MemoryService.workMemoryScope()/resolveScopeChain()/canAccess()/canMutateFromTask()` 的查询、直接读取、派生知识和写权限一起校验，覆盖根执行与 owned child，不能只在 projector 隐藏文本。不能自动继承主负责人/其他 Bot 的私有记忆；不因共享执行或交接批量复制个人上下文，worker 推测不自动升级为团队事实。
- 协作因果链、委派范围、原生 child 递归限制和总预算保持有界；临时 child 不必被登记为长期 Bot，跨 Bot 不得绕过禁止 redelegation 的约束。

### 6.2 完善现有 `handoffOwner()`

- 新负责人在合法范围内接收当前 Work 快照、有效执行/缺口清单和交付义务；准备记录绑定读取版本。准备过程不长持数据库事务，提交时再次校验目标 Bot 可用、同用户、当前授权/转委派范围与完整 CAS。
- 在既有 `.immediate()` 控制事务内原子更新 `ownerBotId`、`ownerEpoch + 1`、`stateVersion + 1`，保存交接审计、协作 handoff 和必要 Outbox；失败全部回滚。满足当前访问及入口权限的相同 operationId 返回原回执；交接后失去控制权的旧负责人重试仍按身份守卫拒绝，不重复交接，通过有权读取的当前 Work/操作结果核对已提交事实。并发两次交接只能一份生效。
- 提交前旧负责人负责，提交后旧负责人的控制决定/新通知创建按责任与版本守卫拒绝。沿用 `unauthorized_actor / epoch_mismatch / version_conflict` 的真实检查顺序；当前 ownerOnly 路径可能先拒绝身份，不能以“未统一返回 epoch_mismatch”误判为允许控制。保留单一当前 owner，不自动把旧 owner 留成可继续创建计划的负责人。
- 核对 `work_dispatch_requests.bot_id` 与尚未提交的旧负责人计划/控制意图：由当前负责人重新评估、明确采纳或作废，不能只更新 owner 后把旧决定当新授权派发；已尝试提交的绑定继续按原命名空间查回，不能为换负责人重复提交。
- 原 binding/worker 的生产者、原 ownerEpoch、输入和专家快照保持历史身份；新负责人明确接管仍有效委派，按当前 Work 授权、delegatedScope、`intentRevision + inputSnapshotId` 和产物证据核验迟到结果。不能只因 binding.ownerEpoch 旧就丢弃成果、停掉全部有效工作或分配新 root。
- 交接不自动改变要求、验收标准、输入、既有成果状态或预算窗口。前台/卡片以当前负责人呈现，内部历史仍保留真实生产者与交接链。

### 6.3 通知发送前复核与在途边界

- 扩展现有 `WorkService.deliverPendingNotifications()` 与 `work_notifications`，复用接受成果时的稳定语义卡片和持久通知意图。当前发送循环持有的旧 Work/notification 对象不能作为每次发送的最新依据。
- 每次真实发送前重新读取当前 `(intentRevision, inputSnapshotId, ownerEpoch, lifecycle)`、成果有效性及必要产物证据。在短事务内裁定失效/改写或认领本次发送 attempt，并持久保存待核对状态；网络发送在事务外，结果按原 attempt 幂等结算。
- 要求/输入变化、取消或产物失效已在认领前提交：旧完成通知标记 superseded/cancelled，或改写成明确的历史进展，不能宣传当前完成。`closed:succeeded` 的有效完成通知可以继续交付，不能把所有非 active 生命周期一律拦截。
- 仅交接且成果仍有效：由当前负责人重核发送者、文案和展示身份，保留交付义务、`notificationId`/语义卡片 ID；需要修订的 payload 在新 attempt 中有记录。已经发出或状态 unknown 的通知不能悄悄换内容复用同一供应商幂等键。
- 发送认领先于变更提交的操作属于在途；继续接收回执/lookup，不声称已撤回。支持幂等/回查的渠道按真实契约恢复；不支持且结果未知时保留 unknown，不盲重发，也不因旧版本而跳过对已发效果的结算。
- 通知失败不重跑 Work，用户已读不改变验收；未发失效通知不伪造 readAt。外部渠道全面接入仍在 Phase 5，本阶段使用已有 channel 接口和确定性效果端点证明 BW-A28。

### 6.4 权威投影与最小 UI

- 在 `BotWorkspacePage.tsx`、已有 Work 卡片/详情和共享 IPC 投影中实际显示资源等待原因、已保留成果、必要缺口/下一步、暂停结算状态、当前实测版本及负责人交接历史。默认信息面向用户决定；token/lease 细节放诊断展开。
- 新事实提交后按既有投影日志和水位广播；新表变化需有对应事务性 Work 投影更新，不能只写数据库而 UI 永远不知情。继续保留 per-user 10,000 条日志边界、gap 快照恢复、稳定卡片、草稿与 pending send 保护。
- 相关控制入口、preload/IPC、store 与详情一起接线；模型工具若扩展继续使用严格 Zod 单源 Schema。普通 Task、Bot 前台能力白名单、用户/渠道身份不得回归。

## 7. 验收矩阵与完成门禁

以下 `bot-work-phase3-*.ts` 均为**拟新增测试入口**，不是当前已存在或已通过的脚本。实施时注册对应 `test:bot-work-phase3-*` 命令及正确分类；可以合理拆分文件，但必须保留场景映射和行为证据。

| 编号 | 必须实际验证的场景与判定 | 拟新增证据入口 |
| --- | --- | --- |
| BW-A26 | 暂停前/后准入边界；在途效果与原生结果继续结算；重复/乱序 Hook 持久积压；latest/each/skip、背压、恢复中崩溃；同输入 resume 不新增完整 root | `scripts/bot-work-phase3-pause-backlog-test.ts` |
| BW-A27 | 并发交接与事务失败回滚；旧 epoch 控制/通知被拒；有效原 worker 迟到成果接纳；要求/输入/预算不自动变更；当前负责人可继续缺口计划 | `scripts/bot-work-phase3-handoff-test.ts` |
| BW-A28 | 每次发送前修改/取消/交接/产物变化；有效交接保留卡片与交付；已认领/已发/unknown 分支核对；不以失效为已读、不重发未知外部效果 | `scripts/bot-work-phase3-handoff-test.ts` |
| BW-A29 | single/chain/parallel、只读、单候选、并发 1、shared/worktree 的计划与真实回执一致；同路径局部冲突保持结构化；chain 拒绝后不继续 | `scripts/bot-work-phase3-resource-gate-test.ts` |
| BW-A30 | 不同 Work/root/dispatch 使用同旧读版本；write/edit/Shell/MCP/Code Mode 均覆盖；软链接/硬链接/大小写适用平台/新路径/父子目录；反向多资源同时请求无死锁；无关可变资源真正并发 | `scripts/bot-work-phase3-resource-gate-test.ts` |
| BW-A31 | 同桌面/浏览器不并发输入；观测后窗口/页面/焦点改变拒绝；租约过期而旧执行仍活动时不得接管；旧队列/held input 释放确认失败保持隔离；重启后旧 token 拒绝 | `scripts/bot-work-phase3-focus-gate-test.ts` + 真实桌面记录 |
| BW-A32 | Work/仓库禁止新分支/worktree 时在计划及真实创建处阻断；显式计划改为有效并发 1 的 shared 或可解释阻碍；无隐藏 Git 分支/工作树与绕过入口 | `scripts/bot-work-phase3-resource-gate-test.ts` |
| BW-A33 | 1 成功 + 1 blocked、必要项启动前 rejected、chain 后续未运行；有效产物保留，结构化冲突不丢；仅缺口补跑；重复/并发/重开只一份新计划，已有真实效果计数不增加 | `scripts/bot-work-phase3-partial-settlement-test.ts` |
| BW-A34 | 自动测试通过仍等待实测；旧输入/旧产物反馈不能验证当前版本；当前失败/通过与环境严格绑定；缺失实测不允许成功关闭 | `scripts/bot-work-phase3-partial-settlement-test.ts` |
| BW-A35 | 应用外改输入或产物，含同 mtime 不同内容、dirty/untracked Git、读取后写前及验收前变化；保留其他来源，拒绝旧写或重验受影响条件；不夸大外部排他 | `scripts/bot-work-phase3-resource-gate-test.ts` / `scripts/bot-work-phase3-partial-settlement-test.ts` |
| 关联 BW-A08 / F11 / F12 | 八类消息真实持久交互与去重；跨用户/越权范围/伪造执行引用拒绝；实际上下文不包含其他 Bot 私有记忆；消息不能绕过控制/预算/递归守卫 | `scripts/bot-work-phase3-collaboration-test.ts` |

### 7.1 必交证据

1. 核心链路使用真实临时 SQLite、真实 Pi Durable/owned children、确定性模型与有实际效果的本地 fixture。至少两个独立连接/执行上下文验证资源互斥、整组准入与并发交接；不能只断言 mock 被调用或源码包含某个字符串。
2. 在租约授予后、效果发生而回执未落盘、逐项结果消费、补跑 Outbox 投递前后、交接事务及通知认领/发送等窗口注入故障。关闭并重开实际存储，必要时强杀受控子进程；记录原命名空间、真实效果次数、预算、租约 token、缺口与回执。不得对真实用户进程/输入做破坏性测试。
3. 为“无关资源并发”“资源冲突等待”“反向多资源无死锁”使用可控屏障与实际顺序断言，限定等待期限；保留已有性能预算，不依赖不可靠的单次 wall-clock 快慢猜结论。
4. GUI/真实桌面场景使用隔离靶应用与真实会话。Linux/Omarchy 必须遵守 `AGENTS.md` 的 AT-SPI、Hyprland 和发行包验收边界；headless 契约测试不能替代真机。Windows、Linux、浏览器、移动端和发行包证据各列适用/未运行范围；未获授权不为补证据自动打包。
5. 功能完成后运行 `pnpm -s typecheck`、`pnpm -s test:all`、新增测试及相关定向回归。至少保留 `test:bot-work-resume-dispatch`、`test:bot-work-foreground-contract`、`test:bot-work-read-lifecycle`、`test:bot-work-projection-retention`、`test:db-schema-discard`、既有 Bot/Work 执行/Memory/投影/恢复/用量用例，以及 subagent 写冲突和相关平台用例；按 `--list` 的 NETWORK/GUI 分类如实安排。新增脚本须通过 `node scripts/test-all.mjs --audit`，有 IPC 变更时核对既有通道清单。
6. 新增 `docs/reviews/bot-work-phase3-YYYY-MM-DD.md`，记录最终代码 SHA、设计基线、平台/依赖、每个 BW 场景、故障点、实际效果/预算/身份与 passed/failed/blocked/not-run；同步更新 [实施记录](bot-work-implementation.md)。不重写 Phase 1/2 历史证据，不把当前环境阻塞改成 passed。

**完成定义：** P3-00～P3-08 全部真实接线，BW-A26～BW-A35 及关联回归有可追查行为证据，必要门禁通过。缺少强制真实环境证据时明确只完成已验证的组件范围并列出未完成项；不得标记 Phase 3 全部验收通过，更不代表 BOT-WORK-1.0 总体交付。

## 8. Codex 执行任务（可逐项勾选）

- [x] **P3-00 基线与数据契约**：资源/子项/补跑/协作身份、schema 32 及唯一约束、`AppDatabase`、共享 DTO 与既有 Inbox/Outbox 已接入，见[实施记录](reviews/bot-work-phase3-2026-11-07.md)。
- [x] **P3-01 文件/Shell 资源门控**：`WorkResourceGate` 统一规范资源、路径/实体别名、多资源整组准入、读版本/fencing 与恢复，根调度与真实工具/普通受管入口同 gate；无关写并发由 resource-gate 用例证明。覆盖 BW-A30。
- [x] **P3-02 分支约束与隔离**：计划与真实创建/恢复均核对授权，禁 worktree 时回落有效并发 1 的 shared 或给出结构化阻碍。覆盖 BW-A29、BW-A32。
- [x] **P3-03 焦点与外部修改**：桌面/浏览器组合资源、旧执行查回、可等待输入清理已接入（组件级通过）；多源与产物指纹、写前/验收前重验覆盖 BW-A35。BW-A31 真实 Windows 桌面输入仍 `FOCUS_FAILED` 受阻，未验收。
- [x] **P3-04 部分成果与定向补跑**：计划项与 rejected 明细持久化、统一消费事务、有效产物保留、受守卫 continuation 唯一派发、当前版本实测缺口。覆盖 BW-A33、BW-A34。
- [x] **P3-05 暂停结算与积压**：新动作与旧效果结算分离、原 Inbox 积压、latest/each/skip、有界队列、崩溃去重与真实 UI 状态。覆盖 BW-A26。
- [x] **P3-06 协作与负责人交接**：八类受限消息、Memory 投影、`handoffOwner` 原子扩展、旧控制拒绝与原委派成果接管。覆盖 BW-A27、关联 BW-A08。
- [x] **P3-07 通知及 UI 联调**：发送前重验/认领、失效独立于渠道失败与已读、在途 unknown 回查；资源等待/缺口/交接投影与页面。覆盖 BW-A28，并贯通 M1/M2 状态。
- [x] **P3-08 联合验证与报告**：typecheck、`test:all`（336 通过 / 0 失败 / 0 新增回归）、八个 Phase 3 headless 用例与 `:dev` 页面通过；证据报告已提交并标注 BW-A31 桌面阻塞与未运行平台。整体验收未完成。

依赖顺序：P3-00 先确定共同契约；P3-01～03、P3-04～05、P3-06 可按独立模块推进，但实际动作依赖资源准入，补跑依赖逐项事实与控制守卫；P3-07 汇合已验证的交接/成果/资源投影，最后 P3-08 联合验收。所有勾选均需关联实际提交与证据。
