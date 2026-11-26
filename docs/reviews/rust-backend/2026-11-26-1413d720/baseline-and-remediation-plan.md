# MyBuddy Rust Core 整改基线与分波次执行清单（`main@1413d720`）

> 冻结日期：2026-11-26（北京时间）  
> 基线提交：`1413d72087a64f75e2d137046f014476b06c0f7a`（分支 `main`）  
> 性质：Wave 1–4 整改工程基线、进程/数据所有权清单、P0/P1 追踪台账与诚实边界声明。

---

## 1. 冻结基线环境与二进制指纹

| 项 | 值 | 来源 / 说明 |
| --- | --- | --- |
| Git SHA | `1413d72087a64f75e2d137046f014476b06c0f7a` | `git log -n 1` |
| 主机 OS / Arch | `win32 / x64` | 当前执行机 |
| Node / pnpm | `v26.13.1` / `12.14.0` | `node --version` / `pnpm --version` |
| Rust / Cargo | `rustc 1.97.1` / `cargo 1.97.1` | `rustc --version` / `cargo --version` |
| Core 协议版本 | `89` | `mybuddy-runtime-audit --protocol-version` |
| `EXPECTED_PI_VERSION` | `1.5.0` | `src/main/capabilities/subagent/worker-launcher.mjs` |
| 原生 worker 二进制（Wave 3 后更新） | `out/native/win-x64/mybuddy-runtime-audit.exe` | SHA-256：`b7e08ab98bb0aedc553962e0a48008501e778e9a374508437582a3715e88a18e` |

---

## 2. 进程角色与唯一权威所有权清单

| 角色 | 权威拥有的数据 / 能力 | 访问方式与边界 |
| --- | --- | --- |
| **Electron Renderer** | 页面 UI、交互、局部展示缓存 | 通过 Electron IPC 与 Main 通信；快照 + 增量恢复后状态必须等于 Core/Pi 权威状态，UI 缓存不作权威真源 |
| **薄 Electron Main** | 窗口、托盘、系统对话框、浏览器视图（`BrowserWindow`/`WebContentsView`/`session`）、桌面输入/无障碍能力、`PlatformCapabilityProxy` | 只读打开 `app.db`（`readonly: true`）；通过 `UiReconnectController` / `CoreBusinessClient` 消费 Core；不持有第二个 `ModelRuntime` 或独立后台调度器 |
| **Rust Core（supervisor + worker）** | `app.db` 唯一写权、事件日志与快照、Work/Cron/Dots/Gateway/Remote/PiHost/Gadget 生命周期与调度、Gadget 静态 HTTP 共享宿主、语义索引/维护 | `std::thread` + 有界 `mpsc`；所有写经统一 `classify_request` → 专用 `database-writer` + `write_gate` + `request_control::commit`；受控唯一写者 |
| **独立 Pi Node Host** | `ModelRuntime`、`DurableBotService`、Pi 原生会话/checkpoint 存储、`SummaryBudget`、MCP/扩展与工具执行编排 | 独立 Node 子进程（`ELECTRON_RUN_AS_NODE=1`），只读打开 `app.db`；通过 `ExecutionHostBridge` 接单并汇报 `executorAck`/`executorProgress`/`executorSettled` |

---

## 3. P0 / P1 问题台账与波次映射

