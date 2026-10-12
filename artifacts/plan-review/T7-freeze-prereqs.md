# T7 — Phase 4 冻结增量（四条规则）执行前最终复核

- 仓库：`C:\Users\servi\Documents\GitHub\wavealstra_harness`
- 模式：**只读核查**（唯一写入 = 本报告）
- 复核时间：2026-10-12
- 被复核对象：规划 Phase 4 冻结增量的四条口头规则
- 标记约定：**【实测】**= 本次会话用工具直接读到的事实（附 `文件:行号` 与原样引用）；**【推断】**= 基于实测的推理判断

---

## 0. 结论速览

| # | 被验证声明 | 前置事实是否成立 | 是否已是既有惯例 | 能否自动强制 | 判定 |
|---|---|---|---|---|---|
| 1 | appStore 不再新增顶层键；新域开独立小 store 文件（参考 btwStore 模式） | **btwStore 存在**：`src/renderer/src/store/btwStore.ts`（499 行） | 是（另有 `projectConfigRailStore.ts` 129 行） | ❌ 无 lint、无门禁 | 前半句（顶层键冻结）为**真新增约束**；后半句**只是复述既有惯例** |
| 2 | index.ts 新 IPC channel 一律用 `XxxIpc` 常量加进 **ipc 域文件** | **不成立**：`src/main/ipc/` 不存在，`src/main` 下 0 个文件定义 `XxxIpc` | 常量惯例是既有惯例，但位置在 `src/shared/*.ts` | ❌ 无 lint | **规则目标位置错误**，照字面执行会把人引到不存在的目录 |
| 3 | AgentService 新方法禁止进 AgentService；新域按 **agent 下 `DomainService.ts`** 独立文件 | **部分不成立**：`src/main/agent/` 70 个顶层文件，**无 `DomainService.ts`**（全仓 `*DomainService*.ts` 0 命中） | "不进 AgentService" 是既有惯例且**已有机器门禁**（N7–N14） | ⚠️ 部分（`test:architecture` N7–N14） | "不进 AgentService"= 重复惯例；"`agent/DomainService.ts`"= **无先例的新发明**，且与既有 `<domain>/<Domain>Service.ts` 惯例冲突 |
| 4 | renderer 新代码禁止 `window.api?.db.*`，走 **dbSync** | **不成立**：`dbSync` 全仓 0 命中 | "只有 appStore 用 db" 事实上已是现状（40/40 全在 appStore） | ❌ 无 lint、无扫描测试 | 禁令接近重复现状；指定替代物 `dbSync` **不存在**，规则不可执行 |

**refutes_parent = true** —— 依据：规则 2 的前置目录 `src/main/ipc/` 不存在；规则 3 的 `agent/DomainService.ts` 不存在；规则 4 的 `dbSync` 不存在。（规则 1 的 `btwStore` 前置事实**成立**。）

---

## 1. 规则一：appStore 顶层键冻结 + 独立小 store 文件

### 1.1 btwStore 模式确实存在【实测】

```
src\renderer\src\store\btwStore.ts    499 行
```

`src/renderer/src/store/btwStore.ts:6-15`（原样引用，节选 1–15）：

```ts
import { create } from "zustand";
import type { BtwUiPatch } from "../../../shared/agent-ipc";
import type { ChatMessage } from "@/types";
import { applyPatchToMessage, useAppStore } from "./appStore";

/**
 * BTW（By The Way，临时上下文分支）renderer 状态模型。
 *
 * 隔离契约（与主任务管道完全正交）：
 * - 消息只存在于本 store 的 ephemeral messages，绝不写入 Task.messages；
 * - 补丁只经独立 btw:event 通道进入 applyBtwPatch，绝不经过 applyAgentPatch 的任务 reducer；
 * - 消息/会话 id 使用 btw-* 前缀，与主任务 id 空间隔离；
 * - 不写 sessionFile / DB / memory；app 重载/重启即消失（主进程另有 keepalive 超时回收）；
 * - 切换父任务即销毁（不漂移、不恢复）。
 */
```

`src/renderer/src/store/btwStore.ts:269`：

```ts
export const useBtwStore = create<BtwState>((set, get) => ({
```

### 1.2 renderer store 目录实际只有 3 个文件【实测】

```
src/renderer/src/store/appStore.ts              6377 行
src/renderer/src/store/btwStore.ts               499 行
src/renderer/src/store/projectConfigRailStore.ts 129 行
```

→ **"独立小 store 文件"已是既有惯例**，有两个先例（btwStore 499 行、projectConfigRailStore 129 行）。第二个先例的文件头（`projectConfigRailStore.ts:1-8`）：

```ts
/**
 * Project Config Rail UI store（Project V2 右栏）。
 * 状态归属：renderer UI store（实施文档 §47），不入 Project Domain。
 * - preferredWidth / collapsed 持久化到 localStorage（UI preference，§16/§17）
 * ...
 */
```

