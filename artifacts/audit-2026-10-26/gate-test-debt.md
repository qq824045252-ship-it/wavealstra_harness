# 测试 / 门禁债务审计（2026-10-26）

- 审计对象：`/home/vivion/github/wavealstra_harness`，HEAD `230e8b1`（main），审计人 gate-auditor。
- 方式：只读仓库；**未跑完整 `test:all`**（由 Lead 并行执行），只跑单条 `test:<name>` / `--list` / typecheck / 静态统计脚本。唯一写入本报告。
- 每条结论标注 **【已验证】**（命令输出或 file:line）或 **【推测】**。

## 0. 环境与已执行命令

| 项 | 值 | 备注 |
|---|---|---|
| node / pnpm（本机） | `v26.7.0` / `12.14.0` | 【已验证】`node -v`、`pnpm -v` |
| `packageManager` / `engines` | **均未设置**（`package.json`） | 【已验证】选版靠"本机装了什么" |
| lockfile | `lockfileVersion: '9.0'`，含 `settings:`/`overrides:`/`patchedDependencies` | 【已验证】`pnpm-lock.yaml:1` |
| workspace 配置 | `pnpm-workspace.yaml` 使用 `verifyDepsBeforeRun: false`(:6)、`allowBuilds:`(:13)、`minimumReleaseAgeExclude:`(:32) | 均为 pnpm 10+/12 特性 |
| `test:*` 脚本数 | **321**（`package.json:356` 起） | 【已验证】 |
| 默认套件 | **260** | 【已验证】`node scripts/test-all.mjs --list` → `选中 260 个用例` |
| 本报告执行 | `pnpm -s typecheck`、`npx tsc -p tsconfig.scripts.json`、`pnpm -s test:project-agent`、`pnpm -s test:browser-open-guard`、`pnpm -s test:models-settings-overlay`、`pnpm -s test:artifact-gate`、`pnpm -s test:harness-quality`、`pnpm install --frozen-lockfile --lockfile-only --offline`、若干只读 node 统计 | 均 ≤ 5 min，无 GUI |

> 审计期间工作树出现 10 个 `artifacts/**/results.json` 的 `M` 状态 —— 来自 Lead 正在跑的 `test:all`，本身就是下面 §3.4 的证据。

---

## 1. typecheck 现状

### 1.1 退出码：0，但不是"干净"

【已验证】

```
$ pnpm -s typecheck
$ tsc --noEmit -p tsconfig.web.json && tsc --noEmit -p tsconfig.node.json && node scripts/typecheck-scripts.mjs
[typecheck-scripts] scripts/ 错误 209 条 · 基线 209 条 · 新增 0 · 已修复 0
[typecheck-scripts] OK：没有新增错误。
real 0m7.944s   EXIT=0
```

- `tsconfig.web.json` / `tsconfig.node.json`（均 `strict: true`）确实是干净的；红灯全部被 `tsconfig.scripts.json` 的棘轮以"基线"形式吞下。
- **P1 / 【已验证】** 209 条基线是**今天（`generatedAt: 2026-10-26T09:06:53Z`，`scripts/typecheck-baseline.json:3`）冻结的现状**，即棘轮由提交 `a571b0b`（2026-10-26 17:07 +0800，feat(test): scripts/ 静态检查棘轮）引入时就已欠 209 条，不是"历史遗留正在还"。棘轮拦的是"第 210 条"，不要求减少。

### 1.2 209 条基线错误的分布

【已验证】从 `npx tsc --noEmit -p tsconfig.scripts.json` 原始输出（1286 行）与 `scripts/typecheck-baseline.json` 去重键统计：

| TS 码 | 条数 | 含义 |
|---|---|---|
| TS2307 | 31 | 模块/声明找不到 |
| TS2339 | 30 | 属性不存在 |
| TS2741 | 30 | 缺少必填属性 |
| TS2322 | 23 | 类型不可赋值 |
| TS2345 | 23 | 参数类型不匹配 |
| TS2353 | 14 | 对象字面量未知属性 |
| TS2451 | 14 | 全局作用域重复声明（同文件/跨文件） |
| TS2882 | 11 | CSS 等 side-effect import 缺声明 |
| TS2367 | 4 | 恒假比较 |
| TS2304 | 4（9 处） | **找不到名字（未定义标识符）** |
| TS2554 / TS2740 / TS2393 / TS2416 / TS2739 / TS2550 等 | 其余 | 参数个数、重载、重复实现等 |

涉及 **98 个文件**。错误最多的文件：`wave5a-preview-entry.tsx` 17、`architecture-test.ts` 10、`project-event-promotion-test.ts` 9、`remote-renderer-regression-fixture.tsx` 9、`browser-external-open-guard-test.ts` 8、`models-settings-overlay-test.ts` 8。

### 1.3 这 209 条落在哪些测试上（关键）

【已验证】按"文件是否被 test:* 直接引用"分类：

| 归属 | 条数 | 占比 | 说明 |
|---|---|---|---|
| default 套件（gate 会跑） | 147 | 70% | 例如 `architecture-test.ts`(10)、`project-event-promotion-test.ts`(9)、`chat-markdown-test.ts`(4) |
| 仅 live/排除套件（gate 从不跑） | 20 | 10% | `browser-external-open-guard-test.ts`(8)、`models-settings-overlay-test.ts`(8)、`durable-bot-test.ts`(3) |
| 未直接接入任何 test:*（孤儿/间接） | 42 | 20% | `wave5a-preview-entry.tsx`(17)、`remote-renderer-regression-fixture.tsx`(9)、`_tmp_actual_wavealstra_execution_probe.ts`(1) |

结论：**两成被容忍的错误在"根本不跑"的代码里**；另有 10% 在"从不被验证"的排除套件里（见 §2）。

### 1.4 "引用已不存在模块/符号"意味着什么：四类，风险不同

**T1 真死（模块/生成物不存在）——4 条【已验证】**

- `scripts/_tmp_actual_wavealstra_execution_probe.ts:3` → `../src/main/execution/ExecutionControlPlane` 不存在（`src/main/execution/` 下无此文件）。
- `scripts/retrieval-eval/r3-eval-runner.ts:19` → `../src/shared/agent-ipc` 相对层级错（正确应是 `../../src/shared/agent-ipc`，该文件存在）。
- `scripts/wave5-real-open-entry.tsx:23` → `../../../shared/artifact-types` 不存在（`shared/` 只有 `package.json` + `src/`）。
- `scripts/pdf-worker-inline-entry.ts` → `../out/tests/pdf.worker.legacy.iife.txt`（构建产物，仓库里没有）。

**T2 类型失明（tsconfig 缺 path alias）——27 条【已验证】**

