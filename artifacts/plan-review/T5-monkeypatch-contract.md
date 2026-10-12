# T5 — subagent IPC 猴补丁 / 三处时序语义 执行前复核

- 仓库：`C:\Users\servi\Documents\GitHub\wavealstra_harness`（工作区根）
- 复核范围：**只读**。唯一写入 = 本文件 `out/plan-review/T5-monkeypatch-contract.md`。
  未修改任何源码；测试与探针均以 **esbuild `write:false` 内存打包 + `Module._compile`** 执行，未在仓库落任何产物（详见 §10）。
- 待验证声明（规划 Phase 2.2）：

  > `subagent-ipc-host.ts` 第 118 到 119 行对 `ipcMain.handle` 打猴补丁，加上 `index.ts` 第 673 行调用位置，加上 `whenReady` 内第 3048 到 3049 行 `HtmlEditIpc` 注册，三处时序语义要加注释与一条清单测试（断言采纳集不变）。

- 复核时间：2026-10-12（Asia/Shanghai）
- 复核定性：**不推翻**（`refutes_parent=false`）。三处行号与文件均实测核对为真；「采纳集不变」**可以**写成测试（且已有等价覆盖），声明的时序描述无事实性错误。但发现 1 处测试基建缺陷 + 3 处需要收紧的措辞（见 §8、§9）。

---

## 0. 结论摘要

| 声明要素 | 实测结论 | 判定 |
| --- | --- | --- |
| `subagent-ipc-host.ts` L118-119 对 `ipcMain.handle` 打猴补丁 | L119 是真正的覆写语句，L118 捕获原函数；补丁函数体是 **L113-126** | ✅ 行号成立（建议改成 L113-126 更准确） |
| `index.ts` L673 调用位置 | L673 `registerSubagentIpcHost(ipcMain);` 实测存在，且是**全仓库唯一调用点** | ✅ 成立 |
| `whenReady` 内 L3048-3049 `HtmlEditIpc` 注册 | L2635 是 `app.whenReady().then(...)` 起点；L3048-3049 两条 `ipcMain.handle(HtmlEditIpc.*)` 在其中 | ✅ 成立 |
| 三处时序语义需加注释 | 三处**都已有注释**：`subagent-ipc-host.ts:144`、`src/main/index.ts:672`、`src/main/index.ts:3365`（另见模块头 `subagent-ipc-host.ts:1-10`） | ⚠️ 部分已存在，补「顺序约束」注释仍有余量 |
| 一条清单测试断言「采纳集不变」 | **可行**，无需 Electron；且 `scripts/subagent-ipc-host-test.ts` L83-92 已断言等价行为（实测 14/14 通过） | ✅ 可行，但「建议新增」前置判断不准 |
| 采纳集是运行时动态填充 | ✅ `const adopted = new Map(...)`，由被补丁拦截的 `handle` 写入 | ✅ 成立 |
| 采纳的 handler 交给 subagent runtime | ❌ **不存在这条交接**：`adopted` 只在 `backend === null` 时被宿主 stub 消费；backend 是内建 `createIpcBackend()` 产物，与 adopted 无关 | ⚠️ 方向需纠正（见 §4） |

**APEX：** 声明的三处文件:行号与「窗口创建前注册」都实测为真，猴补丁实现是无 Electron 依赖的可测函数（`ipcMain` 由参数注入），因此「采纳集不变」完全可以在不启 Electron 的情况下写成测试——`scripts/subagent-ipc-host-test.ts` L83-92 已在测同一行为（实测 14/14 通过）。真正要修的规划缺口不是「能不能测」，而是 `resetSubagentIpcHostForTests()` 不还原 `ipcMain.handle`，导致同一进程内 reset 后再 register 会**静默零注册**（实测 delta=0），新增清单测试若复用同一个 mock 对象会变成假绿。

---

## 1. 待验证声明逐条核对（文件:行号 + 原样引用）

### 1.1 声明①：L118-119 对 `ipcMain.handle` 打猴补丁

`src/main/agent/subagent-ipc-host.ts:113-126`（**原样引用**）：

```ts
113: function patchHandleToAdoptLegacy(
114:   ipcMain: { handle: (channel: string, listener: (...args: unknown[]) => unknown) => void },
115: ): void {
116:   if (handlePatched) return;
117:   handlePatched = true;
118:   const original = ipcMain.handle.bind(ipcMain);
119:   ipcMain.handle = (channel: string, listener: (...args: unknown[]) => unknown) => {
120:     if (HOSTED_CHANNELS.has(channel)) {
121:       adopted.set(channel, listener);
122:       return;
123:     }
124:     return original(channel, listener);
125:   };
126: }
```

- `src/main/agent/subagent-ipc-host.ts:119`：`ipcMain.handle = (channel: string, listener: (...args: unknown[]) => unknown) => {` — **这就是猴补丁本体**（对传入的 `ipcMain` 对象做属性覆写）。
- `src/main/agent/subagent-ipc-host.ts:118`：`const original = ipcMain.handle.bind(ipcMain);` — 保存原实现并绑定 `this`，是补丁的前置步骤而非补丁本身。
- 结论：**声明「第 118 到 119 行」成立**（这两行正是补丁核心两步），但函数边界是 L113-126；建议规划里写 `patchHandleToAdoptLegacy()`（`subagent-ipc-host.ts:113-126`），只写 118-119 会在重构中把守卫 `handlePatched`（L116-117）与 `HOSTED_CHANNELS` 分支（L120-123）排除在「待注释范围」之外。

### 1.2 声明②：`index.ts` 第 673 行调用位置

`src/main/index.ts:672-673`（**原样引用**）：

```ts
672:   // 窗口创建前先挂上 subagent 通道，避免概览一启动 invoke 打出 No handler registered
673:   registerSubagentIpcHost(ipcMain);
```

- 实测全仓库检索 `registerSubagentIpcHost`：定义在 `src/main/agent/subagent-ipc-host.ts:128`，导入在 `src/main/index.ts:130`，**调用点只有 `src/main/index.ts:673` 一处**（`scripts/subagent-ipc-host-test.ts:48-49` 为测试调用）。
- 结论：**成立**。

### 1.3 声明③：`whenReady` 内 L3048-3049 `HtmlEditIpc` 注册

