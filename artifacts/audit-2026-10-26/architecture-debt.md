# 架构与可维护性债务审计（2026-10-26）

- 仓库：`/home/vivion/github/wavealstra_harness`（HEAD `230e8b1`，唯一活动分支 `main`）
- 审计者：Team 架构审计员（shared task `task-3`）
- 范围：`src/`（main / preload / renderer / shared）、`shared/` 工作区、`app/`（remote 客户端 + 遗留骨架）、`scripts/`（测试与门禁）
- 只读约束：本轮未修改任何源码/配置，未 `git commit`、未安装依赖、未启动 Electron、未跑 `test:all`。唯一写入是本文件。
- 结论标记：**已验证**＝本轮独立复现（命令/脚本可重跑）；**推测**＝由间接证据推断，需专项确认。
- 每条给出：严重度 P0–P3、证据（`file:line` 或可复现命令）、建议、成本（S ≤0.5 人日 / M 1–3 人日 / L >3 人日）。

---

## 0. 方法与可复现性

### 0.1 工具链现状（先说明，因为它限制了审计手段）

| 事实 | 证据 |
|---|---|
| 仓库无 ESLint / Prettier / Biome / oxlint 配置，也无 `lint` 脚本 | `ls -a \| grep -iE 'eslint\|prettier\|biome\|oxlint'` 为空；`grep -n 'lint' package.json` 无命中 |
| 无 dependency-cruiser / madge / knip（依赖图与死代码巡航工具全部缺失） | `node_modules/{dependency-cruiser,madge,knip}` 均不存在 |
| 仓库内 `typescript@7.0.2` 是 **原生（tsgo）预览版，不含 JS compiler API**（`ts.createSourceFile === undefined`） | `node -e "const ts=require('typescript');console.log(typeof ts.createSourceFile)"` → `undefined`；`node_modules/typescript/lib/` 只有 `tsc.js`/`getExePath.js`/`version.cjs` |
| 因此 AST 分析改用仓库已有的 `@babel/parser@7.29.9`（TS+TSX+JSX 全支持，未安装新包） | `/tmp/arch/*.mjs`，见 0.3 |

**这本身就是第一条债务结论（P2，已验证）**：`tsconfig` 里 `strict: true` 是唯一全局机械约束，而它只能抓类型不抓结构；架构约束的"保证"目前完全落在 321 个 `test:*` 脚本里（其中相当部分是源码文本 `includes()` 断言）。

### 0.2 口径与已知限制

- **AST 扫描范围**：`src/**`、`shared/**`、`app/**` 下 `.ts/.tsx`（排除 `.d.ts`、`node_modules`、`out`），共 **734 个文件**；解析出 **2,613 条可解析的模块依赖边**（import / export-from / dynamic import / require 全覆盖；5 条 `?asset|?worker` Vite 虚拟模块按外部处理）。
- **依赖解析规则**：相对路径、`@/`→`src/renderer/src`、`@shared/`→`src/shared`、`@mybuddy/shared`→`shared/src/index.ts`；裸包名视为外部依赖。
- **历史口径限制（重要）**：`git log --diff-filter=A` 显示 `AgentService.ts`/`appStore.ts`/`main/index.ts`/`AppDatabase.ts` 全部由首个提交 `ff9e756（2026-10-05 Initial commit: current MyBuddy project）` 一次性引入。因此"近 50 提交热点"只能读出**增量方向**（改了多少、加了多少），读不出"重构史"。全部历史仅 113 个提交。
- **未纳入自动判定**：运行时行为、打包产物、GUI 用例（按规则不跑）。

### 0.3 分析脚本（只读，放 `/tmp`，未进仓库）

| 脚本 | 作用 |
|---|---|
| `/tmp/arch/analyze.mjs` | Babel AST 依赖图 + Tarjan SCC 找环 + 跨层边统计 + `any`/空 catch/console/TODO 计数，输出 `/tmp/arch/report.json`、`edges.json` |
| `/tmp/arch/shape.mjs` / `fns2.mjs` | 巨型文件结构度量（行数、方法数、最长函数区间） |
| `/tmp/arch/err3.mjs` | 精确区分 `catch` 四类：真空 / 仅日志 / 有 throw / 其他 |
| `/tmp/arch/overlap.mjs` / `fields.mjs` | desktop vs remote DTO/类型重复度 |
| `/tmp/arch/api.mjs` | preload 实现对象 vs 手写 `index.d.ts` 契约一致性 |
| `/tmp/arch/err2.mjs` | 空 catch 包裹代码的类别（清理/DB/持久化/IPC） |

> 复现任意统计：`cd /tmp/arch && node analyze.mjs`（约 6 s）。表格中的 `grep`/`wc` 命令均可直接重跑。

---

## 1. 巨型文件与"变更放大点"

### 1.1 事实表（已验证：`wc -l` + Babel AST）

| 文件 | 行数 | KB | import 数 | export 数 | 类方法/顶层函数 | 最长单函数 |
|---|---|---|---|---|---|---|
| `src/main/agent/AgentService.ts` | 5,981 | 277 | 140（152 条 import 行） | 3 | 262 方法（64 async） | `promptInternal` **495 行**（L3873-4367），`createSession` 444 行（L5364-5807） |
| `src/renderer/src/store/appStore.ts` | 6,562 | 263 | 42 | 31 | 53 个 action 箭头函数 | `initRuntime` **429 行**（L2161-2589），`sendMessage` 400 行（L3596-3995），`applyAgentPatch` 277 行（L2808-3084） |
| `src/main/index.ts` | 3,482 | 167 | 117 | 0 | 9 顶层函数 + 36 个 `*Ipc` 命名空间 | `registerIpc` **1,994 行**（L644-2637），whenReady 链 792 行（L2639-3430） |
| `src/main/db/AppDatabase.ts` | 3,771 | 163 | 14 | 5 | 120 方法 | `ensureCurrentCoreSchema` **542 行**（L1554-2095），`ensureMemoryKernelTables` 256 行 |
| `src/main/capabilities/web-access/index.ts` | 3,292 | 133 | 52 | 2 | 45 顶层函数 | 匿名调度函数 **2,380 行**（L912-3291） |
| `src/renderer/src/components/chat/ChatInput.tsx` | 2,310 | 95 | 41 | 1 | 单组件 + **31 个 `useState`** | 组件体 **2,117 行**（L194-2310） |
| `src/preload/index.ts` | 1,375 | 85 | 36 | 2 | 0 函数（单个 `api` 对象字面量，53 键 / 457 方法） | 对象字面量 L292-1373 |
| `src/shared/agent-ipc.ts` | 2,306 | 79 | 1 | **167**（124 interface + 27 type + 14 个 `*Ipc` 常量对象） | — | 纯契约文件 |

### 1.2 "职责数"的硬证据（已验证）

