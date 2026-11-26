# MyBuddy Rust Core 整改与本机 Acceptance 报告（`main@1413d720`）

> 生成日期：2026-11-26（北京时间）  
> 基线提交：`1413d72087a64f75e2d137046f014476b06c0f7a`（当前分支 `main` + 未提交 Wave 1–4 整改工作区）  
> 性质：按整改方案 §4.5 交付清单出具的可复核工程验收报告；严格区分「本机实测通过」「既有基线失败」「受限 / 未执行（`not-run` / `blocked`）」。

---

## 1. 固定候选与环境指纹

| 项 | 实测值 | 来源 |
| --- | --- | --- |
| Git 基线 SHA | `1413d72087a64f75e2d137046f014476b06c0f7a`（未执行 commit/push） | `git log -n 1` / `git status -s` |
| 主机 OS / Arch | `win32 / x64`（Windows 11 x64） | 本机执行环境 |
| Node / pnpm | `v26.13.1` / `12.14.0` | 运行时输出 |
| Rust / Cargo | `rustc 1.97.1` / `cargo 1.97.1` | `$env:RUNTIME_AUDIT_TESTS="1"; node scripts/prepare-runtime-audit.cjs` |
| 原生 worker 二进制 | `out/native/win-x64/mybuddy-runtime-audit.exe` | 0 Cargo 警告；Rust 单测 `50 passed; 0 failed` |
| 二进制 SHA-256 | `b7e08ab98bb0aedc553962e0a48008501e778e9a374508437582a3715e88a18e` | `prepare-runtime-audit.cjs` |
| Core 协议版本 | `89` | `mybuddy-runtime-audit --protocol-version` |
| `EXPECTED_PI_VERSION` | `1.5.0` | `src/main/capabilities/subagent/worker-launcher.mjs` |

---

## 2. 进程 / 职责与数据所有权清单

| 角色 | 权威拥有数据 / 能力 | 运行时访问边界 | 关键源码定位 |
| --- | --- | --- | --- |
| **Electron Renderer** | 页面 UI、交互状态、局部展示缓存 | 仅通过 Electron IPC 与 Main 通信；断连/重开后从 `UiReconnectController` 拉权威快照并增量重放（严格按 `(coreGeneration, seq)` 与 `(entity, revision)` 去重），UI 缓存不作权威真源 | [UiReconnectController.ts](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/src/main/host/UiReconnectController.ts) |
| **薄 Electron Main** | 窗口、托盘、系统对话框、Chromium `BrowserWindow`/`WebContentsView`/`session`、桌面输入/无障碍代理、`PlatformCapabilityProxy` | 生产监督模式下由 `resolveMainRolePolicy(true)` 约束为 `"supervised-ui"`（`ownsBackgroundMaintenance/ProjectCadence/TrashPurgeTimer/LibraryBackgroundRecovery/DotsAndCronLoops/SnapshotCompaction` 全为 `false`）；`MainTimerRegistry` 可核对后台定时器数为 0；只读打开 `app.db`；不拥有第二个 `ModelRuntime` | [MainRolePolicy.ts](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/src/main/host/MainRolePolicy.ts), [PlatformCapabilityProxy.ts](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/src/main/host/PlatformCapabilityProxy.ts), [index.ts](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/src/main/index.ts) |
| **Rust Core（supervisor + worker）** | `app.db` 唯一受控写权、事件日志与快照、Work/Cron/Dots/Gateway/Remote/Maintenance/PiHost/Gadget 调度与租约、Gadget 静态 HTTP 多路径隔离宿主、语义索引/维护池 | 多线程模型（Dedicated Writer + `write_gate`、`ReadPool(4)`、`WorkspaceIoPool(2)`、`ORT(intra=2, inter=1)`、`GadgetHttpHost` 分 `GadgetAppKey` `RwLock` 池、控制通道与高优先前端调度）；UI 关闭后常驻继续 | [main.rs](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/native/runtime-audit/src/main.rs), [maintenance_scheduler.rs](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/native/runtime-audit/src/maintenance_scheduler.rs), [gadget_http_host.rs](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/native/runtime-audit/src/gadget_http_host.rs) |
| **独立 Pi Node Host** | `ModelRuntime`、`DurableBotService`、Pi 原生会话/checkpoint 存储唯一 owner、`SummaryBudget`、MCP/扩展与工具编排、`DotsActions`/`DotsReporting`/`DotsProactiveDelivery`/`DotsDiscovery`/`DotsGoogleMonitor`、`ArtifactDomain`、`GadgetService`、`CronService`、后台维护执行 | 独立 `ELECTRON_RUN_AS_NODE=1` 子进程（通过 `node-electron-host.ts` shim），只读打开 `app.db`；显式向 Core 注册 `declaredCapabilities`、维护代次心跳（旧 generation 被 fencing）；通过 `ExecutionHostBridge` 消费分派并汇报 `executorAck`/`executorProgress`/`executorSettled` | [PiNodeHost.ts](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/src/main/host/PiNodeHost.ts), [ExecutionHostBridge.ts](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/src/main/host/ExecutionHostBridge.ts), [HostCapabilities.ts](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/src/main/host/HostCapabilities.ts) |

