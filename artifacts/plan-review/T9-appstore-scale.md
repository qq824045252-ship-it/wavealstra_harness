# T9 执行前复核：appStore「553 键 / 233 处 get()」规模声明核实

- 仓库：`C:\Users\servi\Documents\GitHub\wavealstra_harness`
- 被核对象：`src/renderer/src/store/appStore.ts`
- 复核时间：2026-10-12
- 代码版本：工作树中的 `src/renderer/src/store/appStore.ts` 内容 = `HEAD` (`9f90f4e`)，`git diff HEAD -- src/renderer/src/store/appStore.ts` 输出为空 → 实测数字对当前提交有效（工作树另有他人/前置的未提交改动，均不在本次核查范围内，本报告未触碰任何源文件）
- 模式：只读核查（唯一写操作 = 本报告）
- 被验证声明（规划 Phase 1 原则）：「553 键、233 处 get()、单 store，一概不动。只做一件事：把 db 直写收进网关。」

---

## 0. 结论速览

| 规划声明 | 实测 | 偏差 | 判定 |
| --- | --- | --- | --- |
| 553 个顶层键 | **261** | **−52.8%** | ❌ **推翻**（远超 20% 阈值） |
| 233 处 `get()` | **270 次调用**（分布在 264 行） | +15.9% | ⚠️ 未超 20%，但口径错误（233 是「含 `get().` 的行数」，不是调用次数） |
| 单 store | 主 store 唯一，但 renderer 共存 **4 个** zustand store | — | ⚠️ 对主 store 成立，对 renderer 不成立 |
| （附）文件总行数 | **6377 行** | — | ✅ |

**refutes_parent = true**（由「553 键」触发）。关键发现：**553 与 233 都是「按行 grep」的产物，不是键数/调用次数**，两者都能在本机 100% 复现（见 §3）。

---

## 1. 方法与工具

| 项 | 值 |
| --- | --- |
| 解析器 | `node_modules/@babel/parser`（AST，非文本 grep） |
| Node | v24.19.0 |
| 为什么不用 TypeScript API | 仓库内 `node_modules/typescript` 是 7.0.2（native 版），`require("typescript")` 只导出 2 个键、`createSourceFile === undefined`，无 JS API 可用 |
| 行数口径 | `[System.IO.File]::ReadAllLines()` 返回 6377 个元素；LF 计数 6377（文件以换行结尾）。`-split "\n"` 得 6378 是「含结尾空串」，不是 6378 行 |
| 文件体量 | 259,363 字节 / 238,251 字符（UTF-8，含中文） |

```powershell
# 行数
(Get-Content -LiteralPath src/renderer/src/store/appStore.ts | Measure-Object -Line).Lines   # 6102  ← 注意：会漏掉 275 个空行，不要用
[System.IO.File]::ReadAllLines('src/renderer/src/store/appStore.ts').Count                   # 6377  ← 采用
```

> `Measure-Object -Line` 输出 6102（它不计空行），与真实 6377 行差 275 行——这本身就是「为什么必须用 AST/ReadAllLines」的例证。

---

## 2. 逐项实测

### 2.1 总行数 = 6377

原样引用（首、尾、关键锚点）：

```
    1: import { DEFAULT_WELCOME_MODE } from "@shared/mode-profile";
    2: import { isGatewayBotTaskId } from "@shared/gateway-task";
    3: import { create } from "zustand";
    4: import { useEffect } from "react";
```

```
 1239: 
 1240: export const useAppStore = create<AppState>((set, get) => ({
 1241:   page: "chat",
```

```
 6108:   },
 6109: }));
 6110: 
```

```
 6377: }
```

- `src/renderer/src/store/appStore.ts:1-4`（imports）
- `src/renderer/src/store/appStore.ts:1240`（store 工厂起点）
- `src/renderer/src/store/appStore.ts:6109`（工厂结束 `}));`）
- `src/renderer/src/store/appStore.ts:6377`（文件最后一行）

工厂体跨度 **1240–6109 = 4870 行**，占全文 76.4%；`6110-6377` 是导出 selector/helper。

### 2.2 顶层键 = **261**（规划说 553）

**方法 A（AST，主口径）**：取 `VariableDeclarator(name=useAppStore)` → `init` 为 `CallExpression(callee=create)` → `arguments[0]` 为 `ArrowFunctionExpression(params=[set,get])` → `body` 为 `ObjectExpression` → `properties.length`。

结果：