`tsconfig.scripts.json` 没有 `paths`（对比 `tsconfig.web.json:17-20` 有 `@/*`、`@shared/*`），于是 `@/store/appStore`、`@/types`、`@/components/...`、`@shared/agent-ipc`、`@shared/terminal-ipc` 全部 TS2307。**这些 import 在运行期由 esbuild 的 `--alias:@=...` 解析，能跑；但 tsc 把它们变成 `any`** —— 也就是说对这些文件，棘轮本来要防的"服务契约漂移"完全看不见（这正是 `typecheck-scripts.mjs` 头注释里 DurableDomainTools 事故的防线）。

**T3 契约漂移（测试 fixture 落后于当前 DTO）——约 100 条【已验证 + 推断】**

典型例子：`ProjectEventPromoteRequest` 现在 `eventId` 是必填（`src/shared/project-domain.ts:566-567`），而多个测试仍传 `{ targetKind: "memory", ... }`（baseline 里 9 条 "Property 'eventId' is missing"）——测试仍然绿，因为运行时容忍缺字段，**说明新增 eventId 的语义路径没有被测试覆盖**。同类还有 `SpaceDto.updatedAt`、`ArtifactSource.storagePath`、`ExternalAgentRunDto.permissionPolicy`、`RemoteTaskSummary.doneAckedAt` 等。这类不是"测试死了"，而是"测试测的是旧契约"。

**T4 未定义标识符（TS2304，9 处 / 4 个文件）——真的会在执行到该分支时 ReferenceError【已验证】**

- `scripts/artifact-machine-gate.ts:372,480,494` 使用 `basename(...)`，但该文件只 import 了 `existsSync, readdirSync, readFileSync, statSync` / `dirname, join, relative`（`artifact-machine-gate.ts:33-34`）。**这个文件就是 CI 步骤 `pnpm -s test:artifact-gate` 的执行体**（`.github/workflows/verify.yml:45`）。当前 32/32 通过（因为 `basename` 只在"发现违规"的分支里调用），一旦真出现违规，gate 会以 ReferenceError 崩溃而不是报出违规详情——失败仍是红，但诊断信息错位。
- `scripts/runtime-prewarm-test.ts:233,357,362` 的 `providerId`（default 套件 `test:runtime-prewarm`）；`scripts/wave5d2-quality-test.ts:121` 的 `XlsxStyle`；`scripts/dedupe-spaces.ts:77` 的 `memCount`（孤儿工具）。
- 这四个文件当前都能跑绿，说明这些分支是**死分支**——即"测试里存在永远不会执行、且执行即崩溃的代码"，baseline 让它不可见。

补充：TS2451（14 条）与 TS2393（2 条）集中在 `browser-external-open-guard-test.ts`、`models-settings-overlay-test.ts`。原因是这两个文件用 `const { readFileSync } = require(...)` + 无 import，被 tsc 当作全局脚本，两个文件的顶层 `ROOT/results/failed/...` 落在同一全局作用域互相冲突。**运行时无影响**（各自独立执行），但它说明 `tsconfig.scripts.json` 的 include 口径（`scripts/**/*.ts` 全量、`strict:false`）本身就在制造噪声。

### 1.5 棘轮自身的失效模式（比 209 条本身更值得修）

- **P0 / 【已验证（代码路径 + 正则复现）】fail-open**：`scripts/typecheck-scripts.mjs:51` 只解析 `path(l,c): error TSxxxx: msg` 行；`:65-67` 只读 baseline 的 `knownErrors`；`:104-112` 在 `added.length === 0` 时一律 `exit 0`。若 tsc 崩溃（OOM/找不到 typescript）或输出配置级错误（如 `error TS18003: No inputs were found`，无 `file(line,col)` 前缀），`current` 为空 → 脚本会打印"这些历史错误已不复现（209 条）… OK：没有新增错误"并 **exit 0**。我用 3 条样例行复现了该正则行为：配置错误行/崩溃输出均 `parsed: false`。
- **P1 / 【已验证】** `tsconfig.scripts.json:10` 是 `"strict": false`——隐式 any、strictNullChecks 等全部关闭，棘轮的灵敏度先天打折。
- **P1 / 【已验证】** baseline 的 key 是 `file :: code :: message`（`:61`），而 message 里含完整类型展开（见 `typecheck-baseline.json:6-13`）。类型定义一改，同一条错误就变成"新增 + 已修复"两条，噪声大、也容易掩盖真实新增。
- **P2 / 【已验证】** `--update-baseline`（`:79-95`）只写 `$comment/generatedAt/knownErrors`，会丢掉任何 provenance 字段；`test-baseline.json` 那边更严重（见 §2.5）。

### 1.6 `scripts/_tmp_actual_wavealstra_execution_probe.ts` 为什么还在

【已验证】

- 37 行；`git log --diff-filter=A` 显示它来自 **initial commit `ff9e756`（2026-10-05，Initial commit: current MyBuddy project）**，即一次性批量导入带进来的，之后无人动过。
- 内容是某次真实项目探针：硬编码 `C:\Users\servi\OneDrive\project\韦威恩`、`ExecutionControlPlane`（已不存在）、`assert` 命令路由；既不是被引用的测试，也没进 package.json。
- 没被 `.gitignore` 挡住：`.gitignore:87` 是 `/scripts/.tmp-*`（`.tmp-` 下划线不匹配 `_tmp_`），`.gitignore:85` 只挡仓库根 `/.tmp-*`。
- 因为 `tsconfig.scripts.json` include `scripts/**/*.ts`，它的 TS2307 一直挂在 baseline 第 1 条。
- **P2 / 【已验证】** 结论：批量导入残留 + .gitignore 规则没覆盖，应直接删除；顺带把 `.gitignore` 的临时文件规则改成 `/scripts/.tmp-*` + `/scripts/_tmp-*`。

---

## 2. test:all 机制盲区

### 2.1 覆盖范围（实测数字）

【已验证】321 个 `test:*` = 自排除 3（`test:all`、`test:all:live`、`test:all:update-baseline`，`test-all.mjs:37`）+ **EXCLUDE 排除 58** + default **260**。

EXCLUDE_PATTERNS（`scripts/test-all.mjs:43-60`）命中的 58 个，按规则分组：