---

## 3. Tool / IPC / Execution Kind 能力与 Handler 对照表

### 3.1 Execution Kind 与 Host Capability 清单（[HostCapabilities.ts](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/src/main/host/HostCapabilities.ts) / [PiNodeHost.ts](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/src/main/host/PiNodeHost.ts)）

| Execution Kind | Capability Flag | 注册与实际 Handler | 反向 / 缺失保护 |
| --- | --- | --- | --- |
| `pi_turn` | `piCore`（默认开） | `PiNodeHost.runPiTurnDispatch` → `AgentService.prompt` / `findSubmission` / `waitForSubmission` + `ephemeral` delta / 持久 receipt | `AgentService` 未拥有写库 fallback，写经 Core |
| `pi_compact` | `piCore` | `PiNodeHost` → `AgentService.compactTask(taskId)`（基于唯一 `SummaryBudget`） | 失败返回 `status: "failed"` |
| `pi_control` | `piCore` | `PiNodeHost.runPiControlDispatch`：支持 `abort`、`regenerate`、`deleteUserMessage`、`findSubmission`、`submissionStatus`、`newDotsConversation`、`openDots`、`generateTaskTitle`、`listModels`、`reloadModels`、`listLoginProviders`、`setProviderEnabled`、`listCredentials`、`login`、`logout`、`authRespond`、`authCancel`、`generateDotsReport`、`generateDotsDream` | 未知 action 显式返回 `status: "failed"`（`Unsupported Pi control action`）；Main 不再拥有第二 `ModelRuntime` |
| `bot_turn` / `work_turn` / `work` / `turn` | `piCore` | `createDurableBotExecutionRunner` → `AgentService.prompt` (`durableAdmissionOnly: true`) + `waitForSubmission` | 支持 `ExecutionHostBridge` 取消、暂停与重连后对账 |
| `cron` / `cron_turn` | `cron`（工作流已接） | `PiNodeHost` + `CronService`（Core 拥有全部定时器，Host 不调用 `cronService.start()`） | 缺失 `submitCron` 不假完成 |
| `dots_control` | `dotsControl` | `PiNodeHost` → `runDotsControlCycle`（`google` / `discovery` / `proactive` / `file_watch` / `watches`，各监视器均带 `{ coreControlled: true }`） | Core 调度按 `capabilities` 过滤；未注册 handler 时 `ExecutionHostBridge` 拒绝完成（`P0-02`） |
| `gateway_control` | `gatewayControl` | 可选注入 `options.runGatewayControlCycle(cycle, channelId, extra)` | 未注入则 `declaredCapabilities` 不包含 `gateway_control`，Core 跳过派发给该 Host 并诚实等待或报缺；强制注入无 handler 时返回失败而非 `completed` |
| `maintenance_control` | `maintenanceControl` | `PiNodeHost.runMaintenanceControlDispatch`：`library_maintenance`（恢复删/还/抽取/FTS/chunks）、`project_cadence`（提案与阻塞风险通知）、`trash_purge`（保留对齐与过期清理 + `WorkGraphService.cleanupByNodeAsync`）、`snapshot_compaction` | 缺相应域服务显式返回 `failed`（`CAPABILITY_UNAVAILABLE`） |

### 3.2 跨进程控制面与工具域桥接

