# T4 — fail-loud services-context 复核报告（只读核查）

- 仓库：`C:\Users\servi\Documents\GitHub\wavealstra_harness`
- 核查对象：`src/main/index.ts`（3463 行，HEAD = `9f90f4e`）
- 待验证声明（规划 Phase 2.1）：*「index.ts 有约 33 个模块级 let（L294-373）在 whenReady 里赋值，handler 闭包读调用时的值，未初始化时静默消失；应建 main/services-context.ts 让 getService(name) 未赋值时抛错。remoteAccessController 这类合法可空保留可选链，需先列出两类清单。」*
- 本次结论：**推翻（refutes_parent = true）**。主因：模块级 `let` 实测 **47** 个（不是 33），且 L294-373 内不存在任何自然子集等于 33；次因：存在合法地在赋值前被读取的时序（`trayService` 在 `app.on("second-instance")` 中，该监听器 import 期注册、而 `trayService` 直到 whenReady 末尾的 `createWindow()` 内才赋值）。
- 标注约定：**【实测】**= 本次用脚本/读取直接得到并可复现；**【推断】**= 基于代码结构与运行时语义的推论，未在本机执行验证。

---

## 0. 方法与可复现命令【实测】

```powershell
# 1) 模块级 let 计数与分类
Get-Content src/main/index.ts | Select-String -Pattern '^let\s'
# 2) 每个变量的赋值点 / 可选链读点 / 其它读点（脚本统计）
#    见 §1 §3 的表格与行号
# 3) 测试脚本如何引用 index.ts
Get-ChildItem -Recurse -File -Include *.ts -Path scripts | Select-String -Pattern 'src/main/index\.ts'
# 4) 门禁排除模式
Select-String -LiteralPath scripts/test-all.mjs -Pattern 'EXCLUDE_PATTERNS' -Context 0,25
```

核查过程为只读；唯一写入即本报告文件 `out/plan-review/T4-fail-loud-context.md`。

---

## 1. 模块级 `let` 的精确数量与逐条清单【实测】

**实测总数：47 个，起止 L294–L373。**

- `L294–L331`：36 个（该区间 38 行，其中 L309、L311 是注释）
- `L355–L373`：11 个（L357/359/361/363/365/370 为注释，L367 是函数调用、L368 是 `const mcpService`）
- 47 = 36 + 11
- 模块级 `var`：0 个；L294 之前（L1–L293）模块级 `let`：0 个
- 历史对照【实测】：`git show <commit>:src/main/index.ts` 统计，最近 7 个触及该文件的提交均为 **47**（仅 `c6a598c` 为 46）。即「33」不是本仓库任一近期版本的实测值，也不是 L294–373 的任一自然子集（无初值 25 / `=null` 20 / `=false` 2 / 有 `?.` 读点 26 / 无 `?.` 读点 21，均非 33）。

### 1.1 L294–L331 原样引用

```ts
294: let db: AppDatabase;
295: let libraryService: LibraryService;
296: let workspaceLibraryBindingService: WorkspaceLibraryBindingService;
297: let workGraphService: WorkGraphService;
298: let libraryProtocol: LibraryProtocol | null = null;
299: let projectService: ProjectService;
300: let projectFolderRelocation: ProjectFolderRelocation;
301: let attentionTracker: ProjectAttentionTracker;
302: let cadenceEngine: ProjectCadence;
303: let projectEventIngestor: ProjectEventIngestor;
304: let projectEventPromoter: ProjectEventPromoter;
305: let projectDocumentImporter: ProjectDocumentImporter;
306: let projectContextResolver: ProjectContextResolver;
307: let agentService: AgentService;
308: let externalAgentRuntime: ExternalAgentRuntime;
309: /** 对话分支（Branch in new task）服务 */
310: let conversationBranchService: ConversationBranchService;
311: /** 扩展栏终端宿主（按 taskId 保活 PTY；App 退出时 dispose） */
312: let terminalHost: TerminalHost | null = null;
313: let cronService: CronService;
314: let gatewayService: GatewayService;
315: let memoryGatewayController: MemoryGatewayController | null = null;
316: let externalCliMemoryBridge: ExternalCliMemoryBridge | null = null;
317: let remoteAccessController: RemoteAccessController | null = null;
318: let trayService: TrayService;
319: let notificationService: NotificationService;
320: let taskLifecycle: TaskExecutionWorkspaceLifecycle;
321: let archivedContentDeletion: ArchivedContentDeletion;
322: let artifactDomainService: ReturnType<typeof createArtifactDomain>["service"];
323: let artifactDomain: ReturnType<typeof createArtifactDomain> | null = null;
324: let gadgetService: GadgetService;
325: let blueprintService: BlueprintService;
326: let quitCleanupPromise: Promise<void> | null = null;
327: let quitCleanupComplete = false;
328: let selectionPopover: SelectionPopover | null = null;
329: let htmlEditService: HtmlEditService | null = null;
330: let reopenSelectionComment: (() => void) | null = null;
331: let perfStartupReported = false;
```

### 1.2 L355–L373 原样引用