`src/main/index.ts:2635`（**原样引用**）：

```ts
2635: app.whenReady().then(async () => {
```

`src/main/index.ts:3048-3052`（**原样引用**）：

```ts
3048:   ipcMain.handle(HtmlEditIpc.start, (event, request: HtmlEditStart) => htmlEditService!.start(request, event.sender));
3049:   ipcMain.handle(HtmlEditIpc.stop, async (event) => {
3050:     const surface = browserHost.captureSurface ?? artifactPreviewHost.captureSurface;
3051:     if (surface?.window.webContents === event.sender) await htmlEditService?.stop();
3052:   });
```

- 结论：**成立**，且 L3048-3049 确实位于 L2635 开启的 `whenReady` 异步体内。

### 1.4 声明隐含的第三处：L3364 `registerIpc()`

`src/main/index.ts:3364-3371`（**原样引用**）：

```ts
3364:   registerIpc();
3365:   // Subagent 是编译内建能力：直接把 backend 接入稳定 IPC host，不扫描用户目录。
3366:   try {
3367:     installBuiltinSubagentIpc();
3368:     agentService.builtinCapabilities.setSubagentAvailable(true);
3369:   } catch (err) {
3370:     console.warn(`[index] 内建 Subagent IPC 初始化失败: ${err instanceof Error ? err.message : String(err)}`);
3371:   }
```

- 结论：**成立**（L3364 是 `registerIpc()` 全仓库唯一调用点，函数定义在 L644）。

### 1.5 三处「时序语义」的真实先后（实测，含行号）

| 顺序 | 事件 | 位置 | 说明 |
| --- | --- | --- | --- |
| 0 | `app.whenReady().then(async () => {` | `src/main/index.ts:2635` | 所有注册都在此异步体内 |
| 1 | `ipcMain.handle(HtmlEditIpc.start/stop, ...)` | `src/main/index.ts:3048-3049` | 在 subagent 宿主注册**之前** |
| 2 | `registerIpc();` | `src/main/index.ts:3364` | 定义于 L644 |
| 2.1 | `registerSubagentIpcHost(ipcMain);` | `src/main/index.ts:673` | **由 L3364 同步调用触发**，不是独立时刻 |
| 2.2 | 宿主 4 通道真实 `handle` | `src/main/agent/subagent-ipc-host.ts:134-143` | |
| 2.3 | `patchHandleToAdoptLegacy(ipcMain);` | `src/main/agent/subagent-ipc-host.ts:145` | **必须在 2.2 之后**（见 §5.2） |
| 3 | `installBuiltinSubagentIpc();` | `src/main/index.ts:3367` | → `capabilities/builtin-subagent.ts:15-17` → `capabilities/subagent/index.ts:568 host.setBackend(backend)` |
| 4 | `createWindow();` | `src/main/index.ts:3405` | 窗口在此才创建（定义 L472-476，`new BrowserWindow` L476） |
| 5 | 渲染层 `window.api?.subagent?.active?.()` | `src/renderer/src/components/artifact/overview/RuntimeObservatory.tsx:59`（`useEffect` 起于 L51） | 首个可能的 `subagent:active` invoke |

关键实测点：**L673 与 L3364 在运行时是同一时刻**（L3364 同步展开到 L673）。规划把它们列为两处「时序位置」在语义上重复计数了；`HtmlEditIpc`（L3048-3049）与 subagent 宿主（L673）之间**没有**任何 `createWindow`，真正的分界线是 **L3405**。

---

## 2. Q1 — 猴补丁精确实现

### 2.1 行号定位（实测）

| 元素 | 位置 |
| --- | --- |
| `patchHandleToAdoptLegacy` 定义 | `src/main/agent/subagent-ipc-host.ts:113-126` |
| 幂等守卫 `if (handlePatched) return;` | `:116` |
| 置位 `handlePatched = true;` | `:117` |
| 保存原实现 `const original = ipcMain.handle.bind(ipcMain);` | `:118` |
| **覆写 `ipcMain.handle = (...) => {...}`** | `:119` |
| 命中采纳：`adopted.set(channel, listener); return;` | `:120-123` |
| 未命中透传：`return original(channel, listener);` | `:124` |
| 调用点（注册函数末尾） | `:145` |

### 2.2 它如何替换 `ipcMain.handle`

不是替换 Electron 模块导出，而是**对传入对象做属性赋值**：`:119` 把 `ipcMain.handle` 指向闭包函数，闭包持有 `:118` 绑定的原实现。因此：

- 任何**在补丁之后**通过该 `ipcMain` 对象调用 `handle("subagent:active"|"subagent:transcript"|"subagent:steer"|"subagent:cancel", fn)` 的代码，`fn` 落入 `adopted`，Electron 侧**不会**产生 handler；
- 其余 channel 走 `:124` 透传原实现，行为不变；
- 补丁 **只对补丁安装时传入的那个 ipcMain 对象生效**（`:118` 里 `original` 也是从同一对象取的）。实测全仓库无其它 `ipcMain.handle =` 赋值（检索 `ipcMain\.handle\s*=` 仅命中 `subagent-ipc-host.ts:119`），也没有 `const { handle } = ipcMain` 之类的提前解构，因此不存在「已捕获旧引用而绕过补丁」的调用点。

### 2.3 `handlePatched` 的作用（模块级一次性开关）

`src/main/agent/subagent-ipc-host.ts:38-41`（**原样引用**）：

```ts
38: let backend: SubagentIpcBackend | null = null;
39: const adopted = new Map<string, (...args: unknown[]) => unknown>();
40: let registered = false;
41: let handlePatched = false;
```

- `handlePatched`（`:41`）：保证**同一进程内补丁只装一次**，避免 `registerSubagentIpcHost` 重入时把 wrapper 再包一层（`registered` 守卫 `:131-132` 已经挡住正常重入，`handlePatched` 是第二道保险，且与 `registered` 解耦）。
- `registered`（`:40`）：保证宿主 4 通道只 `handle` 一次（否则 Electron 抛 `Attempted to register a second handler`）。

### 2.4 `adopted` 的作用

`src/main/agent/subagent-ipc-host.ts:39`：`const adopted = new Map<string, (...args: unknown[]) => unknown>();`
`src/main/agent/subagent-ipc-host.ts:51-55`（**原样引用**）：