### 1.3 appStore 顶层键实际规模【实测】

`src/renderer/src/store/appStore.ts:276`：

```ts
interface AppState {
```

该 interface 从第 276 行延伸到第 **753** 行，顶层属性键 **261 个**（`action + state` 混在同一 interface 内）。因此"不再新增顶层键"针对的是一个已经严重膨胀的结构 —— 这是**真新增约束**，而不是复述。

**⚠ 规则一的书面冲突**：`docs/STATUS.md:275` 仍写着

```
- **渲染层**：单 zustand store；新任务草稿态（首条消息才 materialize）；…
```

该文档描述与现行 3 个 store 文件的事实**已经过时/互相矛盾**。冻结增量若要落地，需同步修订这句，否则"参考 btwStore 模式"与仓库内唯一成文描述直接打架。

### 1.4 是否有自动机制强制"新 store 独立成文件"【实测：没有】

- 根目录**无** ESLint 配置（无 `eslint.config.*` / `.eslintrc*`）。
- `package.json` 的 `devDependencies` 中**无** `eslint` / `biome` / `oxlint`。
- `package.json` 的 `scripts` 中**无** `lint` 脚本；相关门禁只有 `typecheck` 与逐个子系统的 `test:*`。
- `scripts/architecture-test.ts` 只在 662 / 778 / 1846 行 `import` 真实 `useAppStore` 做**行为**测试，**不扫描** appStore 的顶层键数量或 store 目录文件清单。
- 与 store 直接相关的**唯一**静态门禁是 `test:btw-arch`（`scripts/btw-architecture-test.ts`），它用正则断言 **btwStore 的隔离红线**（如 `btw-architecture-test.ts:78` `ok(!/applyAgentPatch\(/.test(btwStore), "3.1 btwStore 不经过任务 reducer（applyAgentPatch）")`），**不**断言"新域必须新开文件"。

**【推断】** `test:btw-arch` 是可复制的**先例形态**：若要把规则 1 变成可自动强制的约束，正确做法是新增同构的扫描测试（例如"store 目录文件数 + appStore `AppState` 顶层键 ≤ 冻结基线"），而不是仅写成一句口头规则。

---

## 2. 规则二：新 IPC channel 用 XxxIpc 常量加进"ipc 域文件"

### 2.1 `src/main/ipc/` 目录不存在【实测】

- `Test-Path src\main\ipc` → `False`
- `Get-ChildItem src -Recurse -Directory | Where-Object { $_.Name -eq 'ipc' }` → **0 个结果**（整个 `src/` 树内没有任何名为 `ipc` 的目录）
- `src/main/` 下共 **35** 个子目录：`agent, artifact, assets, blueprint, browser, cad, capabilities, connectors, cron, db, experts, external-agent, gadget, gateway, html-edit, library, mcp, memory, notification, plugins, professional-tools, project, remote, retrieval, runtime, security, shims, skills, task, terminal, types, usage, voice, workgraph, workspace` —— **无 `ipc`**。

### 2.2 IPC channel 常量对象当前所在目录【实测：`src/shared/`】

`src/main/` 下**没有任何文件**定义 channel 常量对象（`Select-String -Pattern 'export const \w+Ipc\s*=\s*\{'` 在 `src/main/**` 命中 **0** 个）。

常量全部定义在 `src/shared/` —— 共 **23** 个文件包含 `export const XxxIpc = {`：

```
agent-ipc.ts  archive-deletion.ts  artifact-ipc.ts  blueprint-ipc.ts
capture-mode.ts  conversation-branch.ts  conversation-runtime.ts  external-agent.ts
gadget-ipc.ts  html-edit.ts  library-ipc.ts  memory-gateway.ts  memory-kernel.ts
notification.ts  plugin-storage.ts  professional-tools.ts  prompt-context.ts
python-runtime.ts  selection.ts  terminal-ipc.ts  work-graph.ts
workspace-library-binding.ts  workspace-shared-context.ts
```

主仓最大的一处是 `src/shared/agent-ipc.ts`（**2278** 行），其内部一次定义 14 个 channel 常量对象（原样引用首行）：

```ts
src/shared/agent-ipc.ts:13   export const BtwIpc = {
src/shared/agent-ipc.ts:76   export const EnhanceIpc = {
src/shared/agent-ipc.ts:110  export const AgentIpc = {
src/shared/agent-ipc.ts:265  export const CronIpc = {
src/shared/agent-ipc.ts:275  export const GatewayIpc = {
src/shared/agent-ipc.ts:286  export const RuntimeConsoleIpc = {
src/shared/agent-ipc.ts:296  export const BrowserIpc = {
src/shared/agent-ipc.ts:324  export const SubagentIpc = {
src/shared/agent-ipc.ts:406  export const ArtifactIpc = {
src/shared/agent-ipc.ts:424  export const ArtifactSurfaceIpc = {
src/shared/agent-ipc.ts:456  export const McpIpc = {
src/shared/agent-ipc.ts:484  export const DbIpc = {
src/shared/agent-ipc.ts:550  export const WorkspaceIpc = {
src/shared/agent-ipc.ts:2165 export const UsageIpc = {
```

