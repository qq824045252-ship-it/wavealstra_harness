# Step 1：生产入口盘点、所有权清单与行为分类

- **文档基线 SHA**：`046e33ef6a6a492a99e9ad3fa10499dbac85b3aa`（核心基线 `a46f86467a0491f0dd041e2cdecf0af58c694aec` + 执行规范 `046e33ef`）
- **盘点方法**：静态全量追踪（`src/main/`、`native/runtime-audit/src/`、`scripts/`）+ 运行期进程与测试路径核对（注：部分运行期追踪仍在受限于本地旧 protocol 87 进程占用 `out/native/win-x64/mybuddy-runtime-audit.exe`，将在步骤 2 切换验证中同步实测）。

---

## 1. 数据库与持久化存储分域总表

| 存储实体 | 路径 / 形态 | 当前格式 | 当前写入者 | 目标所有者 | 迁移步骤 | 验收 ID |
| --- | --- | --- | --- | --- | --- | --- |
| 应用主数据库 | `~/.mybuddy/app.db` | SQLite WAL | 混合：Rust Core (`mybuddy-runtime-audit`，协议 88) + Electron Main (`better-sqlite3` `AppDatabase.ts` 及各域仓储) | **常驻 Rust Core**（唯一生产写者；Main 不再持有生产写连接） | Step 4（Step 2 先闭合双锁与重建守卫） | RC-05, RC-09, RC-10 |
| 应用 Core 运行态与操作回执 | `~/.mybuddy/app.db.runtime-operations/*.json`、`~/.mybuddy/core.{lock,lease,json}`、`core-worker.lock`、`core-binaries/<sha256>/` | JSON + OS 文件锁 + 不可变二进制副本 | Rust Core (`core_lease.rs`, `core_supervisor.rs`, `request_control.rs`) + Main (`core-client.ts`) | **常驻 Rust Core** | Step 2 闭合，Step 3 扩展 | RC-02, RC-03, RC-05, RC-26 |
| Pi Durable 主存储 | `~/.mybuddy/durable/<sha256(taskId)>/durable.sqlite`（及 gateway 会话目录） | SQLite **DELETE**（rollback journal, `synchronous=FULL`） | Electron Main 内 `DurableBotService` / `DurableSqliteDatabase`；被动只读可走 Rust `durable.rs` (`query_only=ON`) | **独立 Pi Node Host**（唯一可写者；Rust 仅只读快照） | Step 8 | RC-20, RC-21, RC-22 |
| Pi Durable 单写者租约 | `<durableDir>/.mybuddy-writer-lock.sqlite` + `.mybuddy-owner.json` | SQLite EXCLUSIVE + JSON | Electron Main (`DurableStorageLease.ts`) | **独立 Pi Node Host**（由 Rust 托管启停与身份校验） | Step 8 | RC-20, RC-21 |
| Pi 会话附件 / CodeMode 图片 | `<durableDir>/artifacts/`、`<durableDir>/images/` | 不可变硬链接/文件 | Electron Main (`DurableArtifactRegistration.ts`, `DurableCodeMode.ts`) | **独立 Pi Node Host** | Step 8 | RC-21, RC-22 |
| Native Hooks / Improvement 账本 | `~/.mybuddy/native-hooks.sqlite`、`~/.mybuddy/native-improvement.sqlite` | 独立 SQLite | Electron Main (`NativeHookStore.ts`, `NativeImprovementService.ts`) | **常驻 Rust Core**（或按独立辅助账本收拢） | Step 4 / Step 6 | RC-09 |
| 资料库文件 | `~/.mybuddy/library/<spaceId>/<itemId><ext>` | 磁盘文件 | 混合：Rust (`library_text_save`, `library_delete`, `library_restore`, `library_backup`) + Node (`LibraryService`, `LibraryNoteOperations`) | **常驻 Rust Core**（用户显式导入/导出对话框选路径留在 UI/平台代理） | Step 4 | RC-09, RC-10 |
| 产物托管文件 | `~/.mybuddy/artifacts/<taskId>/<artifactId>/` | 磁盘文件 | 混合：Rust (`artifact_write`, `artifact_cleanup`) + Node (`ArtifactStorage`) | **常驻 Rust Core** | Step 4 | RC-09, RC-10 |
| Gadget 源码与状态 | `~/.mybuddy/gadgets/<gadgetId>/{gadget.json,code/,data/.mybuddy-state.json}` | JSON + 文件 | 混合：Rust (`gadget_materialize`, `gadget_source_save`, `gadget_files`, `gadget_state`) + Node (`GadgetStorage`, `GadgetState`) | **常驻 Rust Core** | Step 4 / Step 7 | RC-03, RC-17, RC-19 |
| 任务工作区 / 回收站 / 蓝图实例 / 专家快照 | `~/.mybuddy/task-workspaces*`、`~/.mybuddy/trash/`、`~/.mybuddy/workspace-instances/`、`~/.mybuddy/task-expert-bindings/` | 目录与文件 | 混合：Rust (`task_trash*`, `blueprint_storage`, `blueprint_instance`) + Node (`TaskExecutionWorkspaceLifecycle`, `TaskExpertBindingService`) | **常驻 Rust Core** | Step 4 | RC-09, RC-10 |
| 应用设置 / 模型 / MCP / 专家 / 技能配置 | `~/.mybuddy/{settings.json,models.json,auth.json,subagent.json,web-search.json,memory-access.json,remote-devices.json}`、`~/.mybuddy/{experts,skills,modes,fonts,mcp}/` | JSON + 文件 | Electron Main (`AppSettingsStore`, `ModelsConfigStore`, `RemoteDeviceStore`, `ExpertService`, `McpRuntimeService`, `MemoryGateway*`) | **常驻 Rust Core**（模型凭据与 OAuth/模型配置边界按 Step 4 & Step 8 分离；系统凭据加解密由平台代理） | Step 4 / Step 6 / Step 8 | RC-09, RC-16, RC-22 |
| Dots Discovery / Google 状态 | `~/.mybuddy/dots/discovery/*.json`、`~/.mybuddy/dots/google/**` | JSON 文件 | Electron Main (`DotsDiscovery.ts`, `DotsGoogleAccounts.ts`, `DotsGoogleMonitor.ts`) | **常驻 Rust Core** | Step 6 | RC-14 |
| Gateway 媒体 / Slack 投递日志 | `~/.mybuddy/gateway/media/`、`~/.mybuddy/gateway/slack-deliveries.json` | 磁盘文件 + JSON | Electron Main (`GatewayMedia.ts`, `SlackGatewayJournal.ts`) | **常驻 Rust Core** | Step 6 | RC-15 |
| 系统密钥 / Chromium 会话 | OS Keyring (`safeStorage` / `gnome-libsecret` / DPAPI)、`app.getPath("userData")` | OS / Chromium 存储 | Electron Main (`credentials/`, `BrowserContentService`) | **Electron 薄 Main / 平台代理**（永久保留平台边界） | —（平台边界） | RC-24, RC-26 |

