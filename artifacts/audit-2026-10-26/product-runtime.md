# MyBuddy 产品 / 运行时遗留问题审计（2026-10-26）

> 审计者：product-auditor（Team 子代理）· 对应 shared task `task-4`
> 仓库：`/home/vivion/github/wavealstra_harness`（审计开始时 HEAD `230e8b1`，工作树干净；审计期间其他 Team 成员在各自范围内有产物写入，与本报告的只读结论无关）
> 环境：Linux / Wayland（Omarchy），Electron 44.5.1，`@earendil-works/pi-coding-agent` 1.3.0，better-sqlite3 13.0.3
> 数据：`~/.mybuddy/app.db`（WAL）、`~/.config/wavealstra_harness`（userData）
> 结论标注：**【已验证】**= 有代码行/命令输出/SQL 聚合直接支撑；**【推测】**= 由间接证据推断，需人工复核。

## 0. 方法与边界

- 数据库全程只读：`sqlite3 'file:/home/vivion/.mybuddy/app.db?mode=ro' ...`，只输出表名、计数、状态聚合，**未输出任何密钥/token/凭据/对话正文**。
- 文件、目录、进程、`systemd-coredump`、`journalctl` 均为只读访问。
- **未**启动/重启 Electron 实例，**未**调用真实模型或网络请求，**未**运行 `test:all`、未改源码/配置/数据、未 git commit/push。
- 运行中的 dev 实例（PID 223757 / 224446）保持原状，仅旁路观察。
- 旧审计 `artifacts/quality-audit/`（2026-10）与 `docs/reviews/` 的结论**全部重新核实**，下文只登记当前代码/数据仍成立的部分。

---

## 1. 真实数据健康度（只读）

### 1.1 基本事实

| 指标 | 值 | 说明 |
|---|---|---|
| `PRAGMA user_version` | 27 | 与代码 `CURRENT_DATABASE_SCHEMA_VERSION = 27` 一致（[AppDatabase.ts:58](../../src/main/db/AppDatabase.ts#L58)） |
| `PRAGMA quick_check` | `ok` | 文件未损坏 |
| `journal_mode` | `wal` | 正常 |
| 文件大小 / 页数 | 1,167,360 B / 285 页（4 KiB） | `freelist_count = 0`，即 1.2 MB 全是 schema 页 |
| `sqlite_master` | 92 表 / 177 索引 / 3 触发器 | 与代码建表数量级吻合 |
| WAL | `app.db-wal` 16,512 B（4 帧），`app.db-shm` 32,768 B | 最后写入 17:30:51，此后约 3.8h 无 DB 写入 |

### 1.2 数据分布（聚合）

| 表 | 行数 | 备注 |
|---|---|---|
| `tasks` | **0** | 无任何任务 |
| `spaces` / `projects` | 0 / 0 | |
| `conversation_branches` / `conversation_goals` / `conversation_interactions` | 0 / 0 / 0 | |
| `gateway_messages` / `memory_turns` / `artifact_message_refs` | 0 / 0 / 0 | 库里**不存在** `sessions`/`messages` 表；会话正文走 Pi JSONL（`tasks.session_file`），但 `~/.mybuddy` 下无 sessions/durable 目录 |
| `execution_failures` | 0 | 无记录的失败执行 |
| `usage_events` / `notifications` / `cron_runs` | 0 / 0 / 0 | 近 7 天**无任何错误事件落库** |
| `memory_records` / `memory_evidence` / `memory_embeddings` / `memory_turns` / `memory_pipeline_state` | 全 0 | Memory Kernel 无数据、无流水线状态 |
| `library_items` / `library_chunks` / `library_chunk_embeddings` | 0 / 0 / 0 | Library 空 |
| `semantic_index_jobs` | **1** | `status=pending`、`processed=0`、`failed=0`、`error="model not_installed"` |
| `soul` | 1 | 出厂 persona（只读长度核对，未输出内容） |
| `library_index_state` | 1 | `text-fts-coverage-version=2` |

### 1.3 结论

- **F1.1【已验证·P1】生产库实际是「空 schema」，没有任何用户任务/会话/记忆数据。**
  1.2 MB 体积来自 92 表 + 177 索引，与"数据量"无关。`~/.mybuddy` 目录 birth 为 2026-10-26 16:28:45，`app.db` birth 同为 16:28:45、mtime 17:30:15；`~/.mybuddy/task-workspaces`、`library`、`subagent` 均为空。
  - 佐证：`~/.mybuddy/task-workspaces`、`library` 为空目录；`subagent/` 只有 `active.json`；无 `sessions/`、无 `durable/`。
  - 影响：任何以"真实数据"为前提的验收（记忆、历史会话、用量、Artifact 回放）在本机都无法被真实验证；当前 dev 实例读到的就是空库。
  - 【推测】两种可能：①这是为审计临时重建的干净 profile；②旧 profile 被替换/清空。仅凭文件系统无法区分，需用户确认是否丢失过历史数据。
- **F1.2【已验证·P1】数据库版本不一致时，启动器无条件删除真实库（含 WAL/SHM），无备份、无用户提示。**
  - 证据：[AppDatabase.ts:220-249](../../src/main/db/AppDatabase.ts#L220) `resetIncompatibleDatabaseFile()` 对 `db / -wal / -shm` 直接 `rmSync`；[AppDatabase.ts:251-252](../../src/main/db/AppDatabase.ts#L251) 构造函数第一行调用它，**没有** `app.isPackaged` / `is.dev` / 环境门禁，注释里的 "development schema reset" 只是文案。
  - 触发条件：任何 `user_version !== 27` 的库（降级、回滚、迁移中断、手工导入旧备份）都会在打开前被静默删除，随后重建为空库。
  - 建议：a) 改名/备份为 `app.db.discarded-<ts>` 再重建；b) 至少 `app.isPackaged` 时不自动删，改为报错并引导恢复；c) 启动时把 reset 事件写入可见通知（`notifications` 表）而非只 `console.warn`。
