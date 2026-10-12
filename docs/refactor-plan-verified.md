# 复核实证的改造方案（替代原「不全拆」规划）

- 基线提交：`9f90f4e`
- 证据来源：`artifacts/plan-review/T3-dbsync-surface.md` … `T10-falsify-parent.md`（10 路独立核查，7 路推翻声明）
- 判决图：`diagrams/plan-review-verdict.svg`、`diagrams/plan-review-final-verdict.svg`
- 复核方式：全部结论带 `文件:行号`；仅 `out/` 与 `diagrams/` 为核查产物

## 0. 总结论

原规划**方向可保留**（不全拆、冻结增量），但**量化锚点与 ROI 论证不成立**：

- 真正"删复杂度"的只有 **Phase 3**（方法 −65~−84、源码 −约 243 行 = 类体 4.6%）与 **Phase 0.1**（构造副作用减半）。
- **Phase 1 是持平不是缩减**：`dbSync` 只是改名，净降约 −3 行（0.05%）。
- **Phase 2.1 的动机在 IPC 路径上不可达**（handler 注册于 L3364，renderer 直到 L3405 才存在）。
- **Phase 4 有 3 条规则指向不存在的路径**。
- 原规划"25% 成本拿 80% 收益"因此作废；**不建议投入 19–29 人日**。

## 1. 声明 vs 实测

| 项 | 原规划 | 实测 | 判决 |
|---|---|---|---|
| 0.1 `ExecutionFailureRepository` 双实例 | 真 bug | 无内存态、同一 connection，无可复现故障；但构造器 `ExecutionFailureRepository.ts:14` 是**依赖构造时刻的数据写** | 降级 |
| 0.1 `MemoryService` 实例数 | 4 | **≥4**，`WorkspaceSharedContextService` 有 **2 条**构造路径（`LibraryWorkspaceContextService.ts:42`、`index.ts:3082`） | 清单少算 |
| 0.1 验收「全仓 ≤2 处 new」 | ≤2 | **87**（src 6 / scripts 78 / diagrams 3） | 不可达 |
| 0.2 IPC 清单脚本 | 可写 | 可行，但须限定 `src/main/**` + 解析 `Ipc` 常量对象（37 个）+ 建模 host/legacy 互斥；今日**真实同时生效的重复 = 0** | 保留 |
| 0.3 文本断言清单 | index.ts **1** 个脚本 | **12**（main 6 / preload 7 / web-access 3） | 漏 11 |
| 0.3 假绿风险 | 30% | 严格口径 **13.1%**；真正必假绿仅 **2** 处 | 高估 |
| 1 appStore db 直写 | **126** | **46–48**（口径差）；126 = 含 `window.api` 的行数 | 错 2.6× |
| 1 全 renderer db 直写 | —（隐含只有 appStore） | **105** = appStore 46 + **组件 59 / 25 文件** | 漏算 |
| 1 降行数 | **400–600 行** | 0 ~ −128；网关自身 +150–300 | 错 |
| 1 appStore 顶层键 | 553 | **261**（AST 与 interface 双证） | 错 2.1× |
| 1 `get()` 次数 | 233 | **270**（233 = 含 `get().` 的行数） | 口径错 |
| 2.1 模块级 `let` | ~33 | **47**（近 7 个提交均为 47） | 错 |
| 2.1 fail-loud 收益 | 未初始化静默消失 | IPC 路径不可达；真可空仅 4 个 | 动机作废 |
| 2.2 需新增清单测试 | 需新增 | 已有 `subagent-ipc-host-test.ts`（14/14）；真缺陷是 `reset` 不还原 handle | 改靶 |
| 3 纯透传方法 | 100–140 / 286 | **65–84 / 256**；7 个点名协作者只覆盖 39/84；最大源 `memoryService`(15) 未列入 | 下修 |
| 4 规则 2/3/4 落点 | `ipc/`、`agent/DomainService.ts`、`dbSync` | 三者**均不存在**；常量在 `src/shared/*.ts`；惯例是 `src/main/<domain>/<Domain>Service.ts` | 改写 |

## 2. 逐阶段裁定

### Phase 0.1 — 降级为优化项（做，但不是修 bug）
- 理由改为：**构造副作用只发生一次**。`MemoryService` 构造器 `reapStalePendingCandidates`（`MemoryService.ts:247` → `MemoryRepository.ts:421`）当前冷启动跑 **4 次**；`ExecutionFailureRepository.ts:14` 的 `dismissed_at` 回填跑 **2 次**且影响行依赖构造时刻。
- 收敛**可行**（D 的阻力是封装不是时序）：`AgentService.ts:536` 的 `private readonly` + `AgentServiceDependencies`（L420-423）缺注入点，两者都是可改代码。
- 验收改为：**`src/main/**` 内各 ≤1**（全仓归零不可达，scripts 78 处）。