```ts
51: function invokeAdopted(channel: string, ...args: unknown[]): unknown {
52:   const fn = adopted.get(channel);
53:   if (!fn) return undefined;
54:   return fn({}, ...args);
55: }
```

作用有且只有两个：

1. **吸收**旧扩展对同名通道的 `ipcMain.handle`（`:121`），使其不抛 `second handler`，也不污染 Electron 注册表；
2. 在**内建 backend 缺席时**充当兜底实现（`:60/:71/:83/:98` 的 `if (backend) ... else invokeAdopted(...)`）。

注意 `:54` 传的是伪造事件 `{}`，且 `Map` 语义是**后者覆盖前者**（实测 P5）。

---

## 3. Q2 — `HOSTED_CHANNELS` 定义、成员、其它注册路径

### 3.1 定义与成员

`src/main/agent/subagent-ipc-host.ts:31-36`（**原样引用**）：

```ts
31: const HOSTED_CHANNELS = new Set<string>([
32:   SubagentIpc.active,
33:   SubagentIpc.transcript,
34:   SubagentIpc.steer,
35:   SubagentIpc.cancel,
36: ]);
```

成员值来自 `src/shared/agent-ipc.ts:324-333`（**原样引用**）：

```ts
324: export const SubagentIpc = {
325:   /** 当前父 Task 的 active 实例 */
326:   active: "subagent:active",
327:   /** 运行中实例的实时 transcript（scope 校验；已结束 → ended:true） */
328:   transcript: "subagent:transcript",
329:   steer: "subagent:steer",
330:   cancel: "subagent:cancel",
331:   /** main → renderer：active 实例变化（临时 Chat 订阅刷新） */
332:   event: "subagent:event",
333: } as const;
```

→ 集合 = `{subagent:active, subagent:transcript, subagent:steer, subagent:cancel}`（**4 条**）。
`SubagentIpc.event`（`subagent:event`）**不在**集合内：它是 main→renderer 单向推送（`src/preload/index.ts:661-662` 用 `ipcRenderer.on`；`capabilities/subagent/index.ts:482` 用 `webContents.send`），不经 `ipcMain.handle`，因此无需托管。

### 3.2 全部注册路径（实测 3 条，其中 1 条不产生真实注册）

全仓库检索 4 个通道字符串字面量，命中仅 4 个文件：`src/main/agent/subagent-ipc-host.ts`、`src/main/capabilities/subagent/index.ts`、`src/shared/agent-ipc.ts`、两个 `scripts/*test.ts`。

| # | 路径 | 位置 | 条件 | 结果 |
| --- | --- | --- | --- | --- |
| A | **宿主稳定注册**（唯一生产路径） | `subagent-ipc-host.ts:134-143` | `registerSubagentIpcHost` 被调用且 `registered === false` | 真实 `ipcMain.handle` ×4 |
| B | **旧式扩展自注册**（降级路径） | `capabilities/subagent/index.ts:582-591` | `getIpcHost()` 返回 `null`（未挂宿主槽） | 真实 `ipcMain.handle` ×4，并记入 `ipcChannels` 供 `rollbackIpc` 回滚 |
| C | **补丁吸收**（不注册） | `subagent-ipc-host.ts:120-123` | 宿主已注册（A 已发生）后任何同名 `handle` | 只写 `adopted`，**不**产生 Electron handler |

`src/main/capabilities/subagent/index.ts:555-574`（**原样引用**，路径 B/A 的分叉）：

```ts
555: function registerIpc(): void {
556:   if (ipcRegistered) return; // P2-4：严格幂等，双加载不允许重复 handle 崩主进程
557:   const host = getIpcHost();
558:   const electronMod = tryRequireElectron();
559:   ipcMainModule = electronMod;
560:   const rt = getRuntime();
561:   const backend = createIpcBackend(rt);
562: 
563:   if (host) {
564:     ipcRegistered = true;
565:     ipcViaHost = true;
566:     try {
567:       attachRegistryPush(rt, electronMod);
568:       host.setBackend(backend);
569:     } catch (err) {
570:       rollbackIpc();
571:       throw err;
572:     }
573:     return;
574:   }
```

`src/main/capabilities/subagent/index.ts:582-591`（**原样引用**，路径 B）：

```ts
582:     ipcMain.handle("subagent:transcript", (_ev: unknown, subagentId: string) => backend.transcript(subagentId));
583:     ipcChannels.push("subagent:transcript");
584:     ipcMain.handle("subagent:steer", (_ev: unknown, subagentId: string, instruction: string) =>
585:       backend.steer(subagentId, instruction),
586:     );
587:     ipcChannels.push("subagent:steer");
588:     ipcMain.handle("subagent:cancel", (_ev: unknown, subagentId: string) => backend.cancel(subagentId));
589:     ipcChannels.push("subagent:cancel");
590:     ipcMain.handle("subagent:active", (_ev: unknown) => backend.active());
591:     ipcChannels.push("subagent:active");
```

**结论：存在其它注册路径（B），且它在 Electron 主进程生产启动中不会走到**（宿主槽在 `index.ts:673` 已挂 → `getIpcHost()` 非空 → 走 A 分支直接 `return`）。规划若声称「只有一处注册」，需按上表修正为「一处生产注册 + 一处降级注册 + 一处吸收」。

---

## 4. Q3 — `adopted` map 被谁消费（调用链行号）+ 一处方向性纠正

### 4.1 写入端

`subagent-ipc-host.ts:121` → `adopted.set(channel, listener);`（唯一写入点；`resetSubagentIpcHostForTests` 的 `:151 adopted.clear()` 是清空）。

### 4.2 读取端（唯一读者 = `invokeAdopted`）

`subagent-ipc-host.ts:51-55` 是**全仓库唯一读 `adopted` 的地方**，其 4 个调用者：

| 宿主 stub | 读取行 | 导出函数 | 缺省兜底值 |
| --- | --- | --- | --- |
| `SubagentIpc.active` | `:60` | `handleSubagentActive` (`:57-65`) | `[]` |
| `SubagentIpc.transcript` | `:71` | `handleSubagentTranscript` (`:67-76`) | `EMPTY_TRANSCRIPT` (`:28`) |
| `SubagentIpc.steer` | `:83` | `handleSubagentSteer` (`:78-92`) | `NOT_READY` (`:29`) |
| `SubagentIpc.cancel` | `:98` | `handleSubagentCancel` (`:94-103`) | `{ ok: false, message: NOT_READY.message }` |