| 规则 | 数量 | 例子 |
|---|---|---|
| `/-e2e$/` | 10 | wave5a/5b/5c/5d1-3、pdf-runtime、artifact-open、wave4 |
| `/-desktop$/` | 11 | chat-attachment-acp、expert-binding、memory-lifecycle、computer-use、magpie、archive-deletion、task-status-dot… |
| `^test:remote-/` | 8 | remote-access / connection / done-ack / delete / db / task-cache / renderer-stdio / workspace-create |
| `:live$` | 8（另有 `test:all:live` 已归自排除） | compaction、multi-model-consult、conversation-branch、task-status-dot、acp-remote-android×3、remote-task-dot-android |
| `/-electron$/` | 5 | html-edit、local-capabilities、runtime-probe、core-performance、browser-screenshot |
| `^test:computer-/` | 5 | computer-use-recovery/automation/run/overlay/automation-windows |
| `^test:browser-/` | 4 | browser-refresh / navbar-ui / automation-recovery / open-guard |
| 精确单条 | 7 | `test:terminal`、`test:blender-skill`、`test:streaming-live`、`test:multi-search-live`、`test:durable-bot`、`test:workspace-files-ui`、`test:models-settings-overlay` |

### 2.2 这 58 个平时由谁验证：**没有人**

- 【已验证】CI 只有一个 job（`.github/workflows/verify.yml:50` 跑 `pnpm -s test:all`，不带 `--include-live`），没有 live job、没有定时 workflow、没有 `--include-live` 的其他入口。
- 【已验证】`test:all:live` 只在 `AGENTS.md:8` 和 `verify.yml:19` 的注释里被提到（本地手动）。
- **P0 / 【已验证】证据：排除套件已经烂了一条。** 实测
  `$ pnpm -s test:models-settings-overlay` → **8/9 passed，EXIT=1**，失败项 `explicit refresh bypasses cache for documents and subresources`。因为它在 EXCLUDE 里，`test:all` 永远绿。
  对照组：`pnpm -s test:browser-open-guard` → 6/6 PASS，`pnpm -s test:artifact-gate` → 32/32 PASS。
- 结论：**门禁绿 ≠ 全套健康**；'排除'实际等价于'删除'，但没有删除记录，也没有替代验证手段。

### 2.3 排除名单本身有洞：default 套件里混着 11 个会真正启动 Electron 的用例

【已验证】按 `package.json` 命令串 + cjs 源码静态核对（遵守规则未运行它们）：

直接 `electron ...` 启动的 8 个（都在 default）：`test:memory-ui`、`test:tray`、`test:expert-ui`、`test:project-create-folder-ui`、`test:project-materials-ui`、`test:project-activity-ui`、`test:consult-card-ui`、`test:settings-records-ui`。

node driver 内部 spawn Electron 的 3 个（都在 default）：
- `test:svg-preview-resize`（`scripts/svg-preview-resize-ui-test.cjs:5,25` 里 `require('electron')` + `spawnSync(require('electron'), ...)`）
- `test:consult-selection`（`scripts/run-consult-selection-test.cjs:5-12` 里 `BrowserWindow`）
- `test:consult-entry:desktop`（`scripts/consult-entry-electron-test.cjs` 真实 Electron；**名字用 `:desktop` 结尾，`/-desktop$/` 匹配不到**，只差一个分隔符）

另外嵌套入口绕过排除：【已验证】`test:core-performance-all` = `pnpm build && pnpm test:core-performance && pnpm test:core-performance-electron && ...`，其中 **`test:core-performance-electron` 本身是被 EXCLUDE 的 Electron 用例**，但通过嵌套回到了 default 套件，且前面还先跑一次完整 `pnpm build`（墙钟风险）。

- **P0 / 【已验证】** 这与 `test-all.mjs:9`、`AGENTS.md:7` 的"default 套件排除 GUI/CDP/GPU"直接矛盾：default 套件实际会开 Electron 窗口，JOBS=4 时可能同时开多个；Linux 上没有合成器时甚至要靠 `scripts/ui-capture.cjs` 的降级才不挂死（该文件头注释记录了 6 个用例 45~300s 超时）。
- **P1 / 【已验证】** 命名型排除规则不可靠：`test:all` 用正则匹配"名字"，任何新命名（`-ui`、`:desktop`、`*_desktop`）都会漏；也没有任何测试校验"EXCLUDE 命中的名字都是非 headless"或反之。

### 2.4 唯一已知失败 `test:project-agent` 的现状：仍然红，产品决策仍未决

【已验证】

```
$ pnpm -s test:project-agent      # 1.6s，EXIT=1
AssertionError: Execution audit must preserve the rejected requested Expert decision
+ actual: undefined   - expected: 'project_policy_denied'
```

- 断言位置：`scripts/project-agent-integration-test.ts:233-237`（`snapshots[0].resolvedCapabilities` 中 expert 项的 `reason`）。
- 与 `scripts/test-baseline.json:8-9` 的 `$remaining` 描述**完全一致**：拒绝策略 `expert.deny=["blocked-expert"]`（同文件 `:41`）确实传入，执行前的 `inspectRuntimeContext` 包含该 Expert，但**执行审计快照丢掉了被拒的 Expert 及其 reason**。
- 时间线：基线首次建立于 `5cf6f82`（2026-10-09），该断言来自 initial commit `ff9e756`（2026-10-05）——**至少 17 天、跨 3 个 Pi 升级（1.0.4→1.3.0）一直红**。
- 决策状态：【已验证】`docs/` 与 `artifacts/` 里只有转述，没有结论（`artifacts/plan-review/T8-acceptance-scripts.md:222-224` 原样引用 `$remaining`；`docs/refactor-plan-verified.md:80,132` 把它当"当前仅 1 条"引用）。**即产品决策未做出，baseline 事实上成了无限期豁免。**
- 【已验证】失败是确定性的（1.6s、每次都同样断言），不是 flaky。

### 2.5 baseline 机制会不会让问题不可见：会，而且能一键扩大遮蔽面

【已验证】（`scripts/test-all.mjs`）

1. **长期失败不可见**：已知失败只打印并 `exit 0`（`:152,186-189`）。CI 日志里会出现一行 `FAIL test:project-agent [baseline 已知]`，但结果是绿；没有责任人、截止期、issue 链接。
2. **已修复未删条目不可见**：`:153,164-167` 只打印"可从 baseline 移除"的提示，不影响退出码；没有任何 CI 检查"baseline 里不应存在当前能通过的条目"。
3. **`--update-baseline` 是单点掩盖风险**：`:174-183` 会把**当次所有失败（含超时、含新回归）**写成 `knownFailing` 并 `exit 0`；同时它只写 `$comment/generatedAt/knownFailing` 四个字段，**会删掉现有 `$basis`（`test-baseline.json:3`）和 `$remaining`（`:8-9`）**——也就是文档承诺的"修复后请用它重写"这一步会顺手抹掉"为什么容忍"的全部记录。
4. **超时归因自相矛盾**：`runOne` 把 killed 视为 `ok:false`（`:120-121`），`runPool` 把它推入 `failed`（`:132-138`），`newRegressions = failed - baseline`（`:152`）→ **超时确实会造成门禁失败**；但 `:160` 打印"超时用例（>300s，未作为回归判定）"。文案与行为相反，误导排障方向。
5. **空测试无法识别**：机制只看退出码，见 §3.2（`test:opendesign-smoke` 恒绿）。

