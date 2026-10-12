# T8 验收脚本与 Phase 0.1 验收标准核查报告

- 任务：对重构规划做**执行前**最终复核（只读核查；唯一写入即本文件）
- 仓库：`C:\Users\servi\Documents\GitHub\wavealstra_harness`（HEAD 工作树，未做任何代码/脚本改动）
- 时间：2026-10-12（Asia/Shanghai）
- 待验证声明：规划把验收标准写成 `pnpm -s typecheck` + `test:memory` + `test:execution-restart-recovery` + `test:project-materials-ui` + `test:harness-quality` + `test:agent-loadout` + `test:task-expert-binding` 绿，并要求跑 `pnpm -s test:all`。
- 结论（一句话）：**9 个被点名的脚本全部真实存在（无缺失），但有两条硬伤**——(1) Phase 0.1 的「全仓 `new MemoryService` + `new ExecutionFailureRepository` ≤2 处命中」实测为 **87 处**（scripts/ 78 处、src/ 6 处、diagrams/ 3 处），且被要求绿的 `test:memory`/`test:agent-loadout` 自己就在 `new MemoryService`，该标准与「同一阶段内这些用例保持绿」自相矛盾、按字面**不可达**；(2) `test:project-materials-ui` 的裸跑在本机环境**必失败**（当前 shell `ELECTRON_RUN_AS_NODE=1`），必须写成 `env -u ELECTRON_RUN_AS_NODE pnpm -s test:project-materials-ui`，或改由 `test:all` 代跑（`test-all.mjs:108-109` 会删除该变量）。

> 标记约定：**【实测】**＝本轮直接读取文件/执行只读命令得到的证据；**【推断】**＝基于实测证据的推理，未直接执行验证。

---

## 0. 核查方法与只读边界

| 动作 | 命令/方式 | 是否产生写入 |
| --- | --- | --- |
| 读取 `package.json`、`scripts/test-all.mjs`、`scripts/test-baseline.json`、`scripts/project-materials-ui-test.cjs` | `read` / `grep` 工具 | 否 |
| 全仓构造点计数 | `Get-ChildItem -Recurse -File` + `Select-String -SimpleMatch`（排除 `node_modules`/`out`/`release-*`/`.git`） | 否 |
| 确认 `test:all` 实际选中集合 | `node scripts/test-all.mjs --list`（该分支在 `test-all.mjs:87-91` 直接 `process.exit(0)`，**不跑任何用例**） | 否 |
| 本报告落盘 | `write out/plan-review/T8-acceptance-scripts.md` | **是（唯一允许的写入）** |

为遵守「唯一允许的写操作」约束，**本轮没有真正执行**任何 `pnpm -s test:*`（这些脚本会写 `out/tests/*.png`、`out/tests/*.cjs`）。因此凡是「当前是否真的绿」的判断均标为【推断】，其依据是 `scripts/test-baseline.json` 只有 1 条容忍失败、以及 `artifacts/quality-audit/pi-legacy-purge.md:83` 记录的最近一次门禁结果。

---

## 1. 问题 1：9 个脚本是否真实存在（完整命令原文）

**结论：【实测】9 个全部存在，无缺失。** 佐证：`package.json` scripts 段，逐条原文如下（行号为 `package.json` 实际行号）。

### 1.1 `typecheck` — 存在（package.json:21）

```json
"typecheck": "tsc --noEmit -p tsconfig.web.json && tsc --noEmit -p tsconfig.node.json",
```

依赖文件存在性【实测】：`tsconfig.web.json` exists=True、`tsconfig.node.json` exists=True。

### 1.2 `test:memory` — 存在（package.json:28）

```json
"test:memory": "esbuild scripts/memory-kernel-test.ts --bundle --platform=node --format=cjs --outfile=out/tests/memory-kernel-test.cjs --external:better-sqlite3 --external:onnxruntime-node --external:electron && node scripts/test-guard.mjs out/tests/memory-kernel-test.cjs",
```

底层脚本【实测】：`scripts/memory-kernel-test.ts` exists=True。

### 1.3 `test:execution-restart-recovery` — 存在（package.json:39）

```json
"test:execution-restart-recovery": "esbuild scripts/execution-restart-recovery-test.ts --bundle --platform=node --format=esm --packages=external --outfile=out/tests/execution-restart-recovery-test.mjs && node scripts/test-guard.mjs out/tests/execution-restart-recovery-test.mjs",
```

底层脚本【实测】：`scripts/execution-restart-recovery-test.ts` exists=True。

### 1.4 `test:project-materials-ui` — 存在（package.json:85）

```json
"test:project-materials-ui": "esbuild scripts/project-materials-ui-fixture.tsx --bundle --platform=browser --format=iife --jsx=automatic --alias:@=./src/renderer/src --alias:@shared=./src/shared --alias:@/store/appStore=./scripts/project-materials-store-stub.ts --outfile=out/tests/project-materials-ui.js --loader:.woff2=file --loader:.woff=file --loader:.ttf=file && electron scripts/project-materials-ui-test.cjs",
```

底层文件【实测】：`scripts/project-materials-ui-fixture.tsx` exists=True、`scripts/project-materials-ui-test.cjs` exists=True、`scripts/project-materials-store-stub.ts` exists=True。
**注意：该命令原文中不含任何 `env -u`（见问题 4）。**

### 1.5 `test:harness-quality` — 存在（package.json:36）