| 通道 / 域 | 路径 | 用途与已验证证据 |
| --- | --- | --- |
| **Model Control IPC** | Renderer → Main (`index.ts`) → Core `dispatchExecution(kind: "pi_control")` → `PiNodeHost.runPiControlDispatch` | 登录/取消交互、`listModels`/`reloadModels`、`setProviderEnabled` 等路由到唯一 Pi runtime（T05 通过） |
| **Platform Capability RPC** | `PiNodeHost` (`PlatformRpcClient.invoke`) → Core Relay → Main (`PlatformCapabilityProxy`) → Renderer / Browser / Desktop | Core 实时跟踪 `uiOnline`/`browserAvailable`/`computerAvailable`；Main 离线时返回 `waiting_platform`，执行中取消触发 `AbortSignal` 释放（T06 通过） |
| **Artifacts & Gadgets 工具链** | Pi 工具 (`AgentService`) → `ArtifactDomainSetup` (`dataDirectory/artifacts`) + `GadgetService` (`GadgetStorage`/`GadgetRuntime`) → Core SQLite & `GadgetHttpHost` | Pi 生成文本/Office/Gadget 产物写入真实文件系统并通过 Core 事务关联 `artifactId` 与消息，静态 Gadget 由 Core HTTP 多路径隔离托管（T04、T18、T19 通过） |

---

## 4. 三条基础契约的新增模块覆盖结果

1. **契约一：统一写分类与专用单写者入口（`classify_request` → `database-writer` + `write_gate`）**
   - 覆盖范围：`main.rs` 统一写入/副作用分类、专用 `database-writer` 与 [`write_gate.rs`](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/native/runtime-audit/src/write_gate.rs)；涵盖新增域 `pi_host_supervisor`（`CorePiHost`）、`gadget_state`/`gadget_http_host`（`CoreGadgetHost`）、`maintenance_scheduler`、`work_scheduler`、`dots_scheduler`、`cron_scheduler`、`gateway_scheduler`、`remote_control`。
   - 外部 `BEGIN IMMEDIATE` 锁争用与并发注册/心跳/调度写实测全通过（T07、`test:rust-writer-boundary`、`test:runtime-audit-lifecycle`）。
2. **契约二：取消 / 截止时间与提交线性化（`request_control::commit` + 副作用外置事务）**
   - 代码核查 9 个控制/调度模块均接入 `request_control::commit`：[`business_protocol.rs`](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/native/runtime-audit/src/business_protocol.rs)、[`cron_scheduler.rs`](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/native/runtime-audit/src/cron_scheduler.rs)、[`dots_scheduler.rs`](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/native/runtime-audit/src/dots_scheduler.rs)、[`gateway_scheduler.rs`](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/native/runtime-audit/src/gateway_scheduler.rs)、[`maintenance_scheduler.rs`](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/native/runtime-audit/src/maintenance_scheduler.rs)、[`pi_host_supervisor.rs`](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/native/runtime-audit/src/pi_host_supervisor.rs)、[`remote_control.rs`](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/native/runtime-audit/src/remote_control.rs)、`work_host_lease.rs`、[`work_scheduler.rs`](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/native/runtime-audit/src/work_scheduler.rs)。
   - `PiHostSupervisor` `Launch`/`Stop` 已将 OS `spawn`/`kill` 移出 DB 写事务外执行，提交阶段失败安全回滚进程或代次；入队前/排队中/运行中/提交前后取消严格线性化（T08、`pi_host_supervisor` Rust 单测通过）。
3. **契约三：跨客户端一致超时与 `unknown` / 幂等查询语义（`P1-09`）**
   - `CoreBusinessClient` 断连或未确认写超时时不再吞错或静默换 `requestId` 重放，而是抛出携带原 `requestId` 的 [`RuntimeAuditUnknownOperationError`](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/src/main/platform/core-business-client.ts)，并可通过 `queryOperation(requestId)` 查询持久结构化回执（T09、T20/`P1-09` 通过）。

---

## 5. P0 / P1 关闭台账与 T01–T24 场景矩阵

### 5.1 P0 / P1 问题逐项关闭记录