```ts
355: let artifactRuntime: WebArtifactRuntime | null = null;
356: let artifactProtocol: ArtifactProtocol | null = null;
358: let captureModeController: CaptureModeController | null = null;
360: let selectionStore: SelectionStore | null = null;
362: let promptContextService: PromptContextService | null = null;
364: let workspaceSharedContextService: WorkspaceSharedContextService | null = null;
366: let artifactLegacySource: LegacyArtifactSource | null = null;
369: let professionalToolService: ProfessionalToolRuntimeService;
371: let cadRuntimeService: CadRuntimeService | null = null;
372: let cadArtifactService: CadArtifactService | null = null;
373: let cadFreeCad: FreeCadInterop | null = null;
```

（对照：L353 `const surfaceCoordinator = new NativeSurfaceCoordinator();`、L368 `const mcpService = new McpConfigService();`、L367 `installSubagentInvocationEnv();` 是 **import 期**执行的 `const`/副作用，不在这 47 个之列。即「import 期单例（const） vs ready 期服务（let）」的分野在当前代码里已经存在一半。）

### 1.3 全量清单表（47 条：行号 / 初始化形态 / 唯一赋值点 / 引用数）

| # | 行号 | 变量 | 初始化 | 唯一赋值点 | 读引用数 | 含 `?.` 读点 |
|---|------|------|--------|-----------|---------|------------|
| 1 | 294 | `db` | 无初值 | L2654 | 75 | 1 (L3458) |
| 2 | 295 | `libraryService` | 无初值 | L2660 | 43 | 0 |
| 3 | 296 | `workspaceLibraryBindingService` | 无初值 | L2661 | 7 | 0 |
| 4 | 297 | `workGraphService` | 无初值 | L2662 | 14 | 0 |
| 5 | 298 | `libraryProtocol` | `= null` | L2690 | 1 | 1 (L3374) |
| 6 | 299 | `projectService` | 无初值 | L2695 | 42 | 1 (L393) |
| 7 | 300 | `projectFolderRelocation` | 无初值 | L2696 | 2 | 0 |
| 8 | 301 | `attentionTracker` | 无初值 | L2697 | 3 | 1 (L389) |
| 9 | 302 | `cadenceEngine` | 无初值 | L2699 | 6 | 5 (L411/1410/2706/2707/3438) |
| 10 | 303 | `projectEventIngestor` | 无初值 | L2710 | 4 | 0 |
| 11 | 304 | `projectEventPromoter` | 无初值 | L2717 | 1 | 0 |
| 12 | 305 | `projectDocumentImporter` | 无初值 | L2719 | 1 | 0 |
| 13 | 306 | `projectContextResolver` | 无初值 | L2720 | 1 | 0 |
| 14 | 307 | `agentService` | 无初值 | L2732 | 233 | 2 (L3447/3448) |
| 15 | 308 | `externalAgentRuntime` | 无初值 | L2736 | 21 | 6 |
| 16 | 310 | `conversationBranchService` | 无初值 | L3144 | 4 | 0 |
| 17 | 312 | `terminalHost` | `= null` | L2860 | 16 | 7 |
| 18 | 313 | `cronService` | 无初值 | L3299 | 10 | 1 (L3437) |
| 19 | 314 | `gatewayService` | 无初值 | L3325 | 9 | 2 (L3446/3451) |
| 20 | 315 | `memoryGatewayController` | `= null` | L2693 | 21 | 2 (L1217/3452) |
| 21 | 316 | `externalCliMemoryBridge` | `= null` | L2694 | 3 | 0 |
| 22 | 317 | `remoteAccessController` | `= null` | L2761 | 22 | 10 |
| 23 | 318 | `trayService` | 无初值 | **L635**（createWindow 内） | 10 | 5 (L340/341/634/3427/3436) |
| 24 | 319 | `notificationService` | 无初值 | L2655 | 16 | 2 (L399/638) |
| 25 | 320 | `taskLifecycle` | 无初值 | L2884 | 13 | 1 (L1900) |
| 26 | 321 | `archivedContentDeletion` | 无初值 | L2931 | 1 | 0 |
| 27 | 322 | `artifactDomainService` | 无初值 | L3142 | 28 | 11 |
| 28 | 323 | `artifactDomain` | `= null` | L3137 | 4 | 0 |
| 29 | 324 | `gadgetService` | 无初值 | L3158 | 18 | 2 (L2924/3454) |
| 30 | 325 | `blueprintService` | 无初值 | L3184 | 11 | 0 |
| 31 | 326 | `quitCleanupPromise` | `= null` | **L3434**（before-quit 内） | 1 | 0（L3433 truthiness） |
| 32 | 327 | `quitCleanupComplete` | `= false` | **L3460**（before-quit 内） | 1 | 0（L3431 truthiness） |
| 33 | 328 | `selectionPopover` | `= null` | L3028 | 5 | 5 |
| 34 | 329 | `htmlEditService` | `= null` | L3029 | 5 | 4 |
| 35 | 330 | `reopenSelectionComment` | `= null` | L3064 | 1 | 1 (L2284) |
| 36 | 331 | `perfStartupReported` | `= false` | **L569**（createWindow 内） | 1 | 0 |
| 37 | 355 | `artifactRuntime` | `= null` | L3212 | 1 | 0 |
| 38 | 356 | `artifactProtocol` | `= null` | L3227 | 1 | 1 (L3373) |
| 39 | 358 | `captureModeController` | `= null` | L3261 | 9 | 9 |
| 40 | 360 | `selectionStore` | `= null` | L3027 | 15 | 13 |
| 41 | 362 | `promptContextService` | `= null` | L3083 | 3 | 1 (L2287) |
| 42 | 364 | `workspaceSharedContextService` | `= null` | L3082 | 6 | 0 |
| 43 | 366 | `artifactLegacySource` | `= null` | L3291 | 2 | 0 |
| 44 | 369 | `professionalToolService` | 无初值 | L2974 | 8 | 1 (L3443) |
| 45 | 371 | `cadRuntimeService` | `= null` | L3205 | 3 | 2 (L2899/3455) |
| 46 | 372 | `cadArtifactService` | `= null` | L3197 | 2 | 0 |
| 47 | 373 | `cadFreeCad` | `= null` | L3200 | 2 | 0 |