```json
"test:harness-quality": "esbuild scripts/harness-quality-gate-test.ts --bundle --platform=node --format=cjs --outfile=out/tests/harness-quality-gate-test.cjs --external:electron && node scripts/test-guard.mjs out/tests/harness-quality-gate-test.cjs",
```

底层脚本【实测】：`scripts/harness-quality-gate-test.ts` exists=True。

### 1.6 `test:agent-loadout` — 存在（package.json:35）

```json
"test:agent-loadout": "esbuild scripts/agent-loadout-test.ts --bundle --platform=node --format=esm --packages=external --outfile=out/tests/agent-loadout-test.mjs --external:electron && node scripts/test-guard.mjs out/tests/agent-loadout-test.mjs",
```

底层脚本【实测】：`scripts/agent-loadout-test.ts` exists=True。

### 1.7 `test:task-expert-binding` — 存在（package.json:60）

```json
"test:task-expert-binding": "esbuild scripts/task-expert-binding-test.ts --bundle --platform=node --format=esm --packages=external --alias:electron=./scripts/arch-electron-stub.ts --outfile=out/tests/task-expert-binding-test.mjs && node scripts/test-guard.mjs out/tests/task-expert-binding-test.mjs",
```

底层文件【实测】：`scripts/task-expert-binding-test.ts` exists=True、`scripts/arch-electron-stub.ts` exists=True。

### 1.8 `test:all` — 存在（package.json:341）

```json
"test:all": "node scripts/test-all.mjs",
```

### 1.9 `test:all:update-baseline` — 存在（package.json:343）

```json
"test:all:update-baseline": "node scripts/test-all.mjs --update-baseline",
```

（附：`package.json:342` `"test:all:live": "node scripts/test-all.mjs --include-live"`。）

### 1.10 缺失清单

**空。** 9 个脚本 0 缺失。【实测】

### 1.11 附带实测：6 个"必须绿"的用例都在 `test:all` 的默认选中集合内

`node scripts/test-all.mjs --list` 输出 `[test-all] 选中 242 个用例：`，其中【实测】包含：
`test:agent-loadout`、`test:execution-restart-recovery`、`test:harness-quality`、`test:memory`、`test:project-materials-ui`、`test:task-expert-binding`。

> 【推断】这意味"额外单跑这 6 个"对 `test:all` 是**部分冗余**（`test:all` 已覆盖），真正的增量价值只在于"单独失败时更快定位"。这不是缺陷，但规划把它写成两套并列验收，容易让执行者对"是否重复"产生疑问。

---

## 2. 问题 2：`test:all` 的聚合机制、`EXCLUDE_PATTERNS` 与 ratchet 语义

### 2.1 用例集合的构造【实测，scripts/test-all.mjs】

```
76: let names = Object.keys(pkg.scripts).filter((k) => k.startsWith("test:"));
77: names = names.filter((n) => !SELF_EXCLUDE_PATTERNS.some((re) => re.test(n)));
78: if (!includeLive) names = names.filter((n) => !EXCLUDE_PATTERNS.some((re) => re.test(n)));
79: if (filter) names = names.filter((n) => n.includes(filter));
80: names.sort();
```

自排除（防 fork 炸弹）【实测，`test-all.mjs:33-37`】：

```js
/**
 * 自身与聚合脚本：绝不能递归执行，否则 test:all 会 spawn 自己形成 fork 炸弹
 * （实测：会跑满 45 分钟以上、泄漏大量 node 进程，并把所有用例误判为失败）。
 */
const SELF_EXCLUDE_PATTERNS = [/^test:all/, /^test:verify/];
```

### 2.2 `EXCLUDE_PATTERNS` 原文【实测，scripts/test-all.mjs:39-62】

```js
/**
 * 需要 GUI / CDP / GPU / 真实桌面会话或联网的用例：在无头 CI 上不可靠。
 * 这些由 `--include-live` 或本地机器单独验证，不进入 default 门禁。
 */
const EXCLUDE_PATTERNS = [
  /-e2e$/, // 端到端：脚本里直接 `electron out/tests/...`，且单个用例可达 305s
  /-desktop$/, // Electron 桌面端 UI（CDP 截图/真实窗口）
  /-electron$/, // 需要 electron 运行时
  /:live$/, // 联网/真实服务
  /^test:remote-/, // 远程访问（需真实网络+GUI）
  /^test:browser-/, // 浏览器自动化（需 CDP）
  /^test:computer-/, // 计算机使用（需真实桌面 + Windows 自动化）
  /^test:streaming-live$/,
  /^test:durable-bot$/,
  /^test:multi-search-live$/,
  /^test:workspace-files-ui$/, // 需 GUI 文件面板
  /^test:models-settings-overlay$/,
  /^test:terminal$/, // 需 node-pty 原生模块
  /^test:python-runtime-live$/, // 需真实 Python 运行时下载
  /^test:python-runtime-electron$/,
  // 依赖 gitignore 的官方市场归档 `mybuddyskills-main/`（约 294 技能）：该用例从市场安装真实
  // blender-* 技能，归档不存在时**无法**通过（不是代码缺陷）。需在具备该数据集的机器上单独跑。
  /^test:blender-skill$/,
];
```