| 文件 | 同时承担的职责（可审计证据） |
|---|---|
| `AgentService.ts` | 140 条 import 横跨 **19 个领域目录**（`capabilities` 10、`memory` 6、`project` 4、`cad` 4、`usage` 3、`task` 3、`skills` 3、`mcp`/`experts`/`artifact` 各 2…）：会话创建、prompt 执行、审批桥、生命周期、事件投影、usage 记账、memory 注入、durable bot、consult、regenerate 全在一个类里（262 方法）。命令：`grep -o 'from "\.\./[a-z-]*' src/main/agent/AgentService.ts \| sort \| uniq -c` |
| `src/main/index.ts` | 同一函数里做：445 条 IPC 注册（`src/main/index.ts` 内 `ipcMain.handle`/`ipcMain.on` 计数；全 `src/main` 为 454，口径见 §3.5）+ 服务装配 + 窗口/托盘/单实例锁/退出编排（`registerIpc` 1,994 行；L644 起，L2637 结束） |
| `appStore.ts` | 直接调 preload API **129 次**（`grep -c 'window\.api'`），`get()` 277 次；同一 store 同时管 space/task 树、chat 流式补丁、artifact 面板、settings、通知、远程同步 |
| `AppDatabase.ts` | 62 条 `CREATE TABLE` + schema 迁移 + 62 张表的 CRUD（120 方法），迁移与业务读写同一个类 |
| `ChatInput.tsx` | 31 个 `useState` + 富文本/附件/技能选择/模型选择/快捷键/拖拽 全在一个组件体（2,117 行） |

### 1.3 变更放大点（已验证：`git log --numstat`）

近 50 个提交（2026-10-16 → 2026-10-26）：

```
git log --name-only --format= -50 | grep -v '^$' | sort | uniq -c | sort -rn | head
→ package.json 28（脚本/依赖编排，每提交必动）
→ src/main/capabilities/builtin-capability-extension.ts 4
→ src/main/agent/durable/DurableBotRuntime.ts 4 · src/main/agent/AgentService.ts 4
→ shared/src/remote-contract.ts 4 · app/remote/src/store/remoteStore.ts 4
```

单提交改动文件数：**中位数 4，最大 23**（`cc32b2b` 可移植性门禁）。

全历史按"触碰次数 × 只增不减"看，真正的放大点是：

| 文件 | 触碰提交 | 累计 churn | 结论 |
|---|---|---|---|
| `AgentService.ts` | 18 | **+6,078 / −97** | 5981 行中 5,981 行是初始提交带入；17 次后续改动净增 97 行——**只加不减** |
| `appStore.ts` | 17 | **+6,710 / −148** | 同上 |
| `src/main/index.ts` | 16 | **+3,541 / −59** | `registerIpc` 持续膨胀 |
| `AppDatabase.ts` | 5 | +3,778 / −7 | 几乎零重构 |
| `src/shared/agent-ipc.ts` | 11 | +2,306 / −1 | 契约文件只增不改 |
| `preload/index.ts` | 6 | +1,376 / −1 | 同上 |

最近 8 个触碰 `AgentService.ts` 的提交，每次 **+4…+46 / −0…−10**：

```
4687852 fix(agent): 重新生成不再因悬空模型坐标硬失败  +22/-3
03d7f5c fix(durable): Bot 模型被目录淘汰…            +19/-0
495ba1b perf(remote): 安卓端切换任务不再全量拉取       +32/-0
cdff157 fix(models): 刷新后连带清理…                 +46/-10
```

**判读（已验证）**：这些文件的改动模式不是"重构"，而是"每个功能往里贴一段"。真正的变更放大点不是行数本身，而是**每个跨领域功能都必须落到同一个 6K 行文件里**（例如"suggested model 优先链"同时动 `agent-ipc.ts`、`ModeProfileStore`、`AgentService`、`appStore`），改一处要靠读全文建立上下文。

**P1 · 已验证 · 建议与成本**

1. **给"回流"上机械门禁**（M）：扩展 `architecture-test` 的 N 段——把 `registerIpc` 当前 1,994 行拆成 `ipc/<domain>.ts` 的 36 个注册器后，把"`src/main/index.ts` ≤ 800 行"写成断言；`appStore` 同理（`src/renderer/src/store/chat/*.ts` 拆分 + 行数上限）。仓库已有先例：`scripts/harness-quality-gate-test.ts:16-24` 就是"退休文件必须不存在"的棘轮断言，可直接复用该模式。
2. **优先拆 3 个入口而非全部**（L，分期）：`registerIpc`（L644-2637，按 `*Ipc` 命名空间切 36 个文件，机械操作，风险低）→ `AgentService` 的 `promptInternal`（495 行）与 `createSession`（444 行）→ `ChatInput` 组件体。`docs/refactor-plan-verified.md` 已评估过 `AgentService` 全拆 ROI 不成立（19–29 人日、收益 −243 行），本报告不推翻该结论：**建议先做 IPC 拆分（收益/风险最好）**。

---

## 2. 依赖结构

### 2.1 renderer → main 非法导入：**0**（已验证，历史结论复现）

- 历史审计口径（`artifacts/quality-audit/architecture.md:3,26`）：`0/261` renderer 文件含 `src/main`/`@main` token。
- 本轮独立验证（三种方法互相印证）：
  1. AST 依赖图：`src/renderer/src/**` 共 **262** 个文件，跨层出边只有 `renderer→shared`（**241** 条），`renderer→main` = **0**、`renderer→preload` = **0**；
  2. `grep -rn "from ['\"].*\(src/main\|/main/\|preload\)" src/renderer/src/` → 0 行；
  3. 也不存在 `@main` 之类别名（web tsconfig 只有 `@/*`、`@shared/*`）。
- **结论：renderer 与 main 的隔离当前成立**，且 preload 白名单是唯一通道。这是该仓库最好的一处结构性质。

### 2.2 循环依赖：5 个 SCC，但**真正的运行期环只有 1 个**（已验证）

方法：Babel AST 建图（2,613 边）→ Tarjan 强连通分量；再剔除 `import type`/`export type`（编译期擦除，不产生运行期环）重跑一遍。

| # | 规模 | 环内文件 | 边性质 | 判定 |
|---|---|---|---|---|
| 1 | 15 节点 | `src/main/capabilities/web-access/`：`extract.ts` ↔ `gemini-url-context.ts` ↔ `video-extract.ts` ↔ `youtube-extract.ts` + `github-api/github-extract/kagi/ollama/parallel/perplexity/querit/search1api/tinyfish/brightdata-unlocker/firecrawl` | **值导入**：`extract.ts` 依次 import 13 个 provider；`gemini-url-context.ts:5`、`video-extract.ts:8`、`youtube-extract.ts:7` import 回 `extract.ts` | **真环（运行期）**，靠 ESM 提升才不炸；provider 注册表与调度器互为依赖 |
| 2 | 5 节点 | `ComputerAutomationService.ts` ↔ `ComputerUseRunCoordinator.ts` ↔ `ComputerUseOverlayService.ts` ↔ `ComputerUsePolicy.ts` ↔ `ComputerUseRecoveryPolicy.ts` | 值边只在 `ComputerAutomationService→{RunCoordinator,RecoveryPolicy}→Policy/Overlay` 方向；反向全是 `import type` | 类型环，擦除后无环 |
| 3 | 4 节点 | `src/main/mcp/{BundledMcpExtensions,NativeMcpConfig,McpConfigService,McpModeFilter}.ts` | `McpConfigService→` 其余三个为值；反向 `import type` | 类型环 |
| 4 | 3 节点 | `src/shared/{project-domain,runtime-policy,mode-profile}.ts` | 仅 `mode-profile→runtime-policy` 为值；其余 `import type` | 类型环 |
| 5 | 2 节点 | `src/main/agent/MemoryContextProjection.ts` ↔ `src/main/memory/MemoryService.ts` | `MemoryService→MemoryContextProjection` 为值；反向 `import type` | 类型环 |

