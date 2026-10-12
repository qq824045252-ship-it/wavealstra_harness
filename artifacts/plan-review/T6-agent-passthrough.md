# T6 — AgentService 纯透传层执行前复核（只读核查）

- 仓库：`C:\Users\servi\Documents\GitHub\wavealstra_harness`
- 被核查对象：`src/main/agent/AgentService.ts`（275401 字节，5830 行，git HEAD `9f90f4e`）
- 待验证声明（规划 Phase 3.1）：**"AgentService 约 286 个方法里约 100 到 140 个是纯透传"**；前提是先移出 `skillsService/expertsService/connectorsService/userFonts/backups/settingsStore/modeProfiles` 的所有权；红线是 `prompt()/regenerate()/createSession/会话事件派发/compaction/审批`。
- 核查时间：2026-10-12
- 本次唯一写入：本文件。**未修改任何源码、未运行任何构建/测试/写库命令**；分析脚本通过 stdin 交给 `node -` 执行，临时产物只落在 `%TEMP%`。

---

## 0. 结论摘要

| # | 核查项 | 规划值 | 实测值 | 判定 |
|---|---|---|---|---|
| 1 | AgentService 类体行范围 | — | **511–5822**（5312 行） | 实测 |
| 2 | 类体内方法定义数 | 约 286 | **256**（=255 method + 1 constructor） | **声明不成立（-10.5%）** |
| 2b | 若把唯一一个箭头函数属性 `flushDeltaPatches` 也算"方法" | — | **257** | 实测 |
| 3 | 纯透传（按规划字面定义：单条 `return this.<字段>.<方法>(...)`、实参全裸标识符、无前置检查） | 100–140 | **65** | **声明不成立（高估 ≥1.54×）** |
| 3b | 纯透传（+6 条带 `??`/展开/字段拆包的逐字转发） | — | **71** | 实测 |
| 3c | 纯透传（+13 条 `void` 单语句形态 `this.<字段>.<方法>(...)`） | — | **84**；剔除 2 条非逐字转发（含 `map/sort`、传回调）后**最宽松可辩护口径 82** | 实测 |
| 4 | 7 个点名协作者是否真零依赖 `new` | 零依赖 | **全部零必填构造参数**（6 个无显式构造函数 + `FileBackupService(rootDir?)` 可选），但**全部经 `paths` 模块的 homedir 环境路径定位**，并非可注入 | 声明基本成立，需补精度 |
| 5 | 7 个协作者覆盖了多少条透传 | — | **84 条中只有 39 条（46%）**；最大单一接收者是**不在清单里的 `this.memoryService`（15 条）** | **前提清单不完整** |
| 6 | 红线方法是否存在且复杂 | — | 存在：`createSession` 444 行 / `promptInternal` 495 行 / `regenerate` 184 行 / compaction 3566–3657 / 审批 4748–4782 | 实测成立 |
| 7 | 删除透传的真实数量级 | 100–140 | **65–84 条方法、约 243 行（占类体 4.6%）**，方法数真减但幅度有限 | 规划应下修 |

**总判定：`refutes_parent = true`。** 两个基数都错：方法总数不是 286 而是 256；纯透传在任何可辩护口径下（65 / 71 / 84 / 最宽松 82）都 **< 100**，未进入规划的 100–140 区间。规划的"方法数真减"方向正确，但幅度被高估约 1.2×–2.15×，且前提清单漏掉了 `memoryService` 这个最大透传来源。

---

## 1. 核查方法（可复现）

1. **AST 统计（权威口径）**：用仓库内 `node_modules/@babel/parser@7.29.9` 以 `sourceType:"module", plugins:["typescript"]` 解析该文件，取 `ExportNamedDeclaration → ClassDeclaration(id.name === "AgentService")`，直接读 `class.body.body`（这是 TS 语法层面的类成员列表，不受缩进/注释/字符串干扰）。
2. **缩进级正则交叉校验**：`/^  (?:public |private |protected |static |readonly |async )*(?:async )?[A-Za-z_#][\w$]*\s*(?:<[^>]*>)?\s*\(/` 命中 **整文件 271 行 / 类体内 256 行**，与 AST 的 256 个 `ClassMethod` 起点**逐一相等（差异集合为空）**，故 256 是可靠数字。
3. **纯透传判定**（对每个 `ClassMethod` 的 `body.body` 做语法级判断，不看文本）：
   - 方法体**恰好 1 条语句**；
   - 该语句是 `ReturnStatement`（其 argument 允许一层 `AwaitExpression`）或 `ExpressionStatement`（`CallExpression`）；
   - 表达式为 `CallExpression`，且 callee 链**根节点必须是 `ThisExpression`**（`rootIsThis`）；或 argument 直接是根为 `this` 的 `MemberExpression`（纯字段读取委托）；
   - 实参若全为 `Identifier` / `...Identifier` 记为"严格实参"，否则记为"松散实参"（如 `request ?? {}`、`{...request, createdBy:"user"}`）。
   - **排除带前置检查的委托**：只要方法体语句数 ≠ 1（含 `if` 守卫、`try/catch`、`for...of` 预置副作用、`const` 中间变量）即自动落选；这条规则把 `installExpert`(2306)、`setExpertEnabled`(2356)、`listRuntimeContextSnapshots`(2751)、`switchExpert`(2775)、`getBuiltinCapabilities`(2973) 等全部排除（见 §4.3）。
   - 另记一层 `T4 = [守卫语句, 单条委托]` 共 16 条，用来给出理论上限（§4.4）。
