# T3 — dbSync 网关 + appStore 尾部清理：执行前最终复核

- 仓库：`C:\Users\servi\Documents\GitHub\wavealstra_harness`
- 模式：**只读核查**（唯一写入 = 本报告）
- 基线提交：`9f90f4e fix(remote): collapse flicker + model sheet overflow on Android`
- 复核时间：2026-10-12
- 被复核对象：规划 **Phase 1** ——
  > 建 `src/renderer/src/services/dbSync.ts` 网关，把 `appStore.ts` 内 **126 处** `window.api?.db.*` 直写收进网关，**行数下降 400 到 600 行**；另有小清理：`appStore` 尾部混出的 `relativeTime` 与 `sizeLabel` 移到 `@/lib/format`。
- 标记约定：**【实测】**= 本次会话用工具直接读到的事实（附 `文件:行号` 与原样引用）；**【推断】**= 基于实测的推理判断
- `refutes_parent` 判定口径：按用户给出的三条唯一判据 ——（a）`dbSync` 已存在；（b）`relativeTime`/`sizeLabel` 不在 `appStore`；（c）alias stub 假设不成立。**三条判据经实测全部为假 → `refutes_parent=false`**（详见 §6；但规划的两个**量化锚点**已被实测推翻，必须按 §5、§7 修正，否则不要进入执行）

---

## 0. 结论速览

| # | 待验声明 | 实测结果 | 判定 |
|---|---|---|---|
| 1 | 仓库已存在 `src/renderer/src/services/dbSync.ts` 或同类 renderer 持久化网关 | `src/renderer/src/services/` **目录不存在**；全仓 `dbSync` 0 命中（唯一命中是无关的 `scripts/gateway-durable-test.ts:91` 局部变量 `db`） | **声明为"待建"** —— 与规划一致，非既有资产 |
| 2 | `appStore.ts` 内 **126 处** `window.api?.db.*` 直写 | **实际 48 处 / 48 行**（四类形态，见 §2）。**126 恰好等于 `appStore.ts` 中 `window.api`（全命名空间）的出现次数 = 含 `window.api` 的行数** | ❌ **数字错误（差 2.6 倍）**：把"所有 `window.api` 调用"当成了"db 调用" |
| 3 | `relativeTime` 与 `sizeLabel` 在 `appStore` **文件尾部** | **在**：`appStore.ts:6337`（`relativeTime`）、`:6351`（`sizeLabel`），文件共 **6377 行**；但**两者之间夹着 `clockTime`（:6346），且文件最后 9 行（:6369–6377）是 `guessCanvasArtifactName`** —— 严格说"尾部"应表述为"末尾 41 行内"，不是文件结尾 | ✅ 存在（措辞需收紧，无功能影响） |
| 3b | `@/lib/format` 是否存在 | `src/renderer/src/lib/format.ts` **不存在**（`lib/` 下无任何 `format*` 文件） | 需**新建**；移动会触及 4 个组件 import + 2 份 stub/mock 副本（见 §3.3） |
| 4 | 是否存在依赖 `@/store/appStore` 的 esbuild alias stub（`consult-card-store-stub.ts` 等） | **存在，且是 6 个 alias 站点 / 5 个 stub-mock 文件**：`package.json:79/85/86/93` + `scripts/build-wave5a-preview.mjs:44` + `scripts/build-pdf-runtime-preview.mjs:81`；`scripts/consult-card-store-stub.ts` 确实存在（19 行） | ✅ 机制前提**成立**（红线有真实依据），但字面红线被规划自身的小清理违反（见 §4.3） |
| 5 | 收进网关能降 **400–600 行** | 48 个调用语句**合计只占 176 物理行**；把 `window.api?.db?.` 改写成 `dbSync.` 是字符级替换，**行数变化 = 0**；理论上限（网关吞掉整条语句含 payload）= 176−48 = **128 行**，且网关文件自身要新增约 150–300 行 | ❌ **不合理**：400 行已超过"删掉 appStore 里所有含 `window.api` 的行（126 行）"这一不可能上界；合理区间见 §5 |

**一句话**：`dbSync` 确实待建、两个函数确实在 `appStore`、alias stub 确实存在 → 三条 refute 判据全部为假；但规划的两个量化锚点**双双实测证伪**（126→48；400–600 行→0–128 行），且"只有 appStore 用 db"这一隐含前提也不成立（组件里还有 59 处直写）。

---

## 1. 是否已存在 dbSync / 同类持久化网关

### 1.1 `services/` 目录不存在【实测】

```
glob  src/renderer/src/services/**/*        → No files found
Test-Path src/renderer/src/services          → False
src/renderer/src/ 顶层子目录：components, features, hooks, lib, mock, store, styles, types, utils
```

`src/renderer/src/store/` 只有 3 个文件：

```
src\renderer\src\store\appStore.ts             259363 B / 6377 行
src\renderer\src\store\btwStore.ts              18588 B
src\renderer\src\store\projectConfigRailStore.ts 4255 B
```

### 1.2 全仓无 `dbSync` / 无 renderer db 网关【实测】

```
grep  dbSync|db-sync|dbGateway|persistenceGateway  (*.ts)  → 1 命中，且无关：
  scripts\gateway-durable-test.ts:91: }finally{await gateway.stop();await durable.close();db.close();}
```