### 2.6 并行 / 超时 / 子进程清理

- 【已验证】`JOBS` 默认 **4**（`:68`，可用 `TEST_ALL_JOBS`/`--jobs=` 覆盖）；单用例墙钟 **300s**（`:72`）；而 `test-guard.mjs:28` 默认 **900s** —— 聚合层先杀，**test-guard 的超时实际永不生效**，护栏的"整树 kill"（`test-guard.mjs:134-149`）也用不上。
- **P1 / 【已验证】超时只杀 shell，不杀进程树**：`:111-118` 是 `spawnSync("pnpm", [...], { shell: true, timeout: 300s, killSignal: "SIGKILL" })`。`shell:true` 下被 SIGKILL 的是 `sh -c`（Windows 是 cmd），其下的 `pnpm → esbuild/node/electron` 孙子进程**不会**被回收；这些残留进程会继续持有端口、临时目录、`~/.mybuddy` 锁和 CPU，污染并行队列里的后续用例。test-guard 的 `taskkill /T` / 进程组 kill 保护不到这一层。
- 【已验证】`stdio: "ignore"`（`:113`）→ CI 日志**没有失败用例的任何输出**，只有 PASS/FAIL 名单；artifact 也没有上传。
- 无并发资源分配机制：端口/临时目录/DB 全靠各测试自觉（见 §3.4）。

---

## 3. 测试质量

### 3.1 源码文本断言比例

【已验证】以"被某个 test:* 命令直接引用的入口脚本"为分母（349 个）：

| 口径 | 数量 | 比例 |
|---|---|---|
| `readFileSync(` 且 `.includes(`（宽口径，读到的可能是 `out/tests` 产物、fixture、配置） | 93 | **26.6%** |
| 明确 `readFileSync` 读 `src/`、`app/`、`shared/` 下的实现源码 | 28 | **8.0%** |
| 两者交集（读实现源码并做文本匹配） | 27 | 7.7% |

- 结论：`AGENTS.md:9` 声称"30% 的测试文件 grep 实现源码"，实测**宽口径 26.6%、严格口径 8.0%**——文档口径本身未经核对（见 §5.4 文档漂移）。
- 典型不可维护例子：
  - `scripts/chat-scroll-anchor-test.ts:5-7` 读 `ChatView.tsx`/`ChatInput.tsx`/`global.css`，`:11-30` 用 16 条正则锁定具体实现（`const resetAndPin = (): void =>`、`Math.min(top, maxScrollTop)`、CSS 选择器文本……）——正确重构必红。
  - `scripts/professional-tools-test.ts:467-469`：`assert(shared.includes('PENPOT_ORIGIN = "http://localhost:9001"'))` 之类对源码字面量的断言。
  - `scripts/architecture-test.ts`、`btw-architecture-test.ts`、`pi-codemode-auto-test.ts`、`model-management-refresh-test.ts` 等同族。
- 这些文件同时也在 §1.3 的 147 条 typecheck 债里（`architecture-test.ts` 10 条），说明"文本断言型测试"是债的集中区。

### 3.2 没有真正断言 / 只 smoke 的用例

【已验证】人工核对：启发式扫描出 21 个"无 assert/expect/pass-fail 计数器"的入口，其中 19 个是 `.cjs` driver + `.tsx` fixture（断言在 driver/fixture 的另一半，如 `project-materials-ui-test.cjs` 大量 `assert`）、构建 stub 或 fixture（`*-store-stub.ts`、`gateway-electron-stub.ts`）、`build-*.mjs` 构建器。**真正"空测试"2 个，且都在 default 套件：**

1. **`test:opendesign-smoke`** → `scripts/opendesign-smoke.ts:6` 无条件 `process.exit(0)`，注释写明"本脚本保留文件名以免旧 CI 任务找不到入口"——功能已下线，入口还留着，**每次门禁都白送一个绿**。
2. **`test:expert-market`** → `scripts/expert-market-smoke.ts` 全程 `console.log`，无任何断言；install 失败被 `try/catch` 吞掉后只打印（同文件 `:36-40`），进程仍 exit 0。

- 危害：棘轮只认退出码，这两条让"260 个用例"的计数虚高，也会让"以前绿现在红"的历史对比失真。

### 3.3 test-guard 的隔离：HOME 沙箱已修一批，但仍有漏口

【已验证】`test-guard.mjs:61-72` 默认给子进程注入临时 `HOME/USERPROFILE/XDG_CONFIG_HOME/XDG_CACHE_HOME/XDG_DATA_HOME/XDG_STATE_HOME`，并在结束时删除（`:155-158`，`GUARD_KEEP_HOME=1` 可保留）；`GUARD_HOME=host` 可关闭——**全仓库没有任何脚本使用 `GUARD_HOME=host`**（grep 只命中 test-guard 自身注释/默认值），即所有走护栏的用例都已隔离。

修复历史（证明污染真实存在，而不是理论风险）：

- `cc32b2b`（2026-10-26 16:39）：11 个用例只设 `USERPROFILE` 没设 `HOME`，POSIX 下 `os.homedir()` 读 `HOME`，夹具技能被写进真实 `~/.mybuddy`，**`memory-skill-revision` 因此 `evaluated=9` 失败**（跨用例污染 → 假失败）。
- `78f71e0`（2026-10-26 17:52）：**一次全量门禁就往真实 `~/.mybuddy/library` 塞 168 份重复 demo 文档**（library-*、project-event-*、work-graph-*、knowledge-lifecycle、core-performance 等 20 个用例）。

仍有 4 个漏口：