- 自环（文件 import 自己）= **0**。
- **P2 · 已验证**：环 1 是唯一运行期环（4 个文件构成真实循环）：`extract.ts:12-21` 与 `gemini-url-context.ts:5`、`video-extract.ts:8`、`youtube-extract.ts:7`。建议：把 `extract.ts` 里的 provider 列表抽成 `provider-registry.ts`（值，不含逻辑），provider 只 import registry 与类型，**S 成本**；加一条 `test:architecture` 断言"web-access 目录 SCC 数 = 0"（可复用本轮 `/tmp/arch/analyze.mjs` 的 Tarjan，约 60 行，**S**）。
- **P3 · 已验证**：环 2–5 依赖 `import type` 保持无环。风险是"哪天有人把 `import type` 改成值导入就变成真环"，而**当前没有任何门禁拦截**（见 §3）。建议统一扫描并断言"值导入子图无环"（接上面同一个断言）。

### 2.3 `shared/` 工作区 vs `src/shared`：**没有重复定义，但存在"两个家 + 三种导入写法"**（已验证）

- 物理布局：`shared/`（pnpm workspace 包 `@mybuddy/shared`）只有 3 个文件 536 行：`index.ts`（14 行，`IPC_CHANNELS` + `export * from './remote-contract'`）、`remote-contract.ts`（478 行，40 个接口 253 个字段）、`remote-images.ts`（44 行）。`src/shared/` 84 个文件。
- **无重复类型定义**：`remote-contract.ts` 的 40 个 `Remote*` 类型在 `src/shared` 中不存在同名副本（AST 名称集合对比，重复项 0）。
- **但同一个契约有两个导入路径**：
  - `src/shared/remote-access.ts:1` 用 `export-from "../../shared/src/remote-contract"` 转发一次；
  - `src/main/remote/` 下 **12 个文件**直接深相对路径 import `"../../../shared/src/remote-contract"`（13 条边），绕过 `src/shared` 转发层；
  - `app/remote` 走 `@mybuddy/shared`（17 条边 → `shared/src/index.ts`）。
  - 后果：`shared/` 的 tsconfig 归属**不在根 `typecheck` 里**（`tsconfig.web` include `src/shared/**`，`tsconfig.node` include `src/main|preload|shared`，都不含 `shared/src/**`；只能靠"被 import 时被动类型检查"）。
- **真正的竞争定义只有一处（死代码）**：`shared/src/index.ts` 里 `IPC_CHANNELS = { PING:'ping', GET_APP_INFO:'get-app-info' }` 与全仓 450 个真实 channel（`src/shared/**` 与 `shared/src/**` 共 37 个 `*Ipc` 常量对象，其中 `agent-ipc.ts` 内 14 个）是**两套互不相干的"IPC 常量"**；`IPC_CHANNELS` 只被 `app/main/src/index.ts:5`、`app/preload/src/index.ts:2` 使用，而这两个文件属于**已死的 monorepo 骨架**（见 §4.4）。
- **P2 · 已验证 · 建议（S）**：把 `remote-contract.ts` 迁进 `src/shared/remote-contract.ts` 并在 `shared/src/index.ts` 只做 `export *`（或反向：让 `src/shared` 转发 `shared/src`），然后给 `src/main/remote/**` 统一改用 `@shared/remote-contract`（`tsconfig.web` 已有该别名，`tsconfig.node` 需补 `paths`），删除死掉的 `IPC_CHANNELS`。收益：一种契约一个家，`fs` 层次不再出现 `../../../shared/src/...` 这类穿越路径（当前全仓 78 条 ≥3 级 `../` 深导入，全部指向 `src/shared`）。

### 2.4 preload ↔ `src/shared/agent-ipc.ts` 契约维护方式：**手写三份、当前一致、零机械校验**（已验证）

- 契约分三处，**全部手写、无 codegen**：
  1. `src/shared/agent-ipc.ts`（2,306 行 / 167 export / 124 interface + 27 type）定义 DTO 与 14 个 `*Ipc` 常量对象（全仓 37 个常量对象共 456 个成员，映射到 450 个唯一 channel，7 个跨进程同名、4 个 host/legacy 互斥）；
  2. `src/preload/index.ts`（1,375 行）在 `const api = {…}`（L292-1373）里手写 **53 个顶层键 / 457 个方法**，逐个 `ipcRenderer.invoke(SomeIpc.foo, …)`；
  3. `src/preload/index.d.ts`（788 行）手写 `export interface PreloadApi`（L177-783）供 renderer 的 `declare global { interface Window { api?: PreloadApi } }`（L780-787）使用。
- 本轮实测一致性：preload 实现 53 键 vs d.ts 53 键，**顶层键集合完全一致**（`/tmp/arch/api.mjs`）。但这是"当前恰好同步"，**没有任何断言保证**：
  - `index.d.ts` 与 `index.ts` 是两份独立声明，TS 不会互相比对（`index.ts` 自己也导出 `export type PreloadApi = typeof api;` L1375，但没人用它对 d.ts 做 `satisfies`）；
  - `test:ipc-channel-inventory` 的扫描目录是 `["src/main","src/shared","shared/src","scripts","app"]`——**不含 `src/preload`**，所以 preload 侧 457 个调用点不在冻结基线的保护范围内；
  - renderer 侧对 channel 名的直接引用 **0**（全走 `window.api` 方法名），所以"renderer 需要的 channel 集合"在机器上不可见。
- 顺带发现 2 处**只有一边有**的通道（本轮交叉比对）：
  - `main` 有、preload 无：`html-edit:start/stop/state`——实际 preload 用**字符串字面量** `"html-edit:start"` 而非常量（`src/preload/index.ts:1021-1026`），是把常量对象漏用，不是缺失；
  - preload 有、main 无：`subagent:event`——main 侧用**字符串字面量** `w.webContents.send("subagent:event", …)`（`src/main/capabilities/subagent/index.ts:545`），常量 `SubagentIpc.event` 在 `src/shared/agent-ipc.ts:332` 定义但发送端没引用。
  - 这两条正好证明：**基线只冻结 `src/main` 里的常量引用，字符串字面量形式的注册/发送完全绕过基线**（`grep -c "ipcMain.handle(\"" ...` 可佐证存在字面量注册）。
- **P1 · 已验证 · 建议（S/M）**：加一条 30 行断言：`import { api } from '../src/preload/index'` 的键集合 == `PreloadApi` 的键集合（用 Babel AST 或 `typescript` 的 d.ts 文本解析均可），并把 `src/preload` 加进 `ipc-channel-inventory` 的 `SCAN_DIRS`，同时断言"main 注册集合 == preload invoke 集合（含字面量）"。**成本 S**，可 100% 消除"三处手写漂移"这类事故。

### 2.5 跨层全景（已验证，供回归基线用）

| 边方向 | 条数 | 备注 |
|---|---|---|
| `src/main → src/shared` | 380 | 正常 |
| `src/main → shared/src`（工作区） | 13 | 全部是 remote 契约（§2.3） |
| `src/preload → src/shared` | 35 | 正常 |
| `src/renderer → src/shared` | 241 | 正常；其中 193 次用 `@shared/` 别名、78 条 ≥3 级 `../` 深导入并存（两种写法） |
| `app/remote → shared/src`（`@mybuddy/shared`） | 17 | 正常（移动端唯一契约入口） |
| **`app/remote → src/renderer`** | **1** | ⚠️ **非法**：`app/remote/src/components/RemoteMarkdown.tsx:8` → `"../../../../src/renderer/src/components/common/SvgFencePreview"` |
| `src/shared → package.json` | 1 | `src/shared/app-version.ts:1` 直接 import `../../package.json`（打包器特性，能跑但把版本号耦合进 shared） |