- renderer 侧**唯一**的 db 出口是 preload 暴露的 `window.api.db`：类型定义在 `src/preload/index.d.ts:496-566`，**61 个成员**（57 个操作 + 4 个事件订阅 `onProjectTaskChanged` / `onProjectAttentionChanged` / `onProjectEventsChanged` / `onMemoryChanged`）。
- `src/main/db/` 是主进程 SQLite 层；`src/main/gateway/` 是外部消息通道网关（`window.api.gateway`），**与 renderer 持久化无关**。

> 【推断】规划把 `appStore` 当作"唯一 db 直写点"，因此建一个 renderer 网关是合理的；但见 §2.4 —— **组件里另有 59 处 `window.api?.db?.` 直写**，网关不会自动成为唯一收口点，规划的"收进网关"范围描述不完整。

---

## 2. `appStore.ts` 中 db 直写调用点的精确计数

### 2.1 四类形态与精确数字【实测】

计数方法：对 `appStore.ts`（6377 行，LF 行尾，无 CRLF）逐行正则匹配并逐条列出命中行号。

| 类别 | 形态 | 出现次数 | 命中行号 |
|---|---|---|---|
| A | `window.api?.db?.<M>(...)` | **40** | 771, 889, 1499, 1531, 1929, 2174, 2964, 3300, **3332**, **3378**, **3388**, 3414, 3429, 3644, 4220, 4221, 4235, 4236, 4373, 4387, 4400, 4522, 4568, 4610, 4656, 4675, 5371, 5398, 5404, 5414, 5420, 5423, 5448, 5454, 5470, 5489, 5512, 5561, 5627, 5671 |
| B | `(window.api as any)?.db?.<M>(...)`（any 强转） | **2** | 5823, 6045 |
| C | `(window as any)?.api?.db?.<M>(...)`（`window` 强转） | **1** | 5642 |
| D | 局部别名 `api.db?.<M>(...)`，`api` 来自 `const api = window.api;` | **5** | 2340, 2341, 2342, 2343（绑定 `const api = window.api;` @ `:2062`，所在成员 `initRuntime:` @ `:2061`）；3807（绑定 `const api = window.api;` @ `:3677`） |
| — | **合计** | **48 处 / 48 个不同行**（每行恰好 1 次） | |

**A 类中的"函数引用形式"（3 处，原样引用）【实测】**：

```ts
3332:     const api = window.api?.db?.purgeArchivedContent;
3378:     const api = window.api?.db?.listTrashedTasks;
3388:     const api = window.api?.db?.restoreTrashedTask;
```

**B / C 类原样引用【实测】**：

```ts
5823:       const res: any = await (window.api as any)?.db?.moveSpace?.({ spaceId, targetParentId, targetIndex });
6045:       const res: any = await (window.api as any)?.db?.moveTaskInWorkspaceTree?.({ taskId, targetSpaceId, targetIndex });
5642:     const hasMoveApi = typeof (window as any)?.api?.db?.moveTaskInWorkspaceTree === "function";
```

**D 类原样引用【实测】**（`:2062` 绑定，`:2338-2343` 使用）：

```ts
2062:     const api = window.api;
...
2338:         const [spaces, taskRows, projects, soul, models, skillRows, marketRows, appSettings, expertRows, marketExpertRows, connectorRows] =
2339:           await Promise.all([
2340:             api.db?.listSpaces() ?? Promise.resolve([]),
2341:             api.db?.listTasks() ?? Promise.resolve([]),
2342:             api.db?.listProjects?.() ?? Promise.resolve([]),
2343:             api.db?.getSoul() ?? Promise.resolve(null),
```

```ts
3677:     const api = window.api;
...
3807:         const rows = await api.db?.listTasks?.();
```

**排除的伪形态【实测】**：`window["api"]` = 0；`api.db.`（无 `?.`）= 0；`window.api.db.`（无 `?.`）= 0；`const { ... } = window.api` 解构 = 0。故 48 是**穷尽**计数。

### 2.2 被调方法分布【实测】

`upsertTask` 17、`listTasks` 6、`upsertSpace` 4、`listProjects` 2、`listSpaces` 2、`archiveTask` 2、`archiveSpace` 2、`moveSpace` 2、`deleteSpace` 1、`deleteTask` 1、`deleteTaskWriteGrant` 1、`getSoul` 1、`listTaskWriteGrants` 1、`listTrashedTasks` 1、`moveTaskInWorkspaceTree` 1、`purgeArchivedContent` 1、`renameSpace` 1、`restoreTrashedTask` 1、`updateSoul` 1 → 合计 48，覆盖 preload `db` 61 个成员中的 **19 个**。

### 2.3 "126"从哪来【实测】

```
appStore.ts 中 'window.api' 出现次数              = 126
appStore.ts 中含 'window.api' 的行数              = 126
appStore.ts 中含 'db?.|db.' 的行数（含 db 形态）  = 48
```

> 【推断】**规划的 126 = `appStore.ts` 里 `window.api` 的全部出现次数**（跨 `agent`/`artifact`/`browser`/`db`/`mcp`/`conversationBranch`/`workgraph`… 所有命名空间），被误标为"`window.api?.db.*` 直写"。这是一个可复现的口径混淆，不是"规划写错了小数"。
>
> 交叉印证：兄弟报告 `out/plan-review/T7-freeze-prereqs.md:18` 的 "40/40 全在 appStore" 只覆盖了 A 类 40 处（`window.api?.db?.` 字面量），漏掉了 B/C/D 类 8 处 —— 两份报告合起来说明：**db 直写的完整口径是 48 处**，且**并非"只有 appStore 用 db"**。

### 2.4 组件层还有 59 处 db 直写【实测】