1. **P1 / 【已验证】20 个 default 用例完全绕过 test-guard**（`package.json` 中命令不含 `test-guard.mjs`），其中 11 个是 Electron（§2.3）、9 个 node 直跑：`test:html-edit-source`、`test:core-performance-mybuddy-startup`、`test:chat-scroll-anchor`、`test:cad`（嵌套 7 个）、`test:pdf-runtime-compat`、`test:ipc-channel-inventory`、`test:consult-selection`、`test:pi-host-boundary`、`test:magpie-agent-mybuddy`、`test:core-performance-all`。它们**没有 HOME 沙箱、没有内存上限、没有 900s 护栏**，只有 test:all 的 300s。
2. **P1 / 【已验证（配置）+ 推测（触发）】Windows 上隔离不完整**：guard 只重定向 `HOME/USERPROFILE/XDG_*`，**没有重定向 `APPDATA`/`LOCALAPPDATA`**。而主进程代码有读 `APPDATA` 的路径：`src/main/mcp/McpConfigService.ts:279`、`src/main/capabilities/subagent/invocation.ts:47-49`、`src/main/external-agent/ExternalAgentRuntime.ts:161`、`src/main/remote/RemoteUsbBridge.ts:97`；`scripts/professional-tools-test.ts:36-38` 直接读 `process.env.LOCALAPPDATA`。CI 主平台恰恰是 Windows（§5），这条缺口在 CI 上可能让用例读到/写到真实用户 profile。
3. **P1 / 【已验证】`test:tray` 没有隔离 Electron userData**：`scripts/tray-service-test.cjs` 全文没有 `app.setPath('userData', ...)`（其它 UI 用例都有），TrayService 初始化会落到真实 Electron profile。
4. **P2 / 【已验证】`test:consult-entry:desktop` 读真实用户数据**：`scripts/consult-entry-electron-test.cjs:17-20` 从 `os.homedir()/.mybuddy` 复制 `auth.json/models.json/models-store.json/capabilities.json` 到临时目录——**测试结果依赖本机是否登录过**，在干净 CI/新开发机上行为可能不同。

### 3.4 共享状态 / 固定路径 / 并行 flaky 证据

- **固定端口**：【已验证】`src/main/gateway/webhook-port.ts:17,20` 定义 `WEBHOOK_PORT_CANDIDATES = [52330, 52490, 39140, 39141]`、`DEFAULT_WEBHOOK_PORT = 52140`；`scripts/gateway-port-fallback-test.ts:47-56` 会**故意占用** 52140 + 前两个候选。JOBS=4 时若另一个用例/本地 dev 实例（真实 MyBuddy 网关）同时在用这些端口，就是确定性 flaky。grep 显示目前只有这一个测试用固定端口，故 **P2**。
- **freePort TOCTOU**：【已验证】21 个测试用 "bind(0) → 取端口 → close → 再 bind" 的写法（`scripts/memory-gateway-controller-test.ts:13` 的 `freePort()`，以及 archive-deletion-desktop、durable-bot-desktop、expert-binding-desktop、pi-codemode-auto-desktop-live…）。close 到 re-bind 之间端口可被并行用例抢走 → 偶发 `EADDRINUSE`。
- **共享固定目录**：【已验证】`scripts/svg-preview-resize-ui-test.cjs:3` 与 `scripts/streaming-live-test.cjs:7` 都把产物写到 `out/tests/streaming-live/`；多个 UI 用例的 profile/截图也集中在 `out/tests/`（`project-materials-ui-test.cjs:6-7` 等）。`out/` 虽被 `.gitignore:2` 忽略，但磁盘目录是共享的。
- **固定 sleep/超时等待**：【已验证】7 个 default 文件用 `await new Promise(r => setTimeout(r, N))` 做同步：`durable-bot-test.ts`、`gateway-durable-test.ts`、`pi-reasoning-stream-test.ts`、`remote-startup-reconnect-test.ts`、`selection-popover-e2e.ts`、`task-expert-binding-test.ts`、`workspace-shared-context-ui-race-test.ts`。JOBS=4 抢占 CPU 时，固定 sleep 是最典型的偶发失败来源（`12d0d3b` 已经因为"Pi 进程内 store 缓存竞态"把 magpie 断言改成落盘产物）。
- **P1 / 【已验证】门禁会把工作树写脏**：10 个 default 用例把结果写进**被 git 跟踪的** `artifacts/**/*.json`（含 `new Date().toISOString()` 时间戳和结果）：
  `pi-native-control-test.ts:130-131`、`pi-codemode-auto-test.ts:24`、`minimal-coding-mode-test.ts:120-121`、`pi-host-control-test.ts`、`pi-host-boundary-audit.cjs`、`pi-codemode-auto-ui-test.ts`、`pi100-features-test.ts`、`pi100-model-admission-test.ts`、`pi104-features-test.ts`、`pi104-model-compat-test.ts`。
  本次审计期间（Lead 跑 test:all）`git status` 恰好出现 **10 个 `M artifacts/**/results.json`**，diff 只是时间戳。后果：门禁后工作树永远不干净、易被误提交、并行跑两次互相覆盖、`git diff` 噪声掩盖真实改动。
- 历史佐证（近 300 提交）：`687ba52`（consult-card-ui 消除偶发失败）、`78f71e0`（HOME 隔离）、`cc32b2b`（POSIX 可复现性）、`12d0d3b`（竞态改落盘断言）——4 次"类 flake 修复"。

---

## 4. 孤儿 / 冗余

### 4.1 数量

【已验证】（脚本枚举 `scripts/` 下 479 个代码文件 + `package.json` 引用关系）

| 指标 | 数量 |
|---|---|
| `scripts/` 代码文件（ts/tsx/cjs/mjs/js） | 479 |
| 被某个 `test:*` 命令直接引用（= 入口测试文件） | 349 |
| **未被任何 `test:*` 引用** | **130** |
| ├─ 名字像测试（test/spec/smoke/check/verify/probe） | 48 |
| │  ├─ 被非 test 脚本（build/helper）引用 | 2 |
| │  └─ **在任何 package.json 脚本里都找不到引用（完全孤儿）** | **46** |
| └─ 其余为构建/工具脚本（被其它脚本间接引用） | 82 |
| 从任意 package.json 脚本出发**传递不可达**的文件 | 97（其中 test-ish 48） |

完全孤儿的例子（46 个，节选）：`consult-selection-hook-test.tsx`、`generation-speed-test.ts`、`mcp-discover-test.ts`、`mcp-mode-live-check.ts`、`mcp-native-security-test.ts`、`model-update-live-test.ts`、`plugin-storage-test.ts`、`remote-client-regression-test.ts`、`remote-image-access-test.ts`、`remote-startup-reconnect-test.ts`、`request-user-input-ui-test.ts`、`selection-comment-ui-test.cjs/.tsx`、`selection-popover-e2e.ts`、`skill-market-test.ts`、`skill-root-guard-test.ts`、`space-workspace-cwd-test.ts`、`test-space-uniqueness.ts`、`thinking-levels-test.ts`、`workspace-shared-context-ui-race-test.ts`、`_tmp_actual_wavealstra_execution_probe.ts`、`phase15-verify.ts`、`html-edit-app-smoke.cjs`、`models-portable-electron-test.cjs`、`shell-preferences-desktop-test.cjs`、`run-remote-image-tests.cjs`、`run-remote-regression.cjs`、`verify-blender-skills.ts`、`verify-regenerate.mjs`、`verify-ardot-skills.mjs` 等。