```
useAppStore declarator line: 1240
init type: CallExpression callee: create line: 1240
factory type: ArrowFunctionExpression params: set,get line: 1240
state object lines: 1240 - 6109
TOTAL top-level properties: 261
by node type: {"ObjectProperty":261}
ObjectProperty: 261 ObjectMethod: 0 getters: 0 setters: 0 other: 0 []
identifier key count: 261 duplicates: []
non-identifier keys: []
```

→ **261 个顶层键，全部是 `ObjectProperty`；无计算键（`[x]:`）、无 getter/setter、无重复键**。
结构拆分：**91 个非函数值（state 字段）+ 170 个箭头函数（action）**：

```
top-level properties whose value is NOT a function: 91 | function-valued: 170
value node types: {"StringLiteral":13,"CallExpression":4,"BooleanLiteral":18,"ArrayExpression":16,
                   "NullLiteral":23,"ObjectExpression":10,"NumericLiteral":3,"Identifier":3,
                   "ArrowFunctionExpression":170,"TSAsExpression":1}
```

**方法 B（独立交叉验证）**：同文件 `interface AppState`（`src/renderer/src/store/appStore.ts:276` – `:753`）的成员数：

```
interface AppState line 276 - 753 extends: (none) members: 261
   member kinds: {"TSPropertySignature":261}
```

原样引用两端：

```
  276: interface AppState {
```

```
  752:   }) => Promise<string | null>;
  753: }
```

→ **类型声明 261 个成员 == 实现对象 261 个键，一一对应**。这是两条互相独立的证据（AST 对象字面量 / AST 接口体）给出同一数字。

**方法 C（文本对照）**：create 体内 `^  [A-Za-z_$][\w$]*:` 行数 = **260**，与 261 的 1 行差值已定位：

```
 5579:   },  relocateSpace: async (id) => {
```

`src/renderer/src/store/appStore.ts:5579` 一行同时结束上一属性并开始 `relocateSpace`，正则按行匹配漏掉它。**260 + 1 = 261，完全闭合。**

> 结论：**顶层键 = 261。规划的 553 无任何口径支持**（全文件所有层级对象键总数为 2058，历史版本为 255→261，均不等于 553，见 §3.3）。

### 2.3 `get()` = **270 次**；`useAppStore.getState()` = **19 次**（分开统计）

**方法**：AST 中 `CallExpression` / `OptionalCallExpression` 且 `callee.type === "Identifier" && callee.name === "get"`。

结果：

```
AST CallExpression callee==Identifier 'get': 270
arg-count histogram (get/set): {"set/1":196,"get/0":270}   ← 270 个 get 全部 0 参
get() lines: [1368, 1401, 1474, 1475, ... 5907, 5908]      ← 行号范围 1368–5908
```

- **270 次全部落在 create 工厂体内**（最小行 1368 > 1240），即全部是 zustand 的 `get()`。
- 分布在 **264 个不同行**（6 行出现 2 次）。
- 原样引用样例：
  - `src/renderer/src/store/appStore.ts:1368`：`    const current = get().activeProjectId;`
  - `src/renderer/src/store/appStore.ts:1474`：`    const taskId = get().activeTaskId;`
  - `src/renderer/src/store/appStore.ts:1475`（同行两次的样例之一）

**必须排除的假阳性（这是文本统计最大的坑）**：

```
 2320:       ?.get()
```

原样引用 `src/renderer/src/store/appStore.ts:2318-2324`：

```
 2318:     // Wave 4D：Selection 投影订阅（唯一 truth 在 main SelectionStore；只读 mirror）
 2319:     void api.selection
 2320:       ?.get()
 2321:       ?.then((state) => {
```

`api.selection?.get()` 是 **selection API 的 `get()`**，不是 zustand `get()`。天真正则 `get\(\)` 会把它算进去：

| 统计口径 | 数字 | 说明 |
| --- | --- | --- |
| 原始子串 `get(` | 303 | = 270（zustand）+ 33（成员 `.get(`） |
| 原始子串 `get()` | 271 | = 270 + `L2320 ?.get()` |
| **AST：Identifier `get` 调用** | **270** | ✅ 采用（zustand `get()`） |
| AST：`.get(` / `?.get(` 成员调用 | 33 | `Map.get`（L804/2986/2993/2998/3006/3109/3118/5537/5655/5700/5721/5724/5728/5738/5780/5797/5812/5829/5833/5859/5863/5910/5922/5987/6005/6019/6032/6050/6054/6081/6085/6153 等）、`api.selection?.get()`（L2320） |
| 含 `get().` 的**行数** | **233** | 见 §3.2，= 规划里的 233 |