`src/renderer/src/components/` 下 **25 个文件、59 处** `window.api?.db?.`（与 `appStore.ts` 的 48 处**不重叠**）：

| 文件 | 处数 | 文件 | 处数 |
|---|---|---|---|
| `pages/project/ProjectActivity.tsx` | 14 | `pages/project/ProjectPlan.tsx` | 4 |
| `pages/project/ProjectSettings.tsx` | 4 | `pages/project/ProjectMemory.tsx` | 4 |
| `pages/project/ProjectAssets.tsx` | 5 | `pages/project/ProjectList.tsx` | 2 |
| `pages/project/ProjectWorkspace.tsx` | 3 | `pages/project/ProjectStatusCard.tsx` | 4 |
| `pages/project/ProjectCard.tsx` | 3 | `pages/NewProjectModal.tsx` | 2 |
| `chat/*`（`ChatProjectCrumb`/`ProjectPicker`/`TaskRecoveryNotice`） | 4 | `settings/*`（`MemoryKernelExplorer`/`MemorySkillPanel`） | 3 |
| `workspace/*`（`WorkspaceDetail`/`WorkspaceMemorySection`/`WorkspaceSharedContextSection`） | 3 | 其余 `pages/project/*`（`ProjectBrief`/`ProjectCapabilities`/`ProjectCapabilityDetail`/`ProjectExecutionMaterials`/`ProjectInstructionsDetail`/`ProjectMaterials`/`ProjectStatusCard` 等） | 12 |

代表性原样引用【实测】：

```ts
src\renderer\src\components\pages\project\ProjectActivity.tsx:64: setPosts((await window.api?.db?.listProjectPosts?.(project.id)) ?? []);
src\renderer\src\components\pages\NewProjectModal.tsx:279:       const result = await window.api?.db?.createProject?.(plan.request);
src\renderer\src\components\chat\TaskRecoveryNotice.tsx:15:     const request = window.api?.db?.listExecutionFailures?.(taskId);
src\renderer\src\components\workspace\WorkspaceDetail.tsx:64:     const unsubscribe = window.api?.db?.onMemoryChanged?.(() => setMemoryVersion((version) => version + 1));
```

> 【推断】因此"把 db 调用收进网关"若只做 `appStore`，只是把 48/107 的直写换了个名字；要让网关成为唯一收口点，范围必须扩到 25 个组件文件（否则网关形同虚设）。这与"行数下降"目标方向相反 —— 组件侧迁移会让**组件文件行数**增加。

---

## 3. `relativeTime` / `sizeLabel` 的位置、原文与迁移影响

### 3.1 确实在 `appStore.ts`（但不在文件最末）【实测】

`appStore.ts:6337-6367`（原样引用）：

```ts
6337: export function relativeTime(ts: number): string {
6338:   const diff = Date.now() - ts;
6339:   const MIN = 60_000;
6340:   if (diff < MIN) return "刚刚";
6341:   if (diff < 60 * MIN) return `${Math.floor(diff / MIN)}分钟前`;
6342:   if (diff < 24 * 60 * MIN) return `${Math.floor(diff / (60 * MIN))}小时前`;
6343:   return `${Math.floor(diff / (24 * 60 * MIN))}天前`;
6344: }
6345: 
6346: export function clockTime(ts: number): string {
6347:   const d = new Date(ts);
6348:   return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
6349: }
6350: 
6351: export function sizeLabel(content: string): string {
6352:   // 未打开的 workspace-file 产物 content 为空（内容在 renderCache）；勿显示误导性的「0 B」
6353:   if (!content) return "—";
6354:   // data URI：按 base64 有效载荷估算真实字节，避免把整段 URI 当 UTF-8 文本量
6355:   const dataUri = /^data:[^;]*;base64,([\s\S]+)$/i.exec(content);
6356:   if (dataUri) {
6357:     const b64 = dataUri[1]!.replace(/\s+/g, "");
6358:     const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
6359:     const bytes = Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
6360:     if (bytes < 1024) return `${bytes} B`;
6361:     if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
6362:     return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
6363:   }
6364:   const bytes = new TextEncoder().encode(content).length;
6365:   if (bytes < 1024) return `${bytes} B`;
6366:   return `${(bytes / 1024).toFixed(1)} KB`;
6367: }
```

文件真正的结尾是【实测】：

```ts
6369: /** 从 SVG/HTML 源码猜测产物文件名 */
6370: function guessCanvasArtifactName(content: string, kind: "html" | "svg"): string {
...
6377: }
```

> 结论：**"尾部混出" 成立（末尾 41 行内），但 `relativeTime`/`sizeLabel` 与文件末行之间还夹着 `clockTime`（:6346，被 `MessageItem.tsx:4` 导入）和 `guessCanvasArtifactName`（:6369–6377）**。规划若只搬 `relativeTime`+`sizeLabel`，会把 `clockTime` 单独留在 `appStore`，形成"时间格式化函数一半在 `lib/format`、一半在 `store`"的分裂 —— 需一并决定 `clockTime` 的去留。

### 3.2 `@/lib/format` 不存在【实测】

```
glob src/renderer/src/lib/format*   → No files found
Test-Path src/renderer/src/lib/format.ts → False
lib/ 下 59 个 .ts 文件，最近邻是 projectWorkspace.ts / generationSpeed.ts / messageSizeEstimate.ts
```