**赋值点位置【实测】**（用缩进判定「无条件顶层」还是「条件内」）：

- **43 个**在 `app.whenReady().then(async () => {`（L2635）回调体内、**缩进 2 空格 = 无条件顶层语句**（无一个在 `if`/`try` 分支内）；
- **2 个**在 `createWindow()`（L472–L642）内，由 whenReady L3405 调用：`trayService`（L635）、`perfStartupReported`（L569，缩进 6，位于回调内）；
- **2 个**在 `app.on("before-quit")`（L3430）内：`quitCleanupPromise`（L3434）、`quitCleanupComplete`（L3460）。

因此「都在 whenReady 里赋值」只有 45/47 松散成立；严格说 `quitCleanupPromise` / `quitCleanupComplete` 是在 **before-quit** 里赋值，不在 whenReady 内。每个变量全文件**只有一个赋值点**（0 处重赋值、0 处置回 null）——这点对 fail-loud 有利：不存在「初始化后又置空」的合法窗口。

---

## 2. 两类清单（规划要求先列的两类）【实测】

### 2(a) 初始化为 `null` 的：20 个

`298 libraryProtocol`、`312 terminalHost`、`315 memoryGatewayController`、`316 externalCliMemoryBridge`、`317 remoteAccessController`、`323 artifactDomain`、`326 quitCleanupPromise`、`328 selectionPopover`、`329 htmlEditService`、`330 reopenSelectionComment`、`355 artifactRuntime`、`356 artifactProtocol`、`358 captureModeController`、`360 selectionStore`、`362 promptContextService`、`364 workspaceSharedContextService`、`366 artifactLegacySource`、`371 cadRuntimeService`、`372 cadArtifactService`、`373 cadFreeCad`

—— 但**其中「逻辑上确实可空」的只有 3 个**，其余 17 个是「声明顺序适配」而非真可空：

**真可空（读点可合法落在赋值之前，或值本身是状态位）**：

| 变量 | 可空读点（原样引用） |
|------|--------------------|
| `trayService` L312 | `340:   if (trayService) {` / `3427:   if (process.platform !== "darwin" && !trayService?.shouldSuppressQuit()) app.quit();` / `3436: try { trayService?.dispose(); } catch { /* best effort */ }` / `634:   trayService?.dispose();`（createWindow 内自读，L635 之前） |
| `quitCleanupPromise` L326 | `3433:   if (quitCleanupPromise) return;`（先读后写，同函数 L3434） |
| `remoteAccessController` L317 | `2658:     remoteAccessController?.publishNotificationChanged(event);`（监听器 L2656 注册时该变量尚未赋值，赋值在 L2761）/ `3453:       remoteAccessController?.dispose(),` |

（`quitCleanupComplete` L327 虽是 `= false` 而非 `= null`，但属同一类「状态位在赋值前被读」：`3431:   if (quitCleanupComplete) return;`。）

**「`| null = null` 纯防御」（17 个）**：298、315、316、323、328、329、330、355、356、358、360、362、364、366、371、372、373。
理由（【实测】+【推断】）：它们的唯一赋值点是无条件顶层语句，且全部落在 `registerIpc()`（L3364）**之前**；所有读写这些变量的闭包要么是 L644–L2630 的 IPC handler（在 L3364 才注册）、要么在 whenReady 更晚的位置被注册，因此**不存在可达的先读后写**。典型：`3142:   artifactDomainService = artifactDomain.service;`（赋值）→ handler 内的 `3039: const artifact = artifactDomainService?.get(request.artifactId);`（读）——此时必然已赋值，`?.` 掩盖的是「装配顺序写错」而不是「合法可空」。

### 2(b) 无初始值、必须由启动流程赋值的：25 个

`294 db`、`295 libraryService`、`296 workspaceLibraryBindingService`、`297 workGraphService`、`299 projectService`、`300 projectFolderRelocation`、`301 attentionTracker`、`302 cadenceEngine`、`303 projectEventIngestor`、`304 projectEventPromoter`、`305 projectDocumentImporter`、`306 projectContextResolver`、`307 agentService`、`308 externalAgentRuntime`、`310 conversationBranchService`、`313 cronService`、`314 gatewayService`、`318 trayService`、`319 notificationService`、`320 taskLifecycle`、`321 archivedContentDeletion`、`322 artifactDomainService`、`324 gadgetService`、`325 blueprintService`、`369 professionalToolService`