---

## 2. 全量生产业务入口所有权清单

> 每项包含：当前执行进程、持久化位置、写入者、定时/恢复入口、目标所有者、迁移步骤、验收 ID。

### 2.1 桌面 IPC 与应用生命周期（`src/main/index.ts`）

| 入口 / 域 | 当前执行进程 | 持久化位置 | 当前写入者 | 定时 / 恢复入口 | 目标所有者 | 迁移步骤 | 验收 ID |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 启动单实例与数据目录锁 (`HostDataLease.ts:6-23`, `index.ts:2`) | Electron Main | `~/.mybuddy/.mybuddy-writer-lock.sqlite` + `.mybuddy-owner.json` + Electron SingleInstanceLock | Node (`claimDurableStorageLease`) | 模块加载即抢锁；`before-quit` (`index.ts:3962`) 释放 | Electron 仅保留窗口单实例；数据目录/Core 锁由 **Rust Core** 独占 | Step 2 / Step 3 / Step 9 | RC-05, RC-08, RC-26 |
| 数据库初始化 / 不兼容重建 (`AppDatabase.ts:284-347`) | Electron Main + Rust (`--guard-core-database`) | `~/.mybuddy/app.db` | Node `AppDatabase.migrate()`（取得 Core 双锁后） | 启动 `index.ts:3139-3140` | **Rust Core**（所有权、初始化与重建守卫全收拢） | Step 2（守卫）→ Step 4（初始化收拢） | RC-05, RC-09 |
| `--resident-host` / 退出界面 / 停止 (`ResidentLifecycle.ts`, `index.ts:442-453,3905-3974`) | Electron Main | `<MyBuddyDir>/logs/resident-launcher.log`、`settings.json` | Node (`app.relaunch` / detached bootstrap) | `window-all-closed`、`before-quit` | **Rust Core** 管后台生命周期；Electron 退出界面即真退出 Main（不再靠隐藏 Electron 充当业务宿主） | Step 3（生命周期契约）→ Step 8/9（真正停 Main） | RC-08, RC-20, RC-23, RC-26 |
| `DbIpc.*`（spaces/tasks/projects/todos/pins/review/failures/soul/grants/trash） | Electron Main + Rust Core | `app.db` | 混合：spaces/tasks/projects/todos/pins/review/trash 多为 Rust-first（带 Node 回退）；`DOTS_TASK_ID`/gateway task、`createSpace` sync、`deleteTask`、`createConversationBranchTask`、`add/deleteTaskWriteGrant`、`updateSoul`、`ProjectFolderRelocation.commit`、`WorkspaceLibraryBindingIpc.createFolder` 为 Node-only | 启动 `rebindLegacyTaskWorkspacePaths` (`index.ts:3138`)；`purgeExpiredTrash` (`index.ts:3423-3424` 6h interval + 5s startup) | **Rust Core**（Step 4 关闭所有 Node 写回退与直写） | Step 4 | RC-09, RC-10 |
| `LibraryIpc.*` / `MaterialRetrievalIpc.*` / `WorkspaceNotesIpc.*` / `ProjectNotesIpc.*` | Electron Main + Rust Core | `app.db` + `~/.mybuddy/library/` | 混合：notes/text/delete/restore/backup/index/settings 为 Rust-first；`createSpace/Collection/Item`、`updateItem`、`favorite`、`importFile/Folder`、`attachToTask`、`deleteChunkEmbeddings` 等仍 Node-only | `index.ts:3156-3172`（`recoverFileDeletes`, `recoverLibraryRestores`, `recoverPendingExtractions`, `recoverTextFtsCoverageV2`, `backfillMissingChunks`, `startSemanticIndexing`） | **Rust Core**（文件选择弹窗留 Electron UI） | Step 4 | RC-09, RC-10 |
| `ArtifactDomainIpc.*` / `SavedArtifactIpc.*` / `ArtifactIpc.*` | Electron Main + Rust Core | `app.db` + `~/.mybuddy/artifacts/` + `<durableDir>/artifacts/` | 混合：`register`/`writeManaged`/`orphanGC` 为 Rust-first；`update`/`setFileDependencies`/`addMessageRef`/`applyFolderRelocation` 为 Node-only；`ArtifactSurface` 为 Chromium View | `index.ts:3567-3572`（清 `artifact_write_receipts` + `orphanGC`） | 域写与 GC 归 **Rust Core**；`WebContentsView`/系统打开/另存为弹窗归 **Electron 平台代理** | Step 4（域写）+ Step 9（View/回收） | RC-09, RC-10, RC-24 |
| `MemoryIpc.*` / `MemoryOrganizationIpc.*` / `AnswerRoutingIpc.*` / `MemoryGatewayIpc.*` | Electron Main + Rust Core | `app.db` + `~/.mybuddy/memory-access.json` + `~/.mybuddy/runtime/memory-share/` | 混合：设置记忆 CRUD/lexical/semantic/turn capture 为 Rust-first；L1 提炼/候选和解/遗忘水位/技能学习/记忆认知/`MemoryOrganizationService` 状态变更/HTTP Memory Gateway 为 Node-only | `MemoryOrganizationService` 构造恢复中断扫描为 `paused`；`MemoryCognitionService` `setTimeout`/`setImmediate`；`index.ts:3865` 启动 `MemoryGatewayController` | **Rust Core** | Step 4（写/组织）+ Step 6（Gateway/外部暴露） | RC-09, RC-10, RC-16 |
| `WorkspaceIpc.*` / `workspace:*` / `FileDialogIpc.*` | Electron Main + Rust Core | `app.db` + 用户工作区文件 + `~/.mybuddy/uploads/` | `WorkspaceNotes`/`WorkspaceLibraryBinding` Rust-first；`WorkspaceSharedContextService.promote` (`index.ts:2464`) 与工作区文件移动/重命名/删除写磁盘为 Node-only | — | 数据库与工作区治理归 **Rust Core**；原生文件选择/拖拽/系统文件夹打开归 **Electron 平台代理** | Step 4 | RC-09 |
| `WorkGraphIpc.*` | Electron Main + Rust Core | `app.db` (`work_graph_*`) | `WorkGraphData`/`Integrity` 有 Rust 路径；部分写与 `WorkGraphService` 仍在 Node | — | **Rust Core** | Step 4 | RC-09 |
| `NotificationIpc.*` | Electron Main + Rust Core | `app.db` (`notifications`, `notification_activation_targets`) | 异步列表/未读/已读/关闭为 Rust-first；`cleanup` (`index.ts:3142`)、同步 `publish`/`markReadByDedupeKey`、`activate` 查询为 Node-only；OS Toast 为 Electron | `NotificationService` 构造清理 90d/1000 行；`notification-activation.ts` dev 启动队列 | 状态与去重归 **Rust Core**；系统通知弹窗与激活窗口拉起归 **Electron 平台代理** | Step 4（数据）+ Step 6（事件/投递）+ Step 9（UI 激活） | RC-09, RC-16, RC-23 |
| `UsageIpc.*` / `NativeHooksIpc.*` / `NativeImprovementIpc.*` | Electron Main + Rust Core | `app.db` + `native-hooks.sqlite` + `native-improvement.sqlite` | `UsageStatsService` Rust-first；`backfillAllTasksAsync`/`reattribute`、`NativeHookStore`、`NativeImprovementService` 为 Node-only | `index.ts:3296-3308`（`setImmediate` 回填）；`CronService` 启动 `NativeImprovementService` 1h `setInterval` | **Rust Core** | Step 4 / Step 6 | RC-09 |
| `BlueprintIpc.*` / `TaskExpertBinding` / `ExpertService` | Electron Main + Rust Core | `app.db` + `~/.mybuddy/workspace-instances/` + `~/.mybuddy/{task-expert-bindings,experts}/` | `BlueprintRepository`/`BlueprintInstanceWrite`/`TaskExpertBinding.read/saveSettings` 为 Rust-first；`installFrozen`/`promote`/`purge` 与 `ExpertService` 文件为 Node-only | `BlueprintService.recoverStorage` (`index.ts:3636`) | **Rust Core** | Step 4 | RC-09, RC-10 |
| `ConversationBranchIpc.*` / `ExternalAgentIpc.*` / `PythonRuntimeIpc.*` | Electron Main | `app.db` (`conversation_branches`, `tasks`, `external_agent_runs`, `python_project_bindings`) + 工作区/venv 文件 | **Node-only**（`ConversationBranchService.ts:241`, `ExternalAgentRuntime.ts`, `PythonProjectBindingStore.ts`） | 启动 `PythonRuntime` / ACP 进程清理 | **Rust Core** 管应用域记录；Pi 分支会话目录写入归 **Pi Node Host**；ACP/Python 子进程管理归 **Rust Core**（或受监督宿主） | Step 4（DB）+ Step 7/8（进程边界） | RC-09, RC-22 |
| `BrowserIpc.*` / `CaptureModeIpc.*` / `SelectionIpc.*` / `HtmlEditIpc.*` / `TerminalIpc.*` / `OfficeUseIpc.*` / `CadCraftIpc.*` / `SpeechIpc.*` | Electron Main | Chromium 会话 / 临时草稿 / PTY | Node / Chromium (`BrowserContentService`, `TerminalHost`, `OfficeUse`, `CadCraftFile`) | `TerminalHost` PTY 生命周期；`ComputerUseOverlay` 50ms timer | **Electron 薄 Main / 平台代理**（Chromium/窗口/桌面能力） | Step 9（仅收薄与回收） | RC-24 |

