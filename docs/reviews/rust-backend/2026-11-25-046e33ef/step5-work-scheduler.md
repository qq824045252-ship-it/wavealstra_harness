# Step 5 执行报告：迁 Work 状态机、调度与恢复至 Rust Core（`RC-11`～`RC-13`）

- **步骤 / 场景**：Step 5 — 将 Work 状态机、Cron/Watch 调度器（含时区/DST/时钟回拨防护）、资源冲突控制与并行执行派发、崩溃与未知状态恢复扫描迁入 Rust Core，并收回 Main 调度定时权。
- **源码与产物**：
  - Git `main` SHA：`046e33ef6a6a492a99e9ad3fa10499dbac85b3aa`
  - 原生产物：`out/native/win-x64/mybuddy-runtime-audit.exe`（协议 `89`，SHA-256 `678B34D6F09673C079734F5E02051C9EAA6EEFC5C0877E01441936AB938C1D2A`）
  - 环境：Windows 11 Pro `10.0.26300` (x64)，Node `v26.13.1`，pnpm `12.14.0`，Rust `1.97.1`

---

## 1. 架构切换与关键改动

1. **Rust Work 调度与状态机核心 (`native/runtime-audit/src/work_scheduler.rs`)**：
   - **纯 Rust Cron + 时区/DST 引擎**：支持标准 5 段 Cron 与 US/EU DST 及固定偏移时区（含 `America/Los_Angeles` 春季缺小时 `spring-forward` 首有效时刻映射、`fall-back` 仅首轮触发、`Asia/Shanghai` 与 wall-clock 回拨 high-water 保护及有界页追赶）。
   - **单一业务 Owner 租约围栏 (`work_host_lease` + `work_watch_host_state`)**：
     - 监督模式下 worker 启动独立后台 ticker 线程并自动取得 `core:<generation>` 权威租约，跨代重启切换由 OS `core.lock`/`core-worker.lock` 保证安全后即时接管前代 `core:*` 租约并单调递增 `works.owner_epoch`，同时严格以 `OWNER_CONFLICT` 拒绝外部/旧 owner；过期 `expectedStateVersion`/`expectedIntentRevision`/`expectedOwnerEpoch` 命令返回 `REVISION_CONFLICT`。
   - **状态机与资源冲突并发控制 (`execute_write` / `promote_compatible_executions`)**：
     - 完整承接 `CreateWork`、`AmendWork`、`PauseWork`、`ResumeWork`、`CancelWork`、`CloseWork`、`ArchiveWork`、`ConfigureSubscription`、`DispatchExecution`、`SettleExecution`、`AcceptDeliverable`、`Tick`、`ScanRecovery` 及只读非阻塞查询 `GetWork`/`ListWorks`/`GetExecutionQueue`/`OwnerStatus`。
     - 资源冲突按 `workId`（非显式并发）及独占 `resourceKey` 局部串行排队，互不重叠的独立资源/Work 真并发派发至执行桥，前台读/控不等待后台长任务终态。
   - **恢复扫描与多态分离**：
     - 与 `business_protocol.rs`（`ExecutorAck`、`ExecutorSettled`、`CoreExecutorPresence`）联动：执行桥断连或崩溃在途任务原子落入 `unknown` 并建立 `work_blockers (kind='external_effect')`，恢复扫描绝不换 ID 重放；执行结束（`completed`/`failed`/`stopped`/`unknown`）、部分成果与未覆盖范围（`work_deliverables.uncovered_scope_json`）、成果验收（`acceptDeliverable`）与事项结案（`closeWork`）/ 归档（`work_record_archive`）保持严格分离。
2. **宿主所有权收回 (`WorkWatchScheduler.ts` / `WorkHostAuthority.ts` / `AgentService.ts`)**：
   - `WorkWatchScheduler.start()` 在 `requiresWorkRustWrites(db)` / `readonly` 下直接拒绝在 Main 启动本地调度定时器。
   - `AgentService.ts` 对接 `WorkHostAuthority(..., delegatedToCore = Boolean(runtimeAuditReader?.supervised))` 镜像 Core 权威并触发 Rust `scanRecovery`，UI 断开或 `WorkHostAuthority.stop()` 不释放后台 `core:*` 租约。
3. **协议客户端 (`core-business-client.ts` / `runtime-audit.ts`)**：
   - 开放 `workScheduler(...)` 命令接口（UI / `background-service` / `RuntimeAuditClient` 复用）。

---

## 2. Step 5 实测门禁结果

| 检查项 | 命令 | 结果 | 说明 |
| --- | --- | --- | --- |
| Rust 单元测试 | `RUNTIME_AUDIT_TESTS=1 node scripts/prepare-runtime-audit.cjs` | **PASS（34/34）** | `0 warnings`；新增 DST `spring-forward`/`fall-back`/`Asia/Shanghai` 与 owner fencing / 资源冲突并发恢复单测 |
| 静态类型检查 | `pnpm typecheck` | **PASS（0 错误）** | web / node / scripts 全通过 |
| 套件清单自检 | `node scripts/test-all.mjs --audit` | **PASS** | `headless 525 · GUI 112 · NETWORK 42 · DATASET 14 · ARTIFACT 3 · pending 0` |
| `RC-11`～`RC-13` 实机核心验收 | `pnpm run test:rust-work-scheduler` | **PASS** | Part A 验证 Core 自动持租、Main `WorkWatchScheduler.start()` 被拒；`RC-11` 验证外部 owner 拒绝、worker 强杀重启后 `owner_epoch` 递增与旧 owner/旧版本拒绝、在途合法成果按原 `(ownerEpoch, intentRevision, inputSnapshotId)` 连续核对；`RC-12` 验证长任务执行期间前台 `getWork` 实测 RTT `3.1ms`、独立资源 `/res-b` 真并发完成、重叠资源 `/res-a` 严格串行并在前置落账后自动拉起；`RC-13` 验证 2027 LA `spring-forward` DST（`2027-03-14T02:30`）、时钟回拨防重放、`endsAt` 到期收口、`pause`/`resume` 门禁、执行桥断连转 `unknown` + `external_effect` 阻塞不重放，以及验收/结案/归档三态分离 |
| Work 原有专项与原生契约 | `test:work-host-authority`、`test:bot-work-control`、`test:bot-work-phase4-schedule-clock`、`pnpm run test:all:native` | **PASS（19/19）** | 新增 `test:rust-work-scheduler` 合入 `test:all:native`（19 项全部命中真实 Rust worker） |

---

## 3. 未覆盖环境声明

- **Linux 实机（`not-run`）**：Linux 原生 worker 与 Wayland 环境未在本 Windows 主机执行。
- **GUI / 发行包验收（`not-run`）**：按计划留待 Step 10 完整候选包验收。