其中属于 2(a) 真可空的是 `trayService`（它虽无初值，但**必须**按可空处理）。另外两个布尔状态位（`327 quitCleanupComplete`、`331 perfStartupReported`）不属于 (a)/(b) 任何一类，应单列。

> **对规划的修正**：不能说「(a) = 保留可选链的合法可空 / (b) = 必须抛错的」。正确切法是三类：
> ① 真可空（3+1 个：`trayService`、`quitCleanupPromise`、`remoteAccessController`、`quitCleanupComplete`）→ 保留可选/truthiness；
> ② 状态位（`perfStartupReported`）→ 保持布尔默认；
> ③ 装配型服务（其余 42 个，含 25 个无初值 + 17 个 `= null`）→ 可 fail-loud，但它们**在 IPC handler 路径上不可达未初始化状态**（见 §4）。

---

## 3. 实际可选链读取点：97 处 / 26 个变量【实测】

- `src/main/index.ts` 全文件 `?.` 出现 **165** 次；其中针对这 47 个模块级 `let` 的 **97** 处，分布在 **26** 个变量上。
- 分布（`?.` 次数 / 代表性行号，原样引用）：

| 变量 | `?.` 数 | 代表性读点（原样） |
|------|--------|------------------|
| `selectionStore` | 13 | `2282: ipcMain.handle(SelectionIpc.get, () => selectionStore?.getState() ?? null);` |
| `artifactDomainService` | 11 | `3039: const artifact = artifactDomainService?.get(request.artifactId);` / `3099: return artifactDomainService?.get(artifactId) ?? null;` |
| `remoteAccessController` | 10 | `651: ipcMain.handle(RemoteAccessIpc.status, () => remoteAccessController?.status());` / `656: ipcMain.handle(RemoteAccessIpc.listDevices, () => remoteAccessController?.listDevices() ?? []);` |
| `captureModeController` | 9 | `2271: await captureModeController?.enter(req.artifactId);` / `2279: ipcMain.on(CaptureModeIpc.startInspect, () => void captureModeController?.startInspect());` |
| `terminalHost` | 7 | `2538: terminalHost?.input({ ...req, data: req.data ?? "" });` / `2896: try { terminalHost?.close({ taskId }); }` |
| `externalAgentRuntime` | 6 | `2483: ipcMain.handle(ExternalAgentIpc.active, (_e, taskId?: string) => externalAgentRuntime?.active(taskId) ?? []);` / `2888: if (options?.strict && externalAgentRuntime?.hasLiveTaskRun(taskId)) {` |
| `cadenceEngine` | 5 | `411: cadenceEngine?.schedule(projectId);` / `1410: cadenceEngine?.cancel(id);` |
| `trayService` | 5 | `340: if (trayService) {`（truthiness）/ `3427` / `3436` / `634` |
| `selectionPopover` | 5 | `3057: void selectionPopover?.show({` / `3073: selectionPopover?.invalidate(state);` |
| `htmlEditService` | 4 | `2265: await htmlEditService?.stop();` / `3230: htmlEditService?.invalidate("artifact");` |
| `agentService` | 2 | `3447: try { await agentService?.closeDurableBots(); } catch { /* best effort */ }` |
| `cadenceEngine`/`gatewayService`/`gadgetService`/`memoryGatewayController`/`cadRuntimeService`/`notificationService`/`taskLifecycle`/`attentionTracker`/`projectService`/`libraryProtocol`/`artifactProtocol`/`promptContextService`/`reopenSelectionComment`/`professionalToolService`/`db` | 各 1–2 | 见 §1.3 |

### 3.1 合法可空（`?.` 是正确语义）

- **pre-ready 可达**：`trayService`（L340/341/3427/3436/634）——见 §4.1；`quitCleanupPromise`（L3433）、`quitCleanupComplete`（L3431）。
- **装配顺序使然（监听器先注册、服务后创建）**：`remoteAccessController` L2658 ——
  ```ts
  2655:   notificationService = new NotificationService(db);
  2656:   notificationService.setChangedListener((event) => {
  2657:     broadcastToWindows(NotificationIpc.changed, event);
  2658:     remoteAccessController?.publishNotificationChanged(event);
  2659:   });
  ...
  2761:   remoteAccessController = new RemoteAccessController(
  ```
  （【实测】L2635–L2761 之间无任何顶层 `await`，故该回调在 L2761 前不可能被异步插入；但结构上它确实「先注册后赋值」。）
- **退出清理路径**：`before-quit`（L3436–L3458）中的 `trayService?`、`cronService?`、`cadenceEngine?`、`captureModeController?`、`terminalHost?`、`professionalToolService?`、`externalAgentRuntime?`、`gatewayService?`、`agentService?`、`db?` —— 全部已包在逐条 `try/catch` 里（`best effort`），语义正确：退出时未初始化就跳过。

### 3.2 会「静默消失」的隐患（`?.` 把真实故障降级为无声 no-op）