既有可参考先例：`src/renderer/src/lib/projectWorkspace.ts` 已导出 `formatRelativeTime` 与 `formatAssetBytes`（见 `ProjectActivity.tsx:9` 的 `import { formatAssetBytes, formatRelativeTime } from "@/lib/projectWorkspace";`）；`WorkspaceDetail.tsx:20` 又自造了一份 `relativeTimeLabel`。

> 【推断】仓内**已有 3 份相对时间格式化实现**（`appStore.relativeTime`、`lib/projectWorkspace.formatRelativeTime`、`WorkspaceDetail.relativeTimeLabel`）。新建 `@/lib/format` 是第 4 个落点 —— 若目标是"去重"，正确做法是把它们**合并**到一个模块，而不是新增一个只装 2 个函数的文件。这是规划未提及的额外收益/风险点。

### 3.3 迁移会动到谁【实测】

**必须是组件 import（4 处）**——这正是待验证"红线"的冲突点：

```ts
src\renderer\src\components\pages\FilesPage.tsx:3:        import { relativeTime, sizeLabel, useAppStore } from "@/store/appStore";
src\renderer\src\components\pages\library\LibraryPage.tsx:13: import { relativeTime, useAppStore } from "@/store/appStore";
src\renderer\src\components\common\FileBadge.tsx:3:      import { sizeLabel, useAppStore } from "@/store/appStore";
src\renderer\src\components\sidebar\TaskItem.tsx:5:      import { relativeTime, useAppStore } from "@/store/appStore";
```

调用点（无需改动逻辑，仅 import 源变化）：`FilesPage.tsx:224,225`、`LibraryPage.tsx:821`、`FileBadge.tsx:225`、`TaskItem.tsx:588,669,672`。

**stub / mock 里已有 2 份 `sizeLabel` 影子实现（迁移后必须复核）【实测】**：

```ts
// scripts/project-activity-store-stub.ts（全文 4 行）
1: export const state = { soul: { alias: "我" }, artifacts: [] as any[], activeTaskId: null, tasks: [] as any[], spaces: [] as any[] };
2: export const useAppStore = Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state, setState: () => {} });
3: export const sizeLabel = (bytes: number): string => `${bytes} B`;
4: export const selectActiveTaskArtifacts = (): any[] => [];
```

```ts
// scripts/wave5a-store-mock.ts:42-46
42: export function sizeLabel(content: string): string {
43:   if (content.length < 1024) return `${content.length} B`;
44:   if (content.length < 1024 * 1024) return `${(content.length / 1024).toFixed(1)} KB`;
45:   return `${(content.length / 1024 / 1024).toFixed(1)} MB`;
46: }
```

**为什么 stub 里会有 `sizeLabel`？链路已查明【实测】**：

```
ProjectActivity.tsx:2  import Markdown from "@/components/common/Markdown";
Markdown.tsx:19        import { LocalFileChip } from "./FileBadge";
FileBadge.tsx:3        import { sizeLabel, useAppStore } from "@/store/appStore";
FileBadge.tsx:221-225  export function ArtifactChip(...) { ... const size = sizeLabel(artifact.content); ... }
→ test:project-activity-ui 用 --alias:@/store/appStore=project-activity-store-stub.ts，
  整张图里 FileBadge 的 sizeLabel 只能由 stub 提供，所以 stub 必须硬塞一个（且签名写成 (bytes: number)，与真实 (content: string) 不符）。
```

> 【推断】若把 `sizeLabel` 移到 `@/lib/format`：
> 1. `project-activity-store-stub.ts:3` 与 `wave5a-store-mock.ts:42-46` 变成**死代码**（不报错，但会误导后来者）；
> 2. 更重要：`test:project-activity-ui` 与 `wave5a/pdf-runtime` 预览图里，`FileBadge` 将改为加载**真实** `sizeLabel`（两个 esbuild 构建都带 `--alias:@=./src/renderer/src` / `alias["@"]`，能解析到真实文件），**渲染文本可能变化**（真实实现对空 content 返回 `—`，stub 返回 `<content> B`）。这属于行为差异，必须跑一遍 golden/UI 用例确认，不能默认"纯搬家无影响"。
> 3. 若某个 stub 图里 `FileBadge` 的 `ArtifactChip` 真被渲染，**现状就会输出垃圾**（例如 `<svg …> B`）——移动后反而修好；说明该路径当前未被断言覆盖。

---

## 4. 关键红线核实：`@/store/appStore` esbuild alias stub

### 4.1 `electron.vite.config.ts` 里没有该 alias【实测】

`electron.vite.config.ts:96-114`（renderer 段，原样引用）：

```ts
  renderer: {
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
```

> 即：**生产构建不存在 `@/store/appStore` 替换**。`@` 只是前缀别名。红色线只存在于测试/预览构建。

### 4.2 但测试与预览构建里**确实存在**，共 6 个 alias 站点【实测】

`package.json`（原样引用，节选）：

```
79: "test:project-create-folder-ui": "esbuild scripts/project-create-folder-ui-fixture.tsx ... --alias:@=./src/renderer/src --alias:@shared=./src/shared --alias:@/store/appStore=./scripts/project-create-folder-store-stub.ts ... && electron scripts/project-create-folder-ui-test.cjs",
85: "test:project-materials-ui": "esbuild scripts/project-materials-ui-fixture.tsx ... --alias:@/store/appStore=./scripts/project-materials-store-stub.ts ... && electron scripts/project-materials-ui-test.cjs",
86: "test:project-activity-ui": "esbuild scripts/project-activity-ui-fixture.tsx ... --alias:@/store/appStore=./scripts/project-activity-store-stub.ts ... && electron scripts/project-activity-ui-test.cjs",
93: "test:consult-card-ui": "esbuild scripts/consult-card-ui-fixture.tsx ... --alias:@/store/appStore=./scripts/consult-card-store-stub.ts ... && electron scripts/consult-card-ui-test.cjs",
```