4. 复核脚本一次性产出全部名单，本文所有行号均可在源文件中逐行核对。

---

## 2. Q1 — 类体范围与方法数逐段统计

### 2.1 类体范围（实测）

```
src/main/agent/AgentService.ts
511: export class AgentService {
...
5822: }
```

- **类体：511–5822，共 5312 行**（含类声明行与闭合行）。
- 511 之前（1–510 行）是 import、类型/接口、模块级辅助函数（例如 499–509 的 `AgentTaskLifecycleEvent`），不属于类体。
- 5822 之后只剩一个模块级函数（`isInternalTaskPath`，5825–5830）。

### 2.2 类成员构成（AST 实测）

| 成员类型 | 数量 |
|---|---|
| `ClassMethod` | **256** |
| ├ `kind === "method"` | 255 |
| └ `kind === "constructor"` | 1（**constructor @671–899，229 行，36 条顶层语句**） |
| `ClassProperty` | 78 |
| **成员合计** | **334** |
| 其中箭头函数属性（等价"方法"） | 1：`flushDeltaPatches = (): void => {...}` @**1103–1110** |
| **"方法"最宽口径** | **257** |

- 256 个 `ClassMethod` 的声明行合计覆盖 **4823 行 / 5312 行（90.8%）**。
- 厚度分布：**≤4 行的方法 118 个；≤6 行的方法 143 个**（占 256 的 45%/56%）——这正是"透传层"观感的来源，但"薄"≠"纯透传"（见 §3）。

### 2.3 为什么不可能得到 286（实测复算）

| 计数口径 | 结果 |
|---|---|
| AST `ClassMethod`（权威） | **256** |
| 类体内 2 空格缩进方法签名正则 | **256**（与 AST 完全一致） |
| 整文件同正则 | 271（多出的 15 行在 1–510 行的模块级作用域内） |
| 方法 + 唯一箭头函数属性 | 257 |
| 全部类成员（方法+属性） | 334 |
| 2–4 空格缩进的宽松"像方法"正则 | 270 |
| git HEAD~1 / HEAD~5 的整文件同正则 | 271 / 271（**该文件近 5 次提交未变，286 不是"旧版本残留"能解释的**） |

**结论（实测）**：286 无法由任何自然口径复现；它是**高估约 11.7%** 的数字。规划应以 **256（或含箭头属性 257）** 为基数。

---

## 3. Q2 — 纯透传方法精确统计

### 3.1 三层口径与数字（实测）

| 口径 | 定义 | 数量 | 占 256 方法 |
|---|---|---|---|
| **A｜规划字面口径** | 方法体仅 1 条 `return this.<字段>.<方法>(裸标识符实参...)`，无前置检查、无 patch 发射、无副作用 | **65** | 25.4% |
| **B｜A + 逐字转发（实参含 `?? {}`、`{...req, x}`、字段拆包）** | 仍为单条 return，链根 `this`，无自定义逻辑 | **71** | 27.7% |
| **C｜B + void 形态（单条 `this.<字段>.<方法>(...);`，无 return）** | 语义上同样是纯透传，只是返回 `void` | **84** | 32.8% |
| **C′｜C 剔除 2 条非逐字转发**（`skillAtlasSnapshot` 有 `map/sort/slice`；`resolveSkillsForContext` 传入回调） | 最宽松仍可称为"纯透传"的上限 | **82** | 32.0% |
| **理论上限 T4** | `[守卫/副作用语句, 单条委托]` 的 16 条也全算进去（规划明确排除，此处仅作上界） | 100 | 39.1% |

> 注意：**T4 的 100 条是"不成立的 100"**——这 16 条里，`installExpert`/`uninstallExpert`/`installExpertByPath` 等第一条语句是 `this.preserveExpertBindings(id)`（清除任务专家绑定），`listRuntimeContextSnapshots` 等有 `throw new Error("任务不存在")` 守卫，删掉它们会改变行为或丢失副作用，规划自己把这类排除在"纯透传"之外。

### 3.2 逐字引用的代表性纯透传（实测原文）

字段读取型（1 条）：

```ts
628:   runningConsultCount(): number {
629:     return this.consultWorkers.size;
630:   }
```

单条 return 委托型（A 类，任取 6 条）：

```ts
1891:   listSkills(cwd?: string): SkillDto[] {
1892:     return this.skillsService.listInstalled(cwd);
1893:   }
```
```ts
2462:   listModeProfiles(): ModeProfileSummaryDto[] {
2463:     return this.modeProfiles.listSummaries();
2464:   }
```
```ts
2948:   listUserFonts(): UserFontDto[] {
2949:     return this.userFonts.list();
2950:   }
```
```ts
3237:   listKernelMemory(request?: import("../../shared/memory-kernel").MemoryListRequest | number) {
3238:     return this.memoryService.list(request ?? {});
3239:   }
```
```ts
4797:   listBackups(taskId?: string): FileBackupInfoDto[] {
4798:     return this.backups.listBackups(taskId);
4799:   }
```
```ts
4844:   async startBtw(req: BtwStartRequest): Promise<void> {
4845:     return this.btwService.start(req);
4846:   }
```
```ts
951:   private getTaskRoot(taskId: string): string {
952:     return this.resolveTaskExecutionWorkspaceCwd(taskId);
953:   }
```

void 透传型（C 类独有，共 13 条，全文列出）：