> 注意：这 46 个里有相当一部分**曾经是测试入口**（例如 `remote-*`、`shell-preferences-desktop-test.cjs`、`selection-comment-ui-test.*`），现在既不在 `test:*`、也不被任何脚本引用 —— 属于"删入口不删文件"的沉淀。

### 4.2 `package.json` 里指向已不存在脚本的 `test:*`：**0 条**

【已验证】把 321 条 `test:*` 命令里的所有 `scripts/`、`src/`、`app/`、`shared/` 源文件引用逐一 `fs.existsSync` → **0 缺失**（其余"看起来缺失"的都是 `out/tests/*.cjs` 构建产物，属正常）。

但存在**反向冗余**：功能已删除、入口仍保留（`test:opendesign-smoke`，见 §3.2），用壳脚本"占位保 CI 入口"。这类应该清理或明确标记为 skip。

### 4.3 重复 / 近重复

- 【已验证】`scripts/pi100-features-test.ts` 与 `scripts/pi104-features-test.ts`：58 vs 69 行，diff 仅 37 行（注释版本号 `Pi 1.0` vs `Pi 1.3.0`、临时目录前缀 `pi100-` vs `pi104-`）；两者**都在 default 套件**（`test:pi100-features`、`test:pi104-features`），typecheck baseline 里两者报同一批错误。1.0 已被淘汰（`AGENTS.md:6`、`test-baseline.json:3`），pi100 这份是历史副本。
- 另有 `wave5a/b/c/d*-quality-test.ts` 一族、`pi100/pi104-model-*` 一族结构高度相似（未逐行 diff，【推测】可合并）。
- `browser-navbar-ui-test.cjs` + `.tsx`、`selection-comment-ui-test.cjs` + `.tsx`、`remote-renderer-regression-test.cjs` + fixture 属 driver/fixture 成对，**不是**重复，但其中后者整体已是孤儿（§4.1）。

### 4.4 仓库里的临时/探针文件

`scripts/` 下存在成批非测试的探针/一次性文件：`_tmp_actual_wavealstra_execution_probe.ts`、`probe-main.mjs`、`model-runtime-init-probe.ts`、`pty-host-probe.ts`、`pty-load-probe.cjs`、`ardot-mcp-probe.mjs`、`diag-full.mjs`、`monaco-spike*`、`office-spike*`、`shiki-spike.mjs`、`transition-spike.cjs`、`wcv-cdp-spike.cjs`。除 `_tmp_*` 外多数可用（手工工具），但**没有清理边界**，加上 `.gitignore` 只挡 `.tmp-`，`_tmp_` 这类会永久沉淀（§1.6）。

---

## 5. CI（`.github/workflows/verify.yml`）

### 5.1 实际配置

【已验证】

| 项 | 值 | 行号 |
|---|---|---|
| 触发 | push→main、pull_request、workflow_dispatch | `:8-12` |
| 并发 | cancel-in-progress | `:14-16` |
| 平台 | **只有 `windows-latest`** | `:20` |
| 超时 | 90 min | `:21` |
| pnpm | `pnpm/action-setup@v4` + `version: 9` | `:24-27` |
| node | 22 | `:29-31` |
| 安装 | `pnpm install --frozen-lockfile` + **`continue-on-error: true`** | `:34-36` |
| 门禁步骤 | `pnpm -s typecheck` → `test:harness-quality` → `test:artifact-gate` → `test:all` | `:38-50` |

### 5.2 版本假设与仓库现状不一致

- 【已验证】仓库**没有** `packageManager` / `engines` / `volta`（`package.json`），本地实际 pnpm `12.14.0`、node `v26.7.0`；CI 固定 pnpm `9`、node `22`。**三个维度（包管理器大版本、node 大版本、装包策略）全部漂移**，且没有任何机制阻止本地升级 pnpm 后 CI 悄悄落后。
- 【已验证】`pnpm-workspace.yaml` 用了 pnpm 10+/12 才认识的字段：`verifyDepsBeforeRun`（:6）、`allowBuilds`（:13）、`minimumReleaseAgeExclude`（:32）。lockfile 版本 `9.0` 本身 pnpm 9 能读，且【已验证】`pnpm install --frozen-lockfile --lockfile-only --offline` 在本机 90ms 通过（lockfile 与 package.json 同步，无缺失）。
- 【已验证】`node_modules/.modules.yaml` 记录 `"packageManager": "pnpm@12.14.0"` —— 本机依赖树是按 pnpm 12 装的、按 12 的构建许可策略构建的。
- 【推测】pnpm 9 会忽略 `allowBuilds`（构建脚本放行名单）与 `verifyDepsBeforeRun`，安装/构建行为与本地不同（哪些 postinstall 跑、依赖校验是否发生）。结合 `continue-on-error`，这类差异很难在 CI 上定位。lockfile 兼容性本身未见问题（两者都写 `lockfileVersion 9.0`）。

### 5.3 `continue-on-error: true` 的后果

- 【已验证（语义）】安装失败**不会**在该 step 失败，流程继续；后续 `typecheck`/`test:all` 才各自报错，**真实根因（装包失败）被埋在两个报错之后**。
- 若失败只发生在 optional/二进制依赖（`electron` 下载、`better-sqlite3`/`node-pty` 原生构建），typecheck 仍绿、而 default 套件里的 11 个 Electron 用例会成批红——排障时极易被误判为"UI 测试又 flaky"。
- 它同时意味着"CI 的依赖状态"不可断言：一个半装环境也可能让部分用例通过，门禁结论不再是"代码状态"的干净函数。
- 另外 `.npmrc` 指向 `registry=npmmirror.com` + `electron_mirror=npmmirror.com`（`.npmrc:1-2`），在 GitHub 托管 runner 上多了一个境外可用性依赖，正好被 `continue-on-error` 掩盖。

### 5.4 覆盖范围：没有 Linux / macOS job 的实际影响

- 【已验证】CI 覆盖 typecheck + default 套件 + 两个专项；**不覆盖** 58 个 live/GUI 用例、不覆盖 `test:all:live`。
- 【已验证】提交 `cc32b2b`（2026-10-26）整批修的都是**只在 POSIX/Linux 暴露**的门禁问题：11 个用例只设 USERPROFILE 未设 HOME、隐藏窗口 `capturePage()` 在无合成器时挂死（6 个 Electron UI 用例 45~300s 超时）、`rename` 权限语义、中文长文件名 `ENAMETOOLONG`。**这些问题 Windows CI 一个都发现不了**，只能靠 Linux 开发者踩到再修。
- 反向同理：Windows 特有路径（`APPDATA`/盘符/UNC/UIA）也不会在 Linux 上被覆盖，而 CI 只有 Windows —— "本机绿/CI 红"与"CI 绿/本机红"两个方向都没有对照。
- 结合 §2.3：default 套件里 11 个 Electron 用例在 Linux 上依赖 `ui-capture` 的降级路径；一旦再出现 capturePage 类问题，Linux 的全量门禁会集体超时，而 CI 全绿。

