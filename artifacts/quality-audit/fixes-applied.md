# 已实施的修复（2026-10-09）

本文件记录本轮实际改动、验证方式与**未完成项**。所有"已验证"均指我实际跑通并记录了退出码。

---

## 1. 产品代码修复（唯一确证的正确性缺陷）

### `src/main/library/LibraryService.ts`

**问题**：`refreshChunksForItem` 用空 `catch {}` 静默吞掉 embedding 失效失败且**不打日志**，而同函数 `:1240` 的 chunk 写入失败**有** `console.warn`。这个不对称让"索引悄悄变脏"无法被观测。

**改动**：
- 所有原先的空 catch 补上 `console.warn('[Library] ...', err)`，与该文件既有日志约定一致。
- 清理死参数：`invalidateEmbeddingsForChangedChunks(itemId, _newIds, oldIds, oldHashesForKept)` 的**三个参数全部未被使用**（函数体只做一次全表 SQL 扫描），已重命名为 `deleteStaleEmbeddingsForItem(itemId)` 并删除误导性签名与那段未收敛的注释。行为不变，语义诚实。
- 删除未使用的局部变量 `newHashById`。

**验证**：`pnpm -s typecheck` 退出 0；`test:library-domain`、`test:library-*-transaction`、`test:library-workspace-context` 通过。

---

## 2. 门禁修复：`scripts/artifact-machine-gate.ts` → 30/32 → **32/32**

### R4（真缺陷）
`src/main/index.ts` 访问 `artifactPreviewHost.captureSurface`，但该名字不在门禁的 `ALLOWED` 白名单里。`captureSurface` 是 `ArtifactPreviewHost.ts:32` 的只读 getter，与白名单中已有的 `webContentsView` 同类。**加入白名单后 R4 PASS。**

### R15（门禁自身误报）
旧规则按**方法名**匹配 `markStale|validateAgainst`，于是 `src/main/memory/MemorySkillRevisionService.ts` 的 `markStale`（把 memory skill revision 候选的 DB status 置为 `'stale'`）被误判——它与 SelectionStore 的"选中项过期"只是**同名**，语义无关。

已把规则收窄为：仅当签名/邻域出现 selection 领域类型（`SelectionDescriptor`/`SelectionId`/`SelectionSnapshot`/`selectionStore`）且不属于 memory skill 域时才判定。

**负向对照（证明规则未被架空）**：临时注入 `src/main/artifact/__r15probe.ts`：
```ts
import type { SelectionDescriptor } from "../../shared/selection";
export function markStale(s: SelectionDescriptor) { return s; }
```
→ R15 **FAIL**（正确捕获）；删除探针后恢复 32/32 PASS。

---

## 3. 测试契约漂移修复（每个都跑通验证）

| 测试 | 根因 | 修复 | 结果 |
|---|---|---|---|
| `test:work-graph` | 断言 `schemaVersion=17`，代码已是 **27** | 改读 `CURRENT_DATABASE_SCHEMA_VERSION` | 50/50 PASS |
| `test:workspace-chunk-r2` | 同上 + 库会 seed 欢迎条目成为额外 backfill 候选 | 改读常量；真正删除欢迎条目（旧注释声称已处理但代码未删） | PASS（原 3 失败） |
| `test:pi100-features` | 硬编码 `'1.0.0'`，实际已升级 **1.0.4** | 改从 `worker-launcher.mjs` 的 `EXPECTED_PI_VERSION` 读取 | PASS |
| `test:chat-markdown` | 断言源码含 `isSvgFenceLanguage(extracted.language)`，实现已改为两参数（**更正确**） | 断言放宽为不锁死参数个数 | 117/0 PASS |
| `test:library-workspace-context` | 调用**不存在**的 `context.memoryDigest(...)`；BTW 契约也已变更（evidence 段改由瞬态会话请求投影提供） | 改为断言真实 seam：`assemblePrompt` 的 `memoryRules` 段；BTW 断言改为"不重渲染 evidence" | PASS |
| `test:architecture` | ① fake session 缺 `sessionManager` 等成员 → WeakMap 崩溃；② 断言已被 0.1.17 移除的 `releaseIfIdle` 释放语义；③ 环境缺 `e1` 专家与任务行 | 补齐 fixture（装 `e1` 专家、建任务行）；断言改为新契约（记录 desired、不立即释放、不打断流式） | **6 失败+崩溃 → 4 失败**（仍未全绿，见 §5） |
| `test:project-agent` | fake session 缺 `sessionManager`/`settingsManager`/`abort` 等 → WeakMap 崩溃 | 改用**真实** `SessionManager.inMemory`/`SettingsManager.inMemory`（避免实现演进后再漏方法） | 崩溃已修；剩余 1 条真实断言（见 §5） |