**P2 · 已验证**：`app/remote` 是 Capacitor 安卓 Web 客户端（`app/remote/package.json`，4,849 行），它通过 4 级相对路径**深挖进桌面 renderer 的组件树**。这会：①把桌面 renderer 的 React 组件变成安卓包构建期依赖；②绕过"移动端只消费 `@mybuddy/shared` 契约"的既有约定；③桌面 renderer 组件一改（哪怕只是加个 prop），安卓端可能静默坏。建议把 `SvgFencePreview` 复制/下沉为 `shared/src` 下的无状态组件或 `app/remote` 自带实现，并加一条断言"`app/remote` 不得 import `src/renderer`/`src/main`"（**S**）。

---

## 3. 机械保护缺口

### 3.1 门禁全景（已验证）

| 门禁 | 位置 | 现状 |
|---|---|---|
| `pnpm typecheck` | `package.json:24` | `tsc -p tsconfig.web && tsc -p tsconfig.node && node scripts/typecheck-scripts.mjs` |
| `test:architecture` | `scripts/architecture-test.ts`（2,422 行 / **308 个断言**，`assert(` 出现 309 次含 1 处定义） | 行为测试为主 + 25 条源码文本断言 |
| `test:harness-quality` | `scripts/harness-quality-gate-test.ts`（9 个断言） | "退休文件必须不存在"棘轮 + 上下文预算 |
| `test:ipc-channel-inventory` | `scripts/ipc-channel-inventory.mjs --check` | 冻结 450 channel 名 |
| `test:all` | `scripts/test-all.mjs` | 321 个 `test:*` 的聚合棘轮（`scripts/test-baseline.json` 容忍已知失败） |
| CI | `.github/workflows/verify.yml` | typecheck → harness-quality → artifact-gate → test:all（windows-latest） |
| **缺失** | — | **无 lint、无 import 边界检查、无循环依赖检查、无死代码检查、无未用导出/依赖检查、无文件规模上限、无 `any`/空 catch 策略** |

### 3.2 `test:architecture` 到底断言了什么（5–8 条代表，已验证）

该文件 308 个断言中，绝大部分是**行为断言**（preset 合成、技能隔离、原子写、DB 生命周期…）。真正带"架构约束"性质的集中在 N7–N14 段（25 条源码文本断言，L2182–2420），代表 8 条：

| # | 断言 | 位置 | 性质 |
|---|---|---|---|
| 1 | `AgentService` 必须包含 `this.libraryWorkspaceContext.resolveTask(` —— 会话上下文装配已委托出去 | `scripts/architecture-test.ts:2186` | 正向文本 |
| 2 | 正则禁止 `private (libraryCatalog\|…\|renderBtwProjectContextSegments)(` 回流 `AgentService` | 同文件 `2190` | **反向文本（God object 回流护栏）** |
| 3 | `AgentService` 不得出现 `new LibraryService(this.db)` / `new WorkspaceResourceLocator(this.db` | 同文件 `2196` | 反向文本 |
| 4 | `createSession` 只消费 `SessionExtensionAssembler` 的 factory 列表；Pi 核心工具不得装配宿主覆盖/路径门禁/Shell 改写 | 同文件 `2211`、`2215` | 正向文本 |
| 5 | extension 注册顺序固定：`runtime/capability → MCP/product permission → domain` | 同文件 `2279` | 顺序文本（数组序列） |
| 6 | `SessionApprovalBridge` 拥有审批状态；`AgentService` 不得含 `sessionWriteGrantListeners`/`pendingApprovals` 等实现细节 | 同文件 `2294`、`2310`、`2334` | 反向文本 |
| 7 | 生命周期/事件/提示词/BTW 各自的服务文件必须存在且包含指定方法（`release`/`invalidateAll`/`cleanupFailedCreate`/`disposeAll`） | 同文件 `2323`、`2365`、`2394`、`2413` | 正向文本（成员存在性） |
| 8 | "退役文件必须不存在"：`test:harness-quality` 断言 `src/main/agent/ExecutionRouter.ts` 等 8 个旧 wrapper、5 个会话 todo/plan 服务不得复活 | `scripts/harness-quality-gate-test.ts:16-24` | **文件级棘轮（最可靠的一类）** |

**评价（已验证）**：N7–N14 是"**对已知分解成果的定点护栏**"，不是"对结构的普遍约束"。它们的通病是硬编码调用字符串（`assert(agentSource.includes("this.sessionApprovals.create(opts.taskId, …)"))`），即 AGENTS.md 自己点名的"源码文本断言"陷阱：一次**正确**的重构（改参数、换方法名、调顺序）就会假红；反过来，新增一处同类回流只要换个写法就能假绿。仓库 328 个 `scripts/*.ts` 中 **109 个（33%）** 用 `readFileSync` 做源码扫描（`grep -rln readFileSync scripts/*.ts | wc -l`），同源风险面很大。

### 3.3 高风险约束中的**无保护**清单（已验证）

| 约束 | 保护现状 | 后果（本轮实测） |
|---|---|---|
| 分层方向（renderer ↛ main、preload ↛ renderer、app ↛ 桌面源码） | **无任何断言** | renderer→main 目前恰好 0；但 `app/remote→src/renderer` 已破 1 条，且没人会发现（§2.5） |
| 模块循环依赖 | 无 | 5 个 SCC 存活，其中 1 个是真运行期环（§2.2） |
| IPC **载荷**契约（字段、必填性、版本） | 无（基线只冻结 channel **名**） | `RemoteTaskSummary` vs `TaskDto` 16/18 字段重合，改一边不会报错（§4.1） |
| preload 实现 ↔ `index.d.ts` 一致 | 无 | 今天恰好一致（53/53），下次改必然靠人（§2.4） |
| 单文件规模 / God object 回流（除 N7–N14 点名的符号） | 无通用规则 | `registerIpc` 1,994 行、`appStore.initRuntime` 429 行可继续长 |
| 死文件 / 未用导出 | 无 | 10 个不可达模块存活，约 2,600 行（§4.4） |
| `any` / `@ts-ignore` 策略 | 无 | 266 处 `any`（§4.3） |
| 空 catch / 错误吞咽策略 | 无 | 374 处真空 catch（§5） |
| 生成物不得进源码树 | 无 | `src/main/capabilities/subagent/vendor/*.mjs` 由构建写入 `src/`（§4.2） |

### 3.4 `scripts/` 类型检查这一层是"半盲"的（已验证，P2）