`src/main/agent/subagent-ipc-host.ts:57-65`（**原样引用**，展示「backend 优先、adopted 兜底」）：

```ts
57: export function handleSubagentActive(): unknown {
58:   try {
59:     if (backend) return backend.active();
60:     const adoptedResult = invokeAdopted(SubagentIpc.active);
61:     return adoptedResult === undefined ? [] : adoptedResult;
62:   } catch {
63:     return [];
64:   }
65: }
```

这 4 个函数被宿主在 `:134-143` 注册成**真实** Electron handler，所以 adopted 的消费入口是「宿主已注册的稳定 handler」。

### 4.3 backend 注入链（与 adopted 无关的另一条链）

| 步骤 | 位置 | 代码 |
| --- | --- | --- |
| 1 | `src/main/index.ts:673` | `registerSubagentIpcHost(ipcMain);` |
| 2 | `subagent-ipc-host.ts:133` | `exposeGlobalHost();` |
| 3 | `subagent-ipc-host.ts:105-111` | `(globalThis)[SUBAGENT_IPC_HOST_KEY] = slot;`，key = `"__mybuddySubagentIpcHost"`（`:14`） |
| 4 | `src/main/index.ts:3367` | `installBuiltinSubagentIpc();` |
| 5 | `src/main/capabilities/builtin-subagent.ts:15-17` | `installHostIpc();` |
| 6 | `capabilities/subagent/index.ts:600-602` | `installHostIpc()` → `registerIpc()` |
| 7 | `capabilities/subagent/index.ts:459-465` | `getIpcHost()` 读 `globalThis["__mybuddySubagentIpcHost"]`（key 硬编码于 `:440`） |
| 8 | `capabilities/subagent/index.ts:490-513` | `createIpcBackend(rt)` 产出 backend（**内建实现**，非 adopted） |
| 9 | `capabilities/subagent/index.ts:568` | `host.setBackend(backend);` |
| 10 | `subagent-ipc-host.ts:43-45` | `setSubagentIpcBackend` → `backend = next` |

### 4.4 ⚠️ 纠正：**不存在**「把采纳的 handler 交给 subagent runtime」的交接

实测数据流方向与「交给 runtime」相反：

- `adopted` 里存的是**旧扩展的 handler**；它**永远不会**被注入 `SubagentRuntime`。
- `backend` 是内建能力自己 `createIpcBackend(rt)`（`capabilities/subagent/index.ts:490-513`）的产物，经全局槽 `setBackend` 装进宿主（`:568`）。
- 宿主一旦有 `backend`，`adopted` 分支被**短路遮蔽**（`:59/:70/:82/:97` 的 `if (backend) return ...`）。生产启动中 `setBackend` 发生在 `index.ts:3367`，早于 `createWindow()` 的 `index.ts:3405`，因此**窗口存在期间 backend 恒非空 → `adopted` 在生产路径里实质是死代码**，其唯一现实作用是「让旧扩展的 `handle` 不抛 `second handler`」。
- 同时说明：如果规划的重构打算「把 adopted 当作 legacy 能力的正式接入方式」，那是在给一条**已遮蔽**的路径加语义，值得在 Phase 2.2 明确写清（或者干脆删掉 adopted 分支，只保留吸收行为）。

---

## 5. Q4 — L673 与 L3364 的先后关系 / 为什么必须「窗口创建前」

### 5.1 关系

`registerSubagentIpcHost(ipcMain)` 位于函数 `registerIpc()`（`src/main/index.ts:644`）体内 `:673`；`registerIpc()` 的唯一调用点是 `src/main/index.ts:3364`。二者**不是两个时刻**，而是同一同步展开：L3364 → L673。

在同一 `registerIpc()` 内，`:645-670` 已先注册 Notification / RemoteAccess 通道（在补丁安装**之前**，不受影响，因为补丁只拦 4 个 subagent 通道）。`:673` 之后还有 Gadget / Blueprint 等大量 handle。

### 5.2 真正必须成立的顺序：补丁在「自身 4 通道注册」之后

`src/main/agent/subagent-ipc-host.ts:128-146`（**原样引用**）：

```ts
128: export function registerSubagentIpcHost(ipcMain: {
129:   handle: (channel: string, listener: (...args: unknown[]) => unknown) => void;
130: }): void {
131:   if (registered) return;
132:   registered = true;
133:   exposeGlobalHost();
134:   ipcMain.handle(SubagentIpc.active, () => handleSubagentActive());
135:   ipcMain.handle(SubagentIpc.transcript, (_e: unknown, subagentId: unknown) =>
136:     handleSubagentTranscript(subagentId),
137:   );
138:   ipcMain.handle(SubagentIpc.steer, (_e: unknown, subagentId: unknown, instruction: unknown) =>
139:     handleSubagentSteer(subagentId, instruction),
140:   );
141:   ipcMain.handle(SubagentIpc.cancel, (_e: unknown, subagentId: unknown) =>
142:     handleSubagentCancel(subagentId),
143:   );
144:   // 旧扩展仍会 ipcMain.handle 同名通道；拦截下来当 backend，避免 “second handler”
145:   patchHandleToAdoptLegacy(ipcMain);
146: }
```

- `:145` 必须在 `:134-143` **之后**：`HOSTED_CHANNELS` 恰好就是这 4 个通道（§3.1），若先打补丁，宿主自己的 4 个 listener 会在 `:121` 被塞进 `adopted`，Electron 侧**一个 handler 都没有** → 渲染层 invoke 立刻出现 `No handler registered`；且 `adopted.set(active, () => handleSubagentActive())` 形成**自指递归**（`:60 → :54 → :134 的箭头函数 → :60`），虽被 `:62 catch` 吞成 `[]`，但语义已彻底破损。
- 实测证据：探针 P1 断言注册后真实登记恰为 4 个通道（若顺序颠倒则为 0），PASS（§6.3）。

### 5.3 为什么必须「窗口创建前」注册