```ts
 590:   setProfessionalToolRuntime(runtime: ProfessionalToolRuntimeFacade | null): void { this.runtimeRequirements.setRuntime(runtime); }
 594:   setRuntimeStateListener(listener: ...): void { this.runtimeRequirements.setStateChangeListener(listener); }
 598:   onModePresetSelected(welcomeMode: WelcomeMode, modePresetId: string | null): void { this.runtimeRequirements.onModePresetSelected(welcomeMode, modePresetId); }
 606:   startRuntimeRequirement(providerId: string): void { this.runtimeRequirements.start(providerId); }
1039:   cloneConversationGoal(sourceTaskId: string, childTaskId: string): void { this.conversationGoals.cloneLive(sourceTaskId, childTaskId); }
2279:   uninstallSkill(id: string): void { this.skillsService.uninstall(id); }
2283:   deleteMarketSkill(id: string): void { this.skillsService.deleteFromMarket(id); }
2429:   uninstallConnector(id: string): void { this.connectorsService.uninstall(id); }
2447:   setTaskConnectorIds(taskId: string, ids: string[]): void { this.settingsStore.setTaskConnectorIds(taskId, ids); }
2452:   clearTaskConnectorIds(taskId: string): void { this.settingsStore.clearTaskConnectorIds(taskId); }
2456:   deleteMarketConnector(id: string): void { this.connectorsService.deleteFromMarket(id); }
3254:   forgetKernelMemory(id: string) { this.forgetKernelMemories([id]); }
4860:   btwKeepalive(btwIds: string[]): void { this.btwService.keepalive(btwIds); }
```

（上表 590/594/598/606/1039/2279/2283/2429/2447/2452/2456/4860 在源码中是"签名行 + 方法体行"两行，此处为逐字单行渲染；3254 行在源码中本就是单行原文。参数类型上 594 行的 `Parameters<...>` 已完整保留。）

### 3.3 排除带前置检查的委托 —— 规则与实例（实测）

判定器只在「方法体语句数 == 1」时成立，因此下列 32 条单语句/多语句方法被自动排除，其中要点：

- **有 `if` 守卫**：`runGatewayTurn`@1346（`if (!this.durableBots) throw`）、`setExpertEnabled`@2356（`if (!enabled) this.preserveExpertBindings(id)`）、`listAgentLoadoutObservations`@2680、`listRuntimeContextSnapshots`@2751、`clearRuntimeContextSnapshots`@2756。
- **有前置副作用**：`installExpert`@2306（先 `this.preserveExpertBindings(id)`）、`uninstallExpert`@2346、`deleteMarketExpert`@2351、`installExpertByPath`@2311 与 `importExpertZip`@2337（先 `for (const task of this.db.listTasks()) ... ensureLegacy`）。
- **`try/catch` 包裹（可能吞异常/发 patch）**：`sessionTokenTotals`@4608、`emitContextUsage`@4632、`applyCompactionReserveForModel`@5098。
- **有真实转换而非转发**：`getConversationRuntimeSnapshot`@1006（组装对象）、`boundExpertPrompt`@1289（模板串）、`expertConnectorIds`@1293（`[...new Set(...)]` 去重）、`runtimeCapabilityAvailability`@1137、`getShellIsolationLevel`@2935（`normalizeIsolationLevel`）、`createShellExecutionBackend`@2940（工厂构造）。
- **单条 return 但非 `this` 根**：`getModelsFilePath`@1596 → `return getModelsPath();`、`getAuthFilePath`@1600 → `return getAuthPath();`（模块函数转发，也属可删包装，但**只有 2 条**，且不属于"this 字段透传"）。

**因此"删除纯透传"的真实规模（实测）**：65（规划字面）/ 71（含逐字转发）/ 84（含 void）/ 最宽松 82（剔除 2 条含逻辑者）条方法；这些方法的源码行合计 **243 行**，占类体 5312 行的 **4.6%**。

### 3.4 全量名单（按接收者分组，`名字@行号`，`(void)` 表示无 return）