### 2.3 常量惯例的覆盖率与既有违规【实测】

`src/main/index.ts`（3463 行）内 `ipcMain.handle(` / `ipcMain.on(` 调用共 **444** 处，其中 **12** 处使用**字面量** channel 字符串（即 432 处走常量）：

```
src/main/index.ts:715   ipcMain.on("theme:set", (_event, theme: AppTheme) => {
src/main/index.ts:764   ipcMain.handle("workspace:pickLocalFile", async () => {
src/main/index.ts:842   ipcMain.handle("workspace:pickLocalFolder", async () => {
src/main/index.ts:862   ipcMain.handle("workspace:pickZipFile", async () => {
src/main/index.ts:885   ipcMain.handle("workspace:pathExists", (_event, folderPath?: string) => {
src/main/index.ts:894   ipcMain.handle("workspace:openFolder", async (_event, folderPath?: string) => {
src/main/index.ts:903   ipcMain.handle("workspace:showInFolder", (_event, filePath: string) => {
src/main/index.ts:907   ipcMain.handle("workspace:listFiles", (_event, root: string) => listWorkspaceFiles(root));
...（共 12 处：theme:set / shell:startNativeDrag / workspace:*）
```

**【推断】** 12 处字面量均为早期遗留通道，属于**未被冻结规则约束的存量违规**。若规则 2 要保持"零例外"，需要一并写出这 12 处的豁免或迁移，否则新规则第一天就与现状不符。

### 2.4 是否有自动机制强制"常量必须在某个文件"【实测：没有】

全仓 `scripts/**` 中只有 1 处 `ipcMain.handle("…")` 字面量（`scripts/subagent-ipc-host-test.ts:86`，测试桩），没有任何扫描"channel 常量必须定义在 X 目录"的测试。 → 规则 2 **纯口头契约**。

**判定**：规则 2 的**前半段（必须用 `XxxIpc` 常量）重复既有惯例**（432/444 已如此，零成本、几乎无用）；**后半段（"加进 ipc 域文件"）指向不存在的 `src/main/ipc/`**，正确位置是 `src/shared/*-ipc.ts`（多数为非 `-ipc` 后缀文件，如 `notification.ts`、`memory-kernel.ts`）。

---

## 3. 规则三：AgentService 不进新方法 / `agent` 下 `DomainService.ts`

### 3.1 agent 目录文件清单【实测】

`src/main/agent/`：顶层文件 **70** 个 + 子目录 2 个（`durable/` 7 个文件、`providers/` 3 个文件），递归共 **80** 个文件。

顶层 70 个文件全量：

```
AgentLoadoutObservationService.ts, AgentLoadoutResolver.ts, AgentLoadoutService.ts,
AgentService.ts, artifact-index.ts, BrowserAutomationFailureRecovery.ts,
BtwSessionService.ts, CadFailureRecovery.ts, ComputerUseFailureRecovery.ts,
conversation-runtime-extension.ts, ConversationBranchService.ts,
ConversationExecutionContext.ts, ConversationGoalRepository.ts,
ConversationGoalService.ts, ConversationInteractionRepository.ts,
ConversationInteractionService.ts, delete-parser.ts, EphemeralContextProjection.ts,
EvidenceBudget.ts, ExecutionAttemptRepository.ts, ExecutionFailureRepository.ts,
ExecutionRestartRecovery.ts, ExecutionVerifierRegistry.ts, FileBackupService.ts,
LegacyExecutionControlHistory.ts, LegacyMemoryHistoryHygiene.ts,
LegacyMemorySummaryRecovery.ts, LibraryWorkspaceContextService.ts,
mcp-side-effect-extension.ts, MemoryContextProjection.ts, mode-defaults.ts,
ModelInvocationAdmission.ts, ModelsConfigStore.ts, ModeProfileStore.ts,
parse-user-prompt.ts, PendingActionRegistry.ts, permission-extension.ts,
PiAzureProviderMigration.ts, PromptAssembly.ts, PromptContextBudget.ts,
PromptEnhancementService.ts, PromptExecutionCoordinator.ts, PromptFailureRecovery.ts,
PromptRunRegistry.ts, PromptSubmissionCoordinator.ts, request-transport.d.mts,
request-transport.mjs, RuntimeAssemblyFingerprint.ts, RuntimeAuditStorage.ts,
RuntimeContextResolver.ts, RuntimeContextSnapshotRepository.ts,
RuntimeMaterialEvidence.ts, RuntimeRequirementRecovery.ts, session-branch.ts,
session-history.ts, session-user-messages.ts, SessionApprovalBridge.ts,
SessionEventCoordinator.ts, SessionExtensionAssembler.ts, SessionFileRecovery.ts,
SessionLifecycleManager.ts, SessionRegistry.ts, sessionSkillPaths.ts, ShellArguments.ts,
SkillAuthoringFailureRecovery.ts, SkillPolicy.ts, subagent-invocation-host.ts,
subagent-ipc-host.ts, UiAutomationFailureRecovery.ts, VerifiedCodeExecution.ts
```

