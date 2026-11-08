# Issue #17 实现记录（启动恢复与增量重复计算）

- 日期：2026-11-09
- 源码：`main@bba7fd99e52bf1be1513fad9ca6eb8e6cc8c4d97` + 本分支工作区改动（`measure:issue17` 记录 `worktreeDirty`）。本轮未打包、未发版。
- 运行环境：Linux（Wayland 桌面会话，`DISPLAY=:0` / `wayland-1`），Node `v26.13.0`，pnpm `12.14.0`，依赖 `pnpm install --frozen-lockfile`。
- 结论：A1 测量装置、A2 首窗刷新、A3 bootstrap 分级、A4/A5 恢复准入、B 读取放大、C 投影/对账/侧栏去重均已实现并有 headless 回归；**dev 模式启动已取得分段数据，但发布态/GUI 基线与 100/1,000/10,000 数据集未运行，不能据此宣称最终提速幅度。**

## 一、实现

| Issue 项 | 实现 | 关键位置 |
| --- | --- | --- |
| A1 启动分段 | 新增 `MYBUDDY_PERF_ISSUE17=1` 计量模式：主进程记录 `appReady/windowCreated/rendererLoaded/restoreDelivered/cronReady/gatewayRestored/memoryGatewayReady/remoteAccessReady`，renderer 经 `perf:mark` 上报 `bootstrapApplied/taskListInteractive`；报告含 `resume`（enumerated/delivered/failed/skipped/claimed/pending/maxConcurrent）。测量模式显示窗口并关闭后台节流，避免把隐藏页的 rAF 节流当成首屏 | `src/main/perf/startupMarks.ts`、`src/main/index.ts`、`src/preload/index.ts(.d.ts)`、`src/renderer/src/store/app/runtime/bootstrap.ts` |
| A1 脚本 | `measure:issue17:startup`：隔离 HOME/XDG 启动 `pnpm dev`，按 phase 采样 p50/p95；`--bindings=N` 先做 schema 预热再写入 N 条真实 `tasks`+`durable_bot_bindings` 后测量 | `scripts/core-performance-issue17-startup.cjs` |
| A2 首窗联网刷新 | 建窗前只 `refresh({allowNetwork:false})`；远端发现改后台（15s abort），完成后发 `models_changed`，renderer 重读目录且不覆盖已选模型；`models_changed` 不进入 remote `agent.patch` | `AgentService.init/discoverModelsInBackground`、`shared/agent-ipc.ts`、`agentProjection.ts`、`bootstrap.ts#reloadModelCatalog`、`RemoteEventBus.ts`、`RemoteAccessController.ts` |
| A3 bootstrap 分级 | 关键数据（spaces/tasks/projects/soul/models/settings）一次 `Promise.all`，失败即返回且不写半成品；技能/市场/专家/连接器各自独立加载与失败隔离，晚到响应不写关键分片；模型映射共用 `mapModelCatalog`，模型 ID Set 只构造一次 | `src/renderer/src/store/app/runtime/bootstrap.ts` |
| A4/A5 恢复准入 | `ResumeAdmission`：宽度上限（默认 4，可配）、FIFO、出队复查（binding/authority+Work/回收区）、失败释放名额、`claim` 前台接管、`cancel` 关闭；`resumePersisted` 记录 `lastResumeReport` | `src/main/agent/durable/ResumeAdmission.ts`、`DurableBotService.ts` |
| B1 列表批量读取 | `TaskExpertBindingService.list()` 单查询分块读取全部绑定；`AppDatabase.projectTaskRows` 用批量 reader，单条读取保持原 reader；未初始化绑定服务的数据库仍可列表 | `src/main/experts/TaskExpertBindingService.ts`、`src/main/db/AppDatabase.ts` |
| B2 工具配置复用 | `ToolGate` 每个同步权限阶段只读一次 Task/绑定；微任务边界失效，审批/资源等待后的复查必然重读。`AgentService` 以 Task 对象为键复用 assembly，并按 assembly 复用 selection | `src/main/agent/durable/ToolGate.ts`、`DurableBotService.openInternal`、`AgentService.durableAssembly/durableToolAllowed` |
| C 主进程投影 | `DurableTaskProjection` 每次 open 只 prepare 三条语句；`status`/`updated_at` 用 SQL 条件（`IS NOT`、`<`）判断，外部修改不会被内存缓存掩盖，时间只前进；消息工作区映射幂等 | `src/main/agent/durable/DurableTaskProjection.ts`、`DurableBotService.onSnapshot` |
| C 产物对账 no-op | 关联未变化返回原数组；外层无 Task 替换时不 `set`，不再每帧全任务 map + Store 通知 | `messageArtifactReconcile.ts`、`artifactProjection.ts` |
| C 侧栏同引用 | `sameSidebarTask` 先判 `previous === current`，未变化任务不重新派生展示状态 | `selectors.ts` |
| 远端投影 | `models_changed` 不推送 remote | `RemoteEventBus.ts`、`RemoteAccessController.ts` |