- **`this.memoryService`（15）**：`listKernelMemory`@3237, `listKernelMemoryTurns`@3240, `getKernelMemoryTurn`@3243, `memoriesForKernelTurn`@3245, `getKernelMemory`@3246, `searchKernelMemory`@3247, `listKernelDismissedProjections`@3307, `kernelMemoryHistory`@3413, `kernelMemoryCandidates`@3414, `kernelMemoryStats`@3415, `kernelMemoryScenarios`@3416, `kernelMemoryCoreProfiles`@3417, `kernelMemorySkillCandidates`@3418, `reindexKernelMemory`@3559, `listKernelProjectionProposals`@4969
- **`this.skillsService`（9）**：`listSkills`@1891, `listMarketSkills`@1895, `installSkill`@1899, `installSkillByPath`@1903, `skillAtlasSnapshot`@2039⚠️, `uninstallSkill`@2279(void), `deleteMarketSkill`@2283(void), `setSkillEnabled`@2287, `resolveSkillsForContext`@2668⚠️
- **`this.modeProfiles`（9）**：`listModeProfiles`@2462, `getModeProfile`@2466, `saveModeBlock`@2470, `saveModePolicy`@2474, `resetModeBlock`@2478, `resetModePolicy`@2482, `resetModeProfile`@2486, `openModesDir`@2490, `openModeFile`@2494
- **`this.runtimeRequirements`（7）**：`setProfessionalToolRuntime`@590(void), `setRuntimeStateListener`@594(void), `onModePresetSelected`@598(void), `listRuntimeRequirementStates`@602, `startRuntimeRequirement`@606(void), `stopRuntimeRequirement`@610, `restartRuntimeRequirement`@614
- **`this.connectorsService`（6）**：`listConnectors`@2413, `installConnector`@2417, `importConnectorByPath`@2421, `importConnectorZip`@2425, `uninstallConnector`@2429(void), `deleteMarketConnector`@2456(void)
- **`this.expertsService`（5）**：`listExperts`@2293, `listMarketExperts`@2297, `listExpertPrivateSkills`@2302, `exportExpert`@2342, `getExpertDetail`@2361
- **`this.userFonts`（5）**：`listUserFonts`@2948, `listSystemFonts`@2952, `importUserFontFromPath`@2956, `readUserFont`@2965, `openFontsDir`@2969
- **`this.btwService`（5）**：`startBtw`@4844, `btwPrompt`@4848, `btwAbort`@4852, `btwClose`@4856, `btwKeepalive`@4860(void)
- **`this.conversationGoals`（4）**：`createConversationGoal`@1027, `updateConversationGoal`@1031, `cancelConversationGoal`@1035, `cloneConversationGoal`@1039(void)
- **`this.settingsStore`（3）**：`setTaskConnectorIds`@2447(void), `clearTaskConnectorIds`@2452(void), `getDiskSpace`@2944
- **`this.conversationInteractions`（2）**：`respondConversationInteraction`@1019, `cancelConversationInteraction`@1023
- **`this.db`（2）**：`getSoul`@3228, `updateSoul`@3232
- **`this.skillEffectiveness`（2）**：`kernelSkillEffectiveness`@3481, `kernelSkillEffectivenessSummary`@3484
- **`this.backups`（2）**：`listBackups`@4797, `restoreBackup`@4802
- **单条**：`promoteWorkspaceSharedContextItem`@576(`this.libraryWorkspaceContext`), `getTaskRoot`@951(`this.resolveTaskExecutionWorkspaceCwd`), `listPendingActions`@1015(`this.pendingActions`), `validateSkillPackage`@1936(`this.skillAuthoringService`), `kernelMemoryTurnTasks`@3244(`this.memoryPipeline`), `forgetKernelMemory`@3254(void, `this.forgetKernelMemories`), `kernelSkillRevisionCandidates`@3494(`this.skillRevision`), `enhancePrompt`@4865(`this.promptEnhancement`)

⚠️ = 计入 C(84) 但**不是**逐字转发（前者 `map/sort/slice`，后者传回调），C′ 口径已剔除。

---

## 4. Q3 — 七个"零依赖协作者"逐个核实

### 4.1 规划点名行号 → 原文（全部命中，实测）

```
src/main/agent/AgentService.ts
523:   private readonly skillsService = new SkillsService();
524:   private readonly expertsService = new ExpertService();
527:   private readonly connectorsService = new ConnectorService();
529:   private readonly settingsStore = new AppSettingsStore();
530:   private readonly modeProfiles = new ModeProfileStore();
540:   private readonly userFonts = new UserFontsStore();
549:   private readonly backups = new FileBackupService();
```

**7/7 行号与内容完全对上**（规划写 "约 L523/L524/L527/L540/L549/L529/L530"，实测精确命中）。原文均为**字段初始化器直接 `new`**，即 AgentService 自己 `new` 出实例、自己持有所有权，符合规划描述。

同批还有 4 个规划未点名的同构零依赖字段：

```
528:   private readonly modelsStore = new ModelsConfigStore();
542:   readonly builtinCapabilities = new BuiltinCapabilityRuntime();
543:   private readonly browserAutomation = new BrowserAutomationService(() => browserHost);
549:   private readonly backups = new FileBackupService();
```

### 4.2 "零依赖"的精度（实测构造签名）

| 字段 | 类 | 定义位置 | 构造函数 | 是否零依赖 |
|---|---|---|---|---|
| `skillsService` | `SkillsService` | `src/main/skills/SkillsService.ts:471-1214` | **无显式构造函数**（隐式零参） | 零必填参数 ✔ |
| `expertsService` | `ExpertService` | `src/main/experts/ExpertService.ts:819-1475` | **无显式构造函数** | 零必填参数 ✔ |
| `connectorsService` | `ConnectorService` | `src/main/connectors/ConnectorService.ts:202-668` | **无显式构造函数** | 零必填参数 ✔ |
| `userFonts` | `UserFontsStore` | `src/main/UserFontsStore.ts:66-236` | **无显式构造函数** | 零必填参数 ✔ |
| `settingsStore` | `AppSettingsStore` | `src/main/AppSettingsStore.ts:235-538` | **无显式构造函数** | 零必填参数 ✔ |
| `modeProfiles` | `ModeProfileStore` | `src/main/agent/ModeProfileStore.ts:349-726` | **无显式构造函数** | 零必填参数 ✔ |
| `backups` | `FileBackupService` | `src/main/agent/FileBackupService.ts:40-134` | `constructor(private readonly rootDir?: string) {}` @**41** | 参数**可选**，零必填但**不是无参构造** ⚠ |

`FileBackupService` 原文：

```ts
40: export class FileBackupService {
41:   constructor(private readonly rootDir?: string) {}
...
43:   private backupRoot(): string {
44:     return join(this.rootDir ?? getMyBuddyDir(), "backups");
45:   }
```

**重要修正（实测）**：这 7 个类**零必填构造参数 ≠ 零依赖**。它们全部在执行期通过 `paths` 模块读环境路径（`~/.mybuddy/...`），即**隐式全局依赖，无法在构造时替换**：

