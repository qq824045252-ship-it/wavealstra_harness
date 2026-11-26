# Step 3 验收报告：业务协议、执行桥与独立后台生命周期（RC-06 ～ RC-08）

- **步骤 / 场景**：Step 3（`RC-06` ～ `RC-08`：具名领域命令、多角色连接与权限隔离、事件快照与增量游标订阅/缺口重同步、Core 执行槽与 Main Pi 过渡执行桥、无 UI 后台恢复/熔断与显式停止围栏）
- **源码与产物**：
  - 基于基线 `046e33ef6a6a492a99e9ad3fa10499dbac85b3aa` 新增与修改（未提交工作区改动）：
    - Rust Core：
      - `native/runtime-audit/src/core_lease.rs`：升级 `PROTOCOL = 89`；新增持久化的 `CoreLifecycleState`（`core-lifecycle.json`）与 `CoreStatus`（`core-status.json`）。
      - `native/runtime-audit/src/business_protocol.rs`：实现 `core_domain_events` / `core_event_meta`（有界保留窗口 + `min_available_seq`）/ `core_domain_notes` / `core_command_receipts` / `core_execution_runs`；提供具名领域命令（`coreCommand`: `upsertNote`/`deleteNote`/`setEventRetention`/`setExecutionSlotsLimit`，含 `expectedRevision` 与 `commandId` 去重）、一致性水位快照（`coreEventsSnapshot`）、增量补读与缺口检测（`coreEventsReplay`）、Core 执行槽控制与对账（`coreExecution`: `submit`/`status`/`pause`/`cancel`/`resume`/`reconcile`/`executorAck`/`executorProgress`/`executorSettled`）以及 `assistantLifecycle`。
      - `native/runtime-audit/src/core_supervisor.rs`：升级 `Relay` 为多角色有限并发连接池（支持 legacy `hello <token>` 互斥与 `ui` / `execution-host` / `background-service` 多角色握手），使用 `PriorityOutput`（通知队列与批量响应队列分离）确保慢读 UI 不阻塞控制路径与其他角色；按连接代次（`epoch`）隔离回复与断连清理（UI 断开不撤销后台 Gadget 授权也不取消后台执行，仅 `execution-host` 断连将运行中执行标为 `unknown`）；新增 `--watchdog <dataDir> <dbPath> [--recover]` 实现无界面 worker/supervisor 指数退避重启、连续崩溃熔断（`circuit_open`）及 `stopped_explicitly` 停机围栏。
      - `native/runtime-audit/src/main.rs`：接入 `business_protocol`、`--watchdog`、协议 `89` 与提交后 `coreEvent` / `coreExecutionDispatch` / `coreShutdownRequested` 发射。
    - TypeScript / 平台边界 / Electron Main：
      - `src/main/platform/core-client.ts`：协议升级 `89`，支持多角色握手字段并导出 `prepareCoreBinary`（含 Windows Medium IL 修复）。
      - `src/main/platform/core-business-client.ts`：强类型 `CoreBusinessClient`（命令、执行控制、快照+增量游标订阅、`openEventSubscription` 自动去重与 `gap` 全量重同步、生命周期管理）。
      - `src/main/host/ExecutionHostBridge.ts`：`execution-host` 角色桥及 `createDurableBotExecutionRunner` 过渡适配，把执行派发送到 Main 现有 `AgentService` / `DurableBotService`（不在适配器内隐藏调度逻辑，显式注明此时 Pi 仍驻留 Main）。
      - `src/main/platform/core-autostart.ts`：Windows（`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`）与 Linux（XDG autostart + `systemd --user`）开机看门狗注册规约与分离启动 `launchCoreWatchdog`，严格遵守 `stopped_explicitly` 围栏。
      - `src/main/host/ResidentLifecycle.ts`、`src/main/AppSettingsStore.ts`、`src/shared/agent-ipc.ts`、`src/renderer/src/components/settings/SettingsModal.tsx`、`src/main/platform/runtime-audit.ts`、`src/main/index.ts`：新增 `autostartEnabled` 设置；`RuntimeAuditReader` 默认以 `ui` 角色多路复用；区分「关闭窗口」「退出界面」「停止助理」（显式 `停止助理` 写 `stopped_explicitly`、停自启并 `shutdownCoreWorker`）；挂载 `ExecutionHostBridge` 过渡适配。
    - 测试与门禁注册：
      - `scripts/core-business-protocol-test.ts`（登记为 `package.json` `test:core-business-protocol`，加入 `scripts/test-all.mjs` `DATASET_TESTS` 与 `scripts/verify-native-contract.mjs`）。
  - 原生二进制 `out/native/win-x64/mybuddy-runtime-audit.exe`：
    - 协议版本：`89`
    - SHA-256：`E0EEE6E18567CAD6250887F6173BD8B5ED75EC80D30DD080873D79E7D0B059A5`
  - Pi 版本：`1.5.0`（主执行仍暂留 Electron Main `DurableBotService`）
- **环境**：Windows 11 Pro `10.0.26300` (x64)，Node `v26.13.1`，Rust `1.97.1`，Electron `44.5.1`；真实 Rust Core、真实 SQLite、真实多进程/子进程。
- **结果**：**Windows 本地门禁 `passed`**（Linux 实机看门狗与 `systemd`/XDG 自启实操、`GUI`/`packaged` 实机仍为 `not-run`；Pi 独立宿主与真实联网/渠道留至对应后续步骤）。