### 语义边界

- **前台不排队**：准入只在 `resumePersisted`；`history/prompt/abort/compact` 直连 `open()`，被点开的排队项由 `claim` 接管。
- **已打开的排队项仍执行一次 `resume()`**：`open()` 自带同任务去重，跳过会丢掉恢复义务。
- **`delivered` ≠ native 完成**：`runtime.resume()` 是同步 `void`；队列宽度不约束随后持续的 native 工作。
- **宽度 4 是临时值**，最终值需在发布态/大数据集下确定（提供 `resumeConcurrency` 覆盖）。
- **不缓存权限**：`ToolGate` 只在同一同步阶段复用，任何 await 之后都重读；未捕获权限结果做长期缓存。

## 二、验证

### headless（全部通过）

| 命令 | 结果 |
| --- | --- |
| `pnpm -s typecheck` | 通过（含 `typecheck-scripts`，0 新增错误） |
| `pnpm -s test:all` | **通过 396 · 失败 0 · 已知失败 0 · 新增回归 0**（2.9 min） |
| `pnpm -s test:durable-resume-admission` | 7 组：宽度/FIFO、失败释放名额、出队复查、前台 claim、取消、drain 共享、重复入队、enumerated |
| `pnpm -s test:durable-tool-gate` | 3 组：同阶段单次读取、跨微任务重读、await/reset 重读 |
| `pnpm -s test:durable-task-projection` | 语句只 prepare 一次；同值不写、外改不被缓存掩盖、`updated_at` 不回退、工作区幂等 |
| `pnpm -s test:app-store-transactions` | 15 组（新增：侧栏同引用、产物 no-op 保持引用与零通知、晚到目录保选择、bootstrap 分级、关键失败不写半成品） |
| `pnpm -s test:task-expert-binding` | 新增批量投影断言：一次绑定查询、单条读取一致、无绑定/未初始化服务不炸 |
| 另跑 | `durable-bot`、`durable-session-recovery`、`durable-projection`、`durable-sync`、`remote-access`、`durable-history-block`、`durable-workspace-binding`、`bot-work-phase2-recovery`、`artifact-projection`、`core-performance`、`model-refresh`、`model-catalog-update`、`pi100-model-admission`、`model-scope-stale-heal`、`app-store-structure`、`architecture-graph`、`ipc-channel-inventory` |

> 一次 `test:all` 中 `test:gateway-delivery-journal` 在并行负载下超时（fixture timeout）；单独运行与随后完整重跑均通过，未改其代码或基线。`ipc-channel-inventory` 因新增 `perf:mark` 更新了冻结基线（`artifacts/ipc-channel-baseline.json`，仅 +1 channel）。

### A1 dev 启动分段（0 与 30 个 Durable 绑定）

命令：`pnpm -s measure:issue17:startup --runs=3 --bindings=0|30`（隔离 HOME，`pnpm dev`，3 次；p50/p95，ms）。原始数据：`artifacts/performance/issue-17/<sha>/<run-id>/startup-dev.json`。