**`DomainService.ts` 不在其中**；`glob **/*DomainService*.ts` → **0 命中**（全仓无任何以 `DomainService` 命名的文件）。

### 3.2 SkillsService / ExpertService / ConnectorService 的真实位置【实测】

规则引用的三个"先例"确实存在，但**不在 `src/main/agent/` 下**，而是**每个域一个平级目录**：

```
src/main/skills/SkillsService.ts            1149 行
src/main/skills/SkillAuthoringService.ts     455 行
src/main/experts/ExpertService.ts           1359 行
src/main/experts/TaskExpertBindingService.ts 175 行
src/main/connectors/ConnectorService.ts      630 行
```

`src/main/` 下全部 **55** 个 `*Service.ts` 分布在 30 个子目录（`artifact/`、`memory/`、`remote/`、`capabilities/`、`mcp/`、`workspace/` …），**惯例是 `<domain>/<Domain>Service.ts`**，例如：

```
src/main/artifact/ArtifactService.ts
src/main/memory/MemoryService.ts
src/main/remote/RemoteAccessService.ts
src/main/capabilities/UiAutomationService.ts
src/main/agent/AgentService.ts          ← agent 只是其中之一，不是容器
```

**【推断】** 因此"新域按 agent 下 `DomainService.ts` 独立文件"这句话在**形式上与既有惯例相反**：agent 目录是**会话运行时**的域，不是所有新域的父目录。照字面执行会把 `skills`/`experts` 这类域塞进 `agent/`，制造新的不一致。

### 3.3 "禁止新方法进 AgentService" 已有机器门禁【实测：已存在，N7–N14】

`scripts/architecture-test.ts` 已用 8 组断言把职责从 AgentService 驱逐出去并防止回流（原样引用注释行）：

```
scripts/architecture-test.ts:2175  // ---- N7. Library / Workspace Context 已从 AgentService 抽离，防止 God Object 回流 ----
scripts/architecture-test.ts:2176  const agentSource = readFileSync("src/main/agent/AgentService.ts", "utf8");
scripts/architecture-test.ts:2201  // ---- N8. Main Session extension wiring 归一到 SessionExtensionAssembler ----
scripts/architecture-test.ts:2276  // ---- N9. Session approval bridge is isolated from AgentService ----
scripts/architecture-test.ts:2298  // ---- N10. Main session lifecycle side effects are isolated from AgentService ----
scripts/architecture-test.ts:2320  // ---- N11. Prompt execution/submission state machines stay outside AgentService ----
scripts/architecture-test.ts:2351  // ---- N12. Main session event projection stays outside AgentService ----
scripts/architecture-test.ts:2369  // ---- N13. BTW runtime stays in dedicated service ----
scripts/architecture-test.ts:2391  // ---- N14. Prompt Enhance stays in dedicated service ----
```

运行入口：`pnpm -s test:architecture`。

**【推断】** 这是四条规则中**唯一已有自动强制**的一条 —— 但强制的是**已列出的 8 个具体职责**（Library/Workspace、session factory、approval、lifecycle、prompt coordination、event projection、BTW、prompt enhance），**不能**自动拦截"任意第 9 个新职责"。要覆盖新域，必须在 `architecture-test.ts` 里**再加一条 N15+ 断言**（形态照抄 N7）。

**判定**：规则 3 的"不进 AgentService"= **重复既有惯例**（且部分已有门禁，零边际成本）；"`agent/DomainService.ts`"= **真新增但无先例、且与仓库惯例冲突**，属于需要重写的条款。

---

## 4. 规则四：renderer 禁止 `window.api?.db.*`，走 dbSync

### 4.1 `dbSync` 全仓不存在【实测】

对 `src/`、`scripts/`、`shared/`、`docs/` 全量搜 `dbSync|db-sync|DbSync`（大小写不敏感）→ **0 命中**；对全部 `*.md` 搜同样模式 → **0 命中**。

**结论：规则 4 指定的替代物 `dbSync` 在仓库中不存在**，因此"走 dbSync"这条**不可执行**（既无模块，也无 import 路径，也无契约）。

### 4.2 `window.api?.db` 的现有分布【实测：40/40 全在 appStore】