- `src/main/paths.ts:13-14`：`export function getMyBuddyDir(): string { const dir = join(homedir(), ".mybuddy"); ... }`
- `UserFontsStore.ts:70`：`const d = getFontsDir();`
- `ModeProfileStore.ts:354`：`readText(join(getModesDir(), source, "policy.json"))`；`ModeProfileStore.ts:368`：`return join(getModesDir(), id);`
- `FileBackupService.ts:44`：`join(this.rootDir ?? getMyBuddyDir(), "backups")`
- `AppSettingsStore.ts:200`：`return join(getMyBuddyDir(), "settings.json");`
- `SkillsService.ts` 导入 `getExpertMarketDir, getPluginsDir, getMyBuddyDir, getSkillsDir`（SkillsService.ts:18，用于 187/223/377/399/508/529/534/624/689/725/739/804/851/904/949/999/1118/1154 行）
- `ExpertService.ts:24` 导入 `getExpertExportsDir, getExpertsDir, getExpertMarketDir, getPluginsDir, getSkillsDir`
- `ConnectorService.ts:13` 导入 `getConnectorsDir, getConnectorMarketDir, getPluginsDir, getSkillsDir`
- `AppSettingsStore.ts:41-47` 还有模块加载期副作用（`require("node:fs").statfsSync` 探测）。

**好消息（实测）**：本仓库已有"路径可注入"的成熟范式可照抄——`src/main/capabilities/BuiltinCapabilityStore.ts:102` `constructor(path = join(getMyBuddyDir(), CONFIG_FILE))`、`src/main/experts/TaskExpertBindingService.ts:45` `resolve(options.rootDir ?? join(getMyBuddyDir(), "task-expert-bindings"))`、`src/main/mcp/McpRuntimeService.ts:56` `this.agentDir = options.agentDir ?? getMyBuddyDir()`、`src/main/remote/RemoteDeviceStore.ts:32` `constructor(private readonly path = join(getMyBuddyDir(), "remote-devices.json"))`。所以"移出所有权"应顺手把这些类改成可注入路径，否则只是把 `new` 换个地方写。

### 4.3 前提清单的覆盖缺口（关键实测）

84 条透传按接收者分布：**只有 39 条（46%）打向规划点名的 7 个协作者**，其余 45 条打向**清单外**协作者：

```
this.skillsService 9 / this.modeProfiles 9 / this.connectorsService 6 /
this.expertsService 5 / this.userFonts 5 / this.settingsStore 3 / this.backups 2   →  39（清单内）
this.memoryService 15 / this.runtimeRequirements 7 / this.btwService 5 /
this.conversationGoals 4 / this.conversationInteractions 2 / this.db 2 /
this.skillEffectiveness 2 / this.pendingActions 1 / this.libraryWorkspaceContext 1 /
this.memoryPipeline 1 / this.skillRevision 1 / this.skillAuthoringService 1 /
this.promptEnhancement 1 / this.resolveTaskExecutionW… 1 / this.forgetKernelMemories 1  →  45（清单外）
```

其中最刺眼的是 **`this.memoryService`（15 条，最大单一来源）**，而它**有真实依赖**：

```ts
696:     this.memoryService = new MemoryService(db);
```

同类清单外且有依赖的还有：

```ts
686:     this.runtimeRequirements = new RuntimeRequirementOrchestrator(this.modeProfiles);
766:     this.btwService = new BtwSessionService({        // 依赖注入袋（settings/expert/connector/...）
```

**结论（实测 + 推断）**：只处理 7 个协作者，最多只能消掉 84 条中的 **39 条**透传，距规划 100–140 更远；要吃掉全部 84 条，必须同时处理 `memoryService`（db 依赖）、`runtimeRequirements`（依赖 modeProfiles）、`btwService`（依赖袋）、`conversationGoals/Interactions`、`db`、`skillEffectiveness/skillRevision`、`promptEnhancement` 等——那是一次 IPC 装配面重构，规模远超"移出 7 个零依赖协作者"。

另外：**`modeProfiles` 不是纯叶子**，它已被别的组件持有：`AgentService.ts:686`（给 `RuntimeRequirementOrchestrator`）、`816-855`（`PromptEnhancementService`/`AgentLoadoutService` 的依赖袋里传 `modeProfiles: this.modeProfiles`）、`src/main/agent/AgentLoadoutService.ts:62`（`d.modeProfiles.getProfile(welcomeMode)`）。移动所有权必须同步改这些装配点。

### 4.4 依赖袋范式已经存在（实测，对规划有利）

`src/main/agent/AgentService.ts:848-855` 已经在用"deps 对象"把 `modeProfiles/expertService/connectorsService/skillsService/memoryService` 交给 `AgentLoadoutService`：

```ts
848:     this.loadoutService = new AgentLoadoutService({
...
850:       modeProfiles: this.modeProfiles,
852:       expertsService: this.expertsService,
853:       connectorsService: this.connectorsService,
854:       skillsService: this.skillsService,
855:       memoryService: this.memoryService,
```

这证明"移出所有权"在本仓库有先例与既有形状，**不需要发明新机制**；但也说明这批协作者**已经在被多处消费**，`private readonly` 只是 TS 层面的封装，跨文件消费者（如 `AgentLoadoutService`）走的是显式 deps。

---

## 5. Q4 — 红线方法是否真实存在且复杂（实测行号）