| 编号 | 问题摘要 | 关闭波次 | 对应验收场景 | 状态 |
| --- | --- | --- | --- | --- |
| `P0-01` | `PiNodeHost` 缺 Dots/Artifact/Gadget/工作流注入 | Wave 2 | T01, T02, T04 | **closed** |
| `P0-02` | `ExecutionHostBridge` 缺控制回调假完成 + capability 过滤 | Wave 2 | T01, T03 | **closed** |
| `P0-03` | 模型控制路由 Main 不存在 runtime + Platform RPC 闭环 | Wave 2 | T05, T06 | **closed** |
| `P0-04` | CorePiHost/Gadget 漏分类、7+ 模块未接 `request_control`、事务内 spawn | Wave 1 | T07, T08, T09 | **closed** |
| `P0-05` | 断线重连/代次 fencing/无人值守自动恢复 | Wave 2 | T09, T10, T21 | **closed** |
| `P0-06` | 测试夹具代写/吞错/常量队列/弱断言/单进程 RSS | Wave 1+2 | G0, T04, T11, T18 | **closed** |
| `P1-01` | `RuntimeAuditReader` 默认共用单在途 `database` lane | Wave 3 | T13, T20 | **closed** |
| `P1-02` | Rust 同步短读阻塞 / 有界池隔离 | Wave 3 | T13, T19 | **closed** |
| `P1-03` | `write_gate` / 调度长持锁与公平性 | Wave 3 | T14, T20 | **closed** |
| `P1-04` | `promote_compatible_executions` `LIMIT 128` 队头阻塞 | Wave 3 | T15 | **closed** |
| `P1-05` | 流式 `executorProgress` 逐条写库事务 | Wave 3 | T16, T17 | **closed** |
| `P1-06` | `UiReconnectController` 光标顺序与权威快照水合 | Wave 2 | T11, T17 | **closed** |
| `P1-07` | Main 后台定时器与角色策略收薄 | Wave 3 | T12 | **closed** |
| `P1-08` | `gadget_http_host` 全局 Store 锁与 `sync_all` | Wave 3 | T18 | **closed** |
| `P1-09` | `CoreBusinessClient` 超时 / unknown 与 `queryOperation` 一致语义 | Wave 3 | T08, T09, T20 | **closed** |

### 5.2 T01–T24 与 6 项反向证明覆盖情况

- **T01–T11**（真实装配、Dots 委派、控制周期、真实文本/Office/Gadget 产物闭环、模型控制、Platform RPC 在线/离线/取消释放、写入所有权、取消线性化、持久回执、无人值守 Core/Pi 故障自恢复、UI 重开权威水合）：全部在 `test:wave2-capabilities-recovery`、`test:thin-main`、`test:core-production-lifecycle`、`test:pi-node-host` **实测 PASS**。
- **T12–T20**（Thin Main 离线维护、`RuntimeAuditReader` 单连接 4 路重叠、`conflict:*` 串行与可见等待、第 130 个独立任务 `69.4ms`/`81.1ms` 绕过 128 窗口、`0` SQLite `text_delta` + `n=30` control `p95=1.87ms`/`1.58ms`、慢消费端暂停恢复 `8/8`、`gadget-slow` `377.1ms` 下 fast max `26.6ms`、`ReadPool(4)/WorkspaceIoPool(2)/ORT(2,1)` + `503->200` 自愈、`256` 队列拒收 + 前台优先 + `RuntimeAuditUnknownOperationError`）：全部在 `test:wave3-thin-main-concurrency`（普通及 `--native`）**实测 PASS**。
- **T21–T22**（只读库、`SQLITE_BUSY`、损坏字节不误删、Core `SIGKILL` 后 `integrity_check === ok`；Node 孙子进程树 `633.9ms` 与 Python `18.3ms` 真实关闭释放端口/FD + 缺失运行时显式 `blocked/RUNTIME_ENVIRONMENT_MISSING`）：全部在 `test:wave4-data-process`（普通及 `--native`）**实测 PASS**。
- **6 项 §3.4 反向证明**：全部嵌入并在相应 `--native` 套件实测验证有效（禁用写工具 T04 败、缺 `dots_control` T03 等待/拒收、关自动恢复 T10 败、Gadget 启动失败 503 不混入成功延迟、丢终态触发快照/事件检测、单在途下 T13 重叠=1）。
- **T23（≥8h 连续常驻）**：**`not-run`**（需独立挂机窗口）。
- **T24（双候选指纹交接与真实发行包启动）**：**`not-run`**（遵守 `AGENTS.md` 开发期规则，未执行 `pnpm build` / `pack:*`）。

---

## 6. 全量验证实测结果与失败透明分类

### 6.1 本机 Windows 11 x64（最终二进制 `b7e08ab9...` 上实测全通过项）