**`useAppStore.getState()` 单独统计 = 19 次**，且 19 次的接收者全部是 `useAppStore.getState`（无别名、无其他 store 混入）：

```
AST *.getState() calls: 19
getState receivers: { "useAppStore.getState": 19 }
```

原样引用（节选，含工厂体外 4 处）：

```
 1154:     const current = useAppStore.getState().chatSelections;
 2082:     useAppStore.getState().applyAgentDeltaBatch(patches);
 2312:         dom.onCreated((ev) => useAppStore.getState().applyArtifactCreated(ev)),
 6126:   const s = useAppStore.getState();
 6130:   return useAppStore.getState().draft?.spaceId ?? null;
```

- `src/renderer/src/store/appStore.ts:1154`
- `src/renderer/src/store/appStore.ts:2082`
- `src/renderer/src/store/appStore.ts:2312`
- `src/renderer/src/store/appStore.ts:6126`、`:6130`

→ **270（工厂内 `get()`）+ 19（`useAppStore.getState()`，其中 13 处在工厂体内 1240–6109、6 处在 6110 之后的导出 helper/selector 中：L6126/6130/6133/6193/6194/6195）= 289 个取值入口**。规划若把两者混计会得到不同数字；本次按要求分开给出。

### 2.4 `set(` = **196 次**

**方法**：AST `CallExpression` 且 `callee` 为 Identifier `set`。

结果：

```
AST CallExpression callee==Identifier 'set': 196
arg-count histogram: {"set/1":196}          ← 全部恰好 1 个实参（zustand set 签名）
set() lines: [1318, 1319, 1333, ... 6078]    ← 行号范围 1318–6078，全在工厂体内
```

首个实参形态（196 个）：

| 首实参形态 | 数量 |
| --- | --- |
| 对象字面量 `set({...})` | 85（其中 40 处只有 1 个键） |
| 箭头函数返回对象 `set((s) => ({...}))` | 88 |
| 箭头函数带 block body `set((s) => { ... return {...} })` | 23 |

原样引用：

```
 1318:   openWorkspaceDetail: (spaceId) => set({ activeWorkspaceId: spaceId, page: "workspace" }),
```

- `src/renderer/src/store/appStore.ts:1318`

**原始子串 `set(` = 203 的 7 处差额已全部定位**：

```
set: ident calls=196 member .set( calls=4
  raw substring total: 203 ; lines not explained by ident-calls ( 7 ):
    L1177: "* （方案 Problem One 3.3）。返回值是可并入 Zustand set() 的 Partial<AppState>。"
    L2988: "else patchesByTask.set(patch.taskId, [patch]);"
    L3000: "else patchesByMessage.set(patch.messageId, [patch]);"
    L3111: "interactionsByMessage.set(resolvedMessageId, list);"
    L4543: "? resolveModePreset(profile.policy, task?.modePresetId ?? modePresetId ?? null)"
    L4589: "? resolveModePreset(profile.policy, task?.modePresetId ?? modePresetId ?? null)"
    L5530: "existence.set(key, ok);"
```

即：196（zustand `set`）+ 4（`Map.set`，L2988/3000/3111/5530）+ 1（注释里的 "Zustand set()"，L1177）+ 2（`resolveModePreset(` 内含子串 `set(`，L4543/4589）= 203。✔ 闭合。

- `src/renderer/src/store/appStore.ts:1177`（注释）
- `src/renderer/src/store/appStore.ts:2988`、`:3000`、`:3111`、`:5530`（Map.set）
- `src/renderer/src/store/appStore.ts:4543`、`:4589`（`resolveModePreset(`）

### 2.5 关键判断：只把 db 直写收进网关，appStore.ts 净减还是净增？

**先量清「db 直写」的实际规模**（AST：callee 为 `…db?.<op>` 的成员调用，op 取自该文件实际出现的 db 操作名白名单）：

```
true db call sites: 44 | writes: 32 | reads: 12
by name: {"upsertTask":17,"upsertSpace":4,"listTasks":6,"listSpaces":2,"listProjects":2,
          "archiveTask":2,"archiveSpace":2,"deleteTask":1,"deleteSpace":1,"renameSpace":1,
          "updateSoul":1,"deleteTaskWriteGrant":1,"moveSpace":1,"moveTaskInWorkspaceTree":1,
          "getSoul":1,"listTaskWriteGrants":1}
write spans sum: 157 | single-line(span<=2): 12
```