| 红线项 | 方法 | 行号 | 规模 | 复杂度实测 |
|---|---|---|---|---|
| prompt | `prompt` | **3735–3758** | 24 行 / 5 顶层语句 | 入口协调器：`durableBots` 路由 + `manualCompactions` 守卫(3739) + `resolvePromptCompactionBehavior` + `emitPatch` 回调(3745) + `this.promptExecution.execute`(3743) |
| prompt 实体 | `promptInternal` | **3759–4253** | **495 行 / 71 顶层语句**（全类最大） | 真正的内容装配 + 门控 + patch 发射 |
| regenerate | `regenerate` | **4300–4483** | **184 行 / 6 顶层语句** | 4313 行 `manualCompactions`/`isCompacting` 守卫 |
| createSession | `createSession` | **5213–5656** | **444 行 / 70 顶层语句** | 会话创建 + 审批桥 `sessionApprovals.create`(5437) + 技能/记忆/运行时装配 |
| 会话事件派发 | `dispatchPatch` | **1092–1101** | 10 行 / 2 语句 | 单一出口 |
| 会话事件派发 | `emitPatch` | **1112–1134** | 23 行 / 3 语句 | delta 合并 + 16ms 定时 flush + 结构事件先 flush(1132) |
| 会话事件派发 | `flushDeltaPatches`（箭头属性） | **1103–1110** | 8 行 / 6 语句 | |
| compaction | `getCompactionStatus` | 3566–3571 | 6 行 / 4 语句 | |
| compaction | `publishCompactionState` | 3573–3588 | 16 行 / 6 语句 | 内含 `emitPatch({type:"compaction_status"})`(3587) |
| compaction | `abortCompaction` | 3590–3596 | 7 行 / 5 语句 | |
| compaction | `compactTask` | **3598–3657** | **60 行 / 13 语句** | 依赖 `manualCompactions` Map（声明 @**3562**，使用 3568/3574/3591/3613/3653/3739/4313/4664） |
| compaction | `applyCompactionReserveForModel` | 5098–5114 | 17 行 / 1 语句（try/catch） | |
| 审批 | `approveTool` | **4748–4782** | 35 行 / 6 语句 | 外部写授权 + `sessionApprovals.addWriteGrant`(4760) + `emitPatch tool_update`(4769) |
| 审批 | `approveKernelMemorySkillCandidate` | 3457–3475 | 19 行 / 8 语句 | |
| 审批 | `approveKernelSkillRevisionCandidate` | 3517–3553 | 37 行 / 11 语句 | |
| 审批 | `approveKernelProjectionProposal` | 4973–4977 | 5 行 / 3 语句 | |
| 审批（关联） | `SessionApprovalBridge` 装配 | 687–693 | — | `emitPatch`/`emitLifecycle` 回调 |
| 审批（关联） | `rejectKernelMemorySkillCandidate` / `reject`/`restore` ProjectionProposal | 3476–3480 / 4979–4983 / 4985–4989 | 各 5 行 | |

**红线安全性实测**：本文的 84 条透传方法与上表任一方法**没有任何行号重叠**（集合交集为 0）。唯一紧邻的是 `reindexKernelMemory`@**3559**（单条 `return this.memoryService.reindexSemantic(limit)`），它位于 `approveKernelSkillRevisionCandidate`(3517–3553) 与 `getCompactionStatus`(3566–3571) **之间、但不属于任何红线方法**。

**红线定义本身的漏洞（实测，必须修正）**：规划写"不碰 `prompt()`"，但 `prompt()` 只有 24 行、是纯入口；真正的 495 行实体是 `promptInternal`@3759–4253。同理红线未点名：
- `promptInternal`（495 行，真正的主体）
- `createTransientSession`@4485–4604（120 行 / 18 语句）
- `abortTask`@4668–4732（65 行 / 19 语句）、`abort`@4662–4666
- `dispatchPatch`/`emitPatch`/`flushDeltaPatches`（事件派发三件套）
- `SessionApprovalBridge` 装配@687–693、`manualCompactions`@3562、`sessionApprovals`@908

按当前字面红线执行"清扫透传"，`promptInternal`、`createTransientSession`、`abortTask` 都落在保护范围之外。

---

## 6. Q5 — 判断：删除纯透传层的真实数量级

**实测**：
1. 方法基数 **256**（不是 286）。
2. 纯透传 **65**（规划字面口径）/ **71**（含逐字转发）/ **84**（含 13 条 void）/ **82**（最宽松可辩护上限）。
3. 删除后的真实收益：**方法数 −65～−84**（占 256 的 25%–33%），**源码 −约 243 行**（占类体 5312 行的 4.6%）。**"方法数真减"成立**，但"100–140"高估了 1.2×（对最宽松 82）到 2.15×（对字面 65）。

**推断（标注为推断）**：
- 286 与 100–140 很可能来自"看起来像方法/看起来像转发"的正则或人工抽样，而不是语法级判定；两者都偏高约 10%–50%。
- 规划把 7 个"零依赖协作者"当成全部前提，但**只有 46%（39/84）的透传打向它们**；`memoryService`（15 条）与 `runtimeRequirements`（7 条）才是缺口主体，前者依赖 `db`。若坚持"只动 7 个零依赖协作者"，可消透传 **39 条**，届时方法数只减 15%。
- 由于这 7 个类当前都靠 `homedir()` 环境路径定位，"移出所有权"若不同时引入路径注入（照 `BuiltinCapabilityStore.ts:102` 范式），只是把全局依赖换个持有者，收益主要是可测试性而非可测的体量缩减。

**判据落点**：`refutes_parent = true` —— 纯透传数量（65–84）**明显低于 100**，且方法基数 286 亦不成立。

---