renderer 全域 `window.api?.db` 共 **40** 处，**全部**位于 `src/renderer/src/store/appStore.ts`，其余 renderer 文件（组件层）**0** 处：

```
src/renderer/src/store/appStore.ts:771   const result = await window.api?.db?.upsertSpace({
src/renderer/src/store/appStore.ts:889   const rows = await window.api?.db?.listTasks?.();
src/renderer/src/store/appStore.ts:1499  void window.api?.db?.upsertTask({
src/renderer/src/store/appStore.ts:1929  void window.api?.db?.upsertTask({
src/renderer/src/store/appStore.ts:2964  void window.api?.db?.upsertTask({
src/renderer/src/store/appStore.ts:3300  const deletePromise = window.api?.db?.deleteTask(id);
src/renderer/src/store/appStore.ts:3332  const api = window.api?.db?.purgeArchivedContent;
src/renderer/src/store/appStore.ts:5371  await window.api?.db?.upsertTask?.({
src/renderer/src/store/appStore.ts:5671  void window.api?.db?.upsertTask({
...（共 40 处，行号区间 771–5671）
```

**【推断】** "renderer 不用 `window.api.db`"在**组件层已经是既成事实**（0 违规），所以规则 4 的前半句**接近重复现状**。它的真实约束力只落在"appStore 自己"——而 appStore 又必须继续写库（40 处都在它内部），于是规则 4 对 appStore **自我豁免**，边界定义模糊：到底"renderer 新代码"是否包含 appStore 的新方法？规划未说明。

### 4.3 是否有自动机制强制【实测：没有】

- 无 ESLint（见 §1.4），因此**没有** `no-restricted-properties` / `no-restricted-syntax` 这类现成手段。
- `scripts/**` 中 `window.api?.db` 的出现**全部**在 CDP/Electron 实时测试的 `evaluate("…")` 字符串里（如 `scripts/durable-bot-desktop-test.cjs:283`），属于**运行期调用**，不是静态守卫。
- 无任何测试断言"appStore 之外不得出现 `window.api?.db`"。

**【推断】** 若要把规则 4 落地，唯一现实路径是**新写一个源码扫描测试**（同 `btw-architecture-test.ts` 形态：读所有 renderer 文件，断言 `window.api?.db` 只在 `store/appStore.ts` 命中），并把 `dbSync` 这一半**先设计出来**再写进规则。

---

## 5. 前置事实核对总表（逐条 · 含佐证）