| 编号 | 问题描述 | 目标波次 / 步骤 | 关联验收场景 | 状态 |
| --- | --- | --- | --- | --- |
| **P0-01** | `PiNodeHost` 缺少 `DotsActions`、Artifact、Gadget 与工作流注入 | **Wave 2 / Step 2** | T01, T02, T04 | `done (Wave 2)` |
| **P0-02** | `ExecutionHostBridge` 缺控制回调仍返回 `completed`；Host 未接 `runDotsControlCycle`/`runGatewayControlCycle` | **Wave 2 / Step 2** | T01, T03 | `done (Wave 2)` |
| **P0-03** | 模型控制面调用 Main 不存在的 `ModelRuntime`；`PlatformCapabilityProxy` 缺 Host→Core→Main 协议闭环 | **Wave 2 / Step 2** | T05, T06 | `done (Wave 2)` |
| **P0-04** | `CorePiHost`/`CoreGadgetHost` 漏入统一写/副作用分类；7 个新 Rust 模块未用 `request_control::commit`；`Launch` 在事务内 spawn/kill | **Wave 1 / Step 1** | T07, T08, T09 | `done (Wave 1)` |
| **P0-05** | Core 断线后 `PiNodeHost` / `ExecutionHostBridge` 不重连、仅凭 PID 存活判定、缺乏无人值守恢复与代次对账 | **Wave 2 / Step 3** | T09, T10, T21 | `done (Wave 2)` |
| **P0-06** | 验收夹具失真（模拟 LLM 直接写盘、`upsertApp` 吞错、仅采 Node RSS、`queueDepthMax` 常量、`headSeq>=20` 弱断言等） | **Wave 1 / Step 0** + **Wave 2 / Step 3** | G0, T04, T11, T18 | `done (Wave 1+2)` |
| **P1-01** | `RuntimeAuditReader` 默认共用 `database` lane 且每 lane 单在途 | **Wave 3 / Step 5** | T13, T20 | `done (Wave 3)` |
| **P1-02** | Rust 普通读在主循环同步执行，慢查询阻塞短读 | **Wave 3 / Step 5** | T13, T19 | `done (Wave 3)` |
| **P1-03** | `write_gate` / `work-scheduler-tick` 跨多调度域长持锁 | **Wave 3 / Step 5** | T14, T20 | `done (Wave 3)` |
| **P1-04** | `promote_compatible_executions` 固定 `LIMIT 128` 遮挡后方无冲突候选 | **Wave 3 / Step 5** | T15 | `done (Wave 3)` |
| **P1-05** | 流式 `executorProgress` 逐条写事务与静默吞错 | **Wave 3 / Step 5** | T16, T17 | `done (Wave 3)` |
| **P1-06** | `UiReconnectController` 先推进 `lastSeq` 至快照 `headSeq` 再 replay；Main 快照未完整水合任务/进度/产物 | **Wave 2 / Step 3** | T11, T17 | `done (Wave 2)` |
| **P1-07** | Main 仍驻留完整 `AgentService`、`LibraryIndexMaintenance`、`ProjectCadence` 与 6h trash purge | **Wave 3 / Step 4** | T12 | `done (Wave 3)` |
| **P1-08** | `gadget_http_host` 所有静态实例共用全局 `Store Mutex` 覆盖序列化与 `sync_all` | **Wave 3 / Step 5** | T18 | `done (Wave 3)` |
| **P1-09** | `CoreBusinessClient` 与 `RuntimeAuditReader` 超时/unknown 语义不一致 | **Wave 3 / Step 5** | T08, T09 | `done (Wave 3)` |

---

## 4. 诚实验收边界（本地开发机 vs 受限项）

| 范围 | Wave 1–4 本地可验证情况 | 受限原因 / 状态 |
| --- | --- | --- |
| Rust 单测、原生 worker 协议、SQLite 写边界、Pi Host / 调度器 / Gadget HTTP 隔离与并发压测（T01–T22） | **本机 Windows 11 x64 直接运行验证** | 使用隔离临时目录与 `prepare-runtime-audit.cjs` 准备测试原生产物 |
| Electron 发行包构建与校验（`pnpm build` / `pack:win` / `pack:linux` / `verify:packaged` / `test:all:artifacts` / T24 真双包交接） | **`not-run`（开发期规则禁止）** | 遵守 `AGENTS.md`：未获明确发布指令不执行构建/打包 |
| Linux 实机原生与 Hyprland/AT-SPI 桌面门禁（`test:atspi-transport` / `test:input-guardian-process` / `test:computer-use-linux*`） | **`blocked / not-run`** | 当前执行机为 Windows 11 x64，无 Linux 桌面会话 |
| 真实付费模型 40 题盲测第一关（§3.6） | **`not-run`（待授权与有效模型凭据）** | 需用户授权消耗在线模型额度与凭据 |
| 同一候选 ≥8 小时连续常驻观测（T23） | **`not-run`（需独立挂机窗口）** | 留待 Wave 4 后候选挂机窗口执行 |

---

## 5. Wave 1 验证实测记录（2026-11-26）