这些读点上游必然已赋值（同处同一同步块），`?.` 只会在**装配顺序被改错**时静默吞掉，正是规划想消除的对象：

| 行号（原样） | 静默后果 |
|------|---------|
| `3450–3457` `gatewayService?.stop(), memoryGatewayController?.stop(), remoteAccessController?.dispose(), gadgetService?.disposeAll(), cadRuntimeService?.shutdownAll()` | 退出时**不**停 gateway / 不停 gadget 子进程 / 不停 CAD / 不关 DB（L3458 `db?.close()`），用户完全无感 |
| `1900: ipcMain.handle(TrashIpc.list, () => taskLifecycle?.listTrashedTasks() ?? []);` | 回收站静默显示为空 |
| `2282: ipcMain.handle(SelectionIpc.get, () => selectionStore?.getState() ?? null);` | 选区状态静默为 null |
| `1217: ipcMain.handle(MemoryGatewayIpc.listGrants, () => memoryGatewayController?.listGrants() ?? []);` | 授权列表静默为空 |
| `399: notificationService?.publish({` | 通知静默丢弃 |
| `389: const digest = attentionTracker?.onChange(projectId);` + `if (digest)` | 项目注意度静默不更新 |
| `393: const projectName = projectService?.get(projectId)?.name ?? "项目";` | 静默回退为占位名 |
| `3040: const path = artifactDomainService?.entryPathOf(request.artifactId);` → `3041: if (!artifact ... \|\| !path) throw new Error("HTML 产物源文件不可用");` | 真实原因（服务未装配）被伪装成「源文件不可用」 |

> 注意：这些行都在 `registerIpc()` 的 handler 里，而 `registerIpc()` 在 L3364 才被调用，**晚于全部 43 个赋值**，所以它们永远不会真的读到 undefined —— 隐患是「掩盖未来的装配错误」，不是「当前会发生的故障」。

---

## 4. 关键风险判断：fail-loud 会不会撞上合法的未初始化时序？【实测 + 推断】

### 4.1 IPC 路径：**不可能**在 whenReady 之前到达【实测】

- 全部 IPC 注册点：`ipcMain.*` 共 **444** 处——**442** 处位于 `registerIpc()`（L644–L2630）体内，**2** 处位于 whenReady 内、但也在其赋值之后（`3048: ipcMain.handle(HtmlEditIpc.start, ...)`、`3049: ipcMain.handle(HtmlEditIpc.stop, ...)`）。
- `3364:   registerIpc();` 位于 whenReady 回调**末尾**；`3405:   createWindow();` 更在其后 → **渲染进程存在时（L3405）所有 47 个变量都已赋值**。
- 结论：规划担心的「whenReady 之前 IPC 到达」在本仓库**不存在**。若真有 renderer 提前发 IPC，现有行为是 `No handler registered` 报错，而不是 fail-loud 抛错。

### 4.2 模块级 `app` 事件监听器：**可以**在赋值前被调用【实测】

这三处监听器在 **import 期**注册（L339、L3425、L3430），其读取的变量要等到 whenReady 体内才赋值：

```ts
336: if (!app.requestSingleInstanceLock()) {
337:   app.quit();
338: } else {
339:   app.on("second-instance", () => {
340:     if (trayService) {
341:       trayService.showMainWindow();
342:       return;
343:     }
344:     const win = BrowserWindow.getAllWindows()[0];
345:     if (win && !win.isDestroyed()) {
```

```ts
3425: app.on("window-all-closed", () => {
3427:   if (process.platform !== "darwin" && !trayService?.shouldSuppressQuit()) app.quit();
3428: });
```

```ts
3430: app.on("before-quit", (event) => {
3431:   if (quitCleanupComplete) return;
...
3450:     await Promise.allSettled([
3451:       gatewayService?.stop(),
3452:       memoryGatewayController?.stop(),
3453:       remoteAccessController?.dispose(),
3454:       gadgetService?.disposeAll(),
3455:       cadRuntimeService?.shutdownAll(),
3456:       computerAutomationService.shutdown(),
3457:     ].filter((pending): pending is Promise<void> => Boolean(pending)));
3458:     try { db?.close(); } catch { /* best effort */ }
```

**风险点 A（最实在，会真崩）**：`app.on("second-instance")` 在 import 期注册；`trayService` 直到 `createWindow()` 内 `635:   trayService = new TrayService();` 才赋值，而 `createWindow()` 由 whenReady L3405 调用。因此在**整个启动窗口**（whenReady 解析前 + whenReady 回调执行完 L3405 之前，期间还含 `3012:   await agentService.init();` 这个真实的顶层 await）内，双击/再次启动应用都会让第一实例进入 L340～L349，此时 `trayService === undefined`。现代码 L340 的 truthiness 兜底 + L344 `BrowserWindow.getAllWindows()[0]` 的无窗口兜底，正是作者已预期「窗口/托盘尚未创建」的证据。**若把 L340 改写成 `getService("trayService")`（未赋值即抛错），该回调会抛异常 → EventEmitter 监听器内未捕获异常 → 主进程未捕获异常（Electron 通常弹「A JavaScript error occurred in the main process」）。这是 fail-loud 的真实崩溃时序。**