`scripts/build-wave5a-preview.mjs:41-47`（原样引用）：

```js
  alias: {
    "@shared": join(ROOT, "src", "shared"),
    "@": join(ROOT, "src", "renderer", "src"),
    "@/store/appStore": join(ROOT, "scripts", "wave5a-store-mock.ts"),
    "@/lib/monacoWorkerEntry?worker&inline": join(ROOT, "scripts", "wave5a-worker-stub.ts"),
    "@/lib/pdfWorkerEntry?worker&inline": join(ROOT, "scripts", "wave5a-worker-stub.ts"),
  },
```

`scripts/build-pdf-runtime-preview.mjs:78-85`：同样 `"@/store/appStore": join(ROOT, "scripts", "wave5a-store-mock.ts")`。

汇总：

| stub / mock 文件 | 被哪些站点使用 | 导出面 |
|---|---|---|
| `scripts/consult-card-store-stub.ts`（19 行，**确实存在**） | `test:consult-card-ui`（package.json:93） | `state`、`appendCalls`、`useAppStore` |
| `scripts/project-materials-store-stub.ts` | `test:project-materials-ui`（:85） | `state`、`useAppStore` |
| `scripts/project-activity-store-stub.ts` | `test:project-activity-ui`（:86） | `state`、`useAppStore`、`sizeLabel`、`selectActiveTaskArtifacts` |
| `scripts/project-create-folder-store-stub.ts` | `test:project-create-folder-ui`（:79） | `state`、`useAppStore`、`calls` |
| `scripts/wave5a-store-mock.ts`（46 行） | `build-wave5a-preview.mjs:44`、`build-pdf-runtime-preview.mjs:81` | `useAppStore`、`selectActiveTaskArtifacts`、`useActiveTaskArtifacts`、`sizeLabel` |
| `scripts/build-wave5-real-open.mjs`（第 4 行注释） | **明确"不 alias appStore"**（真实 store + 真实 ArtifactPanel） | — |

`scripts/consult-card-store-stub.ts` 全文【实测】：

```ts
1: /** Minimal store surface for MultiModelConsultCard: only what the card reads/writes. */
...
16: export const useAppStore = Object.assign(
17:   (selector: (value: typeof api) => unknown) => selector(api),
18:   { getState: () => api },
19: );
```

### 4.3 红线判定

**机制前提成立【实测】**：`@/store/appStore` **只在测试/预览构建里被替换**（6 个站点、5 个 stub/mock 文件），而 `@` 始终指向真实 `src/renderer/src`。所以：

- **对的前提**：新子模块（如 `@/services/dbSync`）不会被任何 stub 拦截；被 stub 图引入的真实模块会**真的被打进 bundle**。测试能不能过，取决于该模块是否有"import 期副作用 / 依赖被 mock 掉的符号"。
- **被规划自己违反的地方**：规划的小清理要求 **`FileBadge` / `FilesPage` / `LibraryPage` / `TaskItem` 四个组件 import 新子文件 `@/lib/format`** —— 这与"组件绝不 import 新子文件"**字面冲突**。
- **实际风险等级**：`@/lib/format` 是纯函数模块（无 `window`、无 IPC、无 store 依赖），`@` alias 在所有 6 个站点都可解析 → **不会炸构建**；真实风险是 §3.3 的**渲染文本漂移**（stub 影子实现被真实实现替换），以及 2 份 stub 导出变成死代码。
- **若网关是"组件可 import"的**：`@/services/dbSync` 里若出现**模块顶层** `window.api` 访问或 store 依赖，则被 stub 图引入时会引入真实行为 → 那时红线就变成硬约束。因此**红线应精确表述为**："组件只允许 import 无副作用纯模块；任何携带 `window.api`/store 副作用的模块只能由 `appStore` 内部 import。"

> 结论：**alias stub 假设成立**（不是"不成立"），故它不构成 `refutes_parent=true` 的条件；但规划需要把红线从"绝不 import 新子文件"改写为上面的**副作用口径**，否则规划内部自相矛盾。

---

## 5. 行数下降估算：400–600 行是否合理

### 5.1 分母与实测基线【实测】

| 量 | 实测值 |
|---|---|
| `appStore.ts` 总行数 | **6377**（LF，无 CRLF；`Get-Content`/`ReadAllLines` 一致） |
| `appStore.ts` 中含 `window.api` 的行数 / 出现次数 | **126 / 126** ← 规划"126 处"的来源 |
| db 直写出现次数 / 行数 | **48 / 48** |
| 48 个 db 调用语句**占据的物理行数**（按括号/花括号配平测得） | **176** |
| 其中单行语句 / 多行语句 | 24 / 24（最大跨度：`3644` 16 行、`1929` 12 行、`2964` 12 行、`5671` 10 行） |
| 待搬走的 `relativeTime`+`sizeLabel` | `:6337-6344`（8 行）+ `:6351-6367`（17 行）+ 连带 2 个空行 ≈ **25–27 行** |

### 5.2 三种设计下的净行数变化【推断，输入为 5.1 实测值】