### 2.2 Work、Cron、Dots、Gateway、Remote、Gadget、Pi、安装与更新

| 业务域 / 入口 | 当前执行进程 | 持久化位置 | 当前写入者 | 定时 / 恢复入口 | 目标所有者 | 迁移步骤 | 验收 ID |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Work 租约与控制权威** (`WorkHostAuthority.ts`, `work_host_lease.rs`) | Electron Main + Rust Core | `app.db` (`work_host_lease`) | **Rust-first**（`writer.workHostLease`，仅无原生时 Node 回退） | `heartbeatTimer` 20s `setInterval`、`retryTimer` 100ms-2s `setTimeout`、`onAcquired` 触发 `WorkMemoryCapture.catchUp` | **Rust Core**（Step 5 后不再由 Main 持业务调度权） | Step 2（契约）→ Step 5（调度权威转移） | RC-02, RC-11 |
| **Work 领域状态机、目标与续跑** (`WorkService.ts`, `WorkRepository.ts`, `GoalContinuationService.ts`, `GoalContinuationStore.ts`) | Electron Main | `app.db` (`works`, `work_*`, `conversation_goal_*`) | **Node-only**（`WorkQueueData` 读与 `MarkWorkCardRead` 写为 Rust） | `GoalContinuationService` `setTimeout(0)`；启动 `AgentService.resumePersistedTasks` (`index.ts:3845`) 调 `reconcileRestart` 将 `igniting` 置 `deferred/restart` | **Rust Core**（执行桥派发给 Pi Host） | Step 3（执行桥）→ Step 4（事务）→ Step 5（调度/恢复） | RC-06, RC-11, RC-12, RC-13 |
| **Work Watch 调度器** (`WorkWatchScheduler.ts`) | Electron Main（生产未启动循环） | `app.db` (`work_subscriptions`, `work_schedule_ticks`, `work_events_inbox`, `work_deadline_instances`) | Node (`WorkWatchScheduler` 目前生产仅 `stop()` 与 `hostState()` 被调用) | `setInterval(5000)` 存在但生产未 `start()`；`onSystemSuspend/Resume` 为 no-op | **Rust Core**（接管目标/watch/deadline 调度） | Step 5 | RC-11, RC-13 |
| **Cron 调度与运行** (`CronService.ts`, `CronSchedule.ts`, `CronPlanPersistence.ts`, `CronRunPersistence.ts`) | Electron Main + Rust Core | `app.db` (`cron_jobs`, `cron_runs`, `cron_run_inputs`, `dots_schedule_*`, `tasks`) | `cron_jobs`/`cron_runs` 为 Rust-first（带 Node 回退）；`dots_schedule_*` 与 `cron_run_inputs` 初始化为 Node-only | `scheduleTimer`（分段 `setTimeout` <=24.8d）；启动 `cronService.start()` (`index.ts:3856`) 恢复 `running` run 并执行 Dots `coalesce` catch-up；`powerMonitor` `suspend`/`resume` (`index.ts:3188-3200`)；`before-quit` `flushWrites()` (`index.ts:3952`) | **Rust Core**（计时、时区、休眠恢复、防重、通过执行桥提交任务） | Step 4（写）→ Step 6.1（触发服务） | RC-14 |
| **Dots 文件监听与前后台委派** (`DotsActions.ts`, `DotsDelegations.ts`, `DotsReplyOutbox.ts`, `DotsFollowup.ts`, `DotsReporting.ts`, `DotsFileWatches.ts`, `DotsDeferredRequirements.ts`) | Electron Main（+ Rust `dots_file_watch.rs` 辅助） | `app.db` (`dots_*`, `tasks.status`) + `<durableDir>` (`DurableDotsReply.ts`) | **Node-only**（除了 `TaskBoardRepository` 与原生 file watch 通知） | `DotsFileWatches` 30s `setInterval` + Rust/`fs.watch`；`DotsDelegations` `observationTimer`/`dependencyTimer`/`retries`/`recoveryTimers`；启动 `index.ts:3846-3854` 调 `dotsDelegations.recover` + `startFileWatches` | **Rust Core**（保留轻量委派边界；模型回合走执行桥→Pi Host） | Step 4（写）→ Step 6.2（控制循环） | RC-14 |
| **Dots Google / RSS / Dream / 主动投递** (`DotsGoogleMonitor.ts`, `DotsGoogleAccounts.ts`, `DotsDiscovery.ts`, `DotsProactiveDelivery.ts`, `DotsWorkspace.ts`) | Electron Main | `app.db` (`dots_proactive_delivery`) + `~/.mybuddy/dots/{google,discovery}/` + `<workspace>/常驻能力/` + `<durableDir>` | **Node-only**（`DotsGoogleMonitor` 调外部 `gws` CLI；`DotsDiscovery` HTTP fetch + 调 `agentService.generateDotsDream`） | 3 个 `setInterval`（Google 15s, Discovery 15s, ProactiveDelivery 5s）；启动 `index.ts:3857-3860`；`powerMonitor.resume` 刷新；`before-quit` 关闭 | **Rust Core**（Dream 推理走执行桥→Pi Host） | Step 6.2 | RC-14 |
| **Gateway 渠道服务** (`GatewayService.ts`, `GatewayPlatformRegistry.ts`, `GatewayLifecycleManager.ts`, `GatewayDeliveryJournal.ts`, `SlackGatewayJournal.ts`, `GatewayMedia.ts`, 7 渠道适配器) | Electron Main + Rust Core | `app.db` (`gateway_channels`, `gateway_inbox`, `gateway_outbox`, `gateway_conversation_routes`, `gateway_messages`, `gateway_dots_*`, `gateway_sidebar_conversations`) + `~/.mybuddy/gateway/` + `safeStorage` 密文 | `gateway_messages` 为 Rust-first；其余 `gateway_*` 表与磁盘文件均为 **Node-only** | HTTP webhook 服务器 (`127.0.0.1:52140` 等)、4 个 WebSocket (Feishu/WeCom/DingTalk/Discord/QQ/Slack)、2 个长轮询循环 (Telegram/Weixin iLink)、QR 登录轮询、`recoveryTimers`；启动 `recoverInterrupted()` + `restoreChannels()` (`index.ts:3863`)；`before-quit` `suspend()`+`stop()` | **Rust Core**（连接/路由/去重/队列/对账；`safeStorage` 密钥加解密通过平台代理） | Step 4（表）→ Step 6.3（渠道服务） | RC-15 |
| **Remote 远程服务** (`RemoteAccessController.ts`, `RemoteAccessServer.ts`, `RemoteTaskCommandService.ts`, `RemoteDeviceStore.ts`) | Electron Main | `~/.mybuddy/remote-devices.json`、`~/.mybuddy/remote-uploads/`、`settings.json`、`app.db` (`tasks`, `work_*`, `notifications`) | DB 写走 `writeTaskRecord`/`writeTaskDoneAck` (Rust-first) 及 `WorkService`/`RemoteTaskCommandService` (`UPDATE tasks SET archived=1` Node-only)；设备/上传文件为 Node-only | `http.createServer` (`127.0.0.1:<port>`) + SSE `20s` ping `setInterval`；启动 `index.ts:3877`；`before-quit` `dispose()` (`index.ts:3945`) | **Rust Core**（服务生命周期、命令路由、SSE/事件游标订阅） | Step 6.4 | RC-16 |
| **Gadget 运行与宿主** (`GadgetService.ts`, `GadgetRuntime.ts`, `GadgetHost.ts`, `GadgetState.ts`, `GadgetStorage.ts`, `GadgetRepository.ts`, `gadget-commands.ts`) | Electron Main + 每活跃 Gadget 1 个 `ELECTRON_RUN_AS_NODE=1` 子进程 + 按需子进程 | `app.db` (`gadgets`) + `~/.mybuddy/gadgets/<id>/` | DB/文件/状态多为 Rust-first（带 Node 回退）；每个启动的 Gadget（含静态 Gadget）目前均会拉起独立 `GadgetHost` Node HTTP 子进程 (`127.0.0.1:0`) | 8s 启动超时、1.5s 健康检查、30s action 超时；启动 `recoverStorage()` (`index.ts:3620`)；`before-quit` `disposeAll()` (`index.ts:3946`) | **Rust Core**（静态共享 Rust HTTP Host = 0 专属 Node HTTP；按需后端进程树管理；后台 generation 独立于 UI） | Step 7 | RC-17, RC-18, RC-19 |
| **Pi 主执行与原生存储** (`AgentService.ts`, `ModelInvocationAdmission.ts`, `DurableBotService.ts`, `DurableBotRuntime.ts`, `DurableStorage.ts`, `DurableTaskProjection.ts`, `DurableWorkspaceMoves.ts`, `DurableSubagents.ts`, `DurableCodeMode.ts`, `DurableMcp.ts`, `SessionExtensionAssembler.ts`) | Electron Main（CodeMode/Image 用 `worker_threads`；MCP/Shell 用 `spawn`） | `durable.sqlite`（Pi 原生）+ `app.db`（projection/binding/attempt/failure/usage/diagnostics/snapshots/扩展工具写） | Pi 存储归 Node `DurableSqliteDatabase`；`DurableTaskProjection`/`WorkspaceMoves`/`Diagnostics`/`Snapshots`/`Memory`/`Project`/`Library`/`Artifact` 为 Rust-first；`durable_bot_bindings`/`execution_attempts`/`execution_failures` 插入/`conversation_interactions`/工作区/Goal 状态为 Node-only | 启动 `resumePersistedTasks()` (`index.ts:3845`)；`before-quit` `closeDurableBots()` + `dispose()` (`index.ts:3937-3938`) | **独立 Pi Node Host**（管 Pi 执行与 `durable.sqlite` 唯一写权；所有 `app.db` 写改走 Rust 命令；桌面/浏览器工具走平台代理） | Step 3（先建执行桥）→ Step 4（工具改 Rust 写）→ Step 8（拆出独立 Pi Node Host） | RC-06, RC-20, RC-21, RC-22 |
| **桌面自动化与平台能力代理** (`src/main/platform/computer-use/`, `credentials/`, `processes.ts`, `OfficeNativeDesktop.ts`, `cadcraft.ts`, `tray/`, `fs-security.ts`) | Electron Main + 平台子进程 (`WindowsAutomationHost.ts` powershell / Linux `atspi-worker.cjs` + `input-guardian.cjs` / `OfficeNativeDesktop`) | OS Keyring / 临时 OCR 与草稿文件 | Node / 平台代理 | `WindowsComputerUseBackend` / `LinuxComputerUseBackend` 持有输入清理钩子；`before-quit` `shutdown()` (`index.ts:3948`) | **Electron 薄 Main / 平台代理**（受 Core 策略与调用，保留真实 OS/桌面边界） | Step 7 / Step 8 / Step 9 | RC-24, RC-26 |
| **构建、打包、验证与自升级** (`scripts/before-pack.cjs`, `after-pack.cjs`, `verify-packaged-app.cjs`, `prepare-runtime-audit.cjs`) | Node 构建脚本 / `electron-builder` | `out/native/`, `release/*-unpacked/`, `<dataDir>/core-binaries/<sha256>/` | 构建脚本 + `icacls`（Win Medium IL）+ `core-client.ts`（不可变 SHA-256 副本） | `beforePack`、`afterPack`；生产启动 `prepareCoreBinary` + `stopEndpoint` | **Rust Core 不可变二进制升级 + 双平台包校验** | Step 2（升级交接验证）→ Step 10（发行包整体验收） | RC-05, RC-26 |