| 阶段 | 0 绑定 p50 / p95 | 30 绑定 p50 / p95 |
| --- | --- | --- |
| appReady | 729 / 744 | 711 / 714 |
| windowCreated | 1096 / 1122 | 882 / 889 |
| restoreDelivered | 1121 / 1150 | 1395 / 1774 |
| cronReady | 1121 / 1150 | 1396 / 1774 |
| gatewayRestored | 1121 / 1150 | 1396 / 1775 |
| memoryGatewayReady | 1122 / 1151 | 1397 / 1775 |
| remoteAccessReady | 1122 / 1151 | 1397 / 1775 |
| rendererLoaded | 5953 / 6185 | 5883 / 6157 |
| bootstrapApplied | 6192 / 6387 | 6115 / 6496 |
| taskListInteractive | 6348 / 6543 | 6238 / 6607 |

- 30 绑定时恢复排空（`restoreDelivered − windowCreated`）≈ 0.5s（p50）/ 0.9s（p95），`enumerated=30`、`maxConcurrent=4`、全部 delivered、无失败/跳过；0 绑定时排空 ≈ 25ms。
- 之后 cron/gateway/memoryGateway/remoteAccess 在 +1ms 内就绪（空通道），说明 `await resumePersistedTasks()` 之后的服务启动确实被排空时间推迟。
- **dev 口径包含 electron-vite 启动与源码映射**：`rendererLoaded≈5.9s` 不代表发布态；本表只能用于同机同模式的前后对照，不能当作绝对启动时间或改进幅度。

### 合成测量（不是应用耗时）

`pnpm -s measure:issue17` → `artifacts/performance/issue-17/<sha>/<run-id>/raw.json`：

- 侧栏 selector（500 任务 × 20 消息 × 200 次）：同引用 p50 0.058ms / p95 0.101ms；不同对象（仍走比较）p50 0.305ms / p95 0.805ms。
- 产物对账（200 消息 × 500 次无变化）：`noOpNotifications=0`、`tasks` 引用不变、p50 0.015ms / p95 0.035ms。
- 恢复准入（200 项、宽度 4、合成 2ms open）：117ms、`maxConcurrent=4`、200 delivered。

以上均不含 Electron 启动、React 提交、IPC、SQLite 页缓存或 provider 延迟，不能替代真实操作改善。

## 三、未完成 / 未验证

- **发布态与 GUI**：`test:all:gui`、`test:all:artifacts`、打包产物启动均未运行（按工作流未 build/pack）。实测 `test:durable-bot-desktop`、`test:task-status-dot-desktop`、`test:sidebar-space-collapse-desktop` 均停在 "app ready"/"sidebar mounted" 超时：工作区没有 `out/renderer`（只有 `pnpm dev` 生成的 `out/main`），桌面用例加载不到生产 renderer。GUI 门禁需要先 `pnpm build`，属于未授权的发布工作流。A1 的绝对基线必须在授权构建后用相同脚本与相同数据集复测。
- **大数据集**：100/1,000/10,000 任务与 2,000/10,000 持久消息未运行；当前只验证 0 与 30 个真实 Durable 绑定。
- **renderer React 提交**：未采集每帧 Store 通知 → React commit 计数与真实输入延迟。
- **D 条件项**：Bot 回合缓存、消息行订阅、超大代码块高亮、虚拟列表测量、内存回收、图片/预览资源均未改动，需按 Issue D 以复现证据决定。
- **联网/provider 场景**：模型发现的缓存冷/热、无凭据/有凭据、刷新失败/超时未单独采样。
- **可获取的原始证据**：`artifacts/*` 被 `.gitignore` 忽略，本轮 raw JSON 未随仓库提交；`measure:issue17` 与 `measure:issue17:startup` 可复现（夹具、种子、参数在脚本内）。

## 四、后续

1. 授权构建后跑发布态 A1（同脚本、同数据集），据此确定 `DEFAULT_DURABLE_RESUME_CONCURRENCY`。
2. 扩展数据集到 100/1,000/10,000 任务与长会话，补齐 React 提交与输入延迟。
3. 按测量结果处理 D 条件项与网络型模型发现场景。