- `createWindow()` 定义在 `src/main/index.ts:472`，`new BrowserWindow` 在 `:476`，页面装载在 `:628`（`win.loadURL`）/ `:630`（`win.loadFile`）；实际调用点在 `:3405`（`activate` 重建在 `:3409`）。
- 渲染层「概览」挂载即 invoke：`src/renderer/src/components/artifact/overview/RuntimeObservatory.tsx:51`（`useEffect`）→ `:59` `const list = await window.api?.subagent?.active?.();`；preload 侧 `src/preload/index.ts:651-652` `active: (): Promise<SubagentSummaryDto[]> => ipcRenderer.invoke(SubagentIpc.active),`。
- 时序上 `:3364`（L673 宿主 4 通道 + 补丁）与 `:3367`（backend 注入）都早于 `:3405`（窗口创建），中间无 `await`，因此**不存在**「窗口已创建、handler 未注册」的窗口期；`index.ts:672` 的注释「窗口创建前先挂上 subagent 通道，避免概览一启动 invoke 打出 No handler registered」与实测一致。
- 强度评估（推断）：该保证目前依赖「`registerIpc()` 恰好在 `createWindow()` 之前 41 行、且同一 async 体内无 `await` 插入」这一**隐式**约束；`:3330-3362` 里有 `await`（`memoryGatewayController.start()` `:3347`、`remoteAccessController.start()` `:3357`），一旦将来有人在 `:3364` 之前插入 `createWindow()`（例如「先出窗口再初始化」的启动优化），`No handler registered` 会立刻回归。这正是规划要加注释与清单测试的真实价值点。

---

## 6. Q5 — 「采纳集不变」能否写成测试（关键判断）

### 6.1 结论：**可以**，且无需启动 Electron

根本原因（实测）：`src/main/agent/subagent-ipc-host.ts` **不 import electron**，`ipcMain` 完全由参数注入（`:113-115` 与 `:128-130` 的结构化参数类型），模块级状态只有 4 个变量（`:38-41`）。因此一个纯对象 mock（`{ handle(channel, fn) {...} }`）即可复现补丁与采纳集：

- `adopted` 是模块私有 `Map`（`:39`），**无导出访问器**（实测导出集合：`SUBAGENT_IPC_HOST_KEY`、`setSubagentIpcBackend`、`getSubagentIpcBackend`、`handleSubagentActive/Transcript/Steer/Cancel`、`registerSubagentIpcHost`、`resetSubagentIpcHostForTests`）；
- 但它**可观测**：`resetSubagentIpcHostForTests()`（`:149-158`）清空 `adopted` + 复位 `registered/handlePatched`，之后「真实 mock 收到几个 `handle` 调用」= 采纳集是否吞掉宿主自身注册的**行为级探针**；「`handleSubagentActive()` 的返回值」= 采纳集内容的探针。

### 6.2 `scripts/subagent-ipc-transaction-test.ts` 存在吗？它测什么？

**存在**（`scripts/subagent-ipc-transaction-test.ts`，181 行；脚本 `package.json:262` `test:subagent-ipc-transaction`）。它测**注册事务性**，不是采纳集：

| 场景 | 行号 | 断言 |
| --- | --- | --- |
| A 工具注册中途抛错 | `:104-116` | factory 抛错 + `channels.length === 0` + `handleCalls === 0`（IPC 零注册） |
| B `registerIpc` 中途抛错 | `:118-130` | `rollbackIpc` 后无残留（`channels.length === 0`） |
| C 回滚后可重注册 | `:132-150` | 4 个 channel 全部注册成功 |
| D **宿主已注册 stub → 扩展只 install backend，不 handle** | `:152-174` | `handleCalls === 0`、`channels.length === 0`、backend 已安装 |

它用 `jiti` + `virtualModules: { electron: mock }`（`:75-81`）动态加载真实 `src/main/capabilities/subagent/index.ts`，`PI_CODING_AGENT_DIR` 重定向到 tmp（`:22-23`）——**即已证明「不启 Electron 也能测这条链」**。场景 D 使用的 global 宿主槽（`:155-159`）正是 `__mybuddySubagentIpcHost`。

**且**：`scripts/subagent-ipc-host-test.ts`（99 行；`package.json:263` `test:subagent-ipc-host`）**已经在断言采纳行为**：

`scripts/subagent-ipc-host-test.ts:83-92`（**原样引用**）：

```ts
83:   console.log("== 旧扩展二次 handle 被吸收 ==");
84:   let secondHandleThrew = false;
85:   try {
86:     ipcMain.handle("subagent:active", () => [{ subagentId: "legacy-1" }]);
87:   } catch {
88:     secondHandleThrew = true;
89:   }
90:   assert(!secondHandleThrew, "旧扩展 handle 不抛 second handler");
91:   const adopted = handleSubagentActive() as Array<{ subagentId: string }>;
92:   assert(adopted[0]?.subagentId === "legacy-1", "吸收的旧 handler 生效");
```

同文件 `:48-50` 已断言「宿主自身 4 通道真实登记」——这正是「采纳集未被自身注册污染」的等价断言：

```ts
48:   registerSubagentIpcHost(ipcMain);
49:   registerSubagentIpcHost(ipcMain);
50:   assert(handles.length === 4, `handle 恰好 4 次（${handles.join(",")}）`);
```

### 6.3 实测（本次复核运行）

| 运行 | 命令形态 | 结果 |
| --- | --- | --- |
| 现有宿主测试 | 内存打包 `scripts/subagent-ipc-host-test.ts` → `node` | **passed=14 failed=0**，含「旧扩展二次 handle 被吸收」2 条 PASS |
| 现有事务测试 | 内存打包 `scripts/subagent-ipc-transaction-test.ts`（`--external:jiti`） | **passed=13 failed=0**，含场景 D 5 条 PASS |
| 自写「采纳集不变」探针 P1-P5 | 见 §6.4 | **PASS**：P1 宿主自身 4 通道真实登记；P2 旧扩展 handle 未进真实注册表；P3 采纳 handler 被 stub 消费；P4 backend 存在时采纳集被遮蔽；P5 `Map` 后者覆盖前者 |
| 探针 P6/P7（reset 后复用同一 mock 再注册） | 同上 | **FAIL ×2** → 发现真实基建缺陷，见 §7 |

### 6.4 探针源码（可直接落成正式测试；本次以内存打包执行，未写仓库）