- **写调用点 32 处**（`upsertTask` 17、`upsertSpace` 4、`archiveTask` 2、`archiveSpace` 2、`deleteTask`/`deleteSpace`/`renameSpace`/`updateSoul`/`deleteTaskWriteGrant`/`moveSpace`/`moveTaskInWorkspaceTree` 各 1）。
- **读调用点 12 处**（`listTasks` 6、`listSpaces` 2、`listProjects` 2、`getSoul` 1、`listTaskWriteGrants` 1）。
- **另有 3 处经 `const api = window.api?.db?.X` 间接调用**：写 2 处（`purgeArchivedContent` L3332、`restoreTrashedTask` L3388）、读 1 处（`listTrashedTasks` L3378）。→ **网关需要吸收的写入面 = 32 + 2 = 34 处**；读面 = 12 + 1 = 13 处。
- 32 处写点共占 **157 行**，但**只有 12 处是单行调用 `span<=2`；其余 20 处是多行对象字面量**，行数主体在参数上。
- 注意：`moveSpace`（`src/renderer/src/store/appStore.ts:5823`，`(window.api as any)?.db?.moveSpace`）与 `moveTaskInWorkspaceTree`（`:6045`，`(window.api as any)?.db?.moveTaskInWorkspaceTree`）是**用 `as any` 绕开类型**的 db 直写；若统计规则只按「已知操作名 + 类型化 `window.api?.db?.`」筛选，会漏掉这 2 处（本次第一轮筛选即漏掉，已修正）。

**行数账（逐项）**：

| 变更项 | 行数影响 | 依据 |
| --- | --- | --- |
| 32 个直写点的调用表达式替换（`window.api?.db?.upsertTask` → `dbGateway.upsertTask`） | **Δ0 行** | 调用表达式只占首行，同行内替换；对象字面量参数行约 125 行原样保留。例：`src/renderer/src/store/appStore.ts:1499` / `:1929-1940`(12 行) / `:3644-3659`(16 行) |
| 删除可用性守卫/间接层（写路径，含 2 处 `const api = ...` 间接写） | **−4 行** | `:3332-3333`、`:3388-3389`（各 2 行 `const api = window.api?.db?.X;` + `if (!api) throw ...`） |
| 保留（读路径的同型守卫） | 0 | `:3378-3379` 是 `listTrashedTasks`（读） |
| 新增网关 import | **+1 行** | 顶部 import 区（`:1-4` 同类） |
| **合计（网关放独立新模块）** | **≈ −3 行（区间 −10 ~ +5）** | 占 6377 行的 **0.05%** → **实质持平、微减，量级可忽略** |
| 反例：网关实现在 appStore.ts **内部** | **+60 ~ +150 行（净增）** | 34 个写入面各需 2–4 行包装 + 头部 |

字符层面（不进出行数账，仅供对照）：`window.api?.db?.`（17 字符）→ `dbGateway.`（10 字符），44 个直调点 × 7 字符 ≈ **−308 字符**，占 238,251 字符的 **0.13%**。

原样引用（写路径守卫，可删除候选）：

```
 3331:   purgeArchivedContent: async (request) => {
 3332:     const api = window.api?.db?.purgeArchivedContent;
 3333:     if (!api) throw new Error("永久删除接口不可用，请重启到最新版本");
```

```
 3387:   restoreTrashedTask: async (id) => {
 3388:     const api = window.api?.db?.restoreTrashedTask;
 3389:     if (!api) throw new Error("回收站接口不可用，请重启到最新版本");
```

原样引用（读路径守卫，按「只收写入」保留）：

```
 3377:   refreshTrashedTasks: async () => {
 3378:     const api = window.api?.db?.listTrashedTasks;
 3379:     if (!api) return;
```

原样引用（多行写入点，行数主体在参数上、不会因收网关而消失）：

```
 3644:       const persisted = window.api?.db?.upsertTask({
```

```
 4219:     const task = get().tasks.find(item => item.id === taskId);
 4220:     const persisted = await window.api?.db?.listTasks?.();
 4221:     if (task && !persisted?.some(item => item.id === taskId)) await window.api?.db?.upsertTask?.({ id: task.id, title: task.title, updatedAt: task.updatedAt,
 4222:       spaceId: task.spaceId, projectId: task.projectId, welcomeMode: task.welcomeMode, cwd: task.cwd, expertId: task.expertId });
```

```
 4675:     void window.api?.db?.updateSoul(next);
```

