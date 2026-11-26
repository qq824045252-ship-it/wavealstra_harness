# Step 8 执行报告：独立 Pi Node Host（`RC-20`～`RC-22`）

- **步骤 / 场景**：Step 8（拆出独立 `PiNodeHost` 进程、Electron Main `isolated-client` 解耦、`DurableBotService` 与 `canonical_schema.sql` 只读 `app.db` 修复、`RC-20`～`RC-22`）
- **环境**：Windows 11 Pro `10.0.26300` (x64)，Node `v26.13.1`，pnpm `12.14.0`，Rust `1.97.1`，Electron `44.5.1`，Pi 版本 `1.5.0`（动态读取自 `src/main/capabilities/subagent/worker-launcher.mjs` `EXPECTED_PI_VERSION`）。
- **结论**：**`passed`（Windows；Linux / GUI `not-run`）**

---

## 1. 核心变更清单

### 1.1 Rust Core Pi Host 监督与 Generation 围栏
- **[native/runtime-audit/src/pi_host_supervisor.rs](../../../../native/runtime-audit/src/pi_host_supervisor.rs)**：
  - 新增 `core_pi_hosts` 与 `core_pi_host_fences` 持久化表，`Command::{Status, VerifyLease, Launch, Register, Heartbeat, Stop, FenceGeneration}`。
  - Windows 使用 `CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS`（POSIX 使用 `setsid`）+ `ELECTRON_RUN_AS_NODE=1` 拉起独立分离进程；严格校验 `pi_version == expected_pi_version`，同 `storage_root` 已存在存活 owner 时拒收重复注册并围栏旧 generation。
- **[native/runtime-audit/src/main.rs](../../../../native/runtime-audit/src/main.rs)**：注册 `mod pi_host_supervisor;` 与 `Request::CorePiHost`，读写分离路由并在 `runtime-audit.ts` 中标记 `status` / `verifyLease` 为只读操作。
- **[native/runtime-audit/src/business_protocol.rs](../../../../native/runtime-audit/src/business_protocol.rs)**：为 `ExecutionRequest::{ExecutorAck, ExecutorProgress, ExecutorSettled}` 增加可选 `host_generation` 并校验 `verify_host_generation`，拒绝已被围栏的旧 Pi Host 提交（返回 `STALE_HOST_GENERATION`）。
- **[native/runtime-audit/src/canonical_schema.sql](../../../../native/runtime-audit/src/canonical_schema.sql)** & **[native/runtime-audit/src/durable_task_projection.rs](../../../../native/runtime-audit/src/durable_task_projection.rs)**：
  - 修复 `canonical_schema.sql` 中 `durable_bot_bindings` / `durable_bot_memory_projection` / `durable_bot_workspace_moves` / `durable_bot_message_workspaces` 与运行时不一致导致的 `no such column: b.directory` 问题。
  - 在 `durable_task_projection.rs` 与 `DurableTaskProjection.ts` 补齐 `BindBot`、`CommitBranch`、`RebindGatewayDirectory`、`QueueWorkspaceMove`，消除只读 `app.db` 下 `DurableBotService` / `AgentService` 对 `durable_bot_*` 与 `upsertTask` 的直写残留（`attempt to write a readonly database`）。

### 1.2 独立 `PiNodeHost` 运行时与隔离入口
- **[src/main/host/PiNodeHost.ts](../../../../src/main/host/PiNodeHost.ts)** & **[src/main/host/pi-node-host-entry.ts](../../../../src/main/host/pi-node-host-entry.ts)**：
  - 以 `readonly: true` 打开 `AppDatabase`，在独立进程内承载 `ModelRuntime` → `DurableBotService` → `DurableBotRuntime/Harness`、`McpRuntimeService`、`Subagents` 与 `SummaryBudget` 压缩。
  - 唯一持有 `ExecutionHostBridge`（`role: "execution-host"`），附带 `hostGeneration` 回传 Core，向 Core 注册与心跳，被围栏或失主时立即关闭释放 `DurableStorageLease`。