- 背景正确：`scripts/` 不在 `tsconfig.web/node` 的 include 里，于是有 `scripts/typecheck-scripts.mjs` 棘轮（`package.json:374`）。
- 但 `tsconfig.scripts.json` **没有 `paths`**（对比 `tsconfig.web.json` 有 `@/*`、`@shared/*`），导致所有用别名的测试脚本报 `TS2307 Cannot find module '@/…'`。
- 后果：`scripts/typecheck-baseline.json` 里 **209 条已知错误 / 98 个文件**，其中 **TS2307 恰好 31 条**（`wave5a-preview-entry.tsx` 一个文件 17 条、`chat-markdown-test.ts` 4 条、`message-lifecycle-test.ts` 2 条…），全部是**别名解析噪音**。棘轮的 key 是"文件+错误码+消息"，这些噪音永久占位，同一文件里**真实**的契约漂移错误（`TS2339 属性不存在` 30 条、`TS2353 多余属性` 14 条）与噪音混在一起，人不会再看。
- 实例（真实漂移被容忍）：`scripts/acp-permission-policy-test.ts` 仍在用 `ExternalAgentRunDto.permissionPolicy`、`scripts/agent-loadout-test.ts` 仍在给 `SpaceDto` 写 `updatedAt`——这两个字段已不在契约里，测试却继续跑（说明它们已不再校验真实形状）。
- **建议（S）**：给 `tsconfig.scripts.json` 补 `paths`（`"@/*": ["./src/renderer/src/*"]`、`"@shared/*": ["./src/shared/*"]`），31 条 TS2307 会消失，棘轮信号恢复；随后用 `--update-baseline` 收窄基线。

### 3.5 `artifacts/ipc-channel-baseline.json` 的生成与更新方式（已验证：**不是手工**）

- 生成器：`scripts/ipc-channel-inventory.mjs`（272 行），三种模式齐全：
  - 无参：打印清单，不写文件；
  - `--update`：写基线（`artifacts/ipc-channel-baseline.json`，15.8 KB）；
  - `--check`：与基线比对，新增 channel 即 `exit 1`。
- 已接门禁：`package.json:271` `"test:ipc-channel-inventory": "node scripts/ipc-channel-inventory.mjs --check"`，且 `test:all` 会选中所有 `test:*`（`scripts/test-all.mjs:74`），CI 也跑 `test:all`。
- 基线内容：`scope: "src/main/**"`、`channels` 450 项、`mainRegistrations 454`、`allRegistrations 465`、`uniqueChannels 450`、`duplicates {real:0, mutex:4, crossProcess:7}`、`runtimeChannels ["selection-popover:action"]`、`monkeyPatches ["src/main/agent/subagent-ipc-host.ts:125"]`、`unresolved: 0`。
- 本轮复跑（只读）：`node scripts/ipc-channel-inventory.mjs` → `本进程注册点=454 全仓=465 唯一 channel=450 重复：真=0 互斥=4 跨进程=7 未解析=0`。
- **缺口（P2，已验证）**：①`SCAN_DIRS` 不含 `src/preload`，preload 的 457 个 invoke 不受保护；②只冻结 channel 名字符串，**载荷 schema 与 handler 存在性不校验**；③字符串字面量写法的注册/发送（`html-edit:*`、`subagent:event`）不进基线。
- 任务描述里的"~441 个 IPC 注册"与实测有差：`grep -c 'ipcMain\.\(handle\|on\)' src/main/index.ts` 为 **445**，全仓 `src/main` 为 **454**、含 scripts/app 为 **465**。建议对外统一用 454/450 这两个数（有脚本与基线背书）。

---

## 4. 重复与死代码

### 4.1 remote（安卓）vs desktop：UI 不重复、**DTO 层近乎克隆**（已验证）

- 类型名重叠：`src/renderer/src` 306 个类型 vs `app/remote/src` 18 个，同名只有 `Props`/`State`——**没有整份复制的类型**，两边都 import `@mybuddy/shared` 的 `Remote*` 契约。这是好的设计。
- 但**字段级重复**很明显（Babel 取 interface 字段集合求交，`/tmp/arch/fields.mjs`）：

| remote 类型 | 桌面类型 | 共享字段/较小者 | 比例 |
|---|---|---|---|
| `RemoteTaskSummary`（18 字段） | `TaskDto`（22） | 16 | 0.89 |
| `RemoteHistoryMessage`（12） | `ChatMessageDto`（18） | 11 | 0.92 |
| `RemoteSpaceSummary`（7） | `SpaceDto`（9） | 7 | **1.00** |
| `RemoteToolCall`（6） | `ChatToolCallDto`（9） | 6 | **1.00** |
| `RemotePromptRequest`（8） | `AgentPromptRequest`（22） | 7 | 0.88 |

- 映射层：`src/main/remote/RemoteDtoMapper.ts` 只有 144 行（薄，`mapRemoteTask`/`mapRemoteHistory` 等纯函数），说明这是"**有意的窄口径对外投影**"，设计意图是解耦移动端 wire format。**代价**是：给 `TaskDto` 加字段 → 要同步 `RemoteTaskSummary` + mapper + `app/remote` store + 安卓端渲染，共 4 处，且**没有任何测试保证 4 处一致**（`scripts/remote-*` 用例被 `EXCLUDE_PATTERNS: /^test:remote-/` 排除出 `test:all`，见 `scripts/test-all.mjs:48`）。
- 行为重复：`app/remote/src/store/remoteStore.ts`（1,129 行）与 `appStore.ts` 的流式补丁逻辑各写一份（`remotePatch.ts`/`remoteTimeline.ts` vs `appStore.applyAgentPatch`），`App.tsx`（1,998 行）与桌面 `ChatView` 各写一套消息渲染。
- **P2 · 已验证 · 建议（M）**：①给 `RemoteTaskSummary`↔`TaskDto` 加"字段漂移检测"断言（远程 DTO 字段 ⊆ 桌面 DTO 字段，或允许清单）；②把 `test:remote-client-regression` 之类**纯逻辑**用例从 `EXCLUDE_PATTERNS` 的 `/^test:remote-/` 里豁免出来（当前该正则把整组远程用例排除，而那些用例正是唯一覆盖 `app/remote` 逻辑的测试）。

### 4.2 `src/main/capabilities/subagent` 的 vendor：**构建产物被写进源码树，且被宽泛 gitignore 隐藏**（已验证，P2）

- 体量：整个 `subagent/` 目录 80 KB vendor + `index.ts` 68K/1,425 行 + `runtime.ts` 44K；`vendor/` 两个文件：`command-code.mjs` 63 KB、`context-projection.mjs` 14 KB。
- 来源：`scripts/build-subagent-context.mjs:8-13` 用 esbuild 把 `src/main/agent/EphemeralContextProjection.ts` 与 `src/main/agent/providers/command-code.ts` **打包输出到 `src/main/capabilities/subagent/vendor/`**；调用点是 `electron.vite.config.ts:47-56` 的 `generateBundle`。即 **`pnpm build` 会往源码目录写生成物**。
- 消费方：`src/main/capabilities/subagent/worker-launcher.mjs:8-9` `import … from "./vendor/…"`。
- 隐藏机制：`.gitignore:29` 有一条**全局** `vendor/`（注释说明本意是"上游 MCP 源码浅克隆 `extensions/mcp/*/repo`"），因此这两个生成物**也**被忽略——`git ls-files src/main/capabilities/subagent/vendor/` 为空（未跟踪）。
- 风险：①新鲜 clone 里 `worker-launcher.mjs` 的 import 目标不存在，**直接跑 src 下的 worker 会失败**；仓库里恰好就有这么做且**没有存在性守卫**的脚本：`scripts/subagent-worker-launcher-099-smoke.ts:8`（顺带：它已不在任何 `test:*` 里，是孤儿脚本）；②生成物是"逻辑副本"：`vendor/context-projection.mjs` 头部注释显示它打包了 `EphemeralContextProjection.ts` + `MemoryContextProjection.ts` + `shared/memory-kernel.ts` 的副本，**主进程与子代理 worker 各跑一份同源逻辑**，构建不跑就漂移；③`vendor/` 这条 gitignore 未来会吞掉合法的 vendor 目录。
- **建议（S）**：产物改写到 `out/generated/`（或 `src/../generated/`）并在 `.gitignore` 用精确路径（`src/main/capabilities/subagent/vendor/`）替代全局 `vendor/`；`worker-launcher.mjs` 里加显式失败提示（缺产物时打印"请先 pnpm build"）；删/修孤儿脚本。