| 设计 | appStore 侧变化 | 说明 |
|---|---|---|
| **A. 只把调用点改名**（`window.api?.db?.X` → `dbSync.X`） | **0 行** | 48 处全是同一形状的替换，只少 11 个字符/行（共约 −0.5 KB），**行数完全不变**；网关新增 +48 行以上 |
| **B. 网关吞掉整条语句**（payload 构造也进网关） | **−128 行上限**（176 − 48） | 需要网关接收 `Task`/`Space` 实体并从 store 序列化，是**语义重构**（改调用契约），不是"收进网关"；网关自身 ≥ 150–300 行 → **全仓净增** |
| **C. 连带把组件 59 处也迁进网关**（§2.4） | appStore 侧上限 −128；**组件侧合计 +59 行** | 与"降行数"目标背道而驰 |

### 5.3 判定【推断】

- **上界论证（决定性）**：把 `appStore.ts` 中**每一行**含 `window.api` 的行（**126 行**）整行删掉，也只有 126 行 < 400。**400–600 行的目标超过了该文件全部 `window.api` 足迹的 3–5 倍**，因此在不删除业务逻辑/注释的前提下**不可能达成**。
- 与 db 真正相关的行数足迹上界是 **176 行**（48 条语句的物理跨度），仍然是 400 的下限的 44%。
- **合理区间**：
  - 只做"网关收口 + 改名"：**appStore ≈ 0 行**（可忽略的字符级缩短），全仓 **净增**（网关文件）。
  - 做"网关吞 payload"的强设计：**appStore −80 ~ −130 行**，全仓基本持平或净增。
  - 叠加小清理：**再 −25 ~ −27 行**（`relativeTime`+`sizeLabel`；若含 `clockTime` 则 −29）。
  - ⇒ **可辩护的 appStore 下降区间 ≈ 0 ~ 160 行；"400–600 行"应改写成"约 100–150 行（含小清理），且需强设计"或直接放弃行数作为验收指标**。
- 【推断】"降 400–600 行"更像把"126 处 × 平均 3–4 行"心算出来的（126 × 3.2 ≈ 400）；实测平均每处仅 **3.67 行**，且**这 176 行里绝大多数是业务 payload 而非 db 调用本身**，把 payload 搬进网关只是搬家不删码。

---

## 6. `refutes_parent` 判定说明

用户给出的三条唯一判据，逐条实测：

| 判据 | 实测 | 结果 |
|---|---|---|
| (a) 发现 `dbSync` 已存在 | 全仓 0 命中；`src/renderer/src/services/` 目录不存在 | **假** |
| (b) `relativeTime` 与 `sizeLabel` 不在 `appStore` | 在 `appStore.ts:6337` / `:6351` | **假** |
| (c) alias stub 假设不成立 | `@/store/appStore` alias 存在于 6 个站点；`consult-card-store-stub.ts` 存在 | **假** |

⇒ **`refutes_parent = false`**（严格遵守给定判据口径）。

⚠️ 但必须同时上报：**规划的两个量化锚点（"126 处"、"降 400–600 行"）已被实测推翻**，且隐含前提"db 直写只在 appStore"不成立（组件侧另有 59 处）。**按当前措辞直接执行会在第一步就把行数验收做成不可能达成的目标**；这也解释了为什么同批 `T7` 报告会写出"40/40 全在 appStore" —— 两份报告的口径都不完整，正确口径是 **48（appStore）+ 59（组件）= 107 处**。

---

## 7. 执行前必须落地的修正（plan_fixes）

1. **改口径**：把"126 处 `window.api?.db.*`"改为**实测 48 处**（A 40 + B 2 + C 1 + D 5，行号见 §2.1）；并把"126"注记为"`appStore.ts` 中 `window.api` 全命名空间出现次数"，防止再次混用。
2. **改验收指标**：删除"行数下降 400–600 行"，改为可验证的行为指标，例如"`appStore.ts` 中 `window.api?.db?.` 字面量归零（`grep` 断言 = 0）"；若坚持行数，改成"**≤ −160 行**，且不含网关文件自身"。
3. **改范围**：明确网关是否也收编组件侧 59 处（25 文件）。若只做 appStore，需在规划中写明"网关不追求唯一收口点"，否则该阶段目标自相矛盾。
4. **红线改写**：把"组件绝不 import 新子文件"改为**副作用口径**（"组件只 import 无 `window.api`/store 副作用的纯模块；`dbSync` 只由 `appStore` import"），并**显式列出规划自身允许的例外**：`FilesPage.tsx:3`、`LibraryPage.tsx:13`、`FileBadge.tsx:3`、`TaskItem.tsx:5` 改为从 `@/lib/format` 导入。
5. **小清理配套动作**：a) 决定 `clockTime`（`appStore.ts:6346`，被 `MessageItem.tsx:4` 导入）是否一并迁移；b) 处理 `scripts/project-activity-store-stub.ts:3` 与 `scripts/wave5a-store-mock.ts:42-46` 两份 `sizeLabel` 影子实现（删或标注）；c) 跑 `pnpm -s test:project-activity-ui`、`pnpm -s test:all`（含 wave5a/pdf-runtime golden）确认渲染文本未漂移。
6. **验证命令（执行阶段用）**：
   ```bash
   # 归零断言
   grep -c 'window\.api?\.db?\.' src/renderer/src/store/appStore.ts        # 期望 0
   grep -rc 'window\.api?\.db?\.' src/renderer/src/components             # 期望全 0（若含组件范围）
   # 行数
   wc -l src/renderer/src/store/appStore.ts                               # 基线 6377
   # 受影响用例
   pnpm -s test:project-activity-ui && pnpm -s test:consult-card-ui && pnpm -s typecheck
   ```