| 命令 | 结果 | 关键观测摘要 |
| --- | --- | --- |
| `$env:RUNTIME_AUDIT_TESTS="1"; node scripts/prepare-runtime-audit.cjs` | **PASS** | Cargo **0 警告**；Rust 单测 **`50 passed; 0 failed`**；`--protocol-version` == `89` |
| `node scripts/test-all.mjs --audit` | **PASS** | `headless 525 · GUI 112 · NETWORK 42 · DATASET 22 · ARTIFACT 3 · pending 0`（Windows 默认 523，跳过 2 项 Linux 限定） |
| `pnpm run typecheck` | **PASS** | `tsconfig.web.json`、`tsconfig.node.json`、`scripts/typecheck-scripts.mjs` 0 错误 |
| `pnpm run test:all:native` | **PASS (`27/27`)** | 全部 27 个原生业务用例命中真实 `mybuddy-runtime-audit.exe` 通过 |
| `pnpm run test:wave2-capabilities-recovery` | **PASS** | 单独与 `--native` 均通过（T01–T06, T10–T11, P0-01..06, P1-06） |
| `pnpm run test:wave3-thin-main-concurrency` | **PASS** | 单独与 `--native` 均通过（T12–T20, P1-01..05, P1-07..09） |
| `pnpm run test:wave4-data-process` | **PASS** | 单独与 `--native` 均通过（T21–T22） |
| `pnpm run test:runtime-audit-transport` / `backpressure` / `lifecycle` | **PASS** | 传输、Windows 回环背压、锁争用与过载取消生命周期全通过 |
| `pnpm run test:db-schema-discard` / `pi-native-control` / `durable-storage-current` / `durable-storage-lease` | **PASS** | schema 丢弃契约（8 项）、Pi 1.5.0 控制（15 项）、durable 当前存储（7 项）与租约全通过 |
| `pnpm run perf:rust-core` | **PASS (`5/5`)** | `coldBootMs=113.87`，`recoveryMs=20.28`；`writeTaskRecord` p95=`3.83ms`；`controlAck` p95=`0.51ms`；`heavyWriteMixedWithLightSnapshot` p95=`4.42ms` (`queueDepthMax=2`)；`staticGadgetScaling(20apps)` p95=`11.31ms`；`ui20ReopenAndReclaimCycles` p95=`31.97ms` |
| `pnpm run bench:rust-core-concurrency` | **PASS** | 6 组工作负载 `C=1/2/4/8` 全部 `failures=0` / `controlFailures=0`，见 §7 |

### 6.2 `pnpm run test:all`（固定候选完整 headless 回归，523 项）

- **实测结果**：耗时 `13.5 min`，**`通过 471 · 失败 52 · 已知失败 0 · 新增回归 49 · 执行失败 3 · 超时 3`**（`scripts/test-baseline.json` 中 `knownFailing: []` 未改）。
- **逐类对比 Step 1 冻结基线（[`docs/reviews/rust-backend/2026-11-25-046e33ef/baseline-tests.md`](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/docs/reviews/rust-backend/2026-11-25-046e33ef/baseline-tests.md)：`473 PASS / 50 FAIL`）**：
  1. **50 项与 Step 1 基线失败完全重合**：
     - Node v26 `stripTypeScriptTypes(..., { mode: 'transform' })` 报错（24 项，如 `pstack-*`、`deepseek-*`、`gateway-binding-slack-identity`、`notification-activation`、`dots-profile` 等）；
     - `.tsx` (`shared/src/icons.tsx`) 被 Node ESM 直接加载失败（8 项，如 `app-permission-ui-removal`、`message-html-ui`、`work-file-card-ui` 等）；
     - `test:architecture-graph`、`test:architecture`（2 项，既有 `Pstack` 3 文件运行期环及历史大文件行数棘轮，如 `AppDatabase.ts`、`AgentService.ts`、`index.ts`、`LibraryService.ts`、`MemoryService.ts`、`remoteStore.ts`）；
     - DOM/SSR 环境缺失（2 项：`test:bot-workspace-navigation-ui`、`test:sidebar-pinned`）；
     - 既有行为/源码断言基线失败（13 项：`test:app-store-structure`、`test:dots-delivery`、`test:dots-followup`、`test:durable-context-entrypoints`、`test:durable-workspace-binding`、`test:gateway-conversation`、`test:memory-correctness`、`test:professional-tools`、`test:project-task-defaults`、`test:prompt-enhance`、`test:runtime-orchestrator`、`test:visual-polish-ux`、`test:workspace-navigation-ux`）；
     - 既有 300s 超时（1 项：`test:dots-reply-recovery`）。
  2. **2 项 4 并发争用超时，已单独复验通过**：
     - `test:dots-actions` 在 `test:all` 4 并发下超过 300s 超时；单独执行 **`PASS`**（耗时 **`275s`**，exit `0`）。
     - `test:local-workflow` 在 `test:all` 4 并发下超过 300s 超时；单独执行 **`PASS`**（耗时 **`276s`**，exit `0`）。