---

## RC-06 ～ RC-08 逐项核对与实测观察

| ID | 输入与故障注入 | 实测观察与结果 | 结果 |
| --- | --- | --- | --- |
| **RC-06** | 同 Core 实例同时连接 `ui-1`、`ui-2`、`background-service`、`execution-host`；再连重复 `background-service`；`ui-1` 冒充 `executorAck`；重复发送同 `commandId`、使用过期 `expectedRevision`；`ui-1` 在 `bg` 持 Gadget 授权及 `exec` 运行中时断开 | 1) 四路不同/允许角色接入同一个 `workerPid`，第 2 个互斥 `background-service` 被拒（`role_busy`）。<br>2) `commandId` 去重返回 `deduplicated: true` 且版本保持 `1`；过期 `expectedRevision` 返回 `REVISION_CONFLICT`；UI 冒充执行确认返回 `FORBIDDEN_ROLE`。<br>3) `ui-1` 断开后，`background-service` 既有 Gadget 写入仍成功且 `execution-host` 运行中执行正常收敛为 `completed`。 | `passed` (Win) |
| **RC-07** | `openEventSubscription` 获取快照水位 → 断开 `ui` → `background-service` 连续提交 3 条命令 → 重连并按游标增量补读；缩容 `retentionLimit = 2` 并提交至旧游标落出窗口后重试补读；使用错误 `coreGeneration` 补读；检查重放后修订号 | 1) 断线期间提交的 seq `[1, 2, 3]` 重连后按原顺序补读并经 `(coreGeneration, seq)` 去重。<br>2) 旧游标被裁剪后 `coreEventsReplay` 返回 `gap: true, reason: "cursor_expired"`，触发 `onResync` 自动拉取最新快照并将游标推进到 `headSeq = 7`；错误代次返回 `generation_mismatch`。<br>3) 所有实体的 `revision` 保持 `1`，事件重放/快照读取未触发第二次命令执行。 | `passed` (Win) |
| **RC-08** | 1) 无 `execution-host` 在线时由 UI 提交任务；连接可控执行桥后观察派发、`pause`/`resume`/`cancel` 与限槽；<br>2) 执行运行中断开 `execution-host`，再重连并 `reconcileExecution`，同 `idempotencyKey` 再次提交；核对 `createDurableBotExecutionRunner` 过渡适配；<br>3) 无任何 UI 下启动 `--watchdog`，连续注入 `worker` `SIGKILL` 与 `supervisor` `SIGKILL` 至连续失败熔断，使用 `--recover` 恢复，再调用 `assistantLifecycle("stop")` 观察看门狗退出与拒绝自启 | 1) 无执行者时状态诚实持久化为 `waiting_executor`；执行桥连入后自动派发并完成；`pause -> resume -> cancel` 与 `idempotencyKey` 防重均生效。<br>2) 执行者断连立即将运行中任务标为 `unknown` 并保留原 `executionId`，显式 `reconcile` 收敛完成。<br>3) 无 UI 时杀 worker 与杀 supervisor 均由 `--watchdog` 自动恢复（新 `pid`/`workerPid`/`generation`）；超过 `MYBUDDY_CORE_MAX_RESTARTS=3` 进入 `core-status.json` `circuit_open` 并拒绝无恢复参数的重启；`--recover` 恢复服务；`assistantLifecycle("stop")` 写入 `stopped_explicitly`、撤销端点并让看门狗立即干净退出且再次拉起直接跳过；`syncCoreAutostart` 验证停用状态下不会写入自启。 | `passed` (Win) |

---

## 本步验证命令与结果

- `RUNTIME_AUDIT_TESTS=1 node scripts/prepare-runtime-audit.cjs`：**PASS**（Rust 单元测试 `30/30` passed in `1.77s`，新增 `business_protocol` 3 项单元用例）
- `pnpm typecheck`：**PASS**（web/node/scripts 错误 `0`）
- `node scripts/test-all.mjs --audit`：**PASS**（headless `525` · GUI `112` · NETWORK `42` · DATASET `11` · ARTIFACT `3` · pending `0`，分类自检 OK）
- `pnpm run test:core-business-protocol`：**PASS**（3 组真实进程端到端场景 `PASS`，登记入 `test:all:native`）
- `pnpm run test:all:native`：**PASS**（**`16/16`** 原生真实 worker 门禁全部通过，Step 2 用例无回归）

---

## Step 3 出口门禁与边界说明

- [x] `RC-06` ～ `RC-08` 在 Windows 本机通过，所有新增测试已正式登记入 `package.json`、`scripts/test-all.mjs` 与 `scripts/verify-native-contract.mjs`。
- [x] UI 与后台角色连接分离；无 UI 时 Core 可恢复、无执行宿主时任务诚实等待；`停止助理` 写入显式停止围栏并停掉 Core/看门狗，与 `关闭窗口` / `退出界面` 清晰区分。
- [x] **明确记录现状边界**：按规划此时 **Pi 主执行仍在 Electron Main（通过 `ExecutionHostBridge` + `createDurableBotExecutionRunner` 过渡适配），尚未抽离为独立 Pi Node Host（留待 Step 8）；多数应用域表的日常写入仍将在 Step 4 收拢进 Rust**。
- **下一步**：已满足 **Step 4（收拢应用域写入和事务，`RC-09`～`RC-10`）** 进入条件。