---

## 8. 结构关系图（实测链路）

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 980 560" width="980" height="560" font-family="Segoe UI, sans-serif">
  <rect x="0" y="0" width="980" height="560" fill="#f7f9fc"/>
  <text x="20" y="30" font-size="18" font-weight="700" fill="#16202c">T3 实测：db 直写分布 · appStore 尾部 3 个函数 · @/store/appStore alias stub（6 站点）</text>

  <!-- appStore -->
  <rect x="20" y="60" width="330" height="300" rx="8" fill="#ffffff" stroke="#2f6fd0" stroke-width="2"/>
  <text x="34" y="84" font-size="15" font-weight="700" fill="#2f6fd0">src/renderer/src/store/appStore.ts（6377 行）</text>
  <rect x="34" y="96" width="302" height="60" rx="6" fill="#eaf2ff" stroke="#2f6fd0"/>
  <text x="44" y="116" font-size="13" fill="#16202c">db 直写 48 处 / 48 行（占 176 物理行）</text>
  <text x="44" y="134" font-size="12" fill="#3a4a5c">A window.api?.db?. 40 · B (as any) 2</text>
  <text x="44" y="150" font-size="12" fill="#3a4a5c">C (window as any) 1 · D 局部别名 api.db?. 5</text>

  <rect x="34" y="166" width="302" height="46" rx="6" fill="#fff7e6" stroke="#d9a441"/>
  <text x="44" y="185" font-size="13" fill="#16202c">window.api 全命名空间 = 126 次 / 126 行</text>
  <text x="44" y="203" font-size="12" fill="#8a5a00">← 规划“126 处”的真实出处（口径混淆）</text>

  <rect x="34" y="222" width="302" height="126" rx="6" fill="#f2fbf5" stroke="#2f9e5a"/>
  <text x="44" y="242" font-size="13" font-weight="700" fill="#1d6b3d">文件尾部（实测行号）</text>
  <text x="44" y="262" font-size="12" fill="#16202c">:6337-6344 relativeTime（8 行）</text>
  <text x="44" y="280" font-size="12" fill="#16202c">:6346-6349 clockTime（被 MessageItem:4 导入）</text>
  <text x="44" y="298" font-size="12" fill="#16202c">:6351-6367 sizeLabel（17 行）</text>
  <text x="44" y="316" font-size="12" fill="#16202c">:6369-6377 guessCanvasArtifactName（真末行 6377）</text>
  <text x="44" y="338" font-size="12" fill="#1d6b3d">搬 2 个函数 ≈ −25~27 行；clockTime 需一并决定</text>

  <!-- components -->
  <rect x="380" y="60" width="300" height="150" rx="8" fill="#ffffff" stroke="#c0392b" stroke-width="2"/>
  <text x="394" y="84" font-size="15" font-weight="700" fill="#c0392b">src/renderer/src/components/（25 文件）</text>
  <text x="394" y="108" font-size="13" fill="#16202c">db 直写 59 处（与 appStore 不重叠）</text>
  <text x="394" y="128" font-size="12" fill="#3a4a5c">ProjectActivity.tsx 14 · ProjectAssets 5</text>
  <text x="394" y="146" font-size="12" fill="#3a4a5c">ProjectMemory 4 · ProjectSettings 4 · 其余 21 文件</text>
  <text x="394" y="170" font-size="12" fill="#8a1f14">⇒ 网关不是自动唯一收口点（48/107）</text>
  <text x="394" y="192" font-size="12" fill="#3a4a5c">FileBadge:3 → sizeLabel（待迁到 @/lib/format）</text>

  <!-- lib/format -->
  <rect x="380" y="228" width="300" height="70" rx="8" fill="#fff0f0" stroke="#c0392b" stroke-dasharray="5 4"/>
  <text x="394" y="250" font-size="14" font-weight="700" fill="#c0392b">@/lib/format.ts —— 不存在（待新建）</text>
  <text x="394" y="270" font-size="12" fill="#3a4a5c">lib/ 下无 format* 文件；已有 3 份相对时间实现</text>
  <text x="394" y="288" font-size="12" fill="#3a4a5c">（appStore · lib/projectWorkspace · WorkspaceDetail）</text>

  <!-- alias stubs -->
  <rect x="710" y="60" width="250" height="240" rx="8" fill="#ffffff" stroke="#7d3fd0" stroke-width="2"/>
  <text x="724" y="84" font-size="15" font-weight="700" fill="#7d3fd0">@/store/appStore alias（6 站点）</text>
  <text x="724" y="106" font-size="12" fill="#16202c">package.json:79 create-folder</text>
  <text x="724" y="124" font-size="12" fill="#16202c">package.json:85 project-materials</text>
  <text x="724" y="142" font-size="12" fill="#16202c">package.json:86 project-activity</text>
  <text x="724" y="160" font-size="12" fill="#16202c">package.json:93 consult-card ★存在</text>
  <text x="724" y="178" font-size="12" fill="#16202c">build-wave5a-preview.mjs:44</text>
  <text x="724" y="196" font-size="12" fill="#16202c">build-pdf-runtime-preview.mjs:81</text>
  <rect x="724" y="208" width="222" height="76" rx="6" fill="#f5edff" stroke="#7d3fd0"/>
  <text x="734" y="228" font-size="12" fill="#16202c">@ 始终 → 真实 src/renderer/src</text>
  <text x="734" y="246" font-size="12" fill="#16202c">⇒ 新子模块不被 stub 拦截</text>
  <text x="734" y="264" font-size="12" fill="#6a1fb0">⇒ 精确红线=“无副作用纯模块”</text>
  <text x="734" y="279" font-size="12" fill="#6a1fb0">不是“绝不 import 新子文件”</text>

  <!-- arrows -->
  <line x1="336" y1="126" x2="380" y2="126" stroke="#c0392b" stroke-width="2" marker-end="url(#a1)"/>
  <line x1="530" y1="210" x2="530" y2="228" stroke="#c0392b" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#a1)"/>
  <line x1="680" y1="262" x2="710" y2="200" stroke="#7d3fd0" stroke-width="2" marker-end="url(#a2)"/>

  <defs>
    <marker id="a1" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#c0392b"/></marker>
    <marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#7d3fd0"/></marker>
  </defs>

  <!-- LOC math -->
  <rect x="20" y="380" width="940" height="160" rx="8" fill="#ffffff" stroke="#2f6fd0"/>
  <text x="34" y="404" font-size="15" font-weight="700" fill="#2f6fd0">行数下降实测推算（基线 appStore = 6377 行）</text>
  <text x="34" y="428" font-size="13" fill="#16202c">① 只改名 window.api?.db?. → dbSync. ：0 行（字符级替换）</text>
  <text x="34" y="450" font-size="13" fill="#16202c">② 网关吞掉整条语句（含 payload）：上界 176 − 48 = 128 行，且网关自身 +150~300 行</text>
  <text x="34" y="472" font-size="13" fill="#16202c">③ 叠加小清理：−25~27 行 ⇒ 可辩护区间 ≈ 0 ~ 160 行</text>
  <text x="34" y="496" font-size="13" font-weight="700" fill="#c0392b">④ 反证：删掉所有含 window.api 的 126 行也只有 126 &lt; 400 ⇒ “降 400–600 行”不可能</text>
  <text x="34" y="522" font-size="12" fill="#3a4a5c">标注：【实测】6377 行 / 48 处 / 126 行 / 176 行跨度 / 6 个 alias 站点；【推断】①②③ 的行数推演与上界论证</text>