```
 5423:     const res: any = await window.api?.db?.deleteSpace?.(id);
```

```
 5823:       const res: any = await (window.api as any)?.db?.moveSpace?.({ spaceId, targetParentId, targetIndex });
```

```
 6045:       const res: any = await (window.api as any)?.db?.moveTaskInWorkspaceTree?.({ taskId, targetSpaceId, targetIndex });
```

**判定**：
1. 若网关落在**新模块**，`appStore.ts` **净减约 3 行（量级 −10~+5），等同持平**；把「收网关」当作减行/降规模手段是不成立的。
2. 若网关**写在本文件内**，则明确**净增 60~150 行**。
3. 附带的架构副作用：写入走网关、13 处读仍走 `window.api?.db?.`（`listTasks`/`listSpaces`/`listProjects`/`getSoul`/`listTaskWriteGrants`/`listTrashedTasks`），同一文件长期并存**两套持久化入口**；`:3332/:3388` 式守卫若只改一半，一致性反而下降。
4. 全文件 `const api = window.api...` 间接层共 15 处（其中 db 3 处：`:3332`、`:3378`、`:3388`），写明「只收 db 写入、其余不动」意味着这类守卫仍以混杂形态存在。

---

## 3. 规划数字 553 / 233 的来源还原（高置信推断，均可 100% 复现）

### 3.1 553 = 全文件「2 空格缩进的 `key:` 行」计数

```powershell
$l=[System.IO.File]::ReadAllLines('src/renderer/src/store/appStore.ts')
($l | Where-Object { $_ -match '^  [A-Za-z_$][\w$]*:' } | Measure-Object).Count   # → 553
```

输出：**553**（与规划数字完全一致）。该模式统计的是**全文件任意层级**中缩进恰好 2 空格、形如 `key:` 的行，其中包含 action 函数体内嵌套对象字面量的键（对象参数、`return { ... }` 内的字段等）：

**553 − 261 = 292 行是嵌套对象键，不是顶层键。** 同族计数的对照值：

| 模式（全文件） | 计数 |
| --- | --- |
| `^  [A-Za-z_$]`（任意 2 空格缩进标识符行） | 772 |
| **`^  [A-Za-z_$][\w$]*:`** | **553 ← 规划数字** |
| `^  [A-Za-z_$][\w$]*[:(]` | 554 |
| 全文件所有层级对象键（AST） | 2058 |
| **create 体顶层键（AST）** | **261** |

> 另一种可能的「553 出处」（推断，非认定）：仓库内确有把 `553` 当**行号**使用的文档——`docs/artifact-wave3a-kickoff.md:25` 的表格写有 `| appStore.ts:553/654/1161 | 初始化 artifacts: [] | …`，即 `appStore.ts:553` 是源码行引用。若规划者把「文件:行号」误读成「键数」，也会得到 553 这个数。两种解释都与实测 261 冲突，故结论不变。

### 3.2 233 = 「含 `get().` 的行数」（grep -c 语义）

```powershell
# 按行计数（grep -c 语义）
(Get-Content src/renderer/src/store/appStore.ts | Select-String -Pattern 'get\(\)\.' | Measure-Object).Count
```

实测：

```
occurrences of get(). : 239        ← 按“次”计数
LINES containing get(). : 233      ← 按“行”计数 ← 规划数字
lines with >=2 get(). : 4
```

即 **233 是 grep 的行计数，239 是 `get().` 出现次数，270 是 zustand `get()` 调用次数**。三者口径互不相同，规划取了行计数。

### 3.3 排除「历史版本 / 别的文件」解释

对同一路径的历史版本用同一 AST 脚本复算（`git show <rev>:...`，只读）：

| 版本 | 行数 | 顶层键 | AST `get()` | AST `set()` | 原始 `get()` | 上述 2 空格行计数 |
| --- | --- | --- | --- | --- | --- | --- |
| `HEAD` / `a21c5b5`（= 工作树） | 6377 | **261** | 270 | 196 | 271 | **553** |
| `3261a43` | 6322 | 258 | 269 | 194 | 270 | 545 |
| `0c0774d` | 6293 | 256 | 267 | 191 | 268 | 541 |
| `b4a25cd` | 6289 | 256 | 267 | 191 | 268 | 541 |
| `840e39b` | 6241 | 255 | 262 | 190 | 263 | 539 |
| `c6a598c` | 6233 | 255 | 262 | 188 | 263 | 539 |
| `95dbe28` | 6230 | 255 | 262 | 188 | 263 | 539 |
| `7374164` | 6179 | 255 | 256 | 185 | 257 | 539 |