```ts
import {
  registerSubagentIpcHost, resetSubagentIpcHostForTests,
  setSubagentIpcBackend, handleSubagentActive,
} from "./src/main/agent/subagent-ipc-host";

const calls: string[] = [];
const ipcMain = { handle(channel: string, _fn: unknown): void { calls.push(channel); } };
const ok = (c: boolean, l: string): void => { if (!c) throw new Error(l); };

resetSubagentIpcHostForTests();
registerSubagentIpcHost(ipcMain);
ok(calls.length === 4, "P1 宿主自身 4 通道真实登记");            // 采纳集未吞掉自身注册
const before = calls.length;
ipcMain.handle("subagent:active", () => [{ subagentId: "legacy-1" }]);
ok(calls.length === before, "P2 旧扩展 handle 未进真实注册表");   // 采纳集吸收
ok(JSON.stringify(handleSubagentActive()) === JSON.stringify([{ subagentId: "legacy-1" }]), "P3 采纳 handler 被消费");
setSubagentIpcBackend({ active: () => [{ subagentId: "backend-1" }], transcript: () => ({}), steer: () => ({}), cancel: () => ({}) });
ok((handleSubagentActive() as any)[0]?.subagentId === "backend-1", "P4 backend 存在时采纳集被遮蔽");
```

**判定：`refutes_parent` 不因此为 true** —— 「采纳集不变」可测（已实测通过），不满足「无法写成测试」这一推翻条件。规划真正需要修正的是 §7/§9。

---

## 7. 新发现（规划未覆盖）：`resetSubagentIpcHostForTests()` 不还原 `ipcMain.handle`

`src/main/agent/subagent-ipc-host.ts:148-158`（**原样引用**）：

```ts
148: /** 仅测试用：清掉注册标记与 backend，避免用例串扰。 */
149: export function resetSubagentIpcHostForTests(): void {
150:   backend = null;
151:   adopted.clear();
152:   registered = false;
153:   handlePatched = false;
154:   try {
155:     delete (globalThis as Record<string, unknown>)[SUBAGENT_IPC_HOST_KEY];
156:   } catch {
157:     (globalThis as Record<string, unknown>)[SUBAGENT_IPC_HOST_KEY] = undefined;
158:   }
159: }
```

它复位了 `registered` 与 `handlePatched`，但**没有**恢复被覆写的 `ipcMain.handle`（`:119`）。实测后果（探针 P6/P7 失败 + probe3 复现）：

```
first  register: calls=4 [subagent:active,subagent:transcript,subagent:steer,subagent:cancel]
second register (same object after reset): calls=4 (delta=0)
legacy handle after 2nd register: realRegistryDelta=0 stub=[{"subagentId":"legacy-3"}]
```

即：**同一进程内、对同一 `ipcMain` 对象 reset 后再 `registerSubagentIpcHost`，真实注册数为 0** —— 宿主自己的 4 个 listener 被（仍然生效的）补丁吞进 `adopted`，`handleSubagentActive()` 落入自指递归被 `catch` 成 `[]`。换用**全新 mock 对象**则正常（probe2：`case2 calls=4`）。

影响评估（推断 + 实测边界）：

- **生产无影响**：`registerSubagentIpcHost` 全仓库唯一调用点 `index.ts:673`，且 `registered` 守卫使其天然只执行一次；
- **新增清单测试有陷阱**：若 Phase 2.2 的清单测试在同文件内多次 `reset + register`，或复用同一 mock，会得到**假绿**（`calls.length===4` 恰好因为前一次已跑过，或断言从「真实注册」退化为「什么都没发生」）。现有 `scripts/subagent-ipc-host-test.ts` 之所以没踩到，是因为它只 `register` 两次（`:48-49`，第二次被 `registered` 守卫短路）且**不再 reset 后复用**。

---

## 8. 【实测】与【推断】分栏

### 8.1 实测（本次直接读取 / 运行所得）

1. `subagent-ipc-host.ts:113-126` 猴补丁全文；`patchHandleToAdoptLegacy` 调用点 `:145`；`HOSTED_CHANNELS` 4 成员 `:31-36`；`adopted` 写入点 `:121`、唯一读取点 `:51-55`、4 个消费点 `:60/:71/:83/:98`。
2. 全仓库唯一 `ipcMain.handle =` 赋值在 `subagent-ipc-host.ts:119`；无 `ipcMain` 提前解构。
3. `registerSubagentIpcHost` 唯一生产调用点 `src/main/index.ts:673`；`registerIpc()` 定义 `:644`、唯一调用 `:3364`；`createWindow()` 调用 `:3405`（定义 `:472`，`new BrowserWindow` `:476`，装载 `:628/:630`）；`whenReady` 起点 `:2635`；`HtmlEditIpc` 注册 `:3048-3049`。
4. 注册路径共 3 条：宿主 `subagent-ipc-host.ts:134-143`、降级自注册 `capabilities/subagent/index.ts:582-591`、补丁吸收 `:120-123`（不注册）。
5. backend 注入链行号（§4.3）全部核对无误；`setBackend` 在 `capabilities/subagent/index.ts:568`，早于窗口创建。
6. 现有测试实跑：`subagent-ipc-host-test.ts` **14/14 通过**、`subagent-ipc-transaction-test.ts` **13/13 通过**（内存打包方式，未写仓库）。
7. 探针 P1-P5 通过、P6/P7 失败 → `resetSubagentIpcHostForTests` 不复位 `ipcMain.handle`，同对象二次注册真实登记数 = 0。
8. 两个测试脚本均由 `package.json:262-263` 注册且**不在** `scripts/test-baseline.json`（`subagent-ipc` 无基线条目，即非容忍失败）。
9. `out/plan-review/` 目录此前为空或不存在（本次为唯一新增写入）。

### 8.2 推断（基于实测的合理外推，未经运行时验证）