### 6.3 受限 / 未执行项（`not-run` / `blocked`）

| 范围 | 状态 | 原因 / 前置条件 |
| --- | --- | --- |
| Electron 构建与真发行包验收（`pnpm build` / `pack:win` / `pack:linux` / `verify:packaged` / `test:all:artifacts` / T24） | **`not-run`** | 遵守 `AGENTS.md`：未获明确发布指令不执行 build/打包 |
| Windows Electron GUI 桌面套件（`pnpm run test:all:gui`，112 项） | **`not-run`** | 留待发布前真实桌面候选验收 |
| Linux 原生与 Hyprland/AT-SPI 实机门禁（`test:atspi-transport`、`test:input-guardian-process`、`test:computer-use-linux*`、`test:all:native(linux)`） | **`blocked / not-run`** | 当前主机为 Windows 11 x64，无 Linux + Wayland/Hyprland/libsecret 会话 |
| 真实付费模型 40 题盲测第一关（§3.6 / G7） | **`not-run`** | 需真实在线模型凭据与消耗付费额度授权 |
| 同一候选 ≥8h 连续常驻实测（T23） | **`not-run`** | 需独立长时间挂机窗口 |

---

## 7. 同机同工作集 `1 / 2 / 4 / 8` 并发压测分析与推荐上限

数据来源：[`concurrency-benchmark-results.json`](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/docs/reviews/rust-backend/2026-11-26-1413d720/concurrency-benchmark-results.json)（`generatedAt: 2026-11-26T08:16:30.523Z`，Windows 11 x64 / Node `v26.13.1` / `coreSha256: b7e08ab9...`，全表 `failures = 0`、`controlFailures = 0`）。

### 7.1 六类工作负载实测汇总

| 负载 | C=1 | C=2 | C=4 | C=8 | 观测瓶颈 / 结论 |
| --- | --- | --- | --- | --- | --- |
| **W1 独立固定延迟执行**（`N=16`） | `2294.49ms` (`6.97/s`, overlap=1) | `1282.85ms` (`12.47/s`, `S=1.79`, `E=0.89`, overlap=2) | `697.36ms` (`22.94/s`, `S=3.29`, `E=0.82`, overlap=4) | `544.89ms` (`29.36/s`, `S=4.21`, `E=0.53`, overlap=8) | 满足 `T(4) < T(1)` 且 C=4 `overlap=4`；C=8 `meanSubmitIpcMs` 从 `36.78ms` 升至 `113.95ms`，并行效率跌至 `0.53` |
| **W2 数据库混合读写**（`n=100`） | `146.04ms` (`684.73/s`, p95=`0.96ms`, max=`12.54ms`, inFlight=1, readPool=1) | `136.59ms` (`732.12/s`, `S=1.07`, p95=`0.53ms`, max=`1.21ms`, readPool=2) | `150.72ms` (`663.49/s`, `S=0.97`, p95=`0.64ms`, max=`1.02ms`, readPool=4) | `157.71ms` (`634.09/s`, `S=0.93`, p95=`1.34ms`, max=`1.58ms`, readPool=4) | SQLite WAL 单写者提交构成本质 Amdahl 瓶颈；`ReadPool(4)` 将读尾延迟稳定压在 `~1ms`，但 C=8 无吞吐增益反而升高排队 |
| **W3 冲突 + 独立混跑**（4 冲突 + 12 独立） | `1975.27ms` (`8.10/s`, overlap=1) | `1127.42ms` (`14.19/s`, `S=1.75`, `E=0.88`, overlap=2) | `609.05ms` (`26.27/s`, `S=3.24`, `E=0.81`, overlap=4) | `591.52ms` (`27.05/s`, `S=3.34`, `E=0.42`, overlap=8) | 4 个冲突任务天然串行形成 `~550ms` 临界路径下界；从 C=4 到 C=8 仅快 `2.9%`，效率从 `0.81` 跌到 `0.42` |
| **W4 多路流压力 + 控制响应**（`n=100`） | 1 流 `wall=63.31ms`; ctrl p50=`0.27ms` p95=`0.60ms` max=`1.21ms` | 2 流 `wall=83.42ms`; ctrl p50=`0.28ms` p95=`0.49ms` max=`0.75ms` | 4 流 `wall=170.39ms`; ctrl p50=`0.35ms` p95=`0.53ms` max=`0.69ms` | 8 流 `wall=218.05ms`; ctrl p50=`0.23ms` p95=`0.38ms` max=`0.69ms` | 全档位 durable 事件 `3/6/12/24` 100% 送达、`ephemeralDroppedDelta=0`、控制响应 `p95 ≤ 0.60ms`（远低于 `15ms` 预算） |
| **W5 Gadget HTTP 并发**（`n=100`） | `678.27ms` (`147.43/s`, p95=`9.36ms`, max=`35.00ms`) | `324.66ms` (`308.02/s`, `S=2.09`, p95=`9.05ms`, max=`11.24ms`) | `204.32ms` (`489.43/s`, `S=3.32`, p95=`11.99ms`, max=`15.45ms`) | `159.42ms` (`627.28/s`, `S=4.25`, `E=0.53`, p95=`15.25ms`, max=`20.61ms`) | 分 `GadgetAppKey` `RwLock` 解除全局互锁；C=8 p95/p99 尾延迟明显抬升（`9.05 -> 15.25ms`） |
| **W6 工作区扫描 + ORT + 控制**（`n=16`/`n=100`） | `33.37ms`, scan p95=`4.76ms`, ctrl p95=`0.86ms`, ioActive=1 | `31.14ms` (`S=1.07`), scan p95=`3.41ms`, ctrl p95=`0.58ms`, ioActive=2 | `16.55ms` (`S=2.02`, `E=0.50`), scan p95=`2.29ms`, ctrl p95=`0.34ms`, ioActive=2 | `13.67ms` (`S=2.44`, `E=0.31`), scan p95=`4.01ms`, ctrl p95=`0.35ms`, ioActive=2 | `WorkspaceIoPool=2` 与 `ORT=(inter=1, intra=2)` 将控制延迟稳定锁在 `p95 ≤ 0.86ms` |