</svg>
```

---

## 9. 复现命令（本次核查可逐条重跑）

```powershell
# 1) services 目录 / dbSync 是否存在
Test-Path src/renderer/src/services
Select-String -Path (Get-ChildItem -Recurse -Include *.ts .).FullName -Pattern 'dbSync' | Select-Object -First 5

# 2) 四类 db 直写精确计数（含行号）
$l=[IO.File]::ReadAllLines((Resolve-Path 'src/renderer/src/store/appStore.ts'))
$p=@{A='window\.api\?\.db\?\.';B='\(window\.api as any\)\?\.db\?\.';C='\(window as any\)[^\n]*\.db';D='(?<!window\.)\bapi\.db\?\.'}
foreach($k in $p.Keys){$n=0;$r=@();for($i=0;$i -lt $l.Count;$i++){$m=[regex]::Matches($l[$i],$p[$k]);if($m.Count){$n+=$m.Count;$r+=($i+1)}};"$k total=$n lines=$($r -join ',')"}

# 3) 126 与 48 的口径
([regex]::Matches(([IO.File]::ReadAllText((Resolve-Path 'src/renderer/src/store/appStore.ts'))),'window\.api')).Count   # 126

# 4) 尾部函数与文件末行
Select-String -Path src/renderer/src/store/appStore.ts -Pattern '^export function (relativeTime|sizeLabel|clockTime)'
(Get-Content src/renderer/src/store/appStore.ts).Count   # 6377

# 5) alias stub 站点
Select-String -Path package.json -Pattern '@/store/appStore'
Select-String -Path scripts/*.mjs -Pattern '@/store/appStore'

# 6) 组件侧 db 直写
Get-ChildItem src/renderer/src/components -Recurse -Include *.tsx | ForEach-Object { $c=([regex]::Matches(([IO.File]::ReadAllText($_)),'\.db\?\.')).Count; if($c){"$($_.Name): $c"} }
```

---

## 10. 实测 / 推断分界汇总

**【实测】**（可直接重跑的读数）：`services/` 不存在；`dbSync` 全仓 0 命中；`appStore.ts` 6377 行；db 直写 48 处/48 行（四类行号见 §2.1）；方法分布 19 种；`window.api` 126 次/126 行；组件 25 文件 59 处；48 条语句占 176 物理行；`relativeTime` `:6337-6344`、`clockTime` `:6346-6349`、`sizeLabel` `:6351-6367`、文件末行 `:6377`；`lib/format.ts` 不存在；4 个组件 import 行；6 个 alias 站点 / 5 个 stub-mock 文件；`consult-card-store-stub.ts` 19 行全文；`project-activity-store-stub.ts:3` 与 `wave5a-store-mock.ts:42-46` 两份 `sizeLabel`；`FileBadge:3 → appStore`、`Markdown:19 → FileBadge` 的传递链路。

**【推断】**（依赖上文实测的推理）：规划"126"来自 `window.api` 全命名空间计数；"400–600 行"来自 126 × 3–4 行的心算，且在"只改名/吞语句/含组件"三种设计下均无法达成；把 `sizeLabel` 移出会使 2 处 stub 影子实现变死代码并把真实实现带入 `test:project-activity-ui` 与 wave5a/pdf golden 图，**可能**造成渲染文本漂移（需实跑确认）；精确红线应改写为"副作用口径"。
