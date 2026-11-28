# DuckDB Core IPC 全局整改阶段总结（2026-11-28）

## 1. 背景与目标

在 Core 托管 DuckDB 模式（`runtimeAuditSupervised: true` / `db.coreIdentity`）下，桌面端与后台服务不应直接打开本地 SQLite（`better-sqlite3` / `db.connection` / 同步 `AppDatabase` 读取），所有生产读写需收口到常驻 Rust Core（`mybuddy-runtime-audit`）领域 IPC 与 DuckDB SQL 语法。

本次整改围绕全局静态与运行时核查展开，同时保持 `:memory:` SQLite 单元测试（`db.fixtureConnection`）的双模兼容性。

---

## 2. 已完成并验证的工作

### 2.1 Rust Core（`native/runtime-audit/`）与二进制产物
- 修复 DuckDB SQL 兼容性与编译告警，并补齐多项领域只读/写入支持（AnswerRouting、BotRegistry、ConversationBranch、Cron、DotsDelegation、DurableTaskProjection、ExternalAgentHistory、ImprovementReview、LibraryMetadata、MemoryRecords、MemoryTurn、UsageHistory、Workspace 等）。
- 实际运行 `cargo test`：**106 passed, 0 failed**。
- 已构建产出 `out/native/win-x64/mybuddy-runtime-audit.exe`（协议版本 121）。

### 2.2 Step 1–5 主进程与各子系统 Core IPC 迁移
- **清理 `.connection` 状态误判陷阱**：修复 14 处 `.connection.(readonly|open|memory)` 检查（统一改用 `AppDatabase` 状态属性与 Core 异步门控）。
- **`AppDatabase` / 基础设施**：补充 `resolveWorkspaceExecutionPathAsync`、`isTaskEffectiveArchivedAsync` 等 Core 异步读接口。
- **Agent / Session / Branch / Improvement / External / Remote**：迁移 `AgentService`（Dots/Cron/Workspace/Gadget 异步接口接入）、`GadgetService`、`SessionExtensionAssembler`、`SessionApprovalBridge`、`LibraryWorkspaceContextService`、`BtwSessionService`、`BotSettingsService`、`ConversationBranchService`、`ImprovementReflection`、`ExternalAgentRuntime`（部分）、`RemoteTaskCommandService` 等。
- **Cron 与 Local Workflow**：`CronService` 新增 `dotsScheduleVisibleAsync` 并支持异步可见性校验；`local-workflow-extension` 改为 await Core 异步调度校验。
- **Durable 与 Gateway**：完成 `DurableWorkspaceMoves`、`DurableBotService`、`DurableDotsWorker`、`GatewayService`、`GatewayRouter` 的 Core 异步路径改造。
- **Dots 子系统**：完成 `DotsFileWatches`、`DotsDesktopPreviewExtension`、`DotsNativeResults`、`DotsLibrary`、`DotsActions` 与 `DotsExtension` 的 Core 异步读/写与审批分支改造（保留同步路径供夹具单测使用）。
- **验证回归用例**：新增 `scripts/dots-send-sqlite-guard.cjs` 与 `scripts/core-dots-routing-turn-cases.ts`，验证 Core 模式下 Dots 桌面发送链路实现 **0 次本地 SQLite 打开**。

---

## 3. 已部分完成（当前处于阶段收口状态）

### Step 6：Memory 子系统改造（进行中，暂未完成全部调用方）
已在 `src/main/memory/` 中完成首批 Core 异步适配与 Rust Core 查询对接：
- 已修改文件：
  - `src/main/memory/AssistantMemoryScopes.ts`（`resolveWorkMemoryScopeAsync`、`resolveAssistantScopeChainAsync`）
  - `src/main/memory/BotMemorySource.ts`（Core 模式下补充守卫）
  - `src/main/memory/MemoryRecordsData.ts`
  - `src/main/memory/MemoryTurnRepository.ts`（`canExtractTaskAsync`、`allExistAsync`、`readUndistilledTurns`）
  - `src/main/memory/MemorySkillDistillation.ts`（避免启动期直接查 SQLite，改用异步提炼批次）
  - `src/main/memory/MemorySkillEffectivenessService.ts`
  - `src/main/memory/MemorySkillRevisionService.ts`
  - `src/main/memory/MemorySkillLearningService.ts`（`listAsync` 当前暂返回内存待处理列表，`skillCandidateList` Core IPC 待后续补齐）
  - `src/main/memory/MemoryService.ts`（`currentDelegationSourceAsync`、`detachAllInScopeAsync`、`canPromoteFromTaskAsync`、`promoteFromTaskAsync`、`inferAgentScopeAsync`、`channelBotIdAsync`、`canMutateFromTaskAsync`、`listSkillCandidatesAsync`、`refreshSkillCandidatesAsync`、`deleteSkillHistoryAsync` 等）
  - `src/main/memory/WorkMemorySnapshotRepair.ts`、`src/main/memory/WorkMemoryCapture.ts`
  - `src/main/memory/MemoryOrganizationService.ts`
  - `src/main/memory/MemoryCognitionService.ts`
  - `src/main/memory/MemorySemanticProvider.ts`
  - `src/main/memory/MemoryGatewayController.ts`
  - `src/main/memory/ExternalCliMemoryBridge.ts`