| 核查项 | 实测结果 | 佐证（文件:行号） |
|---|---|---|
| btwStore 模式是否存在 | **存在**，499 行 | `src/renderer/src/store/btwStore.ts:1`、`:269` |
| renderer store 目录文件清单 | **3 个**：appStore 6377 / btwStore 499 / projectConfigRailStore 129 | `src/renderer/src/store/*.ts` |
| "独立小 store 文件"是否既有惯例 | **是**（2 个先例） | `btwStore.ts`、`projectConfigRailStore.ts:1-8` |
| appStore 顶层键规模 | **261 个**（interface 276–753 行） | `src/renderer/src/store/appStore.ts:276` |
| 成文描述是否一致 | **不一致**（仍写"单 zustand store"） | `docs/STATUS.md:275` |
| `src/main/ipc/` 是否存在 | **不存在**（`Test-Path` = False；`src/` 内无名为 ipc 的目录） | 目录枚举：`src/main` 35 个子目录 |
| IPC channel 常量所在目录 | **`src/shared/`**（23 个文件） | `src/shared/agent-ipc.ts:13,110,484`、`:2165` |
| 常量惯例覆盖率 | **432/444** 走常量，12 处字面量 | `src/main/index.ts:715,764,842,…` |
| `agent/DomainService.ts` 是否存在 | **不存在**（全仓 `*DomainService*.ts` 0 命中） | `src/main/agent/` 70 个顶层文件清单 |
| SkillsService/ExpertService/ConnectorService 位置 | 在 `src/main/{skills,experts,connectors}/`，**不在 agent/** | `skills/SkillsService.ts` 1149 行、`experts/ExpertService.ts` 1359 行、`connectors/ConnectorService.ts` 630 行 |
| AgentService 边界是否已有门禁 | **已有**（N7–N14） | `scripts/architecture-test.ts:2175,2201,2276,2298,2320,2351,2369,2391` |
| `dbSync` 是否存在 | **不存在**（全仓 0 命中） | `src/`、`scripts/`、`shared/`、`docs/` 全量搜索 |
| `window.api?.db` 分布 | **40/40 全在 appStore**，组件层 0 | `src/renderer/src/store/appStore.ts:771…5671` |
| 是否存在 lint | **不存在**（无 eslint 依赖、无 lint 脚本、无配置文件） | `package.json` scripts/devDependencies；根目录无 eslint 配置 |
| 现成自动强制机制 | `test:architecture`、`test:btw-arch`、`test:task-isolation-*`（均为**手写正则断言**，非通用规则引擎） | `package.json` scripts；`scripts/architecture-test.ts`、`scripts/btw-architecture-test.ts` |

---

## 6. 图解：四条声明的前置事实 vs 实测现状

（内联自包含 SVG；**实线**=实测已确认，**虚线**=声明主张但前置事实不成立）

<svg viewBox="0 0 980 620" width="980" height="620" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="四条冻结规则的前置事实核查">
  <rect x="0" y="0" width="980" height="620" fill="#f7f8fa"/>
  <text x="20" y="34" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="20" font-weight="700" fill="#1b1f24">Phase 4 四条冻结规则：前置事实核查（■ 实测成立 / ▨ 主张位置不存在）</text>
  <text x="20" y="58" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#4a5259">证据来自本仓只读扫描；矩形内为仓库中真实存在的路径</text>

  <!-- Rule 1 -->
  <rect x="20" y="80" width="460" height="150" rx="8" fill="#ffffff" stroke="#2f6f4f" stroke-width="2"/>
  <text x="36" y="106" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="15" font-weight="700" fill="#1b1f24">规则 1 · appStore 顶层键冻结 / 独立小 store</text>
  <text x="36" y="130" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#2f6f4f">■ btwStore 模式存在：src/renderer/src/store/btwStore.ts（499 行）</text>
  <text x="36" y="152" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#2f6f4f">■ 第二先例：projectConfigRailStore.ts（129 行）</text>
  <text x="36" y="174" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#8a5a00">■ appStore.ts 6377 行，AppState 顶层键 261 个（276–753 行）</text>
  <text x="36" y="196" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#a33">■ docs/STATUS.md:275 仍写「单 zustand store」→ 与现状矛盾</text>
  <text x="36" y="218" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#a33">✗ 无 lint / 无门禁可自动强制</text>

  <!-- Rule 2 -->
  <rect x="500" y="80" width="460" height="150" rx="8" fill="#ffffff" stroke="#b3261e" stroke-width="2"/>
  <text x="516" y="106" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="15" font-weight="700" fill="#1b1f24">规则 2 · 新 channel 进「ipc 域文件」</text>
  <text x="516" y="130" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#b3261e">✗ src/main/ipc/ 不存在（Test-Path=False；src/ 内无 ipc 目录）</text>
  <text x="516" y="152" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#b3261e">✗ src/main/ 下 0 个文件定义 export const XxxIpc = {</text>
  <text x="516" y="174" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#2f6f4f">■ 常量实际在 src/shared/：23 个文件</text>
  <text x="516" y="196" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#2f6f4f">■ index.ts：444 处注册，432 走常量，12 处字面量遗留</text>
  <text x="516" y="218" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#a33">✗ 无扫描测试 → 仅口头契约</text>

  <!-- Rule 3 -->
  <rect x="20" y="246" width="460" height="150" rx="8" fill="#ffffff" stroke="#b3261e" stroke-width="2"/>
  <text x="36" y="272" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="15" font-weight="700" fill="#1b1f24">规则 3 · 不进 AgentService / agent 下 DomainService.ts</text>
  <text x="36" y="296" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#b3261e">✗ DomainService.ts 不存在（全仓 *DomainService*.ts 0 命中）</text>
  <text x="36" y="318" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#2f6f4f">■ agent/：70 顶层文件 + durable/7 + providers/3</text>
  <text x="36" y="340" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#8a5a00">■ 真实惯例是 &lt;domain&gt;/&lt;Domain&gt;Service.ts：skills/experts/connectors</text>
  <text x="36" y="362" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#2f6f4f">■ 已有机器门禁 N7–N14（test:architecture，仅覆盖 8 个职责）</text>
  <text x="36" y="384" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#4a5259">   SkillsService 1149 / ExpertService 1359 / ConnectorService 630 行</text>

  <!-- Rule 4 -->
  <rect x="500" y="246" width="460" height="150" rx="8" fill="#ffffff" stroke="#b3261e" stroke-width="2"/>
  <text x="516" y="272" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="15" font-weight="700" fill="#1b1f24">规则 4 · 禁 window.api?.db.* / 走 dbSync</text>
  <text x="516" y="296" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#b3261e">✗ dbSync 不存在（src/scripts/shared/docs 全仓 0 命中）</text>
  <text x="516" y="318" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#2f6f4f">■ window.api?.db 共 40 处，40/40 全在 appStore.ts</text>
  <text x="516" y="340" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#2f6f4f">■ 组件层 0 处 → 「不用 db」在组件层已是现状</text>
  <text x="516" y="362" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#8a5a00">▲ 规则对 appStore 自我豁免，边界未定义</text>
  <text x="516" y="384" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#a33">✗ 无静态守卫（scripts 内命中均为 CDP evaluate 字符串）</text>

  <!-- Enforcement bar -->
  <rect x="20" y="412" width="940" height="86" rx="8" fill="#ffffff" stroke="#8a5a00" stroke-width="2"/>
  <text x="36" y="438" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="15" font-weight="700" fill="#1b1f24">现成自动强制机制（实测）</text>
  <text x="36" y="462" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#4a5259">▸ 无 ESLint：无 eslint 依赖、无 lint 脚本、无 eslint 配置文件</text>
  <text x="36" y="484" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#2f6f4f">▸ 只有手写正则型测试：test:architecture（N7–N14）、test:btw-arch、test:task-isolation-*；四条规则中仅规则 3 被部分覆盖</text>

  <!-- Verdict -->
  <rect x="20" y="512" width="940" height="92" rx="8" fill="#fff4f2" stroke="#b3261e" stroke-width="2"/>
  <text x="36" y="538" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="15" font-weight="700" fill="#b3261e">判定 refutes_parent = true</text>
  <text x="36" y="562" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#1b1f24">不成立的前置事实：规则 2 的 src/main/ipc/ 、规则 3 的 agent/DomainService.ts 、规则 4 的 dbSync（三者均不存在）</text>
  <text x="36" y="584" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#2f6f4f">成立的前置事实：规则 1 的 btwStore（499 行）与「独立小 store」惯例（2 个先例）；规则 3「不进 AgentService」已有 N7–N14 门禁</text>
</svg>

---

## 7. 四条规则的可执行性判定

### 7.1 能否口头执行、无需 lint？【实测 + 推断】

- **无任何 lint 基础设施**（无 ESLint 依赖、无 lint 脚本、无配置文件）→ 四条规则**只能靠人**（code review / 规划执行者自律）落地。
- 仓库现有的自动化形态是**手写正则断言的源码扫描测试**（`scripts/architecture-test.ts`、`scripts/btw-architecture-test.ts`），并且 `AGENTS.md` 明确警告：**"Prefer asserting behaviour over source text. 30% of test files grep implementation source with readFileSync + .includes(); those break on correct refactors"**。→ 把规则做成扫描测试与仓库自身的测试哲学**方向相反**，这也是四条规则没有做成门禁的现实原因。

### 7.2 现成机制已经能自动强制哪一条？【实测】

只有**规则 3 的一部分**：`pnpm -s test:architecture` 的 `N7`–`N14` 断言阻止 Library/Workspace context、session factory、approval bridge、lifecycle、prompt coordination、event projection、BTW、prompt-enhance 回流进 `AgentService.ts`。
`test:btw-arch` 保护 **btwStore** 的隔离红线（与规则 1 的"参考 btwStore 模式"相关，但**不**强制"新域新开文件"）。
规则 1（顶层键）、规则 2（常量位置）、规则 4（renderer 禁 db）**无任何自动强制**。

### 7.3 哪些只是重复既有惯例（零成本、几乎无用）

| 条款 | 判定 | 理由（实测） |
|---|---|---|
| 规则 1 后半："新域开独立小 store 文件（参考 btwStore）" | **重复惯例** | btwStore 499 行、projectConfigRailStore 129 行两个先例已在库 |
| 规则 2 前半："用 `XxxIpc` 常量" | **重复惯例** | 432/444 已如此；23 个 shared 文件已定义 |
| 规则 3 前半："新方法不进 AgentService" | **重复惯例（且已部分有门禁）** | N7–N14 已存在 |
| 规则 4 前半："禁 renderer `window.api?.db.*`" | **接近重复现状（但非零）** | 组件层已 0 违规；约束力仅剩"appStore 是否也算"，边界未定义 |

### 7.4 哪些是真新增约束

| 条款 | 判定 | 说明 |
|---|---|---|
| 规则 1 前半："appStore 不再新增顶层键" | **真新增** | 现状 261 个顶层键、无门禁、且 `docs/STATUS.md:275` 还写着"单 zustand store"；这是四条里**唯一有实际收敛价值**的约束 |
| 规则 2 后半："加进 ipc 域文件" | **新增但写错目标** | `src/main/ipc/` 不存在，必须改写为 `src/shared/*-ipc.ts` |
| 规则 3 后半："agent 下 DomainService.ts" | **新增但无先例、与惯例冲突** | 既有惯例是 `<domain>/<Domain>Service.ts`；应改写为后者并补 N15 断言 |
| 规则 4 后半："走 dbSync" | **新增但目标不存在** | `dbSync` 全仓 0 命中；须先设计模块与契约，规则才可执行 |
| （缺项）"禁止 renderer 组件层直接 db"的可强制化 | **真正的增量工作** | 需新写源码扫描测试（同 `btw-architecture-test.ts` 形态），把"只有 appStore 可以命中"变成断言 |

---

## 8. 给规划的最小修正建议（供 Phase 4 冻结文本使用）

1. 规则 2 改写：把"加进 ipc 域文件"改为 **"常量加入 `src/shared/agent-ipc.ts`（或对应 `src/shared/*.ts`）"**；`src/main/ipc/` 不存在，不可作为落点。同时决定 `index.ts` 中 12 处字面量 channel（`theme:set` / `shell:startNativeDrag` / `workspace:*`）是否豁免。
2. 规则 3 改写：把"`agent` 下 `DomainService.ts`"改为 **"`src/main/<domain>/<Domain>Service.ts`"**（与 `skills/SkillsService.ts`、`experts/ExpertService.ts`、`connectors/ConnectorService.ts` 一致）；并把"不进 AgentService"落成 `scripts/architecture-test.ts` 的 **N15** 断言（形态照抄 N7）。
3. 规则 4 拆两步：先定义 `dbSync`（当前不存在，需明确模块路径与 API 面），再补一条 renderer 源码扫描断言（`window.api?.db` 仅允许命中 `store/appStore.ts`）；否则该条不可执行。
4. 规则 1 保留（真新增），并同步修订 `docs/STATUS.md:275` 的"单 zustand store"表述；若要可强制，用"冻结基线"断言（顶层键数 / store 文件清单）而非散文规则。
5. 四条规则**都不需要也不会有 lint 支撑**：仓库无 ESLint；任何"无需 lint 即可执行"的表述成立，但代价是**完全没有自动兜底**（仅规则 3 的 8 个职责除外）。

---

## 9. 核查方法与可复现命令（只读）

```powershell
# 规则 1
Get-ChildItem src\renderer\src\store\*.ts | ForEach-Object { $_.Name }
(Get-Content src\renderer\src\store\appStore.ts).Count      # 6377
(Get-Content src\renderer\src\store\btwStore.ts).Count      # 499
(Get-Content src\renderer\src\store\projectConfigRailStore.ts).Count  # 129

# 规则 2
Test-Path src\main\ipc                                      # False
Get-ChildItem src -Recurse -Directory | Where-Object { $_.Name -eq 'ipc' }   # 空
Get-ChildItem src\shared -File -Filter *.ts | Where-Object { Select-String -Path $_.FullName -Pattern 'export const \w+Ipc = \{' -Quiet }   # 23 个
Select-String -Path src\main\index.ts -Pattern 'ipcMain\.(handle|on)\(' -AllMatches   # 444
Select-String -Path src\main\index.ts -Pattern 'ipcMain\.(handle|on)\(\s*"' -AllMatches  # 12

# 规则 3
(Get-ChildItem src\main\agent -File).Count                  # 70
Get-ChildItem src\main -Recurse -Filter *DomainService*.ts  # 空
Select-String -Path scripts\architecture-test.ts -Pattern '---- N\d+'   # N1..N14

# 规则 4
Get-ChildItem -Recurse -File -Include *.ts,*.tsx,*.mjs,*.cjs,*.md,*.json -Path src,scripts,shared,docs | Select-String 'dbSync|db-sync|DbSync'   # 空
Get-ChildItem src\renderer -Recurse -File -Include *.ts,*.tsx | Select-String 'window\.api\?*\.db'   # 40，全部 appStore.ts

# 有无 lint
(Get-Content package.json -Raw | ConvertFrom-Json).scripts.PSObject.Properties | Where-Object { $_.Name -match 'lint' }   # 空
```

---

## 10. 结论（一段话）

**实测**：`btwStore` 模式真实存在（`btwStore.ts` 499 行，另有 `projectConfigRailStore.ts` 129 行），所以规则 1 的前置事实**成立**；但 `src/main/ipc/` 目录**不存在**（IPC channel 常量实际定义在 `src/shared/` 的 23 个文件中，`src/shared/agent-ipc.ts:13/110/484` 等）、`agent/DomainService.ts` **不存在**（`src/main/agent/` 70 个顶层文件无此文件，既有惯例是 `src/main/<domain>/<Domain>Service.ts`，如 `skills/SkillsService.ts` 1149 行）、`dbSync` **全仓 0 命中**。此外仓库**完全没有 lint**（无 eslint 依赖 / 无 lint 脚本 / 无配置文件），四条规则只能口头执行，唯一天然被自动强制的只有规则 3 的一部分（`scripts/architecture-test.ts` 的 N7–N14，防 AgentService 职责回流）。**【推断】** 四条规则中真正有增量价值的只有"appStore 不再新增顶层键"（现状 261 个顶层键）与"renderer 组件层不得直接触 db"的可强制化；其余三条（用 XxxIpc 常量、新域独立 store 文件、不进 AgentService）只是复述既有惯例，边际收益接近于零，而它们附带的**落点描述（ipc 域文件 / agent 下 DomainService.ts / dbSync）全部指向仓库中不存在的位置**，照字面执行会把实现者引到错误目录。