1. 「补丁若先于 `:134-143` 安装会导致 `No handler registered` + 自指递归」——机制由 `:120-123/:60/:134` 代码结构与 `HOSTED_CHANNELS` 成员完全决定，但本次未构造「顺序颠倒」的可运行变体（`patchHandleToAdoptLegacy` 未导出，无法从外部逆序复现），故列为推断。
2. 「生产启动期间 `adopted` 是死代码」——依据是 `setBackend`（`index.ts:3367`）早于 `createWindow()`（`:3405`）且中间无 `await`；未在真实 Electron 会话中断点确认「窗口存在期间 backend 恒非空」（未启动 GUI，符合只读约束）。
3. 「`:3330-3362` 的 `await` 是可被未来插入 `createWindow()` 的位置」——静态阅读结论。
4. 「旧扩展」实体未定位：本次全仓库检索未发现任何**仓库内**扩展对 4 个通道调用 `ipcMain.handle`，故 `adopted` 服务的对象是仓库外/历史版本扩展（与 `:4-6` 注释「旧扩展仍会 handle 同名通道」一致），无法给出具体扩展路径。

---

## 9. 规划修订建议（Phase 2.2）

1. **行号改为函数区间**：把「`subagent-ipc-host.ts` L118-119 打猴补丁」改写为 `patchHandleToAdoptLegacy()`（`subagent-ipc-host.ts:113-126`），并显式把 `handlePatched` 守卫（`:116-117`）与 `HOSTED_CHANNELS` 分支（`:120-123`）纳入注释范围。
2. **纠正「时序三处」的计数**：`index.ts:673` 与 `index.ts:3364` 是**同一同步时刻**（L3364 展开到 L673）；真正需要注释的三个独立语义是 ——（a）`subagent-ipc-host.ts:145` 补丁必须在 `:134-143` 之后；（b）`index.ts:673` 必须早于 `index.ts:3405` 的 `createWindow()`；（c）`index.ts:3048-3049`（`HtmlEditIpc`）早于 `index.ts:3364`、与 subagent 宿主无依赖关系，注释应写明「无依赖、仅顺序记录」而不是暗示因果。
3. **测试策略改为「补一条 + 修一处」**，不要新造冗余清单测试：在既有 `scripts/subagent-ipc-host-test.ts`（`package.json:263`）中新增「宿主自身 4 通道真实登记（`:48-50` 已具备）→ 旧扩展吸收（`:83-92` 已具备）→ 采纳集不被自身注册污染」的顺序断言；同时把「采纳集不变」定义成**行为断言**（真实 `handle` 调用次数 = 4 且 `adopted` 不被宿主 listener 占用），因为 `adopted` 无导出访问器。
4. **修 `resetSubagentIpcHostForTests()`**：记录并恢复被覆写的 `handle`（例如模块级保存 `patchedTarget`/`originalHandle`，reset 时若 `handlePatched` 则写回），或明确「每个用例必须新建 `ipcMain` mock」并加注释；否则新增的顺序断言在 reset 复用场景下会静默失效（实测 delta=0）。
5. **（可选）收紧 `adopted` 的语义**：既然生产路径中 backend 恒早于窗口存在、`adopted` 只会被短路遮蔽，可在注释中写明「adopted 仅为吸收旧扩展，不参与 runtime 交接」；若确认无旧扩展依赖，可在后续阶段删除 `invokeAdopted` 兜底（保留吸收行为），使模块状态从 4 个减到 3 个。

---

## 10. 复核方法与边界

- 只读手段：`read` / `grep` / `glob` 定点读取 + `git status` 确认工作区（复核前已存在他人未提交改动：`src/renderer/...` 与 `artifacts/*.json`，本复核未触碰）。
- 运行测试**不落产物**：`esbuild.buildSync({ write: false })` 内存打包 → `new Module(...)._compile(text)` 执行；外层套 `scripts/test-guard.mjs` 护栏。仓库内未新增/修改任何文件，`out/tests/` 未被写入。
- 未启动 Electron、未运行 `pnpm -s test:all`、未修改任何源码或测试。写入 `%TEMP%` 亦被环境拒绝（`Access is denied`），故所有验证均在内存完成。
- 边界：`patchHandleToAdoptLegacy` 未导出，无法从外部构造「补丁先装」的逆序实验；`adopted` 无访问器，断言只能行为化；真实 Electron GUI 会话未验证。

---

## 11. 时序图（自包含内联 SVG）