### 4.3 TODO/FIXME/HACK 与 `any` 分布（已验证）

- **TODO/FIXME/HACK/XXX 全仓仅 19 处，且 0 处是"技术债标记"**：
  - `grep -rn -E "TODO|FIXME|HACK|XXX" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=out .` → 19 行，分布：`src/main` 6（全是标识符 `PROJECT_TODO_TITLE_MAX_CHARS`、`ProjectTodoStatus`）、`src/shared` 1（同上）、`scripts/durable-bot-desktop-test.cjs` 2（fixture 字符串 `BOT_CREATED_TODO`）、`artifacts/dsh-inspect` 5、`artifacts/quality-audit` 3、`docs/plan` 1、`pnpm-lock.yaml` 1。
  - 任务描述里的"约 21 处"≈ 这个数，但**逐条判定结论是：没有一条值得修**（它们不是债务标记）。真正的问题相反：**代码里没有任何 debt marker**，债务只存在于 `docs/` 与 `artifacts/`（本仓库的审计报告文化很重，`artifacts/` 38,520 行、`docs/` 大量 md）。
  - **建议（S）**：给"已知但暂不修"的点（如 §2.2 环 1、§4.4 死文件）在代码里加 `// DEBT(owner, date): …` 形式标记，或至少在本文末尾维护一份"不做清单"。
- **`any` 统计（AST 精确，`src` + `shared` 709 文件）**：`TSAnyKeyword` **160** 处、`as any`（`TSAsExpression`→any）**106** 处；文本口径 `grep -rn "as any"` = 93、`grep -rn ": any\b"` = 31（差异来自泛型/数组写法）。**`@ts-ignore`/`@ts-expect-error`/`@ts-nocheck` 在 `src`+`shared` 为 0**（唯一 1 处在 `scripts/workspace-runtime-consolidation-test.ts:279`），没有任何 `// eslint-disable` 残留（无 ESLint 也就没人写）。
- 集中位置（P3，已验证）：`src/main/workspace/WorkspaceResourceLocator.ts`（39 any + 36 as any）、`src/main/library/LibraryService.ts`（24/23）、`src/main/capabilities/subagent/runtime.ts`（15/14）、`src/main/capabilities/subagent/index.ts`（24 any）、`appStore.ts`（10/5）。前三处占全仓 `as any` 的 ~40%，是"Pi SDK 对象跨进程透传"的必然代价；`appStore` 的 10 处值得逐个收。

### 4.4 未使用依赖与死代码（已验证）

**未使用依赖：0/22（已抽样全量，非仅 10 个）**

用"全仓 import 字符串"比对 `package.json`（1,252 个文件）：`dependencies` 22 个 **全部**被 import；`devDependencies` 46 个中 9 个不被源码 import，但**逐个人工核对后全部合理**：`@types/*`（5 个，类型专用）、`electron-builder`/`@electron/rebuild`（CLI 专用）、`katex`（经 `src/renderer/src/styles/global.css:1` 的 `@import "katex/dist/katex.min.css"` 使用）、`@shikijs/engine-oniguruma`（shiki 运行时按需加载 wasm 引擎）。→ **这条债务项实测为 0**，不构成问题（`pnpm-lock` 与 workspace 也未见幽灵包）。

**死代码：10 个模块从任何入口不可达（合计 2,740 行）+ 1 个死骨架（230 行）**

方法：从 4 个真实入口（`src/main/index.ts`、`src/preload/index.ts`、`src/renderer/src/main.tsx`、`app/remote/src/main.tsx`）做可达性遍历，与 752 节点图比对。

| 文件 | 行数 | 现状（人工复核） |
|---|---|---|
| `src/main/task/TaskIsolationAudit.ts` | 634 | 只被 `scripts/task-isolation-audit-test.ts` import（诊断工具，非产品路径） |
| `src/main/project/project-memory-extension.ts` | 377 | 只被 2 个测试 import；**生产路径没有装配它**（`grep -rn createProjectMemoryExtension src` 仅测试）→ 项目记忆的生产实现已迁走，测试仍在测旧工厂 |
| `src/main/professional-tools/runtime-readiness.ts` | 230 | 只被 `scripts/runtime-readiness-test.ts` |
| `src/renderer/src/components/chat/RuntimeContextInspector.tsx` | 790 | **零引用**；`scripts/freecad-mcp-contract-test.ts:107`、`scripts/professional-tools-test.ts:488` 反而断言"主界面不得挂它" |
| `src/renderer/src/components/chat/PiCodeModeChip.tsx` + `.css` | 54+8 | **零引用**；`scripts/pi-codemode-auto-ui-test.ts:12` 断言 chat 源码里不得出现 `PiCodeModeChip` |
| `src/renderer/src/components/workspace/WorkGraphInspector.tsx` | 194 | **零引用**（grep 全仓 0 命中） |
| `src/renderer/src/components/blueprint/BlueprintLibrary.tsx` | 162 | **零引用** |
| `src/shared/runtime-audit-inspector.ts` | 82 | 只被上面那个死组件 + `scripts/project-domain-test.ts` 引用 |
| `src/shared/usage-reconciliation.ts` | 209 | 只被 `scripts/usage-reconciliation-test.ts` |
| `app/main/src/index.ts`（77）、`app/preload/src/index.ts`（11）、`app/renderer/src/{App,main,styles}`（142） | 230 | **早期 monorepo 骨架**：`electron.vite.config.ts:86-88` 的入口全部指向 `src/preload|renderer`；根 `tsconfig` 与 `package.json` 不引用 `app/main|preload|renderer`；唯一"用途"是让 `shared/src/index.ts` 的 `IPC_CHANNELS` 看起来有人用 |

**P2 · 已验证 · 建议（S/M）**：①删 `app/main|preload|renderer` 与 `shared/src/index.ts` 的 `IPC_CHANNELS`（230 行 + 8 行，零风险，`S`）；②4 个零引用组件先移入 `archive/` 或直接删（1,200 行，`S`），它们已被"不得挂载"断言替代，留着只会误导新人；③`project-memory-extension.ts` 必须先确认"项目记忆是否已由 MemoryService 统一注入"（证据：`grep -rn createProjectMemoryExtension src` 只命中测试，且 `AgentService.ts` 侧走 `MemoryContextProjection`/`projectMemoryContext` 通路；见 §2.2 环 5），确认后删测试 + 删文件（`M`）；④给 `pnpm -s test:all` 增加一条"不可达模块白名单"断言，把可达性检查变成门禁（复用 `/tmp/arch` 的遍历，约 40 行，`S`）。

### 4.5 测试脚本层面的卫生（已验证）