### 7.2 分进程内存分布（Windows WorkingSet64 / PrivateMemorySize64）

> 注意：下表将测试驱动（Node `driver`）与被测后台（`coreSupervisor`、`coreWorker`）分列，**未把测试驱动内存当成 Rust Core 内存**；总计栏标注了各进程 `WorkingSet64` 求和存在共享 OS 页重复计数的测量边界。

| 场景采样点 | Node 驱动 (`driver`) WS / Priv / Threads | Core 监督器 (`coreSupervisor`) WS / Priv / Threads | Core Worker (`coreWorker`) WS / Priv / Threads | 合计 WS / Priv（含共享页） |
| --- | --- | --- | --- | --- |
| **W1 (`C=1 -> C=8`)** | `77.3–80.2 MiB` / `87.6–89.6 MiB` / `17–18` | `6.8–6.9 MiB` / `1.3–1.4 MiB` / `10` | `19.9–24.1 MiB` / `13.7–17.7 MiB` / `10–11` | `104.8–108.8 MiB` / `102.8–106.7 MiB` |
| **W2 (`C=1 -> C=8`)** | `78.3–78.9 MiB` / `87.5–88.7 MiB` / `18` | `6.8 MiB` / `1.3 MiB` / `10` | `16.1–16.6 MiB` / `10.0–10.5 MiB` / `10` | `101.6–101.9 MiB` / `99.3–100.1 MiB` |
| **W5 (`C=1 -> C=8`)** | `87.7–108.4 MiB` / `93.0–115.9 MiB` / `18` | `6.7 MiB` / `1.2 MiB` / `8` | `12.7–13.3 MiB` / `5.6–6.3 MiB` / `15` | `107.1–128.4 MiB` / `99.8–122.9 MiB` |
| **W6 (`C=1 -> C=8`)** | `109.7–110.1 MiB` / `115.9–116.2 MiB` / `18` | `6.8–6.9 MiB` / `1.3–1.4 MiB` / `9` | `10.6–14.0 MiB` / `4.6–8.0 MiB` / `7` | `127.1–131.0 MiB` / `121.8–125.6 MiB` |

### 7.3 推荐生产并发上限