### Phase 0.2 — 保留，且应最先做
- 价值是**冻结基线**（今日真重复 = 0），不是清理目标。
- 必须建模 4 项：①限定 `src/main/**`；②解析 `Ipc` 常量对象（含 `src/shared` ↔ `shared/src` 转发）；③host/legacy 互斥 + 运行时 `on`/`removeListener`；④重复分 4 级（真重复/互斥/跨进程/测试）。

### Phase 0.3 — 保留，先改清单
- index.ts 口径从 1 改为 **12**；真正需专项复查的只有 `architecture-test.ts:2228` 与 `professional-tools-test.ts:410`（负向断言 + 切片）。

### Phase 1 — 取消 ROI 定位
- 改述为"消除 25 个组件文件里的 59 处 db 旁路"，不再承诺降行数。
- 验收改为可判定断言：`appStore.ts` 内 `window.api?.db?.` 残留 = 0（`grep` 计数），**不写行数指标**。
- 需先决定范围：只收 appStore（46–48）还是全 renderer（105）。

### Phase 2.1 — 砍动机，只留一次校验
- 删除"handler 读到未初始化服务"的论证（不可达）。
- 改为：在 whenReady 末尾对 47 项做**一次完整性校验**，一次性报缺失名单。
- `trayService`/`quitCleanupPromise`/`remoteAccessController`/`quitCleanupComplete` 必须豁免（`trayService` 在 import 期注册的 `index.ts:339` 监听器里被读、L635 才赋值）。

### Phase 2.2 — 改靶到真实缺陷
- 不新造冗余清单测试；补 `resetSubagentIpcHostForTests` 的还原语义（见 §4 已修）。

### Phase 3 — 唯一真删，需下修
- 幅度：**方法 −65~−84（256 中）**、源码 −约 243 行（4.6%）。方法数降幅 25–33%，对可读性仍有价值。
- 前提清单**必须补** `memoryService`(15)、`runtimeRequirements`(7)、`btwService`(5)、`conversationGoals`(4) 等，否则最多只消 39 条。
- 红线用行号白名单 + 断言"删除集 ∩ 红线区间 = ∅"（实测为 0）。

### Phase 4 — 改写落点后立即生效
- 规则 2：常量加进 **`src/shared/agent-ipc.ts`** 或对应 `src/shared/*.ts`（`src/main/ipc/` 不存在）。
- 规则 3：新域用 **`src/main/<domain>/<Domain>Service.ts`**；"不进 AgentService" 落成 `architecture-test.ts` 的 N15 断言。
- 规则 4：先定义 `dbSync` 的模块路径与 API，再补 renderer 扫描断言（`window.api?.db` 只允许命中 `store/appStore.ts`）。
- 规则 1：保留；用冻结基线断言（顶层键 261 + store 文件清单）替代散文规则（仓库无 ESLint）。

## 3. 验收口径修正

- **主判据**：`pnpm -s test:all` 退出码 0（`--list` 实测选中 242 用例，`EXCLUDE_PATTERNS` 16 条）。
- 每个 Phase 出口：**新增回归 = 0，且不得新增 `test-baseline.json` 条目**（当前仅 1 条：`test:project-agent`）。
- `test:project-materials-ui` 必须写成 `env -u ELECTRON_RUN_AS_NODE pnpm -s test:project-materials-ui`，或声明只由 `test:all` 代跑（`test-all.mjs:108-109` 会删该变量）。
- 禁止用 `test:all:update-baseline` 充当验收（其无条件 exit 0）。

## 4. 已修的真实缺陷

### 4.1 `resetSubagentIpcHostForTests()` 不复原被覆写的 `ipcMain.handle`
- 后果：同一 `ipcMain` mock 对象 reset 后再 `register` → 4 个宿主通道被吞进 `adopted`，**真实注册数静默变成 0**；新建的清单测试若复用 mock 会变成假绿。
- 复现：回归断言先失败（`first=4 total=4`）→ 修复后通过（`first=4 total=8`）。
- 改动：`src/main/agent/subagent-ipc-host.ts`（保存 `patchedTarget`/`originalHandle`，reset 时还原）+ `scripts/subagent-ipc-host-test.ts`（新增回归断言）。