---

## 3. 遗留 Node 基础设施要素专项清点

### 3.1 Electron Main 中的网络 Listener
1. **Gateway Webhook HTTP Server** (`src/main/gateway/GatewayLifecycleManager.ts:52`, `webhook-port.ts:32`)：`127.0.0.1:52140`（回退 `52330, 52490, 39140, 39141`）→ Step 6.3 迁至 Rust Core。
2. **Remote Access HTTP/SSE Server** (`src/main/remote/RemoteAccessServer.ts:118`)：`127.0.0.1:<port>` → Step 6.4 迁至 Rust Core。
3. **Memory Gateway HTTP/MCP Server** (`src/main/memory/MemoryGatewayServer.ts:96-127`)：`http.createServer` → Step 4/6 迁至 Rust Core。
4. **Gadget Host HTTP Servers** (`src/main/gadget/GadgetHost.ts:200,343`，当前在 `ELECTRON_RUN_AS_NODE=1` 子进程)：每运行 Gadget 1 个 `127.0.0.1:0` → Step 7 改为共享 Rust HTTP Host。
5. **Gateway 出站 WebSocket 客户端**（Feishu SDK WSClient、WeCom `wss://openws.work.weixin.qq.com`、DingTalk、Discord v10、QQ、Slack Socket Mode）与长轮询循环（Telegram、Weixin iLink）→ Step 6.3 迁至 Rust Core（或受监督独立协议适配）。
6. **OfficeNativeDesktop 端口探测** (`src/main/platform/OfficeNativeDesktop.ts:19-41`)：`net.createServer`/`net.createConnection` → 保留在平台代理。