- `RUNTIME_AUDIT_TESTS=1 node scripts/prepare-runtime-audit.cjs`：**PASS**（Rust 单元测试 `42 passed; 0 failed`，编译产物 SHA-256 `67df4cd74d5694ba3398dad4f34f193ecdbf033e7bbeef3ec69e8c9b05d66781`，`--protocol-version` == `89`）
- `pnpm run typecheck`：**PASS**（`tsconfig.web.json`、`tsconfig.node.json`、`scripts/typecheck-scripts.mjs` 0 错误）
- `node scripts/test-all.mjs --audit`：**PASS**（`headless 525 · GUI 112 · NETWORK 42 · DATASET 19 · ARTIFACT 3 · pending 0`）
- `pnpm run test:all:native`：**PASS**（`24/24` 原生用例全通过，含加固后的 `test:core-production-lifecycle` 与 `test:pi-node-host`）
- `pnpm run perf:rust-core`：**PASS**（`coldBootMs=104.57`、`recoveryMs=14.89`，5 项场景全过；`writeTaskRecord` n=100 p95=`4.64ms` p99=`5.8ms`；`controlAck` n=100 p95=`0.4ms` p99=`0.49ms`；`heavyWriteMixedWithLightSnapshot` n=100 p95=`5.01ms` p99=`6.14ms` `queueDepthMax=2`；`staticGadgetScaling(20apps)` n=20 p95=`13.81ms`；`ui20ReopenAndReclaimCycles` n=20 p95=`32.11ms`）

---

## 6. Wave 2 验证实测记录（2026-11-26）

- `RUNTIME_AUDIT_TESTS=1 node scripts/prepare-runtime-audit.cjs`：**PASS**（Rust 编译 **0 警告**，单元测试 `43 passed; 0 failed`，编译产物 SHA-256 `c3bde4fd489fc60201b6597867609d64e7096b4f87a2b8cc11482ec94dab20b1`，`--protocol-version` == `89`）
- `pnpm run typecheck`：**PASS**（`tsconfig.web.json`、`tsconfig.node.json`、`scripts/typecheck-scripts.mjs` 0 错误）
- `node scripts/test-all.mjs --audit`：**PASS**（`headless 525 · GUI 112 · NETWORK 42 · DATASET 20 · ARTIFACT 3 · pending 0`，分类自检 OK）
- `pnpm run test:all:native`：**PASS**（`25/25` 原生业务用例全通过：`test:wave2-capabilities-recovery` 覆盖 T01–T06/T10/T11 与负面证明；`test:thin-main` 移除 `headSeq >= 20` 逃生舱并严测 `domainNote` 离线补读；`test:core-production-lifecycle` Step 4 校验 SQLite `artifacts` 真实行落盘、Step 7 校验 Core `supervise_tick` 无人值守自动围栏并重拉替代 `PiNodeHost`；`test:pi-node-host` 全绿）
- `pnpm run perf:rust-core`：**PASS**（`coldBootMs=131.3`、`recoveryMs=10.71`，5 项场景全过；`core.writeTaskRecord(warm)` n=100 p95=`5.5ms` p99=`6ms` rssPeak=`140926976`；`core.controlAck(executionStatus)` n=100 p95=`0.44ms` p99=`0.71ms`；`core.heavyWriteMixedWithLightSnapshot` n=100 p95=`5.36ms` p99=`6.42ms` `queueDepthMax=2`；`core.staticGadgetScaling(20apps)` n=20 p95=`17.51ms`；`core.ui20ReopenAndReclaimCycles` n=20 p95=`30.83ms`）

---

## 7. Wave 3 验证实测记录（2026-11-26）