### 4.2 `ExecutionFailureRepository` 构造副作用重放
- 原状：组合根（`index.ts:1854`）与 `AgentService.ts:717` 各构造一份，构造器里的遗留 `dismissed_at` 回填（`ExecutionFailureRepository.ts:14`）是按**构造时刻**生效的数据写，重放会得到两个不同的影响行集合。
- 修复：模块级 `WeakSet<Database>` 记录已初始化的连接，同一连接只执行一次 DDL + 迁移 + 遗留清理；新连接（测试各自建库）仍完整初始化。
- 改动：`src/main/agent/ExecutionFailureRepository.ts`。

### 4.3 `MemoryService` 构造器 `reap` 重放
- 原状：冷启动有 **4 个** `MemoryService` 构造点（`index.ts:2692`、`AgentService.ts:696`、`WorkspaceSharedContextService.ts:52` 经两条路径），`reapStalePendingCandidates` 的 10 分钟窗无"提取已死"判据，重复执行会反复改判在飞候选。
- 修复：模块级 `WeakSet<AppDatabase>`，每个 `AppDatabase` 只清理一次（失败也仍只尝试一次）。
- 改动：`src/main/memory/MemoryService.ts`。

### 4.4 退出路径未处理 rejection
- 原状：`index.ts` 的 `before-quit` 里 `Promise.allSettled([...])` 参数列表求值未包 `try/catch`（同函数其余 12 条 cleanup 均已包），单实例锁失败路径下可能产生未处理 rejection。
- 修复：包 `try/catch`（best effort）。
- 改动：`src/main/index.ts`。

## 5. Phase 0.2 交付：IPC channel 冻结基线

- 脚本：`scripts/ipc-channel-inventory.mjs`（`--update` 写基线 / `--check` 比对 / 无参打印）。
- 门禁：`test:ipc-channel-inventory`（已加入 `package.json`，会被 `pnpm -s test:all` 选中）。
- 基线：`artifacts/ipc-channel-baseline.json`。
- 口径（照复核结论收紧）：限定 `src/main/**` 为"本进程注册"；解析 `Ipc` 常量对象（含 `src/shared` 与 `shared/src`、单引号与无分号 `as const`）；支持多行调用；`ipcMain.handle = …` 记为猴补丁而非注册；重复分 4 级。
- 实测（与 T1 独立复核互证）：

| 项 | 值 |
|---|---|
| 本进程注册点 | 453 |
| 全仓注册点 | 464 |
| 唯一 channel | 449 |
| 真重复 | **0** |
| 互斥（host 与 legacy） | 4（`subagent:active/transcript/steer/cancel`） |
| 跨进程同名 | 7（artifact-domain × e2e） |
| 运行时通道 | `selection-popover:action`（on + removeListener） |
| 未解析引用 | 0 |

- 已验证 `--check` 能真实抓漂移：人为截断基线 → exit 1 并列出新增 channel；恢复后 exit 0。

## 6. 验证记录

| 检查 | 结果 |
|---|---|
| `pnpm -s typecheck` | exit 0 |
| `pnpm -s test:all` | 241 通过 / 1 已知失败（`test:project-agent`，baseline 条目）/ **新增回归 0**，exit 0 |
| `pnpm -s test:subagent-ipc-host` | 15/15（修复前 14/14 + 1 失败） |
| `pnpm -s test:subagent-ipc-transaction` | 13/13 |
| `pnpm -s test:ipc-channel-inventory` | 冻结基线一致，exit 0 |

## 7. 决策

**不做** 19–29 人日的全程序。**已做**：冻结基线（0.2 + 门禁）+ 4 处真实缺陷修复。**仍建议不做**Phase 1（持平）与 Phase 2.1（动机不可达）；Phase 3 若要推进，按 65–84 方法 / −243 行重新估算后再决定。

## 8. 仍存在、但不建议现在动的

1. `MemoryService` 的 10 分钟 reap 窗口本身：现在只跑一次，但"单批提炼 >10 分钟会把在飞候选降级为 `needs_review`"这一边缘行为仍在（属设计取舍，要改需加"提取已死"判据）。
2. `ExecutionFailureRepository.ts:14` 的遗留清理：当前全仓已无 `shell-exit-nonzero` 写入方，属保留的历史迁移。
3. `WorkspaceSharedContextService` 有 2 条构造路径、`new MemoryService` 生产 4 处：本次只消除了副作用重放，未收敛实例数（收敛需改 `AgentService` 依赖签名，见 §2 Phase 0.1）。