### 3.2 后台定时器（`setInterval` / 长 `setTimeout`）
- **Work**：`WorkHostAuthority` 20s 心跳 + 重试定时器（Step 5 迁）；`WorkWatchScheduler` 5s interval（生产未启用，Step 5 清理/迁）；`GoalContinuationService` `setTimeout(0)`（Step 5 迁）。
- **Cron**：`CronSchedule` 分段 `setTimeout`（Step 6.1 迁）；`NativeImprovementService` 1h `setInterval`（Step 6 迁）。
- **Dots**：`DotsFileWatches` 30s `setInterval`、`DotsGoogleMonitor` 15s `setInterval`、`DotsDiscovery` 15s `setInterval`、`DotsProactiveDelivery` 5s `setInterval`、`DotsDelegations` observation/dependency/retry/recovery timers（Step 6.2 迁）。
- **Gateway / Remote / Memory / Project / Trash**：Gateway 重连/心跳定时器（Step 6.3）；Remote SSE 20s ping（Step 6.4）；`ProjectCadence` 每项目 1 个 `setTimeout`（Step 6.5）；`MemoryCognitionService` `nextDue` 定时器（Step 4/6）；`index.ts:3423-3424` 6h trash purge 定时器（Step 4 迁 Rust）。
- **平台/UI 代理保留**：`ComputerUseOverlayService` 50ms hit-test、`WindowsComputerUseBackend` / `LinuxComputerUseBackend` 超时保护、`ResidentLifecycle` 退出前清理定时器（Step 9 移除 `--resident-host` 旧 Electron 宿主重启）。

