# Step 9：收薄 Electron Main、UI 断线重连与隐藏页面回收（RC-23 ～ RC-24）

- **状态**：`passed`（Windows 11 x64 原生实测 + 生产主入口装配 + readonly/supervised 零回退门禁；Linux 与实际打包产物待 Step 10 授权范围内单列）
- **环境**：`Microsoft Windows 11` (x64)、Node `v26.13.1`、Rust `1.97.1`、Electron `44.5.1`（dev/stubbed WCV）、Pi `1.5.0`
- **对应脚本**：`pnpm run test:thin-main`（注册于 `package.json`、`scripts/test-all.mjs` `DATASET_TESTS`、`scripts/verify-native-contract.mjs`）

---

## 1. 本步核心改动与所有权收口

1. **窗口级 UI 重连控制器 (`src/main/host/UiReconnectController.ts`)**：
   - 将 `src/main/index.ts` 的 `coreUiClient` 收敛为受控 UI 订阅会话：`openUiSession()` 拉取 Core 权威快照、`replayFrom()` 按游标补读缺口、`(coreGeneration, seq)` 与单调 `(domain, entityId, kind, revision)` 去重、跨 `coreGeneration` 或游标失效触发 `onResync` 清理旧状态缓存；`win.once("closed")` 仅关闭 UI 会话，不停止 Core 与 `PiNodeHost`。
2. **多表面 WebContents 回收与恢复 (`src/main/host/WebContentsReclaimManager.ts`, `src/main/browser/BrowserHost.ts`, `src/main/artifact/ArtifactPreviewHost.ts`)**：
   - 保护可见页面、含未保存输入（`hasUnsavedInput`）、以及活跃平台控制/自动捕获任务（`hasActivePlatformTask`）不被误杀。
   - 回收闲置隐藏的浏览器标签视图（设置 `reclaimed` 标志保留逻辑 tab 与 `persist:extension-browser` 会话分区）与 `artifact-preview` 视图，记录可观测 `rssBytes`/`heapUsedBytes`/回收历史，并在 `selectTab`/`open`/`wakeSurface` 时精确恢复 URL 与视口状态。
3. **平台能力代理与常驻交接 (`src/main/host/PlatformCapabilityProxy.ts`, `src/main/host/ResidentLifecycle.ts`)**：
   - UI/浏览器离线时显式返回 `{ status: "waiting_platform", capability, reason }` 诚实等待恢复。
   - `ResidentLifecycle` 增加 `supervisedCore?: () => boolean`；启用后 `exitInterface()`/`afterCleanup()` 不再拉起重复的旧 `--resident-host` Electron 业务宿主。
4. **移除生产环境 `needsHost` 静默回退与验证 Main 零业务定时器**：
   - 收紧 `WorkPhase5Facts.ts`、`WorkQueueData.ts`（`readonly` 下免除 `BEGIN IMMEDIATE`）、`DurableTaskProjection.ts`、`DurableWorkspaceMoves.ts`、`FileBackupService.ts`、`ConnectorService.ts` 与 `MemoryService.ts`，在 `supervised`/`requiresRustWrites` 模式下严禁因 `needsHost` 静默回退到 Node SQLite 写入；复核 `CronService`、`DotsGoogleMonitor`、`DotsDiscovery`、`DotsProactiveDelivery` 在 Core 托管模式下启动 **0** 本地轮询定时器。

---

## 2. 门禁实测结果（`2026-11-26`）

| 测试 / 命令 | 结果 | 核心观察 |
| --- | --- | --- |
| `pnpm typecheck` | **PASS** | `tsconfig.web.json`、`tsconfig.node.json`、`scripts/typecheck-scripts.mjs` 新增错误 `0` |
| `node scripts/test-all.mjs --audit` | **PASS** | `headless 525 · GUI 112 · NETWORK 42 · DATASET 18 · ARTIFACT 3 · pending 0`（`OK`） |
| `pnpm run test:thin-main` (`RC-23`) | **PASS** | 连续 20 次 UI 退出/重开，期间持续 Work/Cron/Gateway/Gadget/Note/Notification 活动；Core `coreGeneration` 与 `PiNodeHost` PID/`hostGeneration` 稳定不变，20 次离线通知与事件增量全量补读，`dedupedCount = 2`，`activeListeners` 严格归零，过期代次触发 `resynced: true` |
| `pnpm run test:thin-main` (`RC-24`) | **PASS** | 仅闲置隐藏标签与预览页被回收，保留可见页/未保存输入页/活跃任务页，唤醒后恢复 URL 与 `persist:extension-browser` 分区；离线代理返回 `waiting_platform`；`--resident-host` 不拉起第二业务宿主；`WorkPhase5Facts`/`DurableTaskProjection`/`DurableWorkspaceMoves`/`FileBackupService` 拒绝对话级静默回退；Dots 监控器定时器为 `undefined` |