- 为保证当前仓库可干净编译通过，已补齐 interrupted 状态的 6 处 TypeScript 编译错误（`index.ts` await、`MemoryCognitionService`、`MemoryOrganizationService`、`MemoryService`、`MemoryTurnRepository` / `MemorySkillDistillation`、`MemorySkillLearningService`）。

---

## 4. 尚未完成的后续规划

1. **Step 6 收尾（Memory 全链路收口与单测）**
   - `MemoryRepository.ts`：`insert`/`supersede`/`addScope`/`reapStalePendingCandidates` 内部仅在 `db.fixtureConnection` 时访问 `this.conn`。
   - `MemoryOrganizationService.ts`：补全 Core 模式 `applyAsync` / `undoAsync` / `dismissAsync` 与运行态检查。
   - `MemoryService.ts`：`createCoreMemory`、`createFromTaskAsync`、`updateFromTaskAsync`、Core 模式 `extractAndStore`、`allowsPersonalBotBaselineAsync`、`resolveScopeChainAsync`。
   - `MemoryGatewayService.ts` 与 `MemoryGatewayServer.ts`：全量读写改用 `*Async`。
   - `memory-extension.ts`、`EphemeralContextProjection.ts:186`、`AgentService.ts`（`dotsMemoryReferenceCurrentAsync` / `runtimeBotIdAsync` / `inspectRuntimeContext` / `kernelSkill*` / `memoryOrganization*`）、`DotsActions.ts`（3 处 `dotsMemoryReferenceCurrent`）、`src/main/index.ts`（`createGrantAsync` / `updateGrantAsync` / `detachAllInScopeAsync`）、以及 Rust Core `skillCandidateList` IPC。
   - 验证：`pnpm run test:memory` 与 `pnpm run test:memory-correctness`。

2. **Step 7（Library / Project / Workspace 子系统）**
   - 迁移 `WorkspaceLibraryBindingService`、`WorkspaceLibraryBindingView`、`WorkspaceNotesService`、`WorkspaceSharedContextService`、`ProjectNotesService`、`ProjectFolderRelocation`、`ProjectService`（`deleteAsync`）、`MaterialRetrievalSettings`、`LibraryTextSaves`、`library-ownership`、`library-task-scope`、`LibraryIndexMaintenance`、`LibraryService`。

3. **Step 8（其余生产域）**
   - 检查并迁移 `BlueprintInstanceWrite`（`db.inTransaction`）、`ExternalAgentRuntime`（DDL 与读写全量收口 Core）、`AnswerRoutingService`（构造期 SQLite DDL 守卫）、`TaskExpertBindingService`、`WorkGraphService` / `WorkGraphRepository` / `WorkGraphIntegrity`、`AgentLoadoutObservationService`、`ArchivedContentDeletion`、`TaskExecutionWorkspaceLifecycle`、`BotSettingsService`、`BotWorkspaceNavigationService`、`HistoricalBotReader`、`WorkContinuationWorkspace`、`NativeImprovementService`、`PiNodeHost`。

4. **Step 9（全局防回退门禁与全量验收）**
   - 新增静态审计测试 `scripts/core-sqlite-guard-test.ts`（检查 `src/main/` 未受保护的 `.connection` 与 `native/runtime-audit/src/` DuckDB SQL 语法卫生）。
   - 新增运行时集成测试 `scripts/core-global-domain-ipc-test.ts`（挂 `dots-send-sqlite-guard.cjs` 启动真实 DuckDB Rust Core 验证多域 IPC 与 0 SQLite 打开）。
   - 注册到 `package.json` 与 `scripts/test-all.mjs` headless 桶，完成 `pnpm run test:all` 全量验收。

---

## 5. 当前验证状态（如实记录）

| 检查项 | 状态 | 备注 |
| --- | --- | --- |
| `cargo test` (`native/runtime-audit`) | 通过（106/106） | Step 1–5 期间完成并产出 `mybuddy-runtime-audit.exe`；其后未改 Rust 源码 |
| `pnpm run typecheck` | 已复验通过 | 本次阶段收口修复 6 处 TS 错误后最新验证通过 |
| `pnpm run test:core-dots-desktop-send` | 通过（Step 5 时） | Step 6 部分改动后未重跑 |
| `pnpm run test:memory` / `test:memory-correctness` | 未运行 | 需先完成 Step 6 收尾 |
| `pnpm run test:all` | 未运行 | 需先完成 Step 6–9 |