- **`executionSlotsLimit = 4`**：W1 与 W3 在 `C=4` 达成 `S(4)=3.29` / `3.24`（`E > 0.80`），而扩到 `C=8` 后 W3（受冲突路径约束）几无提速（`609.05ms -> 591.52ms`）且 W1 提交 IPC 均值由 `36.78ms` 涨至 `113.95ms`。
- **`readPoolWorkers = 4`**：W2 中读延迟在 `ReadPool(4)` 下压在 `p95 ≤ 0.64ms`（`C=4`），更高并发只增加调度排队而不突破 SQLite WAL 单写门上限。
- **`workspaceIoWorkers = 2`**：W6 在 2 线程下将 16 并发工作区扫描从 `33.37ms` 降到 `16.55ms` (`C=4`) 且保持 `coreWorker` 常驻仅 `~11–14 MiB`。
- **`ortIntraThreads = 2`, `ortInterThreads = 1`**：限制 ONNX Runtime 内部线程池爆发，避免与 Tokio-free `std::thread` 池争抢物理核，确保并发期间控制通道 `p95 < 1ms`。

---

## 8. 诚实 G0–G8 硬性出口矩阵与能力边界声明

| 门槛 | 当前判定 | 事实依据 / 剩余缺口 |
| --- | --- | --- |
| **G0 证据可信** | **PASS（本机 dev 候选）** | 消除代写成果、静默吞错、常量队列与单测 RSS 失真；`test:all:native` `27/27` 命中真实 worker；`benchmark` 分进程采集与全失败计数完整公开 |
| **G1 所有权** | **PASS（本机 dev 候选）** | `app.db` 写权集中 Rust `database-writer` + `write_gate`；Pi 原生存储由独立 `PiNodeHost` 唯一持有；`resolveMainRolePolicy(true)` 下 Main 只读 `app.db` 且 0 后台维护定时器 |
| **G2 能力完整** | **PASS（隔离 host / 本地能力）** | Dots 委派与 `coreControlled` 周期、文本/Office/Gadget 产物闭环、Model Control IPC、`PlatformCapabilityProxy ↔ Core ↔ PlatformRpcClient` 均已实测打通 |
| **G3 状态可靠** | **PASS（本机 dev 候选）** | 9 个核心模块统一接入 `request_control::commit`；`Launch`/`Stop` 外置 OS 操作；`RuntimeAuditUnknownOperationError` + `queryOperation(requestId)` 在 T08/T09/T20 验证 |
| **G4 生命周期** | **PASS（本机 dev 候选，缺 ≥8h 常驻）** | UI 关闭后 Core + `PiNodeHost` 继续工作；Core/Pi `SIGKILL` 自动恢复、旧代次 fencing 与 `assistantLifecycle("stop")` 不自启在 T10/T12/T21 验证（T23 8h 常驻未跑） |
| **G5 并发有效** | **PASS（本机 dev 候选）** | 单客户端多在途 `overlap=4`、冲突串行 + `waitReason` 可见、130th 绕过 128 阻塞窗、`text_delta` 0 落库、Gadget 分路径锁、C=1/2/4/8 压测有据 |
| **G6 展示和交付** | **PASS（本机 dev / protocol 层）** | `UiReconnectController` 先快照水合后重放增量、慢消费端暂停恢复 8/8、产物/消息/任务权威一致性在 T04/T11/T16/T17 验证（Renderer 全量 GUI 套装未跑） |
| **G7 模型工具能力（§3.6 40 题盲测）** | **`not-run`** | 40 题实机付费模型盲测第一关及后续真实模型完整自主任务闭环**尚未执行**（需授权与有效在线模型凭据） |
| **G8 双平台 / 发行包 / ≥8h 常驻** | **`blocked / not-run`** | Windows GUI 112 项与 `pack:win`/`verify:packaged` 尚未执行；Linux 实机（`test:atspi-transport` / `test:input-guardian-process` / `test:computer-use-linux*` / Linux 包）在本 Windows 主机 **blocked**；≥8h 常驻（T23）**not-run** |

### 声明边界

> 按规划 §4.5 规则，因 **G7（真实付费模型 40 题盲测）与 G8（Linux 实机、Electron GUI 全集、双平台发行包 `verify:packaged`/T24、≥8h 常驻 T23）尚未满足，本轮不宣称整体 G0–G8 最终通过**。  
> 已验证完成的精确边界为：**在 Windows 11 x64（`main@1413d720` + Wave 1–4 整改工作区）上，Rust Core 唯一写权与调度权、独立 Pi Node Host 工具/模型/后台循环装配、Thin Main 角色边界、三条基础契约、T01–T22 核心隔离与 Fault/Process 场景、`27/27` 原生契约集合、以及同机同工作集 `1/2/4/8` 并发压测均已取得可复核实测 PASS 证据**。