**逐条判定【实测，按正则匹配 + `--list` 复核】**：
- `/^test:project-materials-ui$/` **不匹配任何** EXCLUDE 规则（既不以 `-e2e`/`-desktop`/`-electron`/`:live` 结尾，也不在显式名单里）→ **它进入 default 门禁**。（`--list` 输出已复核，见 1.11。）
- 同为"UI + electron 进程"的 `test:memory-ui`、`test:expert-ui`、`test:consult-card-ui`、`test:project-activity-ui`、`test:create-folder-ui` 等同样不在排除名单内。
- 【推断】这与 `test-all.mjs:40` 注释"需要 GUI / CDP / GPU / 真实桌面会话的用例……在无头 CI 上不可靠"以及 `AGENTS.md:8`「GUI/desktop suites need a real desktop session: `pnpm -s test:all:live`」**存在口径不一致**：名字里没有 `-desktop`/`-electron` 后缀的 Electron-UI 用例实际会被 default 门禁执行。`test:project-materials-ui` 正是此类；规划把它列入必绿名单因此**恰好可行**（靠 `test-all.mjs:108-109` 删变量），但把它当成"裸跑脚本"就会踩坑。

### 2.3 与 `scripts/test-baseline.json` 的配合（ratchet 语义）【实测】

关键代码行：

```
30: const BASELINE_PATH = join(ROOT, "scripts", "test-baseline.json");
93: const baseline = existsSync(BASELINE_PATH)
94:   ? new Set(JSON.parse(readFileSync(BASELINE_PATH, "utf8")).knownFailing ?? [])
95:   : new Set();
106: // ELECTRON_RUN_AS_NODE=1 会让 Electron UI 用例以 `app is undefined` 失败；
107: // 必须真正删除该变量（赋值为 undefined 在部分 Node 版本会变成字符串 "undefined"）。
108: const childEnv = { ...process.env };
109: delete childEnv.ELECTRON_RUN_AS_NODE;
113:   const res = spawnSync("pnpm", ["-s", name], {
118:     timeout: PER_TEST_TIMEOUT * 1000,
140:         const known = baseline.has(r.name);
142:           `  ${r.killed ? "TIMEOUT" : "FAIL "} ${r.name}  (${r.secs}s)${r.killed ? "" : known ? "  [baseline 已知]" : "  [新增回归]"}`,
154: const newRegressions = failed.filter((n) => !baseline.has(n));
155: const fixedSinceBaseline = [...baseline].filter((n) => !failed.includes(n) && names.includes(n));
191: process.exit(newRegressions.length > 0 ? 1 : 0);
```

ratchet 语义（翻成可执行规则）：

| 情形 | 行为 | 退出码影响 |
| --- | --- | --- |
| 用例不在 baseline 且**通过** | `passed.push`，打印 `PASS`（`test-all.mjs:135-137`） | 不影响（0） |
| 用例在 baseline 且**失败** | 打印 `FAIL ... [baseline 已知]`（`test-all.mjs:140-143`） | 不影响（0），债务"保持可见" |
| 用例**不在** baseline 却失败 | 计入 `newRegressions`（`test-all.mjs:154`），汇总打印（`test-all.mjs:171-174`） | **exit 1 → 门禁失败** |
| 用例在 baseline 但**现在通过** | 列入 `fixedSinceBaseline`（`test-all.mjs:155`）并提示"可从 baseline 移除"（`test-all.mjs:166-169`） | **不算失败**（0） |
| **超时**（`PER_TEST_TIMEOUT`，默认 300s，`test-all.mjs:74`；命令行 `--timeout=`） | `killed` → 计 FAIL 但**不当作新增回归判定**（`test-all.mjs:161-164` 单列超时清单；`test-all.mjs:122`） | 【实测代码】超时仍进 `failed`，但 `test-all.mjs:154` 的 `newRegressions` 只看 `baseline.has(n)`，超时名若不在 baseline 仍会 exit 1；`test-all.mjs:162` 的措辞"未作为回归判定"与 `191` 行的实际退出码判断存在**措辞/行为不一致**（见风险 R3） |
| `--update-baseline` | 用**本次失败集整体重写** `knownFailing` 并 `process.exit(0)`（`test-all.mjs:176-186`） | 强制 0 |

其它关键机制：
- 并发 `JOBS` 默认 4（`test-all.mjs:70`），`spawnSync("pnpm", ["-s", name], { shell: true, stdio: "ignore", env: childEnv })`（`test-all.mjs:113-120`）——**子进程 stdio 被丢弃**，失败详情只能靠单独重跑获取【实测】。
- `ELECTRON_RUN_AS_NODE` 在子进程环境里被显式删除（`test-all.mjs:106-109`），这正是 `test:project-materials-ui` 能在 `test:all` 里通过的原因。
- 退出码约定见文件头 `test-all.mjs:22`：`0 = 无新增失败；1 = 有新增失败；2 = 用法/环境错误`。

---

## 3. 问题 3：`test-baseline.json` 里有多少条被容忍的失败

**答：【实测】恰好 1 条 —— `test:project-agent`。** 整个文件 11 行，全文如下（原文引用）：