**风险点 B（推断）**：`app.quit()` 在 L336–337（单实例锁失败）**于模块 import 期**被调用，此时 47 个变量全部未初始化。若 Electron 的 `before-quit` 在该 `app.quit()` 调用之后（而非同步内）送达 L3430 的处理器，则 L3450–L3457 是**全文件唯一没有被 `try/catch` 包住的读取区**（其余 L3436–L3448 每条都在 try 内）→ `getService` 抛错 → async IIFE 拒绝 → 未处理 rejection；`.finally()`（L3459–3462）仍会执行 `app.quit()`，所以不会卡死退出，但第二个实例会以异常路径退出，并可能出现错误弹窗/崩溃上报。
**【推断】依据**：handler 注册（L3430）晚于 `app.quit()`（L337）执行；是否命中取决于 `before-quit` 是同步还是异步送达——这一点本次未实测（不启动 GUI/Electron 是本任务的只读约束）。无论是否命中，**建议把 L3450–L3457 包进 try/catch**，成本极低。

**风险点 C（低，且反向）**：`2972–2973` 的 `setInterval/setTimeout(() => void purgeExpiredTrash("startup"), 5_000)` 在 `await agentService.init()`（L3012）之前注册；若 init 超过 5s，定时器会在 `cadRuntimeService`（L3205）、`artifactDomainService`（L3142）、`gadgetService`（L3158）等赋值前触发，进而经 `taskLifecycle.purgeExpired()`（L2960）调用 L2893–L2904 的回调读取这些变量。**但 `purgeExpiredTrash` 整体被 try/catch 包住**（L2953–L2970），fail-loud 只会变成一条 `[trash] purgeExpired(startup) 失败` 日志——属于期望行为，不构成崩溃风险。

### 4.3 测试/无头路径是否加载 index.ts【实测】

- `package.json` 的 `"main": "./out/main/index.js"` → index.ts 只由 Electron 主进程入口加载。
- `src/`、`scripts/`、`tests/` 中**没有任何模块 import / require `src/main/index.ts`**；`scripts/oauth-bundle-verify.ts:14` 只是校验构建产物 `out/main/index.js` 存在。
- L335 的注释也自述：`// 必须在 app ready 前尽早申请；测试/无头路径不加载本模块，不受影响。` —— **实测与注释一致**。
- 副作用：**fail-loud 的启动期行为在现有测试体系里没有任何运行时覆盖**（见 §5.2）。

---

## 5. 测试脚本如何引用 index.ts【实测】

### 5.1 以源码文本（`readFileSync` + `includes`/正则）引用的 6 个脚本

| 脚本 | 行号 | 断言（原样） | 是否在 `test:all` 默认门禁 |
|------|------|-------------|--------------------------|
| `scripts/external-write-grant-test.ts` | 268、272 | `const mainIndexSrc = readFileSync(join(repo, "src/main/index.ts"), "utf8");` / `/agentService\.revokeTaskWriteGrant\(taskId, path\)/.test(mainIndexSrc)` | ✅ 在 |
| `scripts/professional-tools-test.ts` | 430、431、433、437、444 | `assert(main.includes("await shell.openExternal(url);"), ...)` / `main.includes("openInApp: async (url)") && main.includes("BrowserIpc.openRequest, { url }")` / 位置序断言 | ✅ 在 |
| `scripts/builtin-capabilities-test.ts` | 346、352 | `assert(mainSource.includes(\`ipcMain.handle(AgentIpc.${channel}\`), ...)` | ✅ 在 |
| `scripts/gadget-blueprint-test.ts` | 509、512、516 | `mainSource.includes(\`GadgetIpc.${key}\`)` / `BlueprintIpc.${key}` | ✅ 在 |
| `scripts/prompt-enhance-test.ts` | 166、237、277 | `mainIndex.includes("new-task surface 不应携带 taskId")` / `mainIndex.includes("expertId 非法")` | ✅ 在 |
| `scripts/models-settings-overlay-test.ts` | 39 | `const main = read("src/main/index.ts");` | ❌ 被 `EXCLUDE_PATTERNS`（`/^test:models-settings-overlay$/`）排除 |

### 5.2 门禁盲区【实测】

`scripts/test-all.mjs` 的 `EXCLUDE_PATTERNS` 含 `/-electron$/`（"需要 electron 运行时"）、`/-desktop$/`、`/-e2e$/`、`/:live$/` 等。因此：

- **没有任何默认门禁用例会真正启动 Electron 主进程**；`scripts/` 内也搜不到 `spawn(electron)` / `_electron` 启动器。
- ⇒ fail-loud 若在真实启动时序上出错（如风险点 A/B），`pnpm -s test:all` **不会**报错；只有 `pnpm -s test:all:live` / 真机启动打包应用才能发现。

### 5.3 会因该重构直接变红的断言（两条，必须同步改）

1. `scripts/external-write-grant-test.ts:272` 的正则 `/agentService\.revokeTaskWriteGrant\(taskId, path\)/`，命中 `src/main/index.ts:1964:     return agentService.revokeTaskWriteGrant(taskId, path);`。
   只要把读点改写成 `getService("agentService").revokeTaskWriteGrant(taskId, path)`，`agentService\.revoke...` 这一子串（`agentService` 后必须紧跟 `.`）即不再匹配 → **门禁失败**。