> 关于 `test:chat-markdown`：它是**测试错了、代码对了**——把参数从 1 个改成 2 个是修正，测试按精确文本匹配反而变红。这正是"源码文本断言"（占 257 个测试文件的 **30%**）的典型危害。

---

## 4. 结构性修复：让"测试挂了"重新可见（本轮的根因治理）

**根因**：259 个 `test:*` 脚本**没有聚合入口、没有 CI**，所以过期常量、废弃迁移路径、源码文本断言能长期腐烂而无人知晓。这也解释了为什么仓库自己不知道有多少红灯。

新增：
- **`scripts/test-all.mjs`** — 聚合门禁。排除 GUI/CDP/GPU/`-e2e`（脚本内直接调 `electron`，单个用例可达 305s）与联网 `:live` 用例；带**单用例超时**与可选并发。
  - 关键修复：`test:all` 自己也是 `test:*`，早期版本会**递归 spawn 自身形成 fork 炸弹**（实测跑满 45 分钟、泄漏大量 node 进程、把所有用例误判为失败）。已用 `SELF_EXCLUDE_PATTERNS` 排除。
- **`scripts/test-baseline.json`** — **棘轮（ratchet）基线**：已知失败被容忍但会打印，**任何新增失败让门禁失败**。这样避免"上线即全红 → 被忽略"，同时新回归立刻可见。
- **`.github/workflows/verify.yml`** — CI：typecheck → harness gate → artifact gate → `test:all`。
- `package.json` 新增 `test:all` / `test:all:live` / `test:all:update-baseline`；`AGENTS.md` 补文档（含"不要硬编码版本/schema"的约定）。

**当前状态（249 个用例）**：通过 **227**，已知失败 **22**，新增回归 **0** → 门禁 **PASS**。

---

## 5. 未完成项（诚实清单）

1. **`test:architecture` 仍有 4 条失败**：`显式模型/权限/连接器进入主路径 payload` 与 `F2：任务 A 显式值继续作为 explicit 传递`。根因已定位：该用的 `window.api.agent.prompt` 桩**不再被调用**（`promptCalls.length === 0`），说明 appStore 的发送路径已改（新增 ACP/外部 agent 分支），于是这几条断言失败、**且同块的其它断言变成空转**（`first?.connectorIds ?? []` 对 undefined 恒成立）。需要按新 store 路径重写整块，属于重构级工作，本轮未做。**已留在 baseline 中可见。**
2. **`test:project-agent` 剩 1 条真实断言**：执行审计快照 `resolvedCapabilities` **缺少**被拒绝的 Expert 项（`expertId: "blocked-expert"` 确有传入，执行前 inspection 也正确包含），而同测试的 `capability_notices` 期望 3 条含 expert。这是**产品行为问题，需要产品决策**（审计快照是否应保留被拒的 Expert），我没有擅自改测试去迁就。**已留在 baseline 中可见。**
3. **其余 20 条已知失败**未逐个修复：多为 `-desktop`/gui 之外的宿主依赖（`blender-skill` 依赖某仓库目录存在）、fixture 缺依赖（`runtime-skill-loader` 的 `demo-connector`）、或行为漂移（`workspace-tree` 的 v12 迁移断言，而 v12 迁移路径已被"删库重建"策略废弃）。全部记录在 `scripts/test-baseline.json`。
4. **未做发布**：AGENTS.md 的默认发布流程要求 bump 版本、构建 Windows 分发、校验打包产物与快捷方式。**我刻意没有执行**，原因：本次会话期间**有另一个进程在并发修改源码**（`src/main/capabilities/MultiModelConsult.ts`、`src/shared/multi-model-consult.ts` 及 3 个 `multi-model-consult*` 测试脚本于 10:43 被改动，均非我所为）。此时构建分发会把对方未完成的工作打进包，违反"不要打断用户正在进行的任务"。**因此 commit 只包含我自己的文件，未 bump 版本、未 push、未构建。**

---

## 6. 验证记录

```
pnpm -s typecheck                 → exit 0
pnpm -s test:artifact-gate        → 32/32 PASS
pnpm -s test:harness-quality      → PASS
pnpm -s test:all                  → 227 通过 / 22 已知失败 / 0 新增回归 → exit 0
```

逐个复验通过的测试：`work-graph`(50/50)、`chat-markdown`(117/0)、`library-workspace-context`、`pi100-features`、`workspace-chunk-r2`、`artifact-gate`、`harness-quality`。