- **[src/main/shims/node-electron-host.ts](../../../../src/main/shims/node-electron-host.ts)**、**[src/main/host/pi-version.ts](../../../../src/main/host/pi-version.ts)**、**[src/main/host/pi-node-host-bundle.ts](../../../../src/main/host/pi-node-host-bundle.ts)**、**[electron.vite.config.ts](../../../../electron.vite.config.ts)**：
  - 提供纯 Node 无界面 Electron 垫片与动态版本校验，从 `worker-launcher.mjs` 与 `@earendil-works/pi-coding-agent/package.json` 读取实时/预期版本，不引入旧 Pi 兼容层。

### 1.3 Electron Main `isolated-client` 解耦与只读快照读取
- **[src/main/agent/AgentService.ts](../../../../src/main/agent/AgentService.ts)** & **[src/main/index.ts](../../../../src/main/index.ts)**：
  - 监督模式下 Electron Main 以 `executionMode: "isolated-client"` 与 `role: "ui"` 连接 Core，不创建 `ModelRuntime` / `DurableBotService`，不持有 Pi 写入租约。
  - 对话历史（`loadTaskHistory`）、提问索引（`listTaskUserQuestions`）、标题头部摘要（`conversationHeadForTitle`）使用 **[DurableReadOnlyHistory.ts](../../../../src/main/agent/durable/DurableReadOnlyHistory.ts)** 导出的无执行只读 `PASSIVE_READONLY_MODELS` + `openRustDurableStorage`，不获取写锁；`prompt`/`abort`/`compactTask`/`regenerate`/`deleteUserMessage`/`listModels` 通过 Core 转发到独立 `PiNodeHost`，UI 事件经 `coreEvent` 实况转发。
  - 仅在 `residentLifecycle.isStopping()` 时显式 `piHost({ action: "stop" })`；UI 正常关闭或 Main 崩溃不终止 Core 与独立 `PiNodeHost`。

---

## 2. 门禁验证证据（全部在末次编辑后实测）

| 检查命令 | 实测结果 | 覆盖范围 |
| --- | --- | --- |
| `$env:RUNTIME_AUDIT_TESTS="1"; node scripts/prepare-runtime-audit.cjs` | **40 passed; 0 failed**（`0` warnings，release 构建通过） | Rust 单测含 `pi_host_registration_fences_stale_generation_and_preserves_version_pin` 与 `durable_bot_*` schema |
| `pnpm typecheck` | **0 errors**（`tsconfig.web.json` + `tsconfig.node.json` + `typecheck-scripts.mjs` 基线 0 新增 0） | 全仓库 TypeScript + 脚本类型校验 |
| `node scripts/test-all.mjs --audit` | **OK**（`headless 525 · GUI 112 · NETWORK 42 · DATASET 17 · ARTIFACT 3 · pending 0`） | `test:pi-node-host` 已注册到 `DATASET_TESTS` 与 `verify-native-contract.mjs` |
| `pnpm run test:pi-node-host` | **PASS（28s）** | `RC-20A`（Main 优雅断开保持 `piHostPid != mainPid` 并完成工具写盘）、`RC-20B`（独立 Main 子进程 `SIGKILL` 后继续完成）、`RC-21`（中断杀 Pi Host、generation fence 阻断旧 `ExecutorSettled` 返回 `STALE_HOST_GENERATION`、同存储恢复原 receipt、幂等外部效果计数 `1`、未知 `unknown` 不盲重放）、`RC-22`（真实 Pi 模型目录、`blockSummaryBudget` 20k/80k 契约、旧版 `0.99.2` 拒绝、无写锁并发 `readDurableReadOnlyHistory`/`readDurableUserQuestions`/`readDurableConversationHead`） |
| `pnpm run test:pi-cache-protocol` | **6 passed; 0 failed** | Pi 1.5.0 cache/tool 声明回归 |
| `pnpm run test:durable-summary-budget` | **PASS** | `SummaryBudget` 字符预算契约 |
| `pnpm run test:durable-task-projection` | **PASS** | Durable 任务投影与 readonly 保护 |
| `pnpm run test:local-workflow` | **PASS** | 启动序、`AgentService`、`ModelRuntime` 与本地工作流端到端 |
| `pnpm run test:all:native` | **22/22 PASS** | 全部原生契约用例命中真实 `mybuddy-runtime-audit.exe` |