2. `scripts/professional-tools-test.ts:431/433` 要求 `await shell.openExternal(url);` 与 `openInApp: async (url)` **保留在 index.ts**；这两处正是 `professionalToolService = new ProfessionalToolRuntimeService({...})`（L2974–L2991）的构造参数（L2981、L2983）。若按 2.1 把「服务构造」搬入 `services-context.ts`，**该用例必失败**。
   另外 `:444` 的正则 `/if \(\/\^https\?:\/i\.test\(url\)\) \{\s*void shell\.openExternal\(url\);/` 绑定 `createWindow()` 的 `setWindowOpenHandler`，只要 `createWindow` 留在 index.ts 即安全。

---

## 6. 真实收益与风险【判断，基于 §1–§5 的实测】

### 6.1 收益（真实但比规划设想的小）

1. **消除退出路径的静默漏清理**【实测支撑】L3450–L3457 若任一为 `undefined`，`filter(Boolean)` 会把 `undefined` 静默滤掉 → gateway 不停、gadget 子进程不退出、CAD 不停、DB 不关。这是当前唯一「静默失败会导致资源泄漏」的真实面。fail-loud 在**已初始化后的正常运行**里能把这类错误暴露出来。
2. **把既有的 const/let 分野显式化**：`surfaceCoordinator`（L353）、`mcpService`（L368）、`installSubagentInvocationEnv()`（L367）已是 import 期对象，与 47 个 ready 期服务混在同一个 400 行的声明区里，可读性确实差；抽出 context 后「何时可用」有单一出处。
3. **`?.` 噪声收敛**：97 处 `?.` 中约 80 处（17 个防御型 nullable + 装配型服务）在语义上不需要可选链；收敛后「`?.` 出现即代表真可空」成为可用的阅读规则。

### 6.2 风险

1. **清单基数错误（最直接）**：47 ≠ 33。按 33 设计迁移会漏掉 14 个变量（且恰好包含 `trayService` 这类必须按可空处理的项），分类表本身会错。
2. **pre-ready 崩溃（A）**：`trayService` 若被归入「必须抛错」，`second-instance` 在启动窗口内抛异常（§4.2 风险点 A）——这是 fail-loud 唯一会真崩的时序。
3. **退出路径未处理 rejection（B）**：L3450–L3457 未包 try/catch；单实例锁失败路径下 47 个变量全空（【推断】取决于 `before-quit` 送达时机）。
4. **门禁盲区（§5.2）**：改动落在没有任何默认测试覆盖的启动路径上；同时会打挂 2 个源码契约断言（§5.3）——「改完测试全绿」在这里既不可得也不可信。
5. **改动面**：47 个变量共 **706** 处读引用（`db` 75、`agentService` 233 最大）；`tsconfig.node.json` 为 `"strict": true`。若 `getService` 不做 name→type 映射，706 处要么全改调用、要么加 `!`。
6. **收益被高估的部分**：规划的核心动机——「handler 闭包读到未初始化服务而静默消失」——在 **IPC 路径上不可达**（§4.1：handler 在 L3364 注册，晚于 43 处赋值且同处一个同步块；renderer 直到 L3405 才存在）。真正可达的只有 3 个模块级 `app` 事件处理器。

---

## 7. 建议（供规划在 Phase 2.1 执行前采纳）

1. **先更正基数与分类**：按 §1.3 的 47 条表落地，明确三分：真可空 4 个（`trayService`/`quitCleanupPromise`/`remoteAccessController`/`quitCleanupComplete`）、状态位 1 个（`perfStartupReported`）、装配型 42 个。
2. **fail-loud 只作用于「装配完成后」的读点**：建议加一个 ready 标志（例如在 `registerIpc()` 之前置位，或在 whenReady 末尾对 47 项做一次完整性校验并一次性报出缺失名单），IPC handler 路径走 fail-loud，**模块级 `app` 事件处理器（L339–L350、L3425–L3428、L3430–L3463）保留可选/truthiness**。
3. **顺手加防御**：把 L3450–L3457 的 `Promise.allSettled([...])` 包进 `try/catch`（与同函数其它 12 条一致），无论是否做 context 抽取都值得。
4. **同步改 2 个源码契约断言并补运行时验证**：`external-write-grant-test.ts:272`、`professional-tools-test.ts:431/433`（或改为行为断言）；因为 `test:all` 排除 `/-electron$/`、`-desktop`、`:live`，改后**必须**用真机启动一次打包应用（或 `pnpm -s test:all:live`）验证启动时序，不能只看 `pnpm -s test:all` 与 `pnpm -s typecheck`。

---