→ **顶层键的历史区间是 255–261，从未接近 553**；而 553 只有在「2 空格行计数」口径下才出现。**553/233 不是版本漂移，是统计口径错误。**

### 3.4 「单 store」的核实

`src/renderer/src` 内 `from "zustand"` 的模块共 4 个：

| 文件 | 行数 | create 体顶层键 | `get()` | `set()` |
| --- | --- | --- | --- | --- |
| `src/renderer/src/store/appStore.ts` | 6377 | 261 | 270 | 196 |
| `src/renderer/src/store/btwStore.ts` | 499 | 24 | 7 | 11 |
| `src/renderer/src/store/projectConfigRailStore.ts` | 129 | 16 | 2 | 9 |
| `src/renderer/src/lib/externalAgentCatalog.ts` | 57 | 4 | 0 | 0 |

- `src/renderer/src/store/appStore.ts:1240`、`src/renderer/src/store/btwStore.ts:269`、`src/renderer/src/store/projectConfigRailStore.ts:70`、`src/renderer/src/lib/externalAgentCatalog.ts:12`（各自唯一的 `create(...)`）
- 4 个 store 顶层键合计 **305**，仍不是 553。
- 项目文档亦采用「单 store」表述：`docs/架构分析.md:315-317`：

```
 315: ### 4.15 渲染层（Zustand 单 store）
 317: - `appStore.ts` 单 store 全量状态（页面/任务/空间/技能/专家/MCP/面板/草稿…），`initRuntime` 用 `Promise.all` 并行首屏加载 11 组数据
```

→ 「单 store」**对主 store 成立**（appStore 是唯一巨型 store），但 renderer 实际还有 3 个小型卫星 store；「553 键全在一个 store」的图景与实测不符（appStore 261 键）。

---

## 4. 规模实测图（内联 SVG，含实测/推断区分）