<svg xmlns="http://www.w3.org/2000/svg" width="1160" height="700" viewBox="0 0 1160 700" role="img" aria-label="subagent IPC 宿主注册与窗口创建时序">
  <rect x="0" y="0" width="1160" height="700" fill="#ffffff"/>
  <text x="24" y="34" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="20" font-weight="700" fill="#111827">subagent IPC 宿主：注册时序（实测行号）与猴补丁位置</text>
  <text x="24" y="58" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#374151">实线框 = 实测代码位置；虚线框 = 推断的必需顺序约束；红色 = 本次发现的缺陷点</text>

  <!-- timeline -->
  <line x1="120" y1="86" x2="120" y2="620" stroke="#9ca3af" stroke-width="2"/>
  <circle cx="120" cy="100" r="6" fill="#1d4ed8"/>
  <circle cx="120" cy="200" r="6" fill="#1d4ed8"/>
  <circle cx="120" cy="300" r="6" fill="#1d4ed8"/>
  <circle cx="120" cy="400" r="6" fill="#16a34a"/>
  <circle cx="120" cy="480" r="6" fill="#b91c1c"/>
  <circle cx="120" cy="570" r="6" fill="#1d4ed8"/>

  <!-- step 1 -->
  <rect x="150" y="78" width="470" height="46" rx="8" fill="#eff6ff" stroke="#1d4ed8"/>
  <text x="164" y="100" font-family="Consolas, monospace" font-size="13" fill="#111827">app.whenReady().then(async () =&gt; {</text>
  <text x="164" y="118" font-family="Consolas, monospace" font-size="12" fill="#4b5563">src/main/index.ts:2635  ← 所有注册都在此异步体内</text>

  <!-- step 2 -->
  <rect x="150" y="178" width="470" height="46" rx="8" fill="#eff6ff" stroke="#1d4ed8"/>
  <text x="164" y="200" font-family="Consolas, monospace" font-size="13" fill="#111827">ipcMain.handle(HtmlEditIpc.start / .stop, ...)</text>
  <text x="164" y="218" font-family="Consolas, monospace" font-size="12" fill="#4b5563">src/main/index.ts:3048-3049  ← 与 subagent 宿主无依赖</text>

  <!-- step 3 group -->
  <rect x="150" y="262" width="470" height="112" rx="8" fill="#eff6ff" stroke="#1d4ed8"/>
  <text x="164" y="284" font-family="Consolas, monospace" font-size="13" fill="#111827">registerIpc();   src/main/index.ts:3364</text>
  <text x="182" y="304" font-family="Consolas, monospace" font-size="13" fill="#111827">└ registerSubagentIpcHost(ipcMain);  index.ts:673</text>
  <text x="182" y="322" font-family="Consolas, monospace" font-size="12" fill="#111827">└ handle × 4（active/transcript/steer/cancel）:134-143</text>
  <text x="182" y="340" font-family="Consolas, monospace" font-size="12" fill="#b91c1c">└ patchHandleToAdoptLegacy(ipcMain);  subagent-ipc-host.ts:145</text>
  <text x="182" y="358" font-family="Consolas, monospace" font-size="12" fill="#7c2d12">（补丁覆写 ipcMain.handle = L119；原实现绑定 = L118）</text>

  <!-- constraint arrow -->
  <rect x="648" y="278" width="486" height="82" rx="8" fill="#fffbeb" stroke="#d97706" stroke-dasharray="6 4"/>
  <text x="662" y="300" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" font-weight="700" fill="#92400e">必需顺序（推断）</text>
  <text x="662" y="322" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="12" fill="#78350f">补丁必须在自身 4 通道注册之后：否则 HOSTED_CHANNELS 会把宿主</text>
  <text x="662" y="340" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="12" fill="#78350f">自己的 listener 吞进 adopted → Electron 零 handler + 自指递归。</text>

  <!-- step 4 -->
  <rect x="150" y="378" width="470" height="46" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="164" y="400" font-family="Consolas, monospace" font-size="13" fill="#111827">installBuiltinSubagentIpc();  index.ts:3367</text>
  <text x="164" y="418" font-family="Consolas, monospace" font-size="12" fill="#166534">→ subagent/index.ts:568 host.setBackend(backend)  ← adopted 被遮蔽</text>

  <!-- step 5 -->
  <rect x="150" y="458" width="470" height="46" rx="8" fill="#fef2f2" stroke="#b91c1c"/>
  <text x="164" y="480" font-family="Consolas, monospace" font-size="13" fill="#111827">resetSubagentIpcHostForTests() 不清 ipcMain.handle</text>
  <text x="164" y="498" font-family="Consolas, monospace" font-size="12" fill="#b91c1c">实测：同对象二次 register → 真实注册 delta=0（假绿风险）</text>

  <!-- step 6 -->
  <rect x="150" y="548" width="470" height="46" rx="8" fill="#eff6ff" stroke="#1d4ed8"/>
  <text x="164" y="570" font-family="Consolas, monospace" font-size="13" fill="#111827">createWindow();  index.ts:3405（new BrowserWindow :476）</text>
  <text x="164" y="588" font-family="Consolas, monospace" font-size="12" fill="#4b5563">→ 渲染层 RuntimeObservatory.tsx:59 invokes subagent:active</text>

  <!-- right side note -->
  <rect x="648" y="440" width="486" height="154" rx="8" fill="#f9fafb" stroke="#6b7280"/>
  <text x="662" y="464" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" font-weight="700" fill="#111827">adopted 的真实消费链（实测）</text>
  <text x="662" y="486" font-family="Consolas, monospace" font-size="12" fill="#111827">写入：subagent-ipc-host.ts:121（补丁内 adopted.set）</text>
  <text x="662" y="506" font-family="Consolas, monospace" font-size="12" fill="#111827">读取：:52 invokeAdopted ← :60 / :71 / :83 / :98</text>
  <text x="662" y="526" font-family="Consolas, monospace" font-size="12" fill="#111827">触发：宿主已注册的真实 handler（:134-143）</text>
  <text x="662" y="546" font-family="Consolas, monospace" font-size="12" fill="#b91c1c">注意：仅当 backend === null 才走 adopted（:59/:70/:82/:97）</text>
  <text x="662" y="566" font-family="Consolas, monospace" font-size="12" fill="#b91c1c">不存在「把 adopted handler 交给 subagent runtime」的交接</text>
  <text x="662" y="586" font-family="Consolas, monospace" font-size="12" fill="#4b5563">backend 由 capabilities/subagent/index.ts:490-513 自建</text>
</svg>

---

## 12. 附：声明判定表（供规划直接引用）

| 项 | 声明 | 实测 | 判定 |
| --- | --- | --- | --- |
| 行号 1 | `subagent-ipc-host.ts:118-119` 猴补丁 | L119 覆写本体、L118 绑定原实现；函数体 L113-126 | ✅（建议改函数区间） |
| 行号 2 | `index.ts:673` 调用位置 | 唯一调用点，位于 `registerIpc()` 内 | ✅ |
| 行号 3 | `whenReady` 内 `index.ts:3048-3049` HtmlEditIpc | L3048-3049 在 `whenReady`(L2635) 体内 | ✅ |
| 时序 | 「三处时序语义」 | L673 ≡ L3364（同一时刻）；三处真实约束见 §9-2 | ⚠️ 计数需修正 |
| 注释 | 三处需加注释 | 三处均已有注释（`subagent-ipc-host.ts:144`、`index.ts:672`、`index.ts:3365` 等） | ⚠️ 补充即可，非从零 |
| 测试 | 一条清单测试断言采纳集不变 | 可行（无 Electron 依赖）；等价断言已存在于 `subagent-ipc-host-test.ts:48-50/:83-92` | ✅ 可行 / 冗余 |
| 前提 | 采纳集运行时动态填充 | `const adopted = new Map(...)`（`:39`）由 `:121` 填充 | ✅ |
| 隐含 | 采纳 handler → runtime | 无此交接；方向相反（§4.4） | ❌ 需纠正 |
| 测试基线 | — | 两测试均不在 `scripts/test-baseline.json` | ✅ 非容忍失败 |
| 风险 | — | `reset` 不还原 `ipcMain.handle` → 新测试假绿 | ⚠️ 新增发现 |

**refutes_parent = false**：不满足「采纳集不变无法写成测试」（实测可写且已有覆盖）与「规划时序位置描述有误」（三个行号全部核对为真）两条推翻条件中任意一条。上表 ⚠️/❌ 项属于措辞与基建修订，不构成对声明的事实推翻。