### 3.3 子进程（`spawn` / `fork` / `execFile` / `Worker`）
- **Rust Core**：`core-client.ts` (`--guard-core-database`, `--supervise`)、`runtime-audit.ts`（独立模式）、`core_supervisor.rs`（拉起 worker）。
- **Gadget**：`GadgetRuntime.ts` 拉起 `GadgetHost.ts`（`ELECTRON_RUN_AS_NODE=1`），`gadget-commands.ts` 拉起 `ctx.exec` / `process` 后端（Step 7 收归 Rust Core）。
- **Pi 执行工具与环境**：`pi-durable/dist/env/node.js` (`bash`/`powershell`)、`pi-coding-agent` (`rg`)、`pi-mcp` (`StdioTransport`)、`pi-codemode` (`node:worker_threads` QuickJS)、`pi-durable` (`node:worker_threads` Photon)、`DurableSubagents`/`worktree.ts` (`git`)（Step 8 随 Pi 整体迁入独立 **Pi Node Host**）。
- **外部代理 / 运行时**：`ExternalAgentRuntime.ts`（ACP 进程）、`PythonExecutor.ts` / `UvToolchain.ts` / `LocalWhisperSpeechProvider.ts`、`DotsGoogleAccounts` (`gws` CLI)、`DotsDesktopPreview`（独立预览 Electron）、`CloudflaredCli`（`--version` 探测）。
- **平台能力代理**：`WindowsAutomationHost.ts` (`powershell.exe`)、`atspiClient.ts` + `inputGuardian.ts` (`ELECTRON_RUN_AS_NODE=1`)、`OfficeNativeDesktop.ts`、`cadcraft.ts`、`processes.ts` / `fs-security.ts` / `fonts.ts` / `browsers.ts` / `work-shell-read.ts`。