### 5.5 超时预算与可观测性

- 【已验证】`timeout-minutes: 90`，但 `test:all` 本身无总预算：260 用例 / JOBS=4 / 单条上限 300s，**最坏 5.4 小时**。一旦多个用例超时（Linux UI 截图历史就是这样），GitHub 会在 90min 砍掉 job，门禁表现为"被取消"而不是"用例红"，且由于 `stdio: "ignore"` 没有任何失败日志可看。
- 【已验证】没有 `actions/upload-artifact`、没有失败用例日志、没有 junit/coverage 输出。
- 【推测】若按平均 20~30s/用例估算，正常一次全量约 25~35min，90min 余量尚可；风险集中在超时用例或 `pnpm build` 型入口（`test:core-performance-all`）。

### 5.6 文档 / 计数漂移（顺带发现）

【已验证】

| 文档声明 | 实测 | 位置 |
|---|---|---|
| "只支持当前 Pi 版本（1.0.4）" | 仓库依赖是 **1.3.0**（`@earendil-works/pi-ai: 1.3.0`），baseline 也写 1.3.0 | `AGENTS.md:6` |
| "290+ 个 test:* 脚本" | **321** | `test-all.mjs:5`、`AGENTS.md:7` 隐含 |
| "default 套件 241 个用例" | **260**（`--list` 实测） | `test-baseline.json:3`、`docs/refactor-plan-verified.md:132`、`docs/settings-ui-search-consult-cleanup-2026-10-09.md:54` |
| "30% 测试文件 grep 实现源码" | 26.6%（宽）/ 8.0%（严格） | `AGENTS.md:9` |
| "default 套件排除 GUI/CDP/GPU" | default 里仍有 11 个 Electron 用例 + 1 个嵌套 Electron 用例 | `test-all.mjs:9`、`AGENTS.md:7` |

---

## 6. 问题清单与建议（按优先级）

### P0

**G-01 排除套件无人验证且已腐烂；default 套件混入 GUI 用例**（§2.2、§2.3）
- 证据：`test:models-settings-overlay` 实测 8/9 fail（EXIT=1）但被 EXCLUDE；default 里 11 个 Electron 用例（8 直接 + 3 driver）、`test:consult-entry:desktop` 命名漏网、`test:core-performance-all` 嵌套 `test:core-performance-electron`。
- 影响：门禁绿不等于测试健康；GUI 用例在无头/无合成器 Linux 上随时可能集体超时，且从不进 CI。
- 建议：(a) 立刻修 `models-settings-overlay` 的失败或把它显式标 skip + issue；(b) 增加一个独立的 `live`/`desktop` CI job（或本地定时任务 + 结果 artifact），至少每周跑一次 `test:all:live`；(c) 把 EXCLUDE 从"名字正则"改成**显式清单**（外加脚本校验：清单内不得出现 headless-safe 用例，清单外若出现 `electron` 启动则门禁报错）；(d) 修 `test:consult-entry:desktop` 命名或改规则为 `/(^|[-:])desktop$/`；(e) 把 `core-performance-all`/`cad` 这类嵌套聚合拆开或标记为 excluded，避免嵌套绕过。

**G-02 test:all 的超时处理与子进程清理有缺陷**（§2.5-4、§2.6）
- 证据：`:120-121,132-138,152` 把超时算作 `failed/newRegressions`，而 `:160` 打印"未作为回归判定"；`:111-118` `shell:true + killSignal SIGKILL` 只杀 shell，不杀进程树；`:113` `stdio:"ignore"` 丢弃全部输出。
- 影响：超时会造成门禁假红（且文案误导）；超时用例的孙子进程残留，污染并行队列（端到端偶发失败的主要来源之一）；CI 无法定位任何失败原因。
- 建议：(a) 改用 `test-guard` 同样的进程组/taskkill 逻辑（或直接统一成"所有用例都必须经 test-guard 启动"）；(b) 把 `timedOut` 从 `failed` 中分离并显式定义策略（建议仍算回归，但文案必须一致）；(c) 失败时把子进程输出落临时文件/artifact，不要 `stdio:"ignore"`。

### P1

**G-03 typecheck 棘轮：209 条冻结于今日，且存在 fail-open 与类型失明**（§1）
- 证据：`typecheck-baseline.json:3` generatedAt 2026-10-26；`typecheck-scripts.mjs:51,104-112`（解析不到错误时 exit 0）；`tsconfig.scripts.json:10` `strict:false` 且无 `paths`（27 条 TS2307 → 相关文件 import 全 `any`）；TS2304 9 处（含 CI 步骤执行体 `artifact-machine-gate.ts:372,480,494`）；42 条落在不接入的文件。
- 影响：棘轮的原始目的（防服务契约漂移）对 27 个 alias 文件和 strict:false 打了折扣；tsc 异常/配置错误时静默放过；未定义标识符这类真错被永久容忍。
- 建议：(a) `tsconfig.scripts.json` 补 `paths`（照抄 `tsconfig.web.json:17-20`），逐步开 `strict`（先 `noImplicitAny`）；(b) 修 TS2304 的 9 处（尤其 CI gate）；(c) ratchet 加 fail-closed 守卫：tsc 非零退出但解析到 0 条错误 → `exit 2`；(d) baseline 记录 provenance（引入提交/日期），删除 `_tmp` 探针；(e) 给 TS2451 类"全局脚本冲突"改成显式 `export {}` 或按文件独立 tsconfig。

**G-04 `test:project-agent` 的已知失败已 17 天，产品决策仍未决**（§2.4）
- 证据：基线 `5cf6f82`（2026-10-09）建立；断言 `project-agent-integration-test.ts:233-237`；`$remaining`（`test-baseline.json:8-9`）原文明确"需产品决策"；docs 无结论；实测 1.6s 确定性失败。
- 影响：baseline 成为无限期豁免，"已知失败"会随 time 变成"永久失败"，并让后续真正的回归混在同一栏里。
- 建议：给出产品决策（审计快照是否应保留被拒 Expert 及 reason）；若暂不决，把用例改为显式 `skip` 并在 baseline 记录 issue/负责人/复查日期，而不是靠 knownFailing 静默容忍。