- `$env:RUNTIME_AUDIT_TESTS="1"; node scripts/prepare-runtime-audit.cjs`：**PASS**（Rust 编译 **0 警告**，单元测试 `50 passed; 0 failed`，编译产物 SHA-256 `b7e08ab98bb0aedc553962e0a48008501e778e9a374508437582a3715e88a18e`，`--protocol-version` == `89`）
- `pnpm run typecheck`：**PASS**（`tsconfig.web.json`、`tsconfig.node.json`、`scripts/typecheck-scripts.mjs` 0 错误）
- `node scripts/test-all.mjs --audit`：**PASS**（`headless 525 · GUI 112 · NETWORK 42 · DATASET 21 · ARTIFACT 3 · pending 0`，分类自检 OK）
- `pnpm run test:runtime-audit-transport && pnpm run test:runtime-audit-backpressure && pnpm run test:runtime-audit-lifecycle`：**PASS**（传输/背压/取消与过载生命周期全通过）
- `pnpm run test:wave3-thin-main-concurrency`：**PASS**（独立运行与 `--native` 均全绿）：
  - T12：Thin Main `MainRolePolicy`（0 后台维护定时器）+ UI 彻底关闭后 Core `maintenanceScheduler` 驱动 `PiNodeHost` 完成 4 项周期，超期回收任务目录/SQLite 行真实删除且离线生成 `project.attention` 通知。
  - T13：`RuntimeAuditReader` `maxInFlight.database=4`、`ReadPool` `maxActive=4`，`maxConcurrentReads=1` 负向证明 `maxInFlight=1`；4 路独立执行真实并发 `maxOverlap=4`（耗时 `334.8ms` / `--native` `346.3ms`）。
  - T14：同资源 / 同会话严格串行，独立资源并发重叠，阻塞期间暴露 `conflict:*` `waitReason`。
  - T15：1 个运行中 + 128 个阻塞于 `hot-lock` 后，第 130 个独立执行以 `69.4ms`（`--native` `81.1ms`）绕过队头阻塞完成，阻塞项 `waitReason == "conflict:resource:hot-lock:held_by:t15-holder"`。
  - T16：4 路流式推送期间 SQLite `core_domain_events` 存留 `0` 条 `text_delta`，12/12 持久工具与终态事件零丢失，`ephemeralEmitted=4`，control `n=30` `p50=0.62ms` `p95=1.87ms` `max=2.02ms`（`--native` `p50=0.65ms` `p95=1.58ms` `max=1.77ms`）。
  - T17：慢 UI 订阅端暂停读取期间 Core 健康响应 `0.5ms`（`--native` `0.6ms`），重连后 8/8 执行终态 100% 恢复。
  - T18：`gadget-slow` `fsync` 延迟 `377.1ms`（`--native` `366.4ms`）期间 4 个并发 fast gadget 最大延迟 `26.6ms`（`--native` `18.6ms`），缺省入口负向证明显式失败拒绝。
  - T19：有界 `ReadPool(4)` / `WorkspaceIoPool(2)` / `ORT(2,1)` 验证通过，`MYBUDDY_TEST_GADGET_SPAWN_FAIL_ONCE=1` 下首次 HTTP 返回 `503`（`spawnFailures >= 1`、`activeWorkers=0`），二次请求返回 `200`。
  - T20 & P1-09：队列上限 `256` 后拒收 `OVERLOADED`、同槽下 `foreground` 优先于先提交的 `background`、`CoreBusinessClient` 断连未确认写操作抛出携带 `requestId` 的 `RuntimeAuditUnknownOperationError` 且 `queryOperation(requestId)` 返回结构化回执（`queued`）。
- `pnpm run test:all:native`：**PASS**（`26/26` 原生业务用例全通过，含 `test:wave3-thin-main-concurrency`）
- `pnpm run perf:rust-core`：**PASS**（`coldBootMs=111.61`、`recoveryMs=9.7`，5 项场景全过；`core.writeTaskRecord(warm)` n=100 p50=`3.21ms` p95=`4.27ms` p99=`4.49ms` rssPeak=`172654592`；`core.controlAck(executionStatus)` n=100 p50=`0.3ms` p95=`0.67ms` p99=`5.48ms`；`core.heavyWriteMixedWithLightSnapshot` n=100 p50=`3.13ms` p95=`6.56ms` p99=`8.59ms` `queueDepthMax=2`；`core.staticGadgetScaling(20apps)` n=20 p50=`10.29ms` p95=`13.32ms`；`core.ui20ReopenAndReclaimCycles` n=20 p50=`10.78ms` p95=`25.01ms`）

---

## 8. Wave 4 验证实测记录（2026-11-26）