---

## 4. 行为分类：必须保留 / 已退役 / 明确不在范围

### 4.1 必须保留（Must Keep）
1. **单写者与存储分域语义**：`app.db` 应用域与 Pi `durable.sqlite`（DELETE 模式、独占写锁、checkpoint/submission/document 语义、当前版本 1.5.0、摘要预算单源 `SummaryBudget.ts`）明确分域。
2. **当前格式与无兼容包袱策略**：仅支持当前数据库格式与当前 Pi 版本（`1.5.0`），不恢复旧 schema / 旧 Pi（0.99.x/1.0.x）迁移代码；不兼容 schema 须在活 Core 守卫下显式重建且不误把读失败当旧格式。
3. **Core 请求/生命周期/未知语义**：排队截止时间、独立控制通道（cancel/status/revoke）、持久操作回执（`.runtime-operations`）、`unknown` 不可自动换 ID 重放或静默 Node 回退、不可变二进制升级。
4. **Work / Goal / Cron / Dots / Gateway / Remote / Gadget 现行业务语义**：
   - 前台插话、后台委派、长期 watch、`ConversationGoalService` 与 `GoalContinuationService`、`WorkHostAuthority`、`WorkMemoryCapture`、`work_action_admissions` 事实账本、历史 Bot 只读回看（`HistoricalBotReader`, `repair: false`）。
   - Cron `at/every/cron`、CAS 计划写、Dots `coalesce` 恢复与休眠挂起/恢复。
   - Dots 前台工具、委派与幂等回复投递、文件监听、Google/RSS/Dream 与 24h 通知恢复。
   - Gateway 现有支持渠道（Feishu, WeCom, WeChat MP, Telegram, DingTalk, Discord, QQ, Slack, Weixin iLink）去重/队列/出站回执与 `unknown` 处理。
   - Gadget `generation` / `invocationId` 权限边界、静态 Gadget 与多语言按需后端能力。