## 8. 时序与风险示意图（内联 SVG，仅本报告内）

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 980 430" width="980" height="430" font-family="Segoe UI, Arial, sans-serif">
  <rect x="0" y="0" width="980" height="430" fill="#f7f8fa"/>
  <text x="20" y="26" font-size="16" font-weight="bold" fill="#1a1a19">index.ts 装配时序与 fail-loud 可达点（实测 + 推断）</text>

  <!-- import phase -->
  <rect x="20" y="44" width="940" height="96" rx="6" fill="#eef2f7" stroke="#9aa7b4"/>
  <text x="32" y="66" font-size="13" font-weight="bold" fill="#1a1a19">① import 期（L1–L373 顶层执行）</text>
  <text x="32" y="88" font-size="12" fill="#1a1a19">L270–L292 常量 / L283 协议注册 / L294–L373 声明 47 个 let（此处全部未赋值）</text>
  <text x="32" y="108" font-size="12" fill="#1a1a19">L336 requestSingleInstanceLock 失败 → L337 app.quit()（47 个变量全空）</text>
  <text x="32" y="128" font-size="12" fill="#b3261e">L339 app.on("second-instance") 注册 ← 读 trayService，此时必为 undefined</text>

  <!-- whenReady phase -->
  <rect x="20" y="152" width="940" height="112" rx="6" fill="#eaf5ea" stroke="#6b9e6b"/>
  <text x="32" y="174" font-size="13" font-weight="bold" fill="#1a1a19">② app.whenReady().then(async …)（L2635–L3414，43 处赋值 = 无条件顶层）</text>
  <text x="32" y="196" font-size="12" fill="#1a1a19">L2654 db → 2660 libraryService → 2693/2694/2695 → 2732 agentService → 2761 remoteAccessController → 2860 terminalHost → 2974 professionalToolService</text>
  <text x="32" y="216" font-size="12" fill="#8a5a00">L3012 await agentService.init()  ← 唯一顶层 await，事件循环在此可插入外部事件</text>
  <text x="32" y="236" font-size="12" fill="#1a1a19">L3027–3325 selectionStore / artifactDomainService / gadgetService / cronService / gatewayService …</text>
  <text x="32" y="256" font-size="12" fill="#1a1a19">L3364 registerIpc()（442 个 handler 此刻才注册）→ L3405 createWindow()（内含 L635 trayService 赋值）</text>

  <!-- reachability -->
  <rect x="20" y="276" width="460" height="140" rx="6" fill="#fdecea" stroke="#c0392b"/>
  <text x="32" y="298" font-size="13" font-weight="bold" fill="#b3261e">可达未初始化读取（fail-loud 会真出错）</text>
  <text x="32" y="320" font-size="12" fill="#1a1a19">A 第二实例启动 → L339 回调 → L340 trayService（启动窗口全程）</text>
  <text x="32" y="338" font-size="12" fill="#1a1a19">   现兜底：if (trayService) + L344 无窗口兜底 ⇒ 安全</text>
  <text x="32" y="358" font-size="12" fill="#1a1a19">B【推断】L337 app.quit() → before-quit → L3450–L3457</text>
  <text x="32" y="376" font-size="12" fill="#1a1a19">   唯一无 try/catch 的读取区 ⇒ 可能未处理 rejection</text>
  <text x="32" y="398" font-size="12" fill="#1a1a19">C L2973 5s 定时器 → purgeExpiredTrash：已被 try/catch 兜住</text>

  <rect x="500" y="276" width="460" height="140" rx="6" fill="#e8f0fe" stroke="#3b6ea5"/>
  <text x="512" y="298" font-size="13" font-weight="bold" fill="#1e4e8c">不可达（规划的动机在此不成立）</text>
  <text x="512" y="320" font-size="12" fill="#1a1a19">IPC handler 全部在 L3364 注册，晚于 43 处赋值；</text>
  <text x="512" y="338" font-size="12" fill="#1a1a19">renderer 直到 L3405 createWindow 才存在</text>
  <text x="512" y="358" font-size="12" fill="#1a1a19">⇒ 「handler 读到未初始化服务而静默消失」</text>
  <text x="512" y="376" font-size="12" fill="#1a1a19">   在 IPC 路径上不可能发生</text>
  <text x="512" y="398" font-size="12" fill="#1a1a19">97 处 ?. 中约 80 处属「掩盖未来装配错误」</text>
</svg>
```

---

## 9. 结论

- 规划的**基数（33）错误**：实测 **47**（L294–L331 共 36 + L355–L373 共 11），且 33 不对应任何自然子集。
- 规划的**两类清单方向正确但切法不对**：真可空只有 3–4 个，不是「20 个 `=null` 全部合法可空」；`trayService` 无初值却必须按可空处理。
- 规划的**核心动机在 IPC 路径上不成立**（handler 注册晚于全部赋值），但在**模块级 app 事件处理器**上成立且其中一条会真崩。
- 该重构的**净收益**（退出路径静默漏清理、const/let 分野显式化）是真实的，但需以 706 处读引用 + 2 个源码契约断言 + 启动期零测试覆盖为代价；建议按 §7 缩小作用域后再执行。

**refutes_parent = true**（依据：① 47 ≠ 33 且无自然子集为 33；② 存在合法时序 —— `second-instance`（L339）在 `trayService`（L635 赋值）之前读取它，若 fail-loud 化会真崩；③ 单实例锁失败路径下 L3450–L3457 于全空状态下读取，且该区无 try/catch【推断】）。