- `$env:RUNTIME_AUDIT_TESTS="1"; node scripts/prepare-runtime-audit.cjs`（基于最终二进制复核）：**PASS**（Rust 0 警告，`50 passed; 0 failed`，`out/native/win-x64/mybuddy-runtime-audit.exe` SHA-256 `b7e08ab98bb0aedc553962e0a48008501e778e9a374508437582a3715e88a18e`，`--protocol-version` == `89`）
- `pnpm run test:wave4-data-process`：**PASS**（T21 + T22 全通过）：
  - T21a（只读库故障注入）：不删除当前有效 `app.db`，不将其误判为 schema 不兼容，不静默假成功；
  - T21b（`SQLITE_BUSY` 锁竞争）、T21c（非 SQLite 损坏字节区分：`db-schema-discard` 契约保护）；
  - T21d（Core worker `SIGKILL` 恢复 + `PRAGMA integrity_check === "ok"`）；
  - T22a（Node 孙子进程树关闭回收：`host=15004, child=24264, grand=7740, port=51023` 在 `633.9ms` 终止并释放 TCP 端口与 `held.lock` 文件句柄）；
  - T22b（Python HTTP 子进程终止：`pid=2292, port=51035` 在 `18.3ms` 终止并释放端口）；
  - T22c（缺失运行时显式回报 `blocked/RUNTIME_ENVIRONMENT_MISSING`）。
- `pnpm run test:all:native`：**PASS**（`27/27` 原生业务用例全命中真实 worker，含 `test:wave2-capabilities-recovery`、`test:wave3-thin-main-concurrency`、`test:wave4-data-process`、`test:thin-main`、`test:core-production-lifecycle`、`test:pi-node-host`）。
- `pnpm run perf:rust-core`：**PASS（5/5）**（`coldBootMs=113.87`、`recoveryMs=20.28`；`writeTaskRecord(warm)` n=100 p50=`2.89ms` p95=`3.83ms` p99=`4.67ms` max=`5.69ms` rssPeak=`142680064`；`controlAck(executionStatus)` n=100 p50=`0.33ms` p95=`0.51ms` p99=`5.09ms` max=`5.38ms` rssPeak=`150368256`；`heavyWriteMixedWithLightSnapshot` n=100 p50=`3ms` p95=`4.42ms` p99=`5.66ms` max=`6.31ms` rssPeak=`170545152` `queueDepthMax=2`；`staticGadgetScaling(20apps)` n=20 p50=`8.32ms` p95=`11.31ms` p99=`N/A` max=`19.29ms` rssPeak=`171622400`；`ui20ReopenAndReclaimCycles` n=20 p50=`12.98ms` p95=`31.97ms` p99=`N/A` max=`37.22ms` rssPeak=`189255680`）。
- `pnpm run bench:rust-core-concurrency`（固定工作集 `C = 1, 2, 4, 8` 压测，结果文件 [`concurrency-benchmark-results.json`](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/docs/reviews/rust-backend/2026-11-26-1413d720/concurrency-benchmark-results.json)）：**PASS**（6 组工作负载 W1–W6 全档位 `failures=0`、`controlFailures=0`，推荐生产上限：`executionSlotsLimit=4`、`readPoolWorkers=4`、`workspaceIoWorkers=2`、`ortIntraThreads=2`、`ortInterThreads=1`）。
- `pnpm run test:all`（default headless，523 项 / 13.5 min）：实测 **`通过 471 · 失败 52 · 已知失败 0 · 新增回归 49 · 执行失败 3 · 超时 3`**（`scripts/test-baseline.json` `knownFailing: []` 未改）。逐项核对 [`docs/reviews/rust-backend/2026-11-25-046e33ef/baseline-tests.md`](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/docs/reviews/rust-backend/2026-11-25-046e33ef/baseline-tests.md)：50 项为 Step 1 既有基线红（Node v26 `stripTypeScriptTypes` `mode:'transform'` 24 项、`.tsx` `icons.tsx` 8 项、`architecture*` 2 项、DOM/SSR 2 项、既有断言 13 项、`test:dots-reply-recovery` 超时 1 项）；额外 2 项并行争用超时（`test:dots-actions`、`test:local-workflow`）已单独复验 **`PASS`**（分别耗时 `275s` 与 `276s`，exit `0`）。
- `node scripts/test-all.mjs --audit && pnpm run typecheck`：**PASS**（`headless 525 · GUI 112 · NETWORK 42 · DATASET 22 · ARTIFACT 3 · pending 0`；`tsconfig.web.json`、`tsconfig.node.json`、`scripts/typecheck-scripts.mjs` 0 错误）。
- 完整交付汇总与诚实 G0–G8 出口评估见 [`final-acceptance-report.md`](file:///C:/Users/servi/Documents/GitHub/wavealstra_harness/docs/reviews/rust-backend/2026-11-26-1413d720/final-acceptance-report.md)。