5. **平台能力与安全边界**：`safeStorage` / `gnome-libsecret`（拒绝 `basic_text` 保存凭据）、Windows/Linux 桌面自动化与键鼠释放安全边界、Chromium 登录态/浏览器会话。

### 4.2 已退役（Retired — 严禁在迁移中复活）
1. **独立 Bot 模式**（`docs/bot-retirement.md`）：独立 Bot 创建/管理、Bot 前台编排/协作分发、`WorkWatchScheduler` 旧 Bot 定时循环、Bot 定时提醒（`CronService` 已拦截 `bot-reminder`/`snoozeReminder`）、Bot 专属 Google 适配器、`BotWorkspaceNavigation` 主动建空间修复（`repair: true`）。
2. **Work 额度与预算系统**（`docs/work-budget-retirement.md`、`work-budget-retirement.ts`）：`WorkBudgetService`、`work_budget_*` 表、预算窗口投影与预算阻塞。
3. **应用内动作审批环与共享资源隔离**（`docs/work-action-approval-loop.md`、`work-isolation-retirement.ts`）：`WorkActionApprovals`、`WorkAutonomyPolicy`、`WorkResourceGate`、`work_resource_*`、`work_deferred_actions`、工具批准卡片。
4. **外部副作用全局隔离阻塞**（`work-effect-retirement.ts`）：`external_effect` / `unknown_external_effect_ref` 旧阻塞器（统一按“不重放、标记继续”清理）。
5. **Dots 已裁剪流程**（`docs/mybuddy-dots-plan.md`）：Dots 层审批卡、普通产物的独立验收轮、逐文件“已验证”仪式、主动消息外发到外部 IM 渠道。

### 4.3 明确不在范围（Out of Scope）
1. 重写 Pi 内核或其 `durable.sqlite` 原生可写存储进 Rust。
2. 以拆库、更换 SQLite 引擎或引入新桌面/运行框架作为迁移前置条件。
3. 关机、系统休眠期间或（未声明支持的）用户注销跨会话持续执行；仅在已启用常驻的受支持用户会话内验收运行与恢复。
4. 在核心业务路径保留“Core 失败静默回退 Node 写库/执行”的生产双写路径。