**G-05 CI 平台与版本假设过窄**（§5.2-5.4）
- 证据：只有 `windows-latest`（`verify.yml:20`）；pnpm 9 vs 本地 12.14.0、node 22 vs 26.7.0，仓库无 `packageManager`；`cc32b2b` 证明 Linux 专有问题只能事后修。
- 建议：`package.json` 加 `"packageManager": "pnpm@<当前大版本>"` + `engines`；CI 升到同版本或把 pnpm 版本从仓库读取；新增一个 `ubuntu-latest` job（至少 `pnpm install --frozen-lockfile` + `typecheck` + 一批确定 headless 的测试），Electron 用例按需 xvfb 或不跑；macOS 可选。

**G-06 安装失败被 `continue-on-error` 吞掉**（§5.3）
- 证据：`verify.yml:34-36`；`.npmrc:1-2` 使用镜像源。
- 影响：CI 报错定位失真，半装环境的门禁结论不可信。
- 建议：删掉 `continue-on-error: true`（如需容错，改为重试 1 次并显式上报）；固定镜像或用默认 registry；对 `better-sqlite3`/`node-pty`/`electron` 增加安装后 smoke（如 `node -e "require('better-sqlite3')"`）。

**G-07 隔离仍有 4 个漏口**（§3.3）
- 证据：20 个 default 用例绕过 test-guard；`test-guard.mjs:63-72` 未重定向 `APPDATA/LOCALAPPDATA`（Windows CI 主平台）；`test:tray` 无 `app.setPath('userData')`；`consult-entry-electron-test.cjs:17-20` 读真实 `~/.mybuddy`。
- 建议：(a) 把 20 个绕过 guard 的用例纳入 guard（Electron 用例也可用 guard 包一层拿 HOME 沙箱）；(b) guard 补 `APPDATA`/`LOCALAPPDATA`/`TEMP` 等 Windows 路径；(c) `test:tray` 加隔离 profile；(d) `test:consult-entry:desktop` 在缺少用户数据时显式 SKIP 而不是复制真实凭据。

**G-08 门禁会写脏工作树**（§3.4）
- 证据：10 个 default 用例写 tracked `artifacts/**/*.json`（`pi-native-control-test.ts:130-131` 等），本次审计期间出现 10 个 `M`（仅时间戳变化）。
- 影响：运行门禁后工作树永不干净；易被 `git add -A` 误提交；两次运行互相覆盖；diff 噪声掩盖真实改动。
- 建议：测试结果写到 `out/tests/**`（已 gitignore）或 `artifacts/.runtime/`（加 gitignore）；如需保留 tracked 快照，就把时间戳改为可复现格式并只在 `--update` 时写。

### P2

**G-09 源码文本断言仍占 8%~27%**（§3.1）：优先改造 `chat-scroll-anchor-test.ts`、`professional-tools-test.ts:467-469` 这类纯文本 gate —— 改成渲染/行为断言或至少断言"不变量"而不是代码字符串。

**G-10 两条空测试在门禁里恒绿**（§3.2）：删除 `test:opendesign-smoke` / `test:expert-market` 入口或改成真实断言；顺带核对 `test:*` 里是否还有类似的"壳"入口。

**G-11 并行共享资源需要统一治理**（§3.4）：端口用 `listen(0)` 且**保持 server 存活**（不要 freePort 的 close→rebind）；固定 52140 这类用例标注"不可并行"；`out/tests/streaming-live` 等共享目录按测试名隔离；把固定 `sleep` 改成条件轮询。

**G-12 孤儿脚本缺少清理机制**（§4）：46 个完全孤儿 + 21 个仅被构建引用的测试型文件；建议加一个 `test:orphans` 检查（枚举 scripts/ 下未被任何脚本引用的 test-ish 文件），先归档再删除；删除 `pi100-*` 旧版本副本。

**G-13 CI 可诊断性**（§5.5）：为 `test:all` 增加总预算（如 `--max-total-minutes`）、失败日志落盘 + `upload-artifact`、把 `timeout-minutes` 调整为"总预算 + buffer"。

### P3

- **G-14 文档漂移**（§5.6）：`AGENTS.md:6`（1.0.4→1.3.0）、`AGENTS.md:7`/`test-all.mjs:5`（290+→321）、`test-baseline.json:3` + docs（241→260）、`AGENTS.md:9`（30%→实测口径）；建议把可计算的数字改成由脚本生成或直接删掉硬编码。
- **G-15 `test:all --filter` 是名字子串匹配**（`:77`）：`--filter=memory` 会误伤多个用例，建议改精确匹配或 `--filter-regex`。
- **G-16 `test-guard` 的内存口径在 Linux 上不完整**（`test-guard.mjs:120-127`）：POSIX 只读 `VmRSS + VmSwap`，未计入未触及的匿名 commit（Windows 用了 `PrivatePageCount`）；R.E.D. 事故口径在 Linux 上可能漏判。
- **G-17 `test:all` 被 SIGKILL 时 test-guard 的临时 HOME 不会清理**（`test-guard.mjs:155-158` 只在正常 finish 时清理），`/tmp/mybuddy-test-home-*` 会残留；建议启动时清理过期目录。

---

## 7. 不确定 / 未完成

1. **未跑完整 `test:all`**（Lead 在跑）：因此"当前 default 套件除 `test:project-agent` 外是否还有其它红"我没有独立结论；报告里 default 相关数字（260）来自 `--list`，不是执行结果。
2. **未在 Windows / pnpm 9 上验证**：pnpm 9 对 `pnpm-workspace.yaml` 新字段（`allowBuilds` 等）的行为、lockfile 读取、原生模块构建是否与 pnpm 12 一致，均为【推测】；本地无法在不安装依赖的前提下复现。
3. **未运行任何 Electron 用例**（遵守"不要启动新 Electron 窗口"）：§2.3 的"11 个用例会开 Electron"来自命令串与 cjs 源码静态核对，未实测耗时/本机显示环境；`test:consult-entry:desktop`、`test:tray` 当前是否本机可过未验证。
4. **源码文本断言比例是启发式下界**：通过变量拼接路径的 `readFileSync` 可能漏计，故 8.0% 应视为下界、26.6% 应视为上界（宽口径含 fixture/产物）。
5. **孤儿计数口径**：以 `package.json` 引用关系为准，被 build 脚本间接引用的仍可能算"孤儿"；"不可达 97"是传递闭包结果，未考虑运行期动态拼路径。
6. **`$remaining` 的产品决策历史**：只核到 docs/artifacts 中没有结论，无法确认是否在仓库外（issue/聊天）已决策。
7. **`test:models-settings-overlay` 的失败原因**只做到"复现 + 失败项名称"，未深入实现（属 UI 缓存刷新逻辑，需产品/实现负责人确认是回归还是断言过期）。
8. **CI 实际运行历史**（是否长期红/绿、平均耗时）需要 GitHub Actions 权限，未获取。