```json
{
  "$comment": "已知失败基线（棘轮 / ratchet）。test:all 允许这些用例失败但会打印出来，任何*新增*失败会让门禁失败。修复后请用 `pnpm -s test:all:update-baseline` 重写本文件（或手动删除已修复条目）。切勿为掩盖真实回归而新增条目。",
  "$basis": "2026-10-09：本仓库只支持当前 Pi 版本 1.0.4。旧版本（0.99.x / 0.99.2）的 9 个 test 条目及其 49 个脚本已删除（见 artifacts/quality-audit/pi-legacy-purge.md），default 套件由 249 降为 241 个用例。",
  "generatedAt": "2026-10-09T05:56:36.640Z",
  "knownFailing": [
    "test:project-agent"
  ],
  "$remaining": {
    "test:project-agent": "执行审计快照 resolvedCapabilities 未保留「被项目策略拒绝的 Expert」（expertId='blocked-expert' 确有传入，执行前 inspectRuntimeContext 正确包含）。这是产品行为问题，需产品决策：审计快照是否应保留被拒的 Expert；不宜由测试擅自迁就实现，也不宜由实现迁就测试。"
  }
}
```

- 条数【实测】：`knownFailing.length === 1`。
- "前几条内容"：第 1 条即 `test:project-agent`，其容忍原因写在 `$remaining` 中（上引）。
- 交叉佐证【实测】：`artifacts/quality-audit/pi-legacy-purge.md:83` 记录 `pnpm -s test:all → 240 通过 / 1 已知失败 / 0 新增回归 → exit 0`，与"baseline 只有 1 条"一致。
- 当前集中度【实测】：`--list` 显示 default 套件 **242** 个用例，baseline **1** 条 → 门禁对"任一新增失败"极其敏感（这也是 Phase 0.1 若破坏 52 个测试文件之一就会立即变红的机制基础）。
- 顺带【实测】`test-baseline.json` 无任何一条指向本轮 6 个必绿用例 → 【推断】它们当前在 `test:all` 中是绿的（否则会作为新增回归出现在 `pi-legacy-purge.md` 的记录里，或必须新增 baseline 条目，而文件里没有）。

---

## 4. 问题 4：`test:project-materials-ui` 是否需要 `env -u ELECTRON_RUN_AS_NODE`

**答：【实测】在需要——脚本命令本身没有 `env -u`，而本机继承 `ELECTRON_RUN_AS_NODE=1`，裸跑必失败；必须由调用方补 `env -u` 或改用 `test:all`。**

证据链（全部【实测】）：

1. `package.json:85` 的 `test:project-materials-ui` 命令原文中**没有** `env -u ELECTRON_RUN_AS_NODE`（见 §1.4 完整引用）。
2. 本机当前 shell：`ELECTRON_RUN_AS_NODE = [1]`（`$env:ELECTRON_RUN_AS_NODE` 实测为 `1`）。
3. 该用例必须以**真 Electron 主进程**运行——`scripts/project-materials-ui-test.cjs:1-8`：

```js
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const output = join(__dirname, '../out/tests');
app.setPath('userData', join(output, 'project-materials-profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1240, height: 850, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
```

在 `ELECTRON_RUN_AS_NODE=1` 下 `require('electron')` 返回模块路径字符串而非 API 对象，`app.setPath(...)`（第 6 行）即抛错 → 【推断】失败形态正是 `AGENTS.md:10` 描述的现象。
4. 仓库自身文档明确要求加 `env -u`——`AGENTS.md:10` 原文：