## 7. 规划修正建议（供 Phase 3.1 直接采用）

1. **改基数、改区间**：把"约 286 个方法"改为"**256 个 ClassMethod（含 constructor；计入 `flushDeltaPatches` 箭头属性则 257）**"，把"约 100 到 140 个纯透传"改为"**65 个（严格）/ 71 个（含逐字转发）/ 最多 84 个（含 void 形态）**"，并把预期收益写成"方法数 −65～−84、源码 −约 243 行、占类体 4.6%"。
2. **补全前提清单**：在 7 个零依赖协作者之外，显式加入 `this.memoryService`(15 条，`new MemoryService(db)`@696)、`this.runtimeRequirements`(7 条，依赖 `this.modeProfiles`@686)、`this.btwService`(5 条)、`this.conversationGoals`(4)/`this.conversationInteractions`(2)、`this.db`(2)、`this.skillEffectiveness`(2)、`this.skillRevision`(1)、`this.skillAuthoringService`(1)、`this.pendingActions`(1)、`this.libraryWorkspaceContext`(1)、`this.memoryPipeline`(1)、`this.promptEnhancement`(1)；否则最多只消 39 条。同时把 `modelsStore`(528)、`builtinCapabilities`(542)、`pythonRuntime`(548) 一并纳入"零依赖/环境依赖字段"清单。
3. **给协作者加可注入路径**：按 `BuiltinCapabilityStore.ts:102` / `TaskExpertBindingService.ts:45` / `McpRuntimeService.ts:56` 既有范式，把 `SkillsService/ExpertService/ConnectorService/UserFontsStore/AppSettingsStore/ModeProfileStore/FileBackupService` 改成 `constructor(rootDir = getXxxDir())`，并把 `AgentService` 的字段初始化器（523/524/527/529/530/540/549）改成构造参数或 deps 注入；同步更新既有消费点 `AgentService.ts:686 / 816 / 848-855` 与 `AgentLoadoutService.ts:62`。
4. **重写红线为行号白名单**：`promptInternal`@3759–4253、`prompt`@3735–3758、`regenerate`@4300–4483、`createSession`@5213–5656、`createTransientSession`@4485–4604、`abort`@4662–4666、`abortTask`@4668–4732、事件派发 `dispatchPatch`@1092–1101 + `flushDeltaPatches`@1103–1110 + `emitPatch`@1112–1134、compaction `getCompactionStatus`@3566–3571 + `publishCompactionState`@3573–3588 + `abortCompaction`@3590–3596 + `compactTask`@3598–3657 + `applyCompactionReserveForModel`@5098–5114 + `manualCompactions`@3562、审批 `approveTool`@4748–4782 + `approveKernelMemorySkillCandidate`@3457–3475 + `approveKernelSkillRevisionCandidate`@3517–3553 + `approveKernelProjectionProposal`@4973–4977 + `SessionApprovalBridge`@687–693/908；并加入验收断言：删除集与上述区间行号交集必须为空（本次实测为 0）。
5. **验收方式**：删除前后各跑一次 AST 统计脚本（本文 §1 步骤 1–3），断言 `ClassMethod` 由 256 降到预期值、`this.<field>` 计数按 §1 清单变化，且 `pnpm -s typecheck` 与相关 `test:*` 不新增失败。

---