- `scripts/` 495 个文件（328 个 `.ts`），`package.json` 有 368 个脚本 / 321 个 `test:*`。
- 321 个 `test:*` 全部指向存在的文件（仅 2 个是 `pnpm run test:a && …` 的聚合名，非路径，属正常）。
- 但 **462 个脚本文件中 122 个不被任何 `test:*` 引用**；其中大部分是构建/诊断工具（`build-*.mjs`、`*-probe.mjs`、`desktop-cdp-client.cjs`），属合理；**少数是纯垃圾**：`scripts/_tmp_actual_wavealstra_execution_probe.ts`（名字带 `_tmp`，且 import 的 `../src/main/execution/ExecutionControlPlane` 已不存在——仍在 `typecheck-baseline.json` 里占一条 TS2307）、`scripts/subagent-worker-launcher-099-smoke.ts`（§4.2）。
- **建议（S）**：删 `_tmp_*`；在 `test:all` 里加一条"脚本名前缀白名单"检查（或至少 CI 里 grep 禁止 `_tmp_`、`-099-` 这类过期命名）。

---

## 5. 错误处理与可观测性

### 5.1 空 catch：374 处（占全部 catch 的 21.2%），其中约 1/4 吞掉的是有后果的操作（已验证）

方法：Babel AST 精确统计（`/tmp/arch/err3.mjs`），区分"真空块"与"带日志"，不数注释。

| 分类 | 数量 | 说明 |
|---|---|---|
| `catch` 总数 | **1,766** | `src/**`（不含 `.d.ts`） |
| **完全空块**（`catch {}` / `catch (e) {}` 无语句） | **374** | 分布 125 个文件；其中 **310 处带解释性注释**（如 `/* ignore */`） |
| 仅日志（吞掉不抛） | **205** | 有 `console.*` 但无 `throw` |
| 有 `throw` | 288（+13 同时有日志） | 正常传播 |
| 其他（转换/兜底返回） | 886 | 多为 fallback |
| Promise `.catch(() => {})` 真空箭头 | **13** | 未处理 rejection 的静默点 |

空 catch 最多的文件（P3，数量本身可接受，因为多是资源清理）：`src/main/index.ts` 31、`subagent/runtime.ts` 22、`subagent/index.ts` 12、`PromptEnhancementService.ts` 11、`AgentService.ts` 10、`web-access/index.ts` 10、`ExternalAgentRuntime.ts` 10、`AppSettingsStore.ts` 9。

按"被包裹代码类型"再分类（`/tmp/arch/err2.mjs`，正则判 try 块内容）：cleanup 85、read 50、**db 28**、**persist 7**、ipc-net 1、other 203。**高后果样本（P2，已验证）**：

| 位置 | 吞掉什么 | 判读 |
|---|---|---|
| `src/main/db/AppDatabase.ts:1382-1384` | `DELETE FROM library_chunk_embeddings …` 整条语句 | 注释说"表可能不存在"，但**任何**失败（锁、磁盘满、SQL 错）都被吞 → 注释宣称要防的 orphan 反而静默产生 |
| `src/main/db/AppDatabase.ts:1390-1392` | `DELETE FROM library_chunks_fts` | 同上（FTS 清理失败 → 搜索出现幽灵结果） |
| `src/main/db/AppDatabase.ts:3421-3427` | 事务后 `DELETE FROM work_graph_edges …`（**无注释的 `catch {}`**） | 删 workspace 后工作图留下悬空边，且无日志 |
| `src/main/blueprint/BlueprintService.ts:197,200` | `db.deleteTask(id)` / `db.deleteSpaceTree(rootWorkspaceId)`（回滚路径） | 回滚失败被吞 → "失败的蓝图创建"可能残留半棵树；同函数里 `rmSync` 失败**有** `console.warn`（198-202 行），说明作者知道该记日志，这里是漏 |
| `src/main/artifact/ArtifactRepository.ts:146` | `db.pragma("foreign_keys = ON")` | 若 pragma 静默失败，后续 FK 约束全部失效——这是**静默降级为无约束**，风险最高的一类 |
| `src/main/capabilities/subagent/index.ts:547` | 遍历 `BrowserWindow.getAllWindows()` 期间 | 失败后广播悄悄少发（见下 5.2） |

**建议（M）**：①先修上面 6 处（`S`，每处改成 `catch (e) { log.warn(...) }` 或带上下文的 rethrow）；②加门禁：`test:architecture` 里断言"`db.prepare(...).run(...)` 包裹的 try 不得为空 catch"（AST 30 行，`S`）；③其余 368 处保留，但推动 `sandbox` 语义：只允许"清理/只读探测"类空 catch，禁止"写路径"空 catch（规则写进 AGENTS.md，无成本）。

### 5.2 错误被吞掉的代表性链路（已验证，P2）

- **子代理事件广播**：`src/main/capabilities/subagent/index.ts:540-549` 在 try 里遍历窗口 `w.webContents.send("subagent:event", { ts: Date.now() })`，catch 为空。窗口已销毁时正常，但**任何**发送失败（含序列化错误）都会让 UI 看不到子代理进度，且日志里零痕迹——排障只能靠猜。
- **提示词增强**：`src/main/agent/PromptEnhancementService.ts` 11 处空 catch（L156-270），失败后 prompt 静默退回未增强版本；用户只看到"模型效果不对"，看不到原因。
- **设置持久化**：`src/main/AppSettingsStore.ts` 9 处空/注释 catch（L305/310/448 备份轮换、L513 磁盘容量 fallback）。备份轮换失败是**有意**降级（注释写明），但 L513 的 `statfsSync` 失败静默返回 0 字节，会让"磁盘不足"保护失效。
- **全局兜底缺失（P2，已验证）**：主进程**没有** `process.on('uncaughtException')` / `('unhandledRejection')`——`grep -rn "process\.on(" src/main` 只有 2 处（`subagent/index.ts:478` 的 `exit`、`GadgetRuntime.ts:19` 的 SIGTERM/SIGINT）。renderer 有 `ErrorBoundary`（`src/renderer/src/components/ErrorBoundary.tsx`）且在 `main.tsx` 挂载，主进程侧对"异步 throw 导致进程带病运行"没有任何可观测性。**建议（S）**：`src/main/index.ts` 里注册两个 handler，写结构化日志 + 上报一次 telemetry/崩溃目录。

### 5.3 日志是否结构化：**否，且没有日志层**（已验证，P2）

- 没有日志模块：`ls src/main/*log* src/main/runtime/*log*` 无命中，`grep "createLogger\|class Logger"` 无命中，`electron-log` 未安装 —— 全仓就是 `console.*`：
  - `src/main` **297** 条（`AgentService.ts` 44、`index.ts` 42、`LibraryService.ts` 19、`AppDatabase.ts` 14 …）；
  - `src/renderer` **66** 条。
- 风格是"手写前缀"：`console.warn("[AgentService] attachment image missing:", filePath)`（`AgentService.ts:331`）、`console.warn("[AgentService] load attachment image failed", filePath, err)`（343 行）。前缀本身不统一（`[AgentService]`、`[Durable]`、`[BlueprintService]`、`[ipc-inventory]` 混用），**无级别、无时间戳、无 taskId/sessionId 关联、无落盘**（`grep appendFileSync` + `log` 无命中）。
- 后果：用户报障时无法按 task/session 过滤出"这个任务的完整时间线"；Electron 生产构建的 stdout 也不保证可回收。**建议（M）**：引入 50 行的 `main/log.ts`（level + scope + JSON line + 可选落盘 `~/.mybuddy/logs/app-YYYYMMDD.log`），只在**新增代码 + 上述 6 处高风险 catch** 里用；不必全量替换 297 处 `console.*`（收益/风险比不划算），但要把 `console.error` 的调用点纳入"必须带 scope + 结构化字段"的约定写进 AGENTS.md。