```
- Electron UI tests fail with `app` undefined when the shell inherits `ELECTRON_RUN_AS_NODE=1`; run them as `env -u ELECTRON_RUN_AS_NODE pnpm -s test:project-materials-ui`. Screenshots land in `out/tests/*.png`.
```

5. 聚合器已经替调用方处理了这件事——`scripts/test-all.mjs:106-109` 原文：

```js
// ELECTRON_RUN_AS_NODE=1 会让 Electron UI 用例以 `app is undefined` 失败；
// 必须真正删除该变量（赋值为 undefined 在部分 Node 版本会变成字符串 "undefined"）。
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
```

**对规划的可执行修正（必做）**：验收命令必须写成
`env -u ELECTRON_RUN_AS_NODE pnpm -s test:project-materials-ui`
（Git Bash / WSL / Linux/macOS 用 `env -u`；Windows PowerShell 环境等价写法为临时 `Remove-Item Env:ELECTRON_RUN_AS_NODE` 后再运行）。规划若照抄 `pnpm -s test:project-materials-ui`，验收会在环境继承处**必然假红**，与代码质量无关。

> 该用例会写 `out/tests/*.png`（`project-materials-ui-test.cjs:24,52,67,93,104,117,122,155`）与 `out/tests/project-materials-ui.{html,js,css}`；本轮**未执行**，`out/tests` 现有 583 个条目（历史产物）。

---

## 5. 问题 5（关键判断）：Phase 0.1 的 `≤2 处命中` 是否根本无法达成

**答：【实测计数 + 推断结论】按字面「全仓 ≤2 处命中」不可达，且与规划自身的必绿清单自相矛盾。**

### 5.1 全仓计数【实测】

统计方式：`Get-ChildItem -Recurse -File`（扩展名 `.ts,.tsx,.js,.mjs,.cjs,.svg,.md,.json`，排除 `node_modules`、`out`、`release-mybuddy*`、`.git`；隐藏目录 `.wb-ref`/`.tmp-*` 未计入）+ `Select-String -SimpleMatch`。交叉复核：`grep` 工具（ripgrep，遵循 .gitignore）得到完全相同的计数。

| 模式 | 全仓命中 | scripts/ | src/ | diagrams/ |
| --- | --- | --- | --- | --- |
| `new MemoryService` | **71** | 64 | 4 | 3 |
| `new ExecutionFailureRepository` | **16** | 14 | 2 | 0 |
| **合计** | **87** | **78** | **6** | 3 |

文件数【实测】：`new MemoryService` 出现在 44 个文件（scripts/ 39 个测试文件 + 4 个 src 文件 + 1 个 SVG）；`new ExecutionFailureRepository` 出现在 15 个文件（scripts/ 13 个文件 + 2 个 src 文件）。scripts/ 侧合计 **52 个不同文件**（39 + 13，无重叠文件）。

### 5.2 `src/` 内部命中（重构主战场）【实测】

```
src/main/index.ts:2692: const memoryKernel = new MemoryService(db);
src/main/agent/AgentService.ts:696: this.memoryService = new MemoryService(db);
src/main/blueprint/BlueprintService.ts:56: this.memory = deps.memoryService ?? new MemoryService(deps.db, { semantic: false });
src/main/workspace/WorkspaceSharedContextService.ts:52: this.memory = new MemoryService(db);
src/main/index.ts:1854: const executionFailureRepository = new ExecutionFailureRepository(db.connection);
src/main/agent/AgentService.ts:717: this.executionFailures = new ExecutionFailureRepository(db.connection);
```

**即：即使 Phase 0.1 把 `src/` 做到极致（0 处），全仓仍有 78 处 scripts/ 命中 + 3 处 diagrams/ 命中 = 81 处 ≥ 2。** 要满足 ≤2，必须把 **52 个 scripts/ 测试文件**全部改写为经工厂/DI 构造——那不是 Phase 0.1 的"源码收敛"，而是一次跨 `src/` + `scripts/` 的全仓迁移【推断】。

### 5.3 自相矛盾点（决定性证据）【实测】

规划要求下列用例**保持绿**，而它们**自己就在直接 `new MemoryService`**：

```
scripts/memory-kernel-test.ts:35:   const memory = new MemoryService(db, { semantic: false });
scripts/memory-kernel-test.ts:473:   const seedMemory = new MemoryService(seed, { semantic: false });
scripts/memory-kernel-test.ts:485:     const memory = new MemoryService(reset, { semantic: false });
scripts/agent-loadout-test.ts:125:   const memories = new MemoryService(db, { semantic: false });
scripts/execution-restart-recovery-test.ts:18:   const failures = new ExecutionFailureRepository(appDb.connection);
```

- `test:memory` → `scripts/memory-kernel-test.ts`（3 处）
- `test:agent-loadout` → `scripts/agent-loadout-test.ts`（1 处）
- `test:execution-restart-recovery` → `scripts/execution-restart-recovery-test.ts`（1 处）

【推断】因此两种情形都冲突：
- 若 Phase 0.1 **移除/收紧** `new MemoryService(db)` 这一构造入口（这正是 "≤2 处" 的语义前提），上述用例会编译/运行失败 → 违反"这些用例保持绿"；
- 若 Phase 0.1 **不动**构造入口（保持 public），则 52 个测试文件的 78 处命中永远存在 → 违反"≤2 处"。
- 唯一出路是在同一阶段内把 52 个测试文件也改掉，但那与"Phase 0.1 只动 `src/` 组合根"的阶段定义、以及 `AGENTS.md` 中"不要为掩盖回归而扩容"的棘轮纪律（`test-baseline.json` 仅 1 条容忍）不兼容。

### 5.4 其余 scripts/ 命中分布（供改写工作量估算）【实测，节选】

`MemoryService`（64 处，39 文件）密集区：`workspace-shared-context-ui-foundation-test.ts` 6 处；`workspace-runtime-consolidation-test.ts` 6 处；`workspace-runtime-integration-test.ts` 5 处；`memory-kernel-test.ts` 3 处；`project-memory-migration-test.ts` 3 处；其余多为 1–2 处（`project-event-*`/`project-file-import-*` 系列常以 `new ProjectService(new ProjectRepository(db.connection), new MemoryService(db, { semantic: false }))` 内联形式出现，例：`scripts/project-event-test.ts:49`）。

`ExecutionFailureRepository`（14 处，13 文件）：`scripts/browser-automation-recovery-test.ts:15`、`cad-freecad-recovery-test.ts:36`、`computer-use-recovery-evidence-test.ts:23`、`execution-restart-recovery-test.ts:18`、`execution-failure-dismiss-test.ts:13`、`mcp-execution-evidence-test.ts:13`、`prompt-failure-recovery-test.ts:8`、`project-folder-relocation-test.ts:52,59`、`runtime-requirement-recovery-test.ts:8`、`skill-authoring-recovery-test.ts:14`、`ui-automation-recovery-test.ts:10`、`verified-code-execution-test.ts:18`，以及非 `-test.` 脚本 `scripts/core-performance-baseline.ts:148`（`const preflightFailures = new ExecutionFailureRepository(preflightDb.connection);`）。

### 5.5 推荐的替换标准（可判定、且不与必绿清单冲突）

任选其一，写进规划：
1. **限定作用域**：`grep -c 'new MemoryService' src/main/**/*.ts` ≤ 1，且 `grep -c 'new ExecutionFailureRepository' src/main/**/*.ts` ≤ 1（当前各为 4 / 2，实质是把 `index.ts` 之外的构造点收进组合根/工厂）。
2. **限定语义**：断言"除 `src/main/index.ts` 组合根外，`src/` 内不再出现 `new MemoryService(` / `new ExecutionFailureRepository(`"，`scripts/` 与 `diagrams/` 显式排除，并在标准里写明排除理由。
3. 若确实要做全仓迁移，则把它拆成独立阶段，并把计数目标写成"scripts/ 命中由 78 → 0，文件由 52 → 0"，同时把"6 个必绿用例"改为"迁移后仍绿"（因为届时这些用例已被改写，不再能作为"未改动即绿"的证据）。

---

## 6. `test:all` 门禁数据流（含 ratchet 与 `ELECTRON_RUN_AS_NODE` 处理）

<svg viewBox="0 0 940 560" width="940" height="560" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="test-all.mjs 聚合门禁数据流图">
  <rect x="0" y="0" width="940" height="560" fill="#f8fafc"/>
  <text x="20" y="30" font-size="17" fill="#0f172a" font-family="sans-serif">pnpm -s test:all → scripts/test-all.mjs 数据流（行号为实测）</text>

  <rect x="20" y="52" width="250" height="66" rx="8" fill="#e0f2fe" stroke="#0369a1"/>
  <text x="34" y="76" font-size="13" fill="#0f172a" font-family="sans-serif">package.json scripts</text>
  <text x="34" y="96" font-size="12" fill="#0f172a" font-family="sans-serif">Object.keys 以 test: 开头</text>
  <text x="34" y="112" font-size="12" fill="#334155" font-family="sans-serif">test-all.mjs:76</text>

  <rect x="310" y="52" width="230" height="66" rx="8" fill="#fee2e2" stroke="#b91c1c"/>
  <text x="324" y="76" font-size="13" fill="#0f172a" font-family="sans-serif">SELF_EXCLUDE_PATTERNS</text>
  <text x="324" y="96" font-size="12" fill="#0f172a" font-family="sans-serif">/^test:all/ /^test:verify/</text>
  <text x="324" y="112" font-size="12" fill="#334155" font-family="sans-serif">:37, 过滤于 :77（防递归）</text>

  <rect x="580" y="52" width="340" height="66" rx="8" fill="#fef9c3" stroke="#a16207"/>
  <text x="594" y="76" font-size="13" fill="#0f172a" font-family="sans-serif">EXCLUDE_PATTERNS（16 条）</text>
  <text x="594" y="96" font-size="12" fill="#0f172a" font-family="sans-serif">-e2e$ -desktop$ -electron$ :live$ …</text>
  <text x="594" y="112" font-size="12" fill="#334155" font-family="sans-serif">:43-62, 仅未加 --include-live 时于 :78 过滤</text>

  <rect x="20" y="146" width="250" height="60" rx="8" fill="#dcfce7" stroke="#15803d"/>
  <text x="34" y="170" font-size="13" fill="#0f172a" font-family="sans-serif">默认选中 242 个用例</text>
  <text x="34" y="190" font-size="12" fill="#334155" font-family="sans-serif">实测: node scripts/test-all.mjs --list</text>

  <rect x="310" y="146" width="610" height="60" rx="8" fill="#ede9fe" stroke="#6d28d9"/>
  <text x="324" y="170" font-size="13" fill="#0f172a" font-family="sans-serif">childEnv = {...process.env}; delete childEnv.ELECTRON_RUN_AS_NODE  (:108-109)</text>
  <text x="324" y="190" font-size="12" fill="#334155" font-family="sans-serif">→ 这是 test:project-materials-ui 能在门禁里通过的原因（本机环境值为 1）</text>

  <rect x="20" y="238" width="900" height="58" rx="8" fill="#f1f5f9" stroke="#475569"/>
  <text x="34" y="262" font-size="13" fill="#0f172a" font-family="sans-serif">runPool(names)：JOBS=4 (:70)、单用例 300s 超时 (:74)、spawnSync("pnpm",["-s",name],{stdio:"ignore",env:childEnv}) (:113-120)</text>
  <text x="34" y="284" font-size="12" fill="#334155" font-family="sans-serif">每个用例返回 {ok, killed, secs} (:122) → PASS / FAIL / TIMEOUT 分类打印 (:135-144)</text>

  <rect x="20" y="324" width="250" height="74" rx="8" fill="#e2e8f0" stroke="#334155"/>
  <text x="34" y="348" font-size="13" fill="#0f172a" font-family="sans-serif">baseline 载入</text>
  <text x="34" y="368" font-size="12" fill="#0f172a" font-family="sans-serif">test-baseline.json.knownFailing</text>
  <text x="34" y="386" font-size="12" fill="#334155" font-family="sans-serif">:93-95 → 实测仅 1 条: test:project-agent</text>

  <rect x="310" y="324" width="300" height="74" rx="8" fill="#fee2e2" stroke="#b91c1c"/>
  <text x="324" y="348" font-size="13" fill="#0f172a" font-family="sans-serif">newRegressions = failed \ baseline</text>
  <text x="324" y="368" font-size="12" fill="#0f172a" font-family="sans-serif">:154；已知失败仍打印 :140-143</text>
  <text x="324" y="386" font-size="12" fill="#334155" font-family="sans-serif">→ 门禁真正的失败判据</text>

  <rect x="650" y="324" width="270" height="74" rx="8" fill="#dcfce7" stroke="#15803d"/>
  <text x="664" y="348" font-size="13" fill="#0f172a" font-family="sans-serif">exit code :191</text>
  <text x="664" y="368" font-size="12" fill="#0f172a" font-family="sans-serif">newRegressions.length &gt; 0 ? 1 : 0</text>
  <text x="664" y="386" font-size="12" fill="#334155" font-family="sans-serif">0=通过 1=新增回归 2=用法/环境错误(:22)</text>

  <rect x="20" y="426" width="470" height="106" rx="8" fill="#fff7ed" stroke="#c2410c"/>
  <text x="34" y="450" font-size="13" fill="#0f172a" font-family="sans-serif">--update-baseline (:176-186)</text>
  <text x="34" y="470" font-size="12" fill="#0f172a" font-family="sans-serif">knownFailing = 本次 failed 排序后整体重写</text>
  <text x="34" y="488" font-size="12" fill="#0f172a" font-family="sans-serif">然后 process.exit(0)，无论新增多少失败</text>
  <text x="34" y="510" font-size="12" fill="#334155" font-family="sans-serif">→ 规划里"绿"的判据必须用 test:all，不能用 test:all:update-baseline</text>

  <rect x="520" y="426" width="400" height="106" rx="8" fill="#fee2e2" stroke="#b91c1c"/>
  <text x="534" y="450" font-size="13" fill="#0f172a" font-family="sans-serif">Phase 0.1 验收标准实测反例</text>
  <text x="534" y="470" font-size="12" fill="#0f172a" font-family="sans-serif">new MemoryService 71 处（scripts 64 / src 4 / svg 3）</text>
  <text x="534" y="488" font-size="12" fill="#0f172a" font-family="sans-serif">new ExecutionFailureRepository 16 处（scripts 14 / src 2）</text>
  <text x="534" y="508" font-size="12" fill="#334155" font-family="sans-serif">合计 87 处 &gt; 2，且 scripts/ 独占 78 处 / 52 个文件</text>

  <line x1="270" y1="85" x2="308" y2="85" stroke="#334155" stroke-width="2" marker-end="url(#a)"/>
  <line x1="540" y1="85" x2="578" y2="85" stroke="#334155" stroke-width="2" marker-end="url(#a)"/>
  <line x1="700" y1="118" x2="200" y2="144" stroke="#334155" stroke-width="2" marker-end="url(#a)"/>
  <line x1="145" y1="206" x2="145" y2="236" stroke="#334155" stroke-width="2" marker-end="url(#a)"/>
  <line x1="400" y1="296" x2="400" y2="322" stroke="#334155" stroke-width="2" marker-end="url(#a)"/>
  <line x1="145" y1="398" x2="145" y2="424" stroke="#334155" stroke-width="2" marker-end="url(#a)"/>
  <line x1="560" y1="361" x2="648" y2="361" stroke="#334155" stroke-width="2" marker-end="url(#a)"/>
  <line x1="486" y1="470" x2="518" y2="470" stroke="#b91c1c" stroke-width="2" marker-end="url(#a)"/>
  <defs><marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="#334155"/></marker></defs>
</svg>

图中的计数、行号、条数均为 §1–§5 的【实测】结果；`Phase 0.1 验收标准实测反例` 框内的"不可达"判定是【推断】（基于 87 > 2 的计数事实）。

---

## 7. 规划修复建议（按优先级）

| # | 问题（实测） | 建议改法 | 优先级 |
| --- | --- | --- | --- |
| F1 | Phase 0.1 标准「全仓 ≤2 处命中」与事实冲突（实测 87 处；scripts/ 78 处 / 52 文件；被要求绿的 `memory-kernel-test.ts:35,473,485`、`agent-loadout-test.ts:125`、`execution-restart-recovery-test.ts:18` 自身就在构造） | 改为作用域限定式断言：`src/main/**` 内 `new MemoryService` ≤1 且 `new ExecutionFailureRepository` ≤1（当前 4/2），并显式声明 `scripts/`、`diagrams/` 不在统计范围；若坚持全仓归零，则拆独立阶段并按"78→0 处 / 52→0 文件"验收 | P0 |
| F2 | 验收命令 `pnpm -s test:project-materials-ui` 在本机（`ELECTRON_RUN_AS_NODE=1`）必然假红，`package.json:85` 无 `env -u` | 命令改为 `env -u ELECTRON_RUN_AS_NODE pnpm -s test:project-materials-ui`，或明确写"该项由 `test:all` 代跑（`test-all.mjs:108-109` 已删除该变量），不单独裸跑" | P0 |
| F3 | 6 个必绿用例全部已被 `test:all` 默认集合覆盖（实测 242 个用例含这 6 个），两套验收并列但未说明关系；且 `test:project-materials-ui` 属 GUI 用例却未进 `EXCLUDE_PATTERNS`，与 `AGENTS.md:8` 的"GUI 需 `test:all:live`"口径不一致 | 验收写成"主判据 = `pnpm -s test:all` 退出码 0；失败时用 6 个单跑脚本做定位"，并注明 `test:all` 的 stdio 被丢弃（`test-all.mjs:115` `stdio:"ignore"`），失败详情必须单跑获取 | P1 |
| F4 | 门禁现状是"1 条 baseline + 242 用例"（极敏感），`artifacts/quality-audit/pi-legacy-purge.md:83` 记录 0 新增回归 | 规划的每个 Phase 出口都应写明"`test:all` 新增回归 = 0，且**不得**新增 `test-baseline.json` 条目"；禁止用 `test:all:update-baseline`（`test-all.mjs:176-186` 会无条件 exit 0）充当验收 | P1 |

---

## 8. 附带发现（超出被问范围，但影响规划可执行性）

- **R1【实测】**`per-test` 的 stdio 被丢弃（`test-all.mjs:113-120` 的 `stdio:"ignore"`）：`test:all` 只能给"哪个用例失败"，不能给失败原因。规划若把 `test:all` 当唯一验收证据，回归定位成本会很高。
- **R2【实测+推断】**`package.json` 的 `test:project-materials-ui` 依赖 `--loader:.ttf=file`（`:85`），但同族用例 `test:memory-ui`（`:33`）用 `--loader:.ttf=empty`。这不是缺陷，只是提示：不同 UI 用例的 loader 约定不统一，改写时不要照抄。
- **R3【实测】**`test-all.mjs:161-164` 打印"超时用例（…未作为回归判定）"，但 `:154`/`:191` 的实际判据只检查 `baseline.has(n)`，超时用例若不在 baseline 仍会让门禁 `exit 1`。文案与行为存在不一致，规划引用"超时不算回归"时**不能**照抄该措辞。
- **R4【实测】**`test-all.mjs:4` 注释称"仓库有 290+ 个 `test:*` 脚本"，`test-baseline.json.$basis` 称"default 套件由 249 降为 241 个用例"，而本次 `--list` 实测为 **242** 个用例。数字随仓库演进，规划中**不要**把 241/249 之类常数写进验收标准（与 `AGENTS.md` "不要硬编码版本/数量" 的既有纪律一致）。
- **R5【实测】**`docs/mybuddy-core-convergence-plan-2026-09-12.md:258` 是仓库内唯一提到 `ExecutionFailureRepository` 的规划文档，其描述聚焦"按任务保存 causeCode…"等**行为**，并未给出"全仓构造点 ≤2"的机械断言。本轮未在仓库内找到包含"Phase 0.1 ≤2 处命中"原文的规划文件（`out/plan-review/` 在本轮之前不存在，`docs/`、`artifacts/` 亦无该措辞）→ 该标准应来自规划正文（本轮输入），建议连同 F1 一并改稿。

---

## 9. 实测/推断对照总表

| 编号 | 结论 | 类型 | 关键证据 |
| --- | --- | --- | --- |
| Q1 | 9 个脚本全部存在，0 缺失 | 实测 | `package.json:21,28,35,36,39,60,85,341,343` + 底层文件 Test-Path 全 True |
| Q1b | 6 个必绿用例都在 `test:all` 默认集合（242 个）内 | 实测 | `node scripts/test-all.mjs --list` |
| Q2 | `EXCLUDE_PATTERNS` 共 16 条，含 `-e2e$ -desktop$ -electron$ :live$` 等 | 实测 | `test-all.mjs:43-62` |
| Q2b | `test:project-materials-ui` **不**被排除，进入 default 门禁 | 实测 | 正则逐条比对 + `--list` |
| Q2c | ratchet：新增失败 exit 1，已知失败容忍并打印，修好提示移除 | 实测 | `test-all.mjs:93-95,140-143,154-155,166-169,191` |
| Q3 | baseline 容忍失败 = 1 条（`test:project-agent`） | 实测 | `test-baseline.json:5-10` |
| Q4 | 裸跑 `test:project-materials-ui` 在本机必失败，需 `env -u ELECTRON_RUN_AS_NODE` | 实测（环境值 + 命令原文 + 用例代码）+ 推断（失败形态） | `package.json:85`、`$env:ELECTRON_RUN_AS_NODE=1`、`project-materials-ui-test.cjs:1-6`、`AGENTS.md:10`、`test-all.mjs:106-109` |
| Q5 | 全仓 87 处命中（scripts 78 / src 6 / svg 3），`≤2` 不可达 | 实测（计数） | 上文 §5.1/§5.2/§5.4 的 file:line 清单 |
| Q5b | 该标准与"`test:memory`/`test:agent-loadout`/`test:execution-restart-recovery` 保持绿"自相矛盾 | 推断（基于 Q5 与 §5.3 的实测代码行） | `memory-kernel-test.ts:35,473,485`、`agent-loadout-test.ts:125`、`execution-restart-recovery-test.ts:18` |
| Q6 | 6 个必绿用例当前为绿 | 推断 | baseline 无它们 + `pi-legacy-purge.md:83` 记录 0 新增回归（本轮未执行测试，见 §0 边界声明） |

## 10. 核查局限（未做的验证）

1. **未运行任何测试**（受"唯一允许写入"约束）："当前是否绿"、"≤2 标准改写后 `src/` 能否降到 1"均为推断，未实测执行。
2. 计数排除了 `node_modules`、`out`、`release-mybuddy*`、`.git` 与隐藏目录（`.wb-ref`、`.tmp-pi104-patch-coding`）。若规划把隐藏参考目录也计入"全仓"，命中数只会**更大**，结论方向不变。
3. 未逐条运行 `EXCLUDE_PATTERNS` 的 16 条正则做穷举匹配程序化证明；采用人工逐条比对 + `--list`（242 个用例名单）复核，对 `test:project-materials-ui` 的判定已被 `--list` 直接证实。
4. 规划正文（含 Phase 0.1 原文措辞）不在仓库内，本轮依据调用方转述的声明文本核对；若原文实际上写的是"`src/` 内 ≤2"，则 F1 的"自相矛盾"判定应降级为"措辞歧义"，但 Q5 的计数事实不变。