## 8. 结构图（内联 SVG，自包含，浅底深字）

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 980 560" width="980" height="560" role="img" aria-label="AgentService 方法与纯透传统计核对">
  <rect x="0" y="0" width="980" height="560" fill="#ffffff"/>
  <text x="24" y="34" font-size="19" font-family="Segoe UI, sans-serif" fill="#111827" font-weight="bold">AgentService.ts（511–5822，5312 行）：规划值 vs 实测值</text>

  <!-- left: claim -->
  <rect x="24" y="58" width="300" height="212" rx="10" fill="#fef3f2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="42" y="84" font-size="15" font-family="Segoe UI, sans-serif" fill="#7f1d1d" font-weight="bold">规划 Phase 3.1 声明</text>
  <text x="42" y="112" font-size="14" font-family="Segoe UI, sans-serif" fill="#111827">方法总数：约 286</text>
  <text x="42" y="136" font-size="14" font-family="Segoe UI, sans-serif" fill="#111827">纯透传：约 100 – 140</text>
  <text x="42" y="160" font-size="14" font-family="Segoe UI, sans-serif" fill="#111827">前提：移出 7 个零依赖协作者</text>
  <text x="42" y="184" font-size="14" font-family="Segoe UI, sans-serif" fill="#111827">红线：prompt/regenerate/</text>
  <text x="42" y="204" font-size="14" font-family="Segoe UI, sans-serif" fill="#111827">createSession/事件/压缩/审批</text>
  <text x="42" y="238" font-size="14" font-family="Segoe UI, sans-serif" fill="#b91c1c" font-weight="bold">两处基数均不成立</text>
  <text x="42" y="258" font-size="13" font-family="Segoe UI, sans-serif" fill="#7f1d1d">方法数高估 11.7%；透传高估 1.2×–2.15×</text>

  <!-- right: measured -->
  <rect x="344" y="58" width="612" height="212" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="362" y="84" font-size="15" font-family="Segoe UI, sans-serif" fill="#14532d" font-weight="bold">实测（Babel AST + 缩进正则交叉校验，二者差集为空）</text>
  <text x="362" y="112" font-size="14" font-family="Segoe UI, sans-serif" fill="#111827">类成员 334 = ClassMethod 256（255 method + 1 constructor）+ ClassProperty 78</text>
  <text x="362" y="136" font-size="14" font-family="Segoe UI, sans-serif" fill="#111827">含箭头属性 flushDeltaPatches@1103 → 方法最宽口径 257</text>
  <text x="362" y="166" font-size="14" font-family="Segoe UI, sans-serif" fill="#111827">P1 严格（单条 return this.x.y(裸标识符)）＝ 65</text>
  <text x="362" y="190" font-size="14" font-family="Segoe UI, sans-serif" fill="#111827">P2 ＋逐字转发（?? / 展开 / 拆包）＝ 71</text>
  <text x="362" y="214" font-size="14" font-family="Segoe UI, sans-serif" fill="#111827">P3 ＋void 形态单语句 ＝ 84　→ 剔除 2 条含逻辑者 ＝ 82</text>
  <text x="362" y="242" font-size="14" font-family="Segoe UI, sans-serif" fill="#14532d" font-weight="bold">删除收益：方法 −65～−84，源码 −243 行（类体 4.6%）</text>
  <text x="362" y="262" font-size="13" font-family="Segoe UI, sans-serif" fill="#166534">带守卫/副作用者（16 条）已按规划规则排除</text>

  <!-- bar chart -->
  <text x="24" y="306" font-size="15" font-family="Segoe UI, sans-serif" fill="#111827" font-weight="bold">数量级对比（同一刻度）</text>
  <g font-family="Segoe UI, sans-serif" font-size="13" fill="#111827">
    <text x="24" y="336">规划 100–140 区间</text>
    <rect x="190" y="322" width="280" height="18" fill="#fca5a5" stroke="#dc2626"/>
    <text x="478" y="336" fill="#7f1d1d">100 – 140（含带守卫委托的不可达上界 100）</text>

    <text x="24" y="366">实测 P1 严格口径</text>
    <rect x="190" y="352" width="130" height="18" fill="#86efac" stroke="#16a34a"/>
    <text x="328" y="366" fill="#14532d">65</text>

    <text x="24" y="394">实测 P3 最宽可辩护</text>
    <rect x="190" y="380" width="164" height="18" fill="#86efac" stroke="#16a34a"/>
    <text x="362" y="394" fill="#14532d">82　（84 含 void）</text>

    <text x="24" y="422">其中打向点名 7 协作者</text>
    <rect x="190" y="408" width="78" height="18" fill="#fde68a" stroke="#d97706"/>
    <text x="276" y="422" fill="#78350f">39 / 84 = 46%</text>

    <text x="24" y="450">其中打向 memoryService（清单外）</text>
    <rect x="190" y="436" width="30" height="18" fill="#fdba74" stroke="#ea580c"/>
    <text x="228" y="450" fill="#7c2d12">15（new MemoryService(db)@696）</text>
  </g>

  <!-- redline strip -->
  <rect x="24" y="472" width="932" height="70" rx="10" fill="#f8fafc" stroke="#334155" stroke-width="1.2"/>
  <text x="40" y="494" font-size="14" font-family="Segoe UI, sans-serif" fill="#0f172a" font-weight="bold">红线实测（均存在且复杂）｜ 84 条透传与红线区间行号交集 = 0</text>
  <text x="40" y="516" font-size="13" font-family="Segoe UI, sans-serif" fill="#111827">prompt 3735–3758（24 行，仅入口） → 实体 promptInternal 3759–4253（495 行）｜ regenerate 4300–4483（184 行）</text>
  <text x="40" y="534" font-size="13" font-family="Segoe UI, sans-serif" fill="#111827">createSession 5213–5656（444 行）｜ compaction 3566–3657 + 5098–5114 + manualCompactions@3562｜ 审批 approveTool 4748–4782 + SessionApprovalBridge@687–693</text>
</svg>

**图注（区分实测/推断）**：圆角框内数字均为 AST 实测；"规划声明"框内容摘自待验证声明原文；"两处基数均不成立""高估 1.2×–2.15×"为基于实测的推断结论；"含带守卫委托的不可达上界 100"是实测 T4=16 条与 P3=84 条相加所得的算术上界（因这 16 条带前置检查/副作用，规划自身定义即排除，故不可达）。

---

## 9. 复算方式（一行命令即可复现）

分析脚本（与本次相同）通过 stdin 执行，不落盘到仓库；核心三步：

1. `@babel/parser` 解析 → 取 `AgentService` 类 → `class.body.body` 计数（得 256 / 78 / 334）；
2. 对每个 `ClassMethod` 断言 `body.body.length === 1` 且语句形态为 `return/void this.<...>`，并按实参是否全为 `Identifier`/`SpreadElement(Identifier)` 分层（得 65 / 71 / 84）；
3. 对 7 个协作者文件重复步骤 1，读取其 `kind === "constructor"` 节点（得 6 个无构造函数 + 1 个可选参数）。

关键行号索引（供抽查）：`511`、`523`、`524`、`527`、`529`、`530`、`540`、`549`、`576`、`590`、`628`、`951`、`1015`、`1027`、`1039`、`1092`、`1103`、`1112`、`1891`、`2279`、`2413`、`2462`、`2948`、`3237`、`3457`、`3517`、`3559`、`3562`、`3566`、`3598`、`3735`、`3759`、`4300`、`4748`、`4797`、`4844`、`5213`；`FileBackupService.ts:41`、`paths.ts:13`、`BuiltinCapabilityStore.ts:102`、`TaskExpertBindingService.ts:45`、`AgentLoadoutService.ts:62`。