<svg viewBox="0 0 980 620" width="980" height="620" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="appStore.ts 规模实测对比图">
  <rect x="0" y="0" width="980" height="620" fill="#f7f8fa"/>
  <text x="24" y="34" font-family="Segoe UI, sans-serif" font-size="20" fill="#111827">appStore.ts 规模实测（HEAD 9f90f4e，工作树未改动）</text>
  <text x="24" y="57" font-family="Segoe UI, sans-serif" font-size="13" fill="#374151">实线框 = AST 实测；虚线框 = 规划声明的 grep 行计数口径（本文 §3 已复现）</text>

  <rect x="24" y="76" width="932" height="238" rx="8" fill="#ffffff" stroke="#d1d5db"/>
  <text x="44" y="102" font-family="Segoe UI, sans-serif" font-size="15" fill="#111827">A. 顶层键：261（不是 553）</text>

  <rect x="44" y="118" width="200" height="70" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="60" y="144" font-family="Segoe UI, sans-serif" font-size="13" fill="#111827">文件 total 6377 行</text>
  <text x="60" y="166" font-family="Segoe UI, sans-serif" font-size="13" fill="#111827">create 体 1240–6109</text>
  <text x="60" y="182" font-family="Segoe UI, sans-serif" font-size="12" fill="#4b5563">（4870 行 = 76.4%）</text>

  <rect x="300" y="118" width="200" height="70" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="316" y="144" font-family="Segoe UI, sans-serif" font-size="13" fill="#111827">顶层键 = 261</text>
  <text x="316" y="164" font-family="Segoe UI, sans-serif" font-size="12" fill="#4b5563">91 state 字段</text>
  <text x="316" y="180" font-family="Segoe UI, sans-serif" font-size="12" fill="#4b5563">170 箭头函数 action</text>

  <rect x="556" y="118" width="200" height="70" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="572" y="144" font-family="Segoe UI, sans-serif" font-size="13" fill="#111827">interface AppState</text>
  <text x="572" y="164" font-family="Segoe UI, sans-serif" font-size="12" fill="#4b5563">276–753 行</text>
  <text x="572" y="180" font-family="Segoe UI, sans-serif" font-size="12" fill="#4b5563">成员 = 261 ✔ 互相印证</text>

  <line x1="244" y1="153" x2="296" y2="153" stroke="#4f46e5" stroke-width="2" marker-end="url(#ar)"/>
  <line x1="500" y1="153" x2="552" y2="153" stroke="#4f46e5" stroke-width="2" marker-end="url(#ar)"/>

  <rect x="812" y="118" width="124" height="70" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-dasharray="5 4"/>
  <text x="826" y="142" font-family="Segoe UI, sans-serif" font-size="13" fill="#991b1b">规划：553</text>
  <text x="826" y="162" font-family="Segoe UI, sans-serif" font-size="12" fill="#991b1b">−52.8%</text>
  <text x="826" y="180" font-family="Segoe UI, sans-serif" font-size="12" fill="#991b1b">口径错误</text>

  <text x="44" y="216" font-family="Segoe UI, sans-serif" font-size="13" fill="#111827">553 的真实来源（本次已复现）：</text>
  <rect x="44" y="226" width="892" height="34" rx="6" fill="#fff7ed" stroke="#f59e0b"/>
  <text x="58" y="248" font-family="Consolas, monospace" font-size="13" fill="#7c2d12">grep '^  [A-Za-z_$][\w$]*:' 全文件 = 553  =  261 顶层键  +  292 个嵌套对象键（action 体内的 key: 行）</text>

  <text x="44" y="284" font-family="Segoe UI, sans-serif" font-size="12" fill="#4b5563">对照：全文件所有层级对象键 = 2058；历史版本顶层键 = 255→261（从未接近 553）</text>
  <text x="44" y="302" font-family="Segoe UI, sans-serif" font-size="12" fill="#4b5563">行数口径陷阱：Measure-Object -Line = 6102，漏 275 个空行；ReadAllLines = 6377 才是真值</text>

  <rect x="24" y="328" width="932" height="150" rx="8" fill="#ffffff" stroke="#d1d5db"/>
  <text x="44" y="354" font-family="Segoe UI, sans-serif" font-size="15" fill="#111827">B. 取值/写入入口：get() 270、getState() 19、set( 196</text>

  <rect x="44" y="370" width="286" height="92" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="58" y="394" font-family="Segoe UI, sans-serif" font-size="13" fill="#065f46">zustand get() = 270 次（264 行）</text>
  <text x="58" y="414" font-family="Segoe UI, sans-serif" font-size="12" fill="#065f46">全部 0 参；行号 1368–5908</text>
  <text x="58" y="432" font-family="Segoe UI, sans-serif" font-size="12" fill="#065f46">原始子串 get( = 303 = 270 + 33</text>
  <text x="58" y="450" font-family="Segoe UI, sans-serif" font-size="12" fill="#065f46">33 = Map.get / L2320 ?.get()</text>

  <rect x="346" y="370" width="286" height="92" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="394" font-family="Segoe UI, sans-serif" font-size="13" fill="#065f46">useAppStore.getState() = 19</text>
  <text x="360" y="414" font-family="Segoe UI, sans-serif" font-size="12" fill="#065f46">接收者 100% 为 useAppStore</text>
  <text x="360" y="432" font-family="Segoe UI, sans-serif" font-size="12" fill="#065f46">13 处在工厂体内（1240–6109）</text>
  <text x="360" y="450" font-family="Segoe UI, sans-serif" font-size="12" fill="#065f46">6 在 6110 之后的 helper/selector</text>

  <rect x="648" y="370" width="288" height="92" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="662" y="394" font-family="Segoe UI, sans-serif" font-size="13" fill="#065f46">zustand set( = 196 次（全部 1 参）</text>
  <text x="662" y="414" font-family="Consolas, monospace" font-size="12" fill="#065f46">set({...}) 85 / (s)=&gt;({...}) 88</text>
  <text x="662" y="432" font-family="Consolas, monospace" font-size="12" fill="#065f46">(s)=&gt;{...} 23</text>
  <text x="662" y="450" font-family="Segoe UI, sans-serif" font-size="12" fill="#065f46">原始子串 203 = 196+4+1+2（§2.4）</text>

  <rect x="24" y="490" width="932" height="112" rx="8" fill="#ffffff" stroke="#d1d5db"/>
  <text x="44" y="516" font-family="Segoe UI, sans-serif" font-size="15" fill="#111827">C. 「只把 db 直写收进网关」的行数账（推断，依据 §2.5 实测点位数）</text>

  <rect x="44" y="528" width="210" height="58" rx="6" fill="#f5f3ff" stroke="#7c3aed"/>
  <text x="58" y="550" font-family="Segoe UI, sans-serif" font-size="13" fill="#4c1d95">32 直写点：Δ0 行</text>
  <text x="58" y="570" font-family="Segoe UI, sans-serif" font-size="12" fill="#4c1d95">同行替换调用表达式</text>

  <rect x="266" y="528" width="210" height="58" rx="6" fill="#f5f3ff" stroke="#7c3aed"/>
  <text x="280" y="550" font-family="Segoe UI, sans-serif" font-size="13" fill="#4c1d95">−4 行 / +1 行</text>
  <text x="280" y="570" font-family="Segoe UI, sans-serif" font-size="12" fill="#4c1d95">删 2 处守卫，加 1 行 import</text>

  <rect x="488" y="528" width="210" height="58" rx="6" fill="#f5f3ff" stroke="#7c3aed"/>
  <text x="502" y="550" font-family="Segoe UI, sans-serif" font-size="13" fill="#4c1d95">≈ −3 行（−10~+5）</text>
  <text x="502" y="570" font-family="Segoe UI, sans-serif" font-size="12" fill="#4c1d95">= 6377 行的 0.05%，持平</text>

  <rect x="710" y="528" width="226" height="58" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-dasharray="5 4"/>
  <text x="724" y="550" font-family="Segoe UI, sans-serif" font-size="13" fill="#991b1b">反例：网关写在文件内</text>
  <text x="724" y="570" font-family="Segoe UI, sans-serif" font-size="12" fill="#991b1b">+60~+150 行（净增）</text>

  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L0,6 L7,3 z" fill="#4f46e5"/>
    </marker>
  </defs>
</svg>

---

## 5. 规划修复建议

1. **改写 Phase 1 的规模基线（数字口径）**：`553 键` → `261 顶层键`（`interface AppState` 261 成员一一对应，`appStore.ts:276-753` / `:1240-6109`）；`233 处 get()` → `270 次 zustand get()（264 行）`，并单列 `useAppStore.getState() 19 次`、`set() 196 次`。若必须保留旧数字，须标注「行计数口径」，否则后续排期与验收都会按错误的 2.1 倍规模做决策。
2. **修正 Phase 1 的收益预期**：Phase 1 唯一动作 = db 直写收网关 → `appStore.ts` 约 **−3 行（区间 −10~+5，0.05%）**，**实质持平**。不要把「收网关」写成「减规模/减行数」；若目标真是降规模，需另立条目（按域拆分 action、抽离 170 个箭头函数中的大块逻辑、拆 store）。
3. **网关落点必须在新模块，且读路径一并纳入**：否则 `appStore.ts` 内会同时存在 `dbGateway.*`（32 直写 + 2 间接写）与 `window.api?.db?.list*`（12 直读 + 1 间接读）两套入口，`:3332/:3388` 式 `const api = ...; if (!api)` 守卫只会改一半。验收口径建议：`appStore.ts` 内 `window.api?.db?.` 残留 = 0，且行数变化声明为 ±10 行以内。
4. **执行前先跑基线、执行后跑同一命令对比**：`pnpm -s typecheck` + 相关 `test:*`；行数/键数/调用数用本报告 §1 的 AST 脚本（`@babel/parser`，不要用 `Measure-Object -Line`、不要用全文件 `^  \w+:` 正则）。

---

## 6. 边界与未验证项（区分实测 / 推断）

**实测（可复现的命令与输出均在本报告内）**：6377 行；261 顶层键（AST 对象 + AST 接口双证）；`get()` 270 / `getState()` 19 / `set()` 196；db 操作 44 个直调点（32 写 + 12 读），另有 3 处经 `const api = window.api?.db?.X` 间接调用（2 写 + 1 读）；553 与 233 的复现命令与数值；历史版本对照表；4 个 zustand store 的规模。

**推断（有数据支撑但非直接观测）**：
- §3.1/§3.2「553/233 来自行计数 grep」——数值 100% 复现，但规划文档原文不在本仓库（`out/plan-review/` 此前不存在，全仓 `*.md` 未检索到含「553 键 / 233 处」的规划文件），故「来源还原」标注为高置信推断而非事实认定。
- §2.5 的行数账：32 个直写点的替换是 1:1 同行替换（结构事实），但「删除 2 处守卫能省 4 行」「网关实现在文件内 +60~+150 行」取决于最终实现形态，属估算。
- 「网关」的目标形态（renderer 侧新模块 / 复用 main 侧 IPC / 收紧 `window.api.db` 暴露面）规划未给出；本报告按前两种分别给出估算，未对任一形态做实现级验证。

**未执行**：未运行 typecheck / 测试 / 构建（只读核查，且不修改任何源文件）；未对 `appStore.ts` 之外的文件做等价统计（除 §3.3 历史版本与 §3.4 satellite store）。