---

## 6. 优先级与建议汇总

### 6.1 风险排序（本轮实测）

| 排名 | 问题 | 严重度 | 状态 | 成本 |
|---|---|---|---|---|
| 1 | 分层/循环/契约三类高风险约束**零机械保护**；`app/remote→src/renderer` 已破 1 条、5 个依赖环存活、preload 契约三处手写 | **P1** | 已验证 | S–M |
| 2 | `registerIpc`（1,994 行）+ `AgentService`（5,981 行/+6,078−97 只增不减）+ `appStore`（6,562 行）无拆分护栏与规模上限 | **P1** | 已验证 | M（IPC 拆分）～L（AgentService 拆分） |
| 3 | `scripts/` 类型检查半盲（31 条别名 TS2307 噪音掩盖真实漂移；209 条基线） | **P2** | 已验证 | S |
| 4 | 生成物写进源码树 + 全局 `vendor/` gitignore（子代理 worker 逻辑双份） | **P2** | 已验证 | S |
| 5 | 6 处高后果空 catch（DB 删除/pragma/回滚） + 主进程无 uncaught 兜底 | **P2** | 已验证 | S |
| 6 | 10 个不可达模块（2,740 行）+ 死 monorepo 骨架（230 行） | **P2** | 已验证 | S–M |
| 7 | 无结构化日志（297+66 处 console，无 scope/level/落盘） | **P2** | 已验证 | M（增量） |
| 8 | remote DTO 与桌面 DTO 字段级克隆（0.88–1.00），远程用例被 `EXCLUDE_PATTERNS` 整组排除 | **P2** | 已验证 | M |
| 9 | `any` 266 处、`@ts-ignore` 0 | **P3** | 已验证 | S（`appStore` 10 处先收） |
| 10 | TODO/FIXME 0 条可修项 | **P3** | 已验证 | — |
| 11 | 未使用依赖 0/22 | — | 已验证（非问题） | — |

### 6.2 建议的执行顺序（若只做 5 件事）

1. **半天（S）：把"结构"变成门禁**——新增 `scripts/architecture-graph-test.ts`（复用本轮 `/tmp/arch/analyze.mjs` 的 Babel+Tarjan，约 150 行）：断言①`renderer→main`、`preload→renderer`、`app/remote→src/{main,renderer}` 均为 0；②**值导入**子图 SCC = 0；③存在最大行数上限（如 800 行，白名单当前 8 个巨型文件，只允许减少）。这三条把 §2 与 §1 的"惯例"变成"保证"，且不引入 ESLint。
2. **半天（S）：修 `tsconfig.scripts.json` 的 `paths`**，让 31 条 TS2307 噪音消失、209 条基线真正可用。
3. **1–2 天（M）：按 `*Ipc` 命名空间把 `registerIpc`（L644-2637）拆成 `src/main/ipc/*.ts`**，`src/main/index.ts` 回到 ~800 行；用现有 `test:ipc-channel-inventory` + `test:all` 兜住回归（通道集合不变 = 安全网，这正是该基线的价值）。
4. **半天（S）：preload 契约一致性断言**（`api` 键集合 == `PreloadApi` 键集合）+ 把 `src/preload` 纳入 `ipc-channel-inventory` 的扫描范围。
5. **半天（S）：删死代码 + 修 6 处高后果空 catch + 加主进程 uncaught 兜底**。

### 6.3 与历史审计的对照

- `artifacts/quality-audit/architecture.md`（2026-10-09，HEAD `3261a43`）的 `0/261` 分层结论：**本轮复现成立**（当前 262 个 renderer 文件，0 条 renderer→main）。该文档"零机械保护"的判断**依然成立**，且本轮新增两条它没覆盖的破口：`app/remote→src/renderer`、5 个依赖环。
- `docs/refactor-plan-verified.md`（10 路复核）关于"不建议全拆 `AgentService`（19–29 人日 / 收益 −243 行）"的结论：**本报告不推翻**。§6.2 只推荐"IPC 拆分 + 结构门禁"，因为 `registerIpc` 是机械可切分、且有 channel 基线做安全网的**唯一高 ROI 目标**。
- 该文档 §5 记录的 IPC 基线口径（453 注册点 / 449 唯一）与今日实测（454 / 450）差 1，属正常增长（4 个 `html-edit` 通道 + magpie 相关），基线未漂移。

---

## 附录 A：关键命令速查（均可重跑）

```bash
# 1) 大文件行数 / KB
find src shared -type f \( -name '*.ts' -o -name '*.tsx' \) -printf '%s %p\n' | sort -rn | head -25 \
  | while read sz p; do printf '%9d B %6d L  %s\n' "$sz" "$(wc -l < "$p")" "$p"; done

# 2) 变更放大点（近 50 提交）
git log --name-only --format= -50 | grep -v '^$' | sort | uniq -c | sort -rn | head -25
# 每次 diffstat
for h in $(git log --format=%h -20 -- src/main/agent/AgentService.ts | head -8); do \
  echo "--- $h"; git show --numstat --format= $h -- src/main/agent/AgentService.ts | awk 'NF==3{print " +"$1"/-"$2}'; done

# 3) 依赖图 / 环 / 跨层（Babel AST + Tarjan）
cd /tmp/arch && node analyze.mjs

# 4) 空 catch / any 精确统计
cd /tmp/arch && node err3.mjs && node err2.mjs

# 5) IPC 基线（只读模式，不写文件）
node scripts/ipc-channel-inventory.mjs
grep -c 'ipcMain\.\(handle\|on\)' src/main/index.ts

# 6) preload 契约一致性
cd /tmp/arch && node api.mjs

# 7) 死代码可达性
cd /tmp/arch && node -e "…见 §4.4 方法说明…"   # report.json + edges.json 已含全部边

# 8) 依赖使用率
node -e "…见 §4.4：（dependencies 22 全用；devDeps 9 个非源码引用均有解释）…"
```

## 附录 B：本轮未验证 / 需后续确认

1. **`project-memory-extension.ts` 是否真的已废弃**（推测：生产路径已由 `MemoryContextProjection` + Pi request hook 取代；需产品负责人确认后再删，避免删掉"未接线但打算接线"的功能）。
2. **环 2–5 是否为"故意用 `import type` 打破"**（推测：是；但无注释说明，需作者确认，否则应改写为显式接口抽取）。
3. **`app/remote` 的 4,849 行是否在 CI 中被类型检查**：`app/remote/package.json` 有 `typecheck: tsc --noEmit`，但根 `pnpm typecheck` **不调用**它（`grep -n app/remote package.json` 只在 `files` 白名单命中）；`scripts/remote-*.ts` 通过 `typecheck-scripts`（`strict:false` + 棘轮）间接覆盖了一部分。**建议**把 `app/remote` 的 typecheck 接进根 `typecheck`（推测成本 S，但需先跑一次看存量错误）。
4. **CI 是否真的在跑**：`verify.yml` 存在且挂 `push: main` + `pull_request`，但本轮无法确认 GitHub 上最近一次运行状态（只读仓库、不联网）。
5. `grep -c 'ipcMain.handle'` 口径与 `ipc-channel-inventory` 的 454 存在 ±1 差异（`html-edit` 的 `on` 与 `handle` 混用、猴补丁 `subagent-ipc-host.ts:125`），对外引用时以基线脚本输出为准。