- **F1.3【已验证·P3】语义索引任务自 17:30 起永久停在 `pending`，错误字段写着 `model not_installed`，没有失败计数/重试上限/用户提示。**
  - 证据：`semantic_index_jobs` 行状态如上；写入口 [LibraryService.ts:1436-1455](../../src/main/library/LibraryService.ts#L1436) 在 `SemanticModelManager.getStatus() !== "ready"` 时 `updateJob("pending", null, "model " + status)` 后直接 return。启动时每次都会 `ensureJob()` 一次，但状态永远不前进。
- **F1.4【已验证·P3】近 7 天错误事件为 0 是指"没有错误被记录"，不代表"没有错误发生"**：DB 里没有统一的运行错误表；执行失败只走 `execution_failures`（当前为空），gateway/cron 失败只写各自表。诊断信息主要依赖外部日志（见 F2.2）。

---

## 2. 运行时证据（只读）

### 2.1 当前 dev 实例

| 项 | 值 |
|---|---|
| electron-vite dev | PID 223757，启动 17:30:18，已运行约 3h44m，RSS ≈ 580 MB |
| Electron 主进程 | PID 224446，启动 17:30:49，RSS ≈ 305 MB；`SingletonLock -> omarchy-224446`（与主进程 PID 一致，无残留锁） |
| 子进程 | zygote ×3、GPU、network、renderer（PID 224722，RSS ≈ 233 MB）共 12 个 Electron 进程，属正常结构 |
| 重复实例 / zombie | 无（仅 1 个 electron-vite、1 个主进程；`ps` 无 `Z` 状态） |
| 窗口 | Hyprland 合成器无对应 client；但 `org.freedesktop.StatusNotifierItem-224446-1` 存在，`closeToTray` 默认 `true`（[AppSettingsStore.ts:187](../../src/main/AppSettingsStore.ts#L187)）——**【推测】窗口被关闭进托盘，属预期行为，不是窗口未加载** |
| 日志 | 唯一应用日志 `/home/vivion/github/.tools/dev.log`（27 KB，281 行），最后写入 18:23:43（一次 HMR）；其后无输出（空闲）。日志里没有错误、没有 `did-fail-load`、没有 `render-process-gone` |
| userData | `~/.config/wavealstra_harness` 55 MB；`Crashpad/` 只有 `client_id`（36 B），**0 个崩溃报告**；`DIPS` 36 KB + `DIPS-wal` 74 KB 正常 |

### 2.2 崩溃证据

- **F2.1【已验证·P1，原因推测】当天 17:26–17:30 主进程发生 4 次 `SIGILL`（非法指令）原生崩溃，均留下 25–28 MB core dump，应用自身无任何记录。**

| PID | 时间 | 信号 | core 大小 | 同签名栈顶 |
|---|---|---|---|---|
| 215771 | 17:26:36 | SIGILL (`ILL_ILLOPN`) | 26.1 MB | `electron + 0x937f521` |
| 218605 | 17:28:10 | SIGILL (`ILL_ILLOPN`) | 25.8 MB | 同上 |
| 222056 | 17:29:22 | SIGILL (`ILL_ILLOPN`) | 25.3 MB | 同上 |
| 223348 | 17:30:15 | SIGILL (`ILL_ILLOPN`) | 27.6 MB | 同上 |

  - 命令行均为 `.../electron/dist/electron --disable-component-update --disable-background-networking .`（主进程，非 GPU/renderer）；内核日志 `traps: electron[...] trap invalid opcode`；四份栈完全同形（ASLR 后同偏移）。
  - 时间点与 `journalctl` 中 `.tools/mybuddy.sh restart`（17:26:36 等）重合。该脚本 `stop` 用 `pkill -f`（默认 SIGTERM）→ **【推测】崩溃发生在优雅退出/重启路径**，而不是运行期间；当前实例（17:30:49 起）已稳定 3h44m，说明不是必现启动崩溃。
  - 影响：若退出路径会 SIGILL，关闭/重启时可能丢失未落盘状态（例如刚刚排队但未提交的输入），且**用户与开发者都不会被告知**。
  - 建议：用 core dump 符号化（`electron` 调试符号 / `coredumpctl gdb`）确认帧；同时用一个最小复现（启动后立刻 SIGTERM）区分"退出路径 bug"与"V8/native 模块（`@napi-rs/keyring` 在 module 列表中被点名）在 teardown 期非法指令"。
- **F2.2【已验证·P2】崩溃/失败可观测性缺口**
  - 代码未初始化 `crashReporter`（全仓库 0 处 `crashReporter`），Crashpad 因此永远为空，原生崩溃只进系统 coredump（需要 root 工具才能看到）。
  - `did-fail-load` / `render-process-gone` / `child-process-gone` 只 `console.error`：[index.ts:575-581](../../src/main/index.ts#L575)、[index.ts:3432-3434](../../src/main/index.ts#L3432)，打包版用户看不到，也没有重载/提示。
  - dev 日志每次 `start` 被 `>` 覆盖（`.tools/mybuddy.sh` 第 24 行），**本次 4 次崩溃没有留下任何应用侧日志上下文**；`~/.config/wavealstra_harness` 下也没有应用日志目录。
  - 建议：`crashReporter.start()` + 把 `render-process-gone`/`child-process-gone` 升级为可见通知（`notifications`）+ 日志轮转（`.1` 备份），并在 `~/.mybuddy/logs/` 落一份可导出的运行日志。

---

## 3. 文档承诺 vs 代码（「承诺了但没做完」前 8 项）

> 排序：影响用户/安全优先。旧审计里已修复的结论不在此列（见 §3.9 复核结果）。

### 3.1【P2 · 已验证】语义索引 / 记忆 embedding 没有安装入口，相关能力实际永久关闭

- 承诺：`docs/r3-cpu-cost.md`、`docs/r3-review-baseline.md` 描述 R3 语义检索（BAAI/bge-m3 INT8）已评测、可融合进检索；[SemanticModelManager.ts:1-15](../../src/main/retrieval/SemanticModelManager.ts#L1) 注释写"model downloaded on demand to userData"。
- 现实：
  - 模型目录 `~/.mybuddy/models/semantic/bge-m3-int8-v1/` 不存在（`~/.mybuddy` 下只有 `models.json` / `models-store.json`）。
  - `SemanticModelManager.download()`（[SemanticModelManager.ts:240](../../src/main/retrieval/SemanticModelManager.ts#L240)）**全仓库没有任何调用点**；没有 IPC、没有 UI 按钮、没有脚本。模型只能靠人工放置约 541 MB 的 `model.onnx` + `.data` + tokenizer（`docs/r3-cpu-cost.md` 记录的还是 `C:\tmp\bge-poc\...` 路径）。
  - 于是 `MemorySemanticProvider`/`WorkspaceSemanticProvider` 永远抛 `SemanticUnavailableError`（[SemanticRuntime.ts:48](../../src/main/retrieval/SemanticRuntime.ts#L48)），记忆语义召回、Library 向量检索只剩 FTS/词法回退；DB 里 `semantic_index_jobs` 的 `pending + model not_installed` 就是直接证据（F1.3）。
- 建议：补 `semanticModel.install()` IPC + 设置页入口（下载/校验/进度/失败原因），或在 UI 明示"语义检索未启用"；至少把 `getSemanticModelStatus` 接到设置页。

### 3.2【P2 · 已验证】WorkGraph 的 Phase 6 首版 UI 已实现但从未挂载，用户不可达

- 承诺：[workgraph-adr.md:209](../../docs/workgraph-adr.md#L209) 明确 Phase 6 首版 UI：Entity detail panel 内 Related / Depends on / Produced / Derived from，支持添加/删除/跳转。
- 现实：`WorkGraphInspector.tsx`（194 行，实现完整：listRelated、addEdge、removeEdge、跳转、错误提示）**全仓库仅自引用**——没有任何 import/mount/route（`grep -rn WorkGraphInspector` 只命中它自己）。后端（Service/Repository/IPC/Integrity）与 Agent 扩展都在线（[index.ts:2028-2056](../../src/main/index.ts#L2028)），唯独 UI 没有接线。
- 影响：图谱能力对用户完全不可见，等于"只有后端"。
- 建议：挂到 Task/Workspace/Project 详情面板（或先做只读入口），并加最小 UI 冒烟测试（渲染 + 添加/删除一条 edge）。

### 3.3【P2 · 已验证，下线意图推测】OpenDesign 集成文档写"已实现"，代码已把 provider 退役

- 承诺：[opendesign-integration.md](<docs/opendesign-integration.md>) 与 [opendesign-integration-plan.md](<docs/opendesign-integration-plan.md>) 均标注「状态：**已实现**」，描述 `OpenDesignRuntime`、`od mcp` 注入、preset「AI 设计引擎 · OpenDesign」、降级矩阵。
- 现实：
  - `opendesign` 已被列入退役 provider：[professional-tools.ts:31](../../src/shared/professional-tools.ts#L31) `RETIRED_MANAGED_PROVIDER_IDS = ["ardot-local","blender","freecad","opendesign"]`。
  - `src/main/professional-tools/` 下**没有** `OpenDesignRuntime.ts`；`mode-defaults.ts` 没有 opendesign preset；只剩链接策略 `isBareOpenDesignDaemonUrl`（[link-policy.ts:41-63](../../src/shared/link-policy.ts#L41)）说明"裸根无 Web UI，有 HTML 产物才预览"。
  - 仓库只有一个初始提交，无法从历史判断是否为有意下线；**【推测】**产品已主动退役但两篇文档没更新。
- 影响：新成员/第三方 AI 会按文档去找不存在的 preset 与 runtime，浪费排查时间；用户也拿不到文档承诺的设计引擎路线。
- 建议：二选一——要么更新两篇文档为"已退役（原因/替代方案）"，要么恢复实现；不要保留"已实现"的状态标记。

### 3.4【P2 · 已验证】产品/Agent 文档版本信息严重过期，会误导实现判断

| 文档 | 文档写的 | 实际（`package.json` / 代码） |
|---|---|---|
| [STATUS.md:4](<docs/STATUS.md>) / :31-33 | 最后核对 2026-08-08；Electron ^37；electron-vite ^4；TS ^5.8；`pi-coding-agent` **^0.83** | Electron **44.5.1**；electron-vite **5.0.0**；TS **7.0.2**；pi-coding-agent **1.3.0** |
| [AGENTS.md:6](<AGENTS.md>) | "只支持当前 Pi 版本（**1.0.4**）" | `package.json` 与 worker pin 均为 **1.3.0**（[worker-launcher.mjs:11](../../src/main/capabilities/subagent/worker-launcher.mjs#L11)） |
| [pi104-upgrade-20261007.md](<docs/pi104-upgrade-20261007.md>) | 以 1.0.4 为"当前" | 已被 1.3.0 取代 |

- 影响：STATUS.md 自我定位是"供第三方 AI / 开发者快速了解本项目"的入口文档，版本错误会直接导致按旧 API 写代码；AGENTS.md 是每个 agent 的必读规则。
- 建议：改 STATUS.md 为"版本由 package.json 唯一真源，这里不再抄写具体版本"；AGENTS.md 的 Pi 版本改为引用 `EXPECTED_PI_VERSION`，避免再次漂移。

### 3.5【P3 · 已验证】执行验证（verifier）只有 process-exit 一个适配器，验证证据 UI 未落地

- 文档自认：[mybuddy-core-convergence-plan-2026-09-12.md:178](<docs/mybuddy-core-convergence-plan-2026-09-12.md>)：edit、bash、MCP、CAD、委托/子 Agent 还没有读回适配器；通用 verifier 注册、验证证据 UI、其它工具修改产物的失效规则仍待实现。
- 现状：`ExecutionVerifierRegistry` 只注册了 `process-exit-code` 一个 verifier（[ExecutionVerifierRegistry.ts:49-66](../../src/main/agent/ExecutionVerifierRegistry.ts#L49)）；内置 write 有读回校验（`VerifiedCodeExecution`），但 renderer 里只有外部 Agent 的 "workspace_observed" 徽标，没有统一的"验证证据"面板。
- 建议：在计划的阶段里显式标注"已做/未做"，不要用 30% 源码 grep 测试冒充行为验证；至少为 edit/bash 补一个读回 verifier 和 UI 证据入口。

### 3.6【P3 · 已验证】Remote（Android）评审 P1-2 未收敛：单文件继续膨胀

- 评审基线：[remote-architecture-review-2026-09-12.md:177](<docs/remote-architecture-review-2026-09-12.md>) 指出 `App.tsx` 1699 行 + `app.css` 1852 行。
- 现状：`app/remote/src/App.tsx` **1998 行**（+17.6%），`app/remote/src/styles/app.css` **2762 行**（+49%）；P0-2 的控制项虽然接线了（见 §3.9），但都堆进了同一个文件。
- 建议：按 sheet/路由拆 `App.tsx`（composer / task list / session / settings），CSS 拆到组件级；先搬迁不改行为。

### 3.7【P3 · 已验证】Remote 评审 P1-7 未收敛：`adb reverse` 只在安装包缺失时移除

- 证据：[RemoteUsbBridge.ts:66-71](../../src/main/remote/RemoteUsbBridge.ts#L66) 建立 `adb reverse` 后，只有在 `pm path com.mybuddy.remote` 失败时才 `reverse --remove`；没有在 USB Bridge 关闭、服务停止、设备断开时回收。`grep -rn "reverse --remove"` 全仓库仅此一处。
- 影响：端口转发残留（`tcp:3352` 一直占用），换设备/重装后可能连到错误实例；用户侧表现为"USB 配对连不上但看不出原因"。
- 建议：在 `RemoteUsbBridge.stop()/dispose()` 与 `app.will-quit` 里按 serial 回收，并在错误路径提示。

### 3.8【P3 · 已验证，影响面推测】Computer Use 多显示器未实现；非 Windows 平台完全不可用，但设置页仍列 `computer_exec`

- 文档自认：[computer-use-assessment-20261019.md:323](<docs/computer-use-assessment-20261019.md>)：`list_displays` 尚未实现；`image_scale>1` 时 legacy 桌面坐标仍需人工换算。
- 代码：全仓库 `list_displays` 0 命中；`ComputerAutomationService.available` 只在 `process.platform === "win32"` 为真（[ComputerAutomationService.ts:458](../../src/main/capabilities/ComputerAutomationService.ts#L458)），非 Windows 时 `computer_exec` 抛 "当前仅支持 Windows"（同文件 :563）。
- 但能力页把 `computer_exec` 默认列在"界面与桌面操作"工具里（[CapabilitiesTab.tsx:515-522](../../src/renderer/src/components/settings/CapabilitiesTab.tsx#L515)）；本机 Linux 用户会看到一个不可用的桌面工具入口（状态由 runtime 决定，**【推测】**若状态取 availability 则应显示不可用，但工具名仍会被展示）。
- 建议：按平台过滤/禁用 `computer_exec` 入口并给出"仅 Windows"说明；`list_displays` 与坐标系换算作为 P1 尾部收口（多显示器是常见场景）。

### 3.9 复核后**不成立**的旧结论（避免复述过期结论）

- Remote 评审 P0-1（Origin 校验形同虚设）：**已修**——`RemoteAccessServer.originAllowed()` 白名单 + 非白名单 403（[RemoteAccessServer.ts:125-160](../../src/main/remote/RemoteAccessServer.ts#L125)），CORS 只回显已放行 Origin。
- Remote 评审 P0-2（四个控件没接线）：**已修**——契约新增 `modelId` / `permissionMode` / `attachments`（`shared/src/remote-contract.ts` 的 `RemotePromptRequest`），手机端真实上传附件、下发权限与模型（`app/remote/src/App.tsx` 的 composer/AddToChat 仅发送恢复草稿已在注释里记录为 P1 修复）。
- Remote 评审 P1-4（SSE 乐观上报）：**已修**——`RemoteEventBus` 有事件 id 与短期 `replayAfter(lastEventId)`（[RemoteEventBus.ts:76-84](../../src/main/remote/RemoteEventBus.ts#L76)），服务端从 `last-event-id` 恢复。
- Spike 决策：shiki / monaco / docx-preview / SheetJS / pptxgenjs 均已被实际引用（`src/renderer/src/lib/codeHighlight.ts`、`monacoLazy.ts`、`src/main/artifact/*`），spike 文档里未勾选的"后续动作"属于文档未回勾，不是功能缺失。
- `docs/reviews/` 的持久化/压缩类结论：当前代码已有对应修复与注释（如 `loadTaskHistory` 的"空 projection 伪装正常空会话"事故修复，见 §4.4），本次未发现回归。

---

## 4. 用户可见错误路径与静默失败

### 4.1 结论先行

关键交互路径（发送失败、历史打不开、重新生成失败、恢复故障）**大多已具备用户可见反馈**，代码里有明确的事故修复注释，不应再说"全面静默失败"。真正的静默点集中在**"能力不可用"与"设置/后台任务失败"**两类：用户不会收到提示，只会感觉"功能没有/设置没生效"。

### 4.2 静默失败清单

| # | 位置 | 现象 | 用户可见？ | 严重度 | 结论 |
|---|---|---|---|---|---|
| S1 | [MemoryService.ts:735-776](../../src/main/memory/MemoryService.ts#L735) | 语义检索不可用时直接词法回退，`SemanticUnavailableError` 被吞掉（非该错误才 warn） | 否 | P2 | 已验证；设计上允许回退，但应至少一次提示"语义检索未安装模型" |
| S2 | [appStore.ts:4795-4799](../../src/renderer/src/store/appStore.ts#L4795) | 思考偏好保存失败：只 `console.error` 并回滚本地值 | 否 | P3 | 已验证；用户会以为设置已保存 |
| S3 | [appStore.ts:2763-2765](../../src/renderer/src/store/appStore.ts#L2763) | 外部模型配置刷新失败：warn + 保留旧选择 | 否 | P3 | 已验证；模型目录可能默默过期 |
| S4 | [index.ts:1970-1979](../../src/main/index.ts#L1970) | `getSemanticIndexStats` 异常 → `{running:false}`；`getSemanticModelStatus` 异常 → `{status:"failed"}` | 否（且 renderer 未调用） | P3 | 已验证；IPC 把异常伪装成正常默认值 |
| S5 | [AgentLoadoutObservationService.ts:37-56](../../src/main/agent/AgentLoadoutObservationService.ts#L37) | 读观测/规则失败 → 返回空数组/默认 rules | 否 | P3 | 已验证；Loadout 推荐静默为空 |
| S6 | [index.ts:3432-3434](../../src/main/index.ts#L3432)、:575-581 | 渲染进程/子进程崩溃只写 console | 否（打包版） | P2 | 已验证；见 F2.2 |
| S7 | 全仓库无 `uncaughtException` / `unhandledRejection` 全局兜底（`grep` 仅子代理/gadget 内部有） | 主进程未捕获异常时行为取决于 Electron 默认 | 部分（stderr） | P3 | 已验证；建议补全局兜底 + 可见通知 |

### 4.3 已具备可见反馈的代表性路径（正面，供对照）

- 发送被主进程拒绝：`sendMessage` 的 `result.error` → Bot 写 `botInputError`，普通任务给 assistant 追加 error 块（[appStore.ts:3905-3930](../../src/renderer/src/store/appStore.ts#L3905)）。
- 历史加载失败：注释直接写明"空 projection 会伪装成正常空会话（真实事故）"，失败写入 `historyError` 并由 ChatView 渲染横幅（[appStore.ts:3360-3370](../../src/renderer/src/store/appStore.ts#L3360)、[ChatView.tsx:902-905](../../src/renderer/src/components/chat/ChatView.tsx#L902)）。
- 重新生成失败：`failPending("[code] message")`，旧回复保留（[appStore.ts:4183-4209](../../src/renderer/src/store/appStore.ts#L4183)）。
- 执行恢复：`TaskRecoveryNotice` 显示恢复分类、阶段、causeCode、副作用与下一步（[TaskRecoveryNotice.tsx](<src/renderer/src/components/chat/TaskRecoveryNotice.tsx>)），关闭只隐藏不伪装已解决。
- 模型缺失：`BotModelCatalog` 抛"当前没有可用模型：请在设置 → 模型中启用一个模型后重试"（[BotModelCatalog.ts:108](../../src/main/agent/durable/BotModelCatalog.ts#L108)），主会话侧 `AgentService` 也有明确报错。

### 4.4 长任务 / 重试 / 网络失败

- 重试与退避在 Pi SDK/`provider-retry` 层，主进程另有 `ModelInvocationAdmission`；UI 有停止按钮与 queued/steer/interrupt 三种语义。
- 未发现"长时间无输出"的 watchdog（`grep stall/watchdog` 无命中）；流式中断依赖 SDK 事件，若 SDK 无事件则 UI 只能等用户手动停止。**【推测】P3**，建议在 UI 层加"静默超过 N 秒"提示（不自动中断）。

---

## 5. 运行中的 dev 实例状态（只读观察）

- 未见启动错误：`dev.log` 只有 Rollup 对 zod 注释的告警和构建输出；主进程日志仅 `[index] 任务执行工作区路径重绑完成：cwd=0, trash_path=0`、`[Tray] 系统托盘已初始化`。
- 无重复实例、无 zombie、无 stale singleton；tray 项存在，窗口进托盘属预期。
- 唯一异常是 17:26–17:30 的 4 次 SIGILL 崩溃（F2.1），全部发生在当前实例启动之前；当前实例稳定。
- 需要**特别提醒**：dev 实例直接使用生产路径 `~/.mybuddy/app.db`（`getDbPath()` 固定 `join(homedir(), ".mybuddy")`，与 `user-data-dir` 无关，[paths.ts:13-17](../../src/main/paths.ts#L13)、[paths.ts:182-184](../../src/main/paths.ts#L182)）。因此"跑 dev / 改 schema"会直接作用于真实 profile；再叠加 F1.2 的无条件删库，风险是实打实的。

---

## 6. 取证命令（可复现）

```bash
# 数据（只读）
sqlite3 'file:/home/vivion/.mybuddy/app.db?mode=ro' 'PRAGMA user_version; PRAGMA quick_check; PRAGMA page_count; PRAGMA freelist_count;'
sqlite3 'file:/home/vivion/.mybuddy/app.db?mode=ro' "SELECT COUNT(*) FROM tasks; SELECT status,error FROM semantic_index_jobs;"
# 崩溃
coredumpctl list --no-pager | tail -6
journalctl --since '2026-10-26 17:24' --until '2026-10-26 17:32' --no-pager | grep -iE 'electron|trap invalid'
# 进程/窗口/托盘
pgrep -af 'electron-vite.js dev'; readlink ~/.config/wavealstra_harness/SingletonLock
gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.ListNames | grep StatusNotifierItem
# 承诺交叉验证
grep -rn "WorkGraphInspector" --include=*.tsx src | grep -v 'WorkGraphInspector.tsx'
grep -rn "\.download(" src/main/retrieval
```

---

## 7. 不确定处（需人工确认，不要据此单独下结论）

1. **空库是否意味着历史数据丢失**：`~/.mybuddy` 目录 birth = 16:28:45（今天），无法区分"新 profile"与"旧 profile 被替换"；需用户确认是否曾在此机器产生过任务/记忆。
2. **SIGILL 根因**：四份 core 同一签名、无符号；"退出路径 / V8 teardown / native 模块"三种可能都未排除，需要符号化复现（启动后立即 `kill -TERM` 多次）。
3. **OpenDesign 退役是否有意**：仓库只有一个初始提交，没有退役提交说明；文档未同步更新，不能断言是 bug 还是文档债。
4. **WorkGraph UI 是否预期在后续 Phase 挂载**：ADR 写 Phase 6/9，代码注释也是"Phase 6/9 UI"，可能只是尚未接线；但按当前 HEAD，用户确实不可达。
5. **语义模型是否产品上就设计为"手动放置"**：`SemanticModelManager` 注释写"downloaded on demand"，但没有任何 on-demand 触发点；需产品确认。

---

## 8. 优先级建议（按投入产出）

1. **P1**：DB 版本不一致改为"备份 + 报错/通知"，禁止静默删库（F1.2）；dev 实例禁止指向生产 profile（或至少启动时高亮提示）。
2. **P1**：SIGILL 退出路径符号化定位 + `crashReporter` / 崩溃可见通知 / 日志轮转（F2.1、F2.2）。
3. **P2**：语义模型安装入口 + 状态展示（3.1）；WorkGraph UI 接线（3.2）；OpenDesign 文档改状态（3.3）；文档版本真源化（3.4）。
4. **P3**：Remote 结构拆分与 `adb reverse` 回收（3.6/3.7）；Computer Use 平台过滤与 `list_displays`（3.8）；静默失败点补提示（4.2）。
