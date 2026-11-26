# Step 4 执行报告：收拢应用域写入与事务（`RC-09`～`RC-10`）

- **步骤 / 场景**：Step 4 — 收拢 `app.db` 全部应用域写入至 Rust Core，开启监督生产路径 `readonly: true`（`PRAGMA query_only = 1`），验证写者边界（`RC-09`）与域等价性（`RC-10`）。
- **源码与产物**：
  - Git `main` SHA：`046e33ef6a6a492a99e9ad3fa10499dbac85b3aa`
  - 原生产物：`out/native/win-x64/mybuddy-runtime-audit.exe`（协议 `89`，SHA-256 `6734D4E7F4D853E45FE9BA8249DB5DFD8169236567AB2FF34372A681BA29D7B6`）
  - 环境：Windows 11 Pro `10.0.26300` (x64)，Node `v26.13.1`，pnpm `12.14.0`，Rust `1.97.1`

---

## 1. 写入收敛架构与关键改动

1. **Rust Core 应用域写入模块**：
   - `native/runtime-audit/src/db_schema.rs` + `canonical_schema.sql`：由 Rust Core 初始化并校验 `v36` schema（`CURRENT_DATABASE_SCHEMA_VERSION = 36`），监督生产模式下宿主机仅读打开。
   - `native/runtime-audit/src/batch1_writes.rs`、`batch2_writes.rs`、`batch3_writes.rs`、`batch4a_writes.rs`、`batch4b_writes.rs`、`batch4b_bot.rs`、`batch4b_work.rs`：承接 Workspace / Task / Blueprint / Artifact / Project / Cron / Notification / Usage / Dots / Gateway / Memory / Library / Bot / Work 全部应用域写入与事务提交；新增 `RebindLegacyTaskWorkspacePaths`（`batch2_writes.rs`）。
2. **宿主读写边界与 Overlay 一致性**：
   - `src/main/index.ts`：监督生产启动 `AppDatabase.open(undefined, { runtimeAuditExecutable, runtimeAuditSupervised: true, readonly: true })`。
   - `src/main/db/AppDatabase.ts`：`rebindLegacyTaskWorkspacePaths` 在 `requiresRustWrites` 下经 `queueTaskBatch2Write` 收拢至 Rust，`readonly: true` 时强制 `PRAGMA query_only = 1` 与禁止宿主机写 SQLite。
   - `src/main/agent/work/WorkDomainRuntime.ts` & `src/main/agent/work/WorkService.ts`：
     - 修复 `overlayMergeAll` / `overlayFindAll` 对基础 SQLite 行也严格执行 `predicate` 过滤，防止 partial/empty overlay 时返回脏行。
     - 修复 `WorkService.emitCurrentProjection`：在 Rust 异步批量写回尚未落盘前（`!sqlProjection || sqlProjection.stateVersion < work.stateVersion || options.force`），在 `requiresWorkRustWrites` 下通过 `this.project(work)` 从 overlay 生成最新投影并推送。
   - `src/main/agent/work/BotCollaborationRepository.ts`：使 `requestPreview`/`replyPreview` 使用 Unicode 码点切片匹配 SQLite `substr(..., 1, 500)` 语义。
   - `src/main/agent/work/BotConversationRepository.ts`：在 `bot_messages`/`bot_work_feedback`/`work_conversations` 无未落盘 overlay 时走带 `AND EXISTS ... LIMIT 101` 的索引区间扫描，有未落盘 overlay 时走 overlay 合并分支，兼顾分页性能与强一致读。
   - `src/main/workspace/WorkspaceNotesService.ts` / `src/main/project/ProjectNotesService.ts` / `src/main/gateway/GatewayService.ts`：补全 `db.connection?.readonly`、`flushGatewayWrites?.()` 与无外部 `runDbTransaction` 上下文兜底，保持最小测试桩兼容。
   - `durable.sqlite`、`native-hooks.sqlite`、`native-improvement.sqlite`、`.mybuddy-writer-lock.sqlite` 保持 Node/Pi RW 独立归属，不受 `app.db` 只读围栏阻塞。

---

## 2. Step 4 实测门禁结果

| 检查项 | 命令 | 结果 | 说明 |
| --- | --- | --- | --- |
| Rust 单元测试 | `RUNTIME_AUDIT_TESTS=1 node scripts/prepare-runtime-audit.cjs` | **PASS（32/32）** | `0 warnings`（协议 89 最新 `native/` 编译产物） |
| 静态类型检查 | `pnpm typecheck` | **PASS（0 错误）** | `tsconfig.web.json`、`tsconfig.node.json`、`scripts/typecheck-scripts.mjs` 全通过 |
| 套件清单自检 | `node scripts/test-all.mjs --audit` | **PASS** | `headless 525 · GUI 112 · NETWORK 42 · DATASET 13 · ARTIFACT 3 · pending 0`；无新增错误 |
| `RC-09` 写者边界实机门禁 | `pnpm run test:rust-writer-boundary` | **PASS** | 实证监督 `AppDatabase.readonly === true`、`PRAGMA query_only === 1`、宿主机直写 `INSERT`/`UPDATE` 抛 `readonly`；Workspace/Task/Rebind/Work/Notification/Cron 经 Rust 提交并在重开后留存；`durable.sqlite` 与 `native-hooks.sqlite` 保持可写；`src/main/` 无未防护写 SQLite 文件 |
| `RC-10` 域等价性对比门禁 | `pnpm run test:rust-domain-equivalence` | **PASS** | 监督 readonly Rust 与宿主机 RW 精确等价：`spaceName="Equiv Workspace"`、`taskTitle="Equiv Task"`、`workTitle="Equivalence Goal v2"`、`workLifecycleAfterPause="paused"`、`workLifecycleAfterResume="active"`、`workIntentRevAfterAmend=2`、`conflictCode="idempotency_conflict"`、`rollbackCount=0`、`subscriptionCount=1`、`inboxCount=2`、`projectionCount=5`、`notificationRead=true` |
| 原生契约全量套件 | `pnpm run test:all:native` | **PASS（18/18）** | 包含 Step 2–3 原有 16 项 + 新增 `test:rust-writer-boundary`、`test:rust-domain-equivalence`，全部命中真实 worker |
| Headless 全量棘轮套件 | `pnpm run test:all`（523 项） | **PASS（0 新增回归）** | `通过 473 · 失败 50 · 超时 1`，与 Step 1 基线（`046e33ef`：473 PASS / 50 FAIL / 1 TIMEOUT）完全一致；已先定位并修复 5 项临时回归（`pi-native-core-tools`、`slack-gateway`、`business-gateway-registration-service`、`external-write-grant`、`bot-history-query`）后全量复跑清零 |

---

## 3. 未覆盖环境声明

- **Linux 实机（`not-run`）**：`cargo test`、Linux `test:all:native` 与 Wayland/AT-SPI 检查未在本 Windows 主机执行。
- **GUI 112 项与发布包构建（`not-run`）**：按计划留待对应步骤及 Step 10 完整候选包验收（不提前运行 `pnpm build` / `pack:*`）。
