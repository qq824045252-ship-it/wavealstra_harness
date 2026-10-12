# T10 · 父代理四条定论的证伪式复核（只读核查报告）

- 目标：对一份重构规划做执行前最终复核，**默认假设下列四条父代理定论有错**，主动寻找反例、边缘情况与被忽略的调用路径。
- 仓库：`C:\Users\servi\Documents\GitHub\wavealstra_harness`（工作副本，`git log -1` = `9f90f4e`）
- 写操作范围：**仅本文件**（唯一允许的写操作）。源码未做任何修改。
- 证据分级：**【实测】**＝本次用 read/grep/选择字符串读取过原文；**【推断】**＝由实测事实推导，未直接观测运行行为。本环境无法启动 GUI/真实 Electron 冷启动，故**未运行**应用做时序实测。
- 图示：`diagrams/t10-falsify-parent-evidence.svg`

---

## 0. 复核方法与口径（可复现）

| 项 | 命令/口径 | 说明 |
| --- | --- | --- |
| A/B 构造点普查 | 在 `src/` 全量文件上匹配 `new ExecutionFailureRepository`、`new MemoryService(`、`new WorkspaceSharedContextService(`、`new BlueprintService(`、`new LibraryWorkspaceContextService(` | 【实测】 |
| C 计数 | 对 `src/renderer/**/*.{ts,tsx,js,jsx}` 匹配正则 `api\??\.db\??\.([A-Za-z0-9_]+)`，逐行归类 | 【实测】 |
| D 顺序 | 直接读 `src/main/index.ts` L2635–L3364，逐行确认 `await`、`registerIpc` 定义/调用位置 | 【实测】 |

口径定义（后文 C 依赖）：
- **引用次数**：正则命中 `api.db.<method>` 的个数（**方法引用**）。
- **行数**：出现 `api.db` 的源码行数（**调用点行**）。
- **非读取调用**：方法名不以 `list|get|on|pick|inspect` 开头且非 `typeof` 守卫的引用（近似「写面」）。
- **根绑定**：`const api = window.api?.db;` 形式的解构（无方法名，单独计）。

---

## 1. 定论 A：ExecutionFailureRepository 双实例「不是 bug」

### 原文（被复核的定论）
> ExecutionFailureRepository 双实例（index.ts L1854 与 AgentService.ts L717）不是 bug：该类无实例级状态，两处 db.connection 是同一 better-sqlite3 对象，读写同一张表实时 SQL，仅构造器幂等 DDL 跑两遍。

### 1.1 与事实相符的部分【实测】

| 断言 | 判定 | 佐证（文件:行号 + 原文） |
| --- | --- | --- |
| 两处构造点确实是这两处 | ✅ 一致 | `src/main/index.ts:1854`：`const executionFailureRepository = new ExecutionFailureRepository(db.connection);`<br>`src/main/agent/AgentService.ts:717`：`this.executionFailures = new ExecutionFailureRepository(db.connection);` |
| 该类无实例级状态 | ✅ 一致 | `ExecutionFailureRepository.ts:6`：`constructor(private readonly db: Database.Database) {` —— 全类唯一字段即构造器参数属性；L5–L75 无其它字段声明 |
| 两处是同一 better-sqlite3 对象 | ✅ 一致 | `AppDatabase.ts:243`：`private readonly db: Database.Database;`；`AppDatabase.ts:267-269`：`get connection(): Database.Database { return this.db; }`；`src/main/index.ts:2654`：`db = new AppDatabase();`（全仓仅此一处实例化，`index.ts:294` 为 `let db: AppDatabase;`） |
| 读写同一张表实时 SQL | ✅ 一致 | 全部方法用 `this.db.prepare(...)`（L20、L22、L36、L51、L56、L61、L71），无缓存层 |
| 是否被继承或包装 | ✅ **未发现** | `src/` 内 `ExecutionFailureRepository` 共 33 次出现，**0 次** `extends ExecutionFailureRepository`；其余全部是 `import type` + 依赖注入字段（如 `SessionEventCoordinator.ts:36`：`executionFailures?: ExecutionFailureRepository;`） |
| 是否还有第三处 `new` | ✅ 生产代码无 | `src/` 内 `new ExecutionFailureRepository` 仅 2 处（上述）；其余 14 处全在 `scripts/`（与 `scripts/core-performance-baseline.ts:148` 同类的测试/基线脚本） |

### 1.2 反例 1：构造器并不是「纯幂等 DDL」——L14 是数据写，且影响行集合依赖构造时刻

`src/main/agent/ExecutionFailureRepository.ts:7-14` 原文（逐字）：

```ts
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS execution_failures (...); CREATE INDEX IF NOT EXISTS idx_execution_failures_task ON execution_failures(task_id, created_at);`);
    const columns = db.prepare("PRAGMA table_info(execution_failures)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "dismissed_at")) db.exec("ALTER TABLE execution_failures ADD COLUMN dismissed_at INTEGER");
    // Legacy MyBuddy versions persisted every shell non-zero exit as a Recovery card. Those are ordinary tool failures, not unresolved recovery state.
    db.prepare("UPDATE execution_failures SET dismissed_at = COALESCE(dismissed_at, ?) WHERE cause_code = 'shell-exit-nonzero' AND resolved_at IS NULL AND dismissed_at IS NULL").run(Date.now());
  }
```

- L7 的 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`、L12 的 `ALTER TABLE ... ADD COLUMN` 确实是时间无关幂等（有 `PRAGMA` 守卫）。
- **L14 不是**：它把「执行这一刻仍然未决（`resolved_at IS NULL AND dismissed_at IS NULL`）的所有 `shell-exit-nonzero` 行」一次性标记为 `dismissed_at`。该语句本身对同一时刻重复执行是幂等的，但**两个实例的构造时刻不同**（`registerIpc()` 在 `index.ts:3364` 才执行，AgentService 在 `index.ts:2732` 构造），因此两次运行的影响行集合可以是两个不同的集合 → **不是「同一件幂等事情跑两遍」**，而是「两个不同时刻各做一次有副作用的状态变更」。
- 危害窗口【推断】：若在「实例 1 构造之后、实例 2 构造之前」新写入并仍为未决的 `shell-exit-nonzero` 行，实例 2 的构造会把它静默忽略，用户看不到它。

**止爆条件【实测】**：全仓（`src/` + `scripts/` + `shared/`）搜索 `shell-exit-nonzero`，**唯一命中的文件就是 `src/main/agent/ExecutionFailureRepository.ts` 自身**（即 L14 那条 SQL）。也就是说当前代码库没有任何地方再写入该 causeCode → 上面的数据损失路径**当前不可复现**。这是「潜在缺陷 / 机制描述错误」，不是「当前已发生 bug」。

### 1.3 反例 2：两个实例能力并不等价（恢复路径只挂在一边）

`src/main/agent/AgentService.ts:719`：`recoverInterruptedExecutions(this.executionAttempts, this.executionFailures);`

- 该调用只存在于 AgentService 构造器中【实测：全仓 `recoverInterruptedExecutions` 仅 3 处命中：`AgentService.ts:19` 导入、`:719` 调用、`ExecutionRestartRecovery.ts:11` 定义】。
- 因此 index.ts 侧那个实例**不参与**「重启中断恢复」（`ExecutionRestartRecovery.ts:12-29` 会把未结束 attempt 转成 `application-restarted` 恢复记录），只有 AgentService 侧参与。
- 结论：在「接线能力」维度上，两个实例并非等价副本；把它们描述成「同一逻辑的两个无差别句柄」不准确。

### 1.4 未构成反例的两点（主动排除，避免误报）

- **事务嵌套互相干扰**：`record()`（L19-23）与 `resolveMatching()`（L73）用的是 `this.db.transaction(...)`，作用于**同一个** connection。better-sqlite3 的 `Database#transaction` 在被嵌套时用 SAVEPOINT，且驱动是同步执行；两实例共享同一 connection，因此不存在「两个连接各自 BEGIN 互锁」的窗口。**未发现反例**。
- **`recordIfAbsent` 检查-插入竞态**：`recordIfAbsent`（L27-33）是「list 后 record」的读改写。跨两个实例调用会有 TOCTOU，但 better-sqlite3 是同步 API，两段代码之间不存在 JS 让出点；且生产代码里只有 AgentService 侧实例被注入到恢复器与 `SessionEventCoordinator.ts:36`，index.ts 侧实例只服务 `list`/`dismiss` 两个 IPC。**当前不构成真实反例**。

### 1.5 定论 A 的结论

- **是否成功证伪**：**部分证伪**。核心结论「当前生产代码不构成功能 bug」**未能证伪**（我确实找不到现实可复现的数据损失或索引分歧）；但**机制描述被证伪**——「仅构造器幂等 DDL 跑两遍」与 L14 的原文不符，且两实例能力不等价。
- **需要怎么修正**：
  1. 把「仅幂等 DDL 跑两遍」改成「**除幂等 DDL 外，构造器还执行一次 `dismissed_at` 回填 UPDATE（L14），其影响行依赖构造时刻**；由于全仓已无该 causeCode 的写入方，当前不可复现，属潜在缺陷」。
  2. 补一句「两实例能力不等价：`recoverInterruptedExecutions` 只挂在 AgentService 侧（L719）」。
  3. 收敛方案不要以「该类无状态所以双实例零成本」为理由；真正的理由是「**每次构造都会再写一次库**」，收敛目标应包括「构造副作用只发生一次」。
- **证据级别**：1.1、1.2（L7-14 原文）、1.3、1.4 全为【实测】；「窗口期可发生」为【推断】。

---

## 2. 定论 B：MemoryService 三实例「全是 semantic ON，不会产生索引分歧」

### 原文（被复核的定论）
> MemoryService 三实例（index.ts L2692、AgentService.ts L696、WorkspaceSharedContextService.ts L52）全是 semantic ON，不会产生索引分歧。BlueprintService 的 semantic 为 false 只在测试 fallback 触发。

### 2.1 与事实相符的部分【实测】

| 断言 | 判定 | 佐证 |
| --- | --- | --- |
| 三处构造点存在 | ✅ | `src/main/index.ts:2692`：`const memoryKernel = new MemoryService(db);`；`src/main/agent/AgentService.ts:696`：`this.memoryService = new MemoryService(db);`；`src/main/workspace/WorkspaceSharedContextService.ts:52`：`this.memory = new MemoryService(db);` |
| 生产路径没有 `semantic:false` | ✅ | 全 `src/` 匹配 `semantic: false` **只有 1 处**：`src/main/blueprint/BlueprintService.ts:56`：`this.memory = deps.memoryService ?? new MemoryService(deps.db, { semantic: false });` |
| Blueprint 的 false 只在回退分支 | ✅ | `BlueprintService.ts:46` 注释：`/** Shared production Memory Kernel; tests/standalone callers may omit (semantic disabled fallback). */`；且组合根已正向注入：`src/main/index.ts:3191`：`memoryService: memoryKernel,`（围绕 L3184 `blueprintService = new BlueprintService({`） |
| 三实例语义解析一致 | ✅ | `MemoryService.ts:244`：`this.semantic = opts?.semantic === false ? null : new MemorySemanticProvider(db);` —— 默认即构造 provider；`MemorySemanticProvider.ts:45-62` 的 `index()` 与 `:77-88` 的 `search()` 全部把 `model_id`/`model_version`/`dimension` 固定取自 `SEMANTIC_MODEL_ID`/`SEMANTIC_MODEL_VERSION`/`SEMANTIC_DIMENSION` 常量，实例间无差异。 |
| 底层运行时是进程级单例 | ✅ | `SemanticRuntime.ts:177-183`：`const singletons = new Map<string, SemanticRuntime>(); export function getSemanticRuntime(...)` —— 按 modelsRoot 复用。**未发现**「多实例各自加载模型导致维度分歧」的反例。 |

**→ 定论 B 中「不会产生索引分歧」这一核心命题，我未能证伪。** 我找不到任何让某个 MemoryService 在生产路径关闭 semantic 或有不同 embedding 配置的路径。

### 2.2 反例 1：实例不是 3 个，而是**至少 4 个**；且 `WorkspaceSharedContextService` 本身有**第二条构造路径**（实为 2 份）

`src/main/workspace/WorkspaceSharedContextService.ts:49-53` 原文：

```ts
export class WorkspaceSharedContextService {
  private readonly memory: MemoryService;
  constructor(private readonly db: AppDatabase) {
    this.memory = new MemoryService(db);
  }
```

`src/main/agent/LibraryWorkspaceContextService.ts:42` 原文：

```ts
    this.workspaceSharedContext = dependencies.workspaceSharedContext ?? new WorkspaceSharedContextService(db);
```

而 `LibraryWorkspaceContextService` 由 AgentService 构造（`src/main/agent/AgentService.ts:701-706`）：

```ts
    this.libraryWorkspaceContext = new LibraryWorkspaceContextService(
      db,
      this.memoryService,
      this.projectContextResolver,
      () => this.settingsStore.read().memoryEnabled,
    );
```

且 `AgentServiceDependencies`（`AgentService.ts:420-423`）**只有** `createAgentSession` 一个字段 → 组合根**没有**把 `index.ts:3082` 的那份 `workspaceSharedContextService` 注入进去：

```ts
export interface AgentServiceDependencies {
  /** Test seam at the SDK boundary; all MyBuddy createSession assembly still runs. */
  createAgentSession?: typeof createAgentSession;
}
```

因此生产路径的真实构造（【实测】`new MemoryService` 在 `src/` 共 4 处调用点、3 个文件）：

| # | 构造点 | 持有者 | semantic | 使用方 |
| --- | --- | --- | --- | --- |
| 1 | `AgentService.ts:696`（经 :707 `new ProjectService(projectRepository, this.memoryService)` 共享） | AgentService | ON | Agent/MCP/Project 域 |
| 2 | `WorkspaceSharedContextService.ts:52`（经 `LibraryWorkspaceContextService.ts:42` 触发，构造于 `AgentService.ts:701`） | AgentService 内的第 1 份 WSCS | ON | `LibraryWorkspaceContextService.ts:138` `this.workspaceSharedContext.promote(...)` |
| 3 | `index.ts:2692` `memoryKernel`（`memoryGatewayController`、`projectService`、`ProjectContextResolver`、`BlueprintService` 共用） | 组合根 | ON | IPC/Memory Gateway/Project/Blueprint |
| 4 | `WorkspaceSharedContextService.ts:52`（经 `index.ts:3082` `workspaceSharedContextService = new WorkspaceSharedContextService(db);`） | 组合根的第 2 份 WSCS | ON | `index.ts:2003` `getView`、`index.ts:2097` `promote`、`index.ts:3125` `getDigestForTask` |

→ **定论 B 的「三实例」清单漏了 1 个（第 4 个），并把 `WorkspaceSharedContextService` 当成单份。** 这直接影响任务的计数与「统一注入」的收敛面：`WorkspaceSharedContextService` 需要收敛的构造点也是 2 个，不是 1 个。

### 2.3 反例 2：构造器的 `reapStalePendingCandidates` 跑 **≥4 遍**，且这是**真实数据写**，10 分钟窗口可误伤在飞候选

`src/main/memory/MemoryService.ts:240-252` 原文（逐字）：

```ts
  constructor(private readonly db: AppDatabase, opts?: { semantic?: boolean }) {
    this.repository = new MemoryRepository(db);
    this.cognition = new MemoryCognitionService(db);
    this.learning = new MemorySkillLearningService(db, this.repository);
    this.semantic = opts?.semantic === false ? null : new MemorySemanticProvider(db);
    // Candidates stuck 'pending' from an interrupted extraction become reviewable instead of invisible.
    try {
      const reaped = this.repository.reapStalePendingCandidates(Date.now() - 10 * 60_000);
      if (reaped > 0) console.info(`[MemoryKernel] reaped ${reaped} stale pending candidates → needs_review`);
    } catch (error) {
      console.warn("[MemoryKernel] stale candidate reap failed", error);
    }
  }
```

`src/main/memory/MemoryRepository.ts:419-425` 原文（逐字，注意 SQL 条件）：

```ts
  /** Candidates left 'pending' by an interrupted extraction become reviewable instead of invisible. */
  reapStalePendingCandidates(olderThan: number): number {
    const result = this.conn.prepare(
      "UPDATE memory_candidates SET status='needs_review', resolved_at=? WHERE status='pending' AND created_at < ?",
    ).run(Date.now(), olderThan);
    return Number(result.changes ?? 0);
  }
```

事实链【实测】：
1. `reap` 的 SQL 条件恰好是 `status='pending' AND created_at < now-10min` —— **没有**「提取任务已死」的判据，只有时间窗。
2. 每次 `new MemoryService(...)` 都会执行它 → 生产冷启动至少 **4 次**（上表 4 个构造点；三者集中在 L2692/L2732 附近，第 4 个在 L3082，确实存在「前一次 reap 之后再有新 pending」的时间差）。
3. 提炼循环是**逐条** `insertCandidate` 后立刻 `reconcileCandidate`（`MemoryService.ts:894-897`），并且 **L896 会跳过已被改判的候选**：
   `if (this.repository.getCandidate(dto.id)?.status !== "pending") continue;`
   → 若单批提炼耗时超过 10 分钟（多候选 + 模型慢 + 重试），批次早期插入的候选会在同一批循环内被（另一实例的）reap 改成 `needs_review`，随后被 L896 跳过，**该候选不会走自动 reconcile**，只会以「待复核」形式出现在候选队列里（`MemoryService.ts:921-929` 的 `resolveCandidateReview` 才处理）。
4. `resolveCandidate`（`MemoryRepository.ts:408-412`）是无条件 UPDATE：`status=?`，因此晚到的提炼结果可以覆盖 `needs_review`，不会产生脏状态；危害是**自动落库被降级为人工复核**（可用性/行为差异），不是数据损坏。

**严重性校准【推断】**：正常批次远短于 10 分钟，因此这是低概率边缘情况；但它**可发生**，且是「构造器有库写副作用 + 多实例导致副作用重复」的直接后果。定论 B 的表述「不会产生索引分歧」虽然为真，却把「构造器是纯内存初始化」当成前提，漏掉了这个有窗口的写副作用。

### 2.4 定论 B 的结论

- **是否成功证伪**：**部分证伪**。核心命题「三实例全 semantic ON、不会有索引分歧」**未能证伪**（反而被我用 `MemorySemanticProvider` 常量与 `SemanticRuntime` 单例进一步证实）；但**实例清单与副作用描述被证伪**：
  - 生产路径是 **≥4 个 MemoryService**、**2 份 `WorkspaceSharedContextService`**，不是 3 个；
  - 构造器并非「只做内存初始化」：每个实例都会跑一次 `memory_candidates` 的 `UPDATE`（`MemoryService.ts:247` → `MemoryRepository.ts:421-423`），带 10 分钟时间窗，可在特定时序下把在飞 pending 候选改判为 `needs_review`。
- **需要怎么修正**：
  1. 实例清单改为：`AgentService.ts:696`、`WorkspaceSharedContextService.ts:52`（**两个调用方**：`LibraryWorkspaceContextService.ts:42`、`index.ts:3082`）、`index.ts:2692`，共 4 个实例 / 2 份 WSCS；收敛任务需覆盖 `LibraryWorkspaceContextService.ts:42` 的默认分支。
  2. 把「无索引分歧」与「无副作用」拆开写：索引/语义配置确实一致；但**每个实例构造都会写 `memory_candidates`**，收敛目标应为「reap 只跑一次（移到组合根显式调用或幂等守卫）」。
  3. 若保留 10 分钟窗口，建议在报告里显式声明「单批提炼 >10 分钟会把早期候选降级为待复核」为已知边缘行为。
- **证据级别**：构造点、SQL 原文、L896 跳过逻辑、【实测】；「>10 分钟批次会触发」为【推断】。

---

## 3. 定论 C：appStore 的 db 直写面「精确为 47 个调用点行与 48 次方法引用」

### 原文（被复核的定论）
> appStore.ts 的 db 直写面精确为 47 个调用点行与 48 次方法引用，不是规划说的 126。

### 3.1 复核结果：appStore 层面接近但**不等**，而**「直写面」的分母明显不完整**

【实测】对 `src/renderer/**/*.{ts,tsx,js,jsx}` 匹配 `api\??\.db\??\.([A-Za-z0-9_]+)`：

| 口径 | 实测值 |
| --- | --- |
| 全 renderer `api.db` 方法引用总数 | **105**（分布在 105 个不同 文件:行） |
| 其中 `src/renderer/src/store/appStore.ts` | **46 行 / 46 次方法引用** |
| 其中 components 等其它 renderer 文件 | **59 次**，分布在 **24 个文件** |
| 只有 `api.db` 而无方法名的根绑定（`const api = window.api?.db;`） | **3 处**：`ProjectFolderRelocation.tsx:18`、`ProjectMaterials.tsx:124`、`NewProjectTodoModal.tsx:92` |
| **裸写（无可选链）**：`window.api.db.<method>` | **1 处**：`src/renderer/src/components/pages/project/ProjectMaterials.tsx:100` —— `const [next, pinned] = await Promise.all([libraryApi().snapshot(), window.api.db.listProjectPins(project.id)]);` |
| 非读取调用（方法名不以 `list|get|on|pick|inspect` 开头，排除 `typeof` 守卫） | **66**：appStore **33** + components **33** |

**appStore 逐行清单【实测，46 行】**（行号:方法）：771 upsertSpace、889 listTasks、1499/1531/1929 upsertTask、2174 listTasks、2340 listSpaces、2341 listTasks、2342 listProjects、2343 getSoul、2964 upsertTask、3300 deleteTask、3332 purgeArchivedContent、3378 listTrashedTasks、3388 restoreTrashedTask、3414/3429 upsertTask、3644 upsertTask、3807 listTasks、4220 listTasks、4221/4236 upsertTask、4373 upsertTask、4387 listProjects、4400 upsertTask、4522/4568/4610/4656 upsertTask、4675 updateSoul、5371 upsertTask、5398/5404 archiveTask、5414/5420 archiveSpace、5423 deleteSpace、5448 listTaskWriteGrants、5454 deleteTaskWriteGrant、5470/5512/5561 upsertSpace、5489 listSpaces、5627 renameSpace、5642 `typeof (window as any)?.api?.db?.moveTaskInWorkspaceTree`、5671 upsertTask。

→ 就 appStore 自身而言，父代理的 47/48 与我的 46/**46** 相差 1；无论以哪个为准，**「精确」这个词不成立**（差异来自 5642 的 `typeof` 守卫与 2340-2343 的解构块是否计入「调用点行」）。我没有找到能让行数变 47、引用数变 48 的口径，故判定该数字**口径不明/不可复现**。

### 3.2 反例（核心）：直写面并不止于 appStore —— **24 个 renderer 文件绕过 store 直接写 `window.api.db`**

这些文件从未经过 appStore 的 action，属于「同一写面」的直接组成部分；只数 appStore 会漏掉约一半：

【实测】`window.api.db` 的写调用（节选逐字，完整清单见下表）：
- `src/renderer/src/components/chat/TaskRecoveryNotice.tsx:27`：`await window.api?.db?.dismissExecutionFailure?.(taskId, failure.id);`（**与定论 A 同一张 `execution_failures` 表**，绕过 store 直接 dismiss）
- `src/renderer/src/components/pages/project/ProjectActivity.tsx:95`：`await window.api?.db?.createProjectPost?.({ projectId: project.id, body: draft.trim() });`
- `src/renderer/src/components/pages/project/ProjectAssets.tsx:146`：`await window.api?.db?.createProjectResource?.({`（同文件 :242 再一处；:265 `deleteProjectResource`）
- `src/renderer/src/components/pages/project/ProjectSettings.tsx:112`：`const result = await window.api?.db?.archiveProject?.(project.id, !project.archived);`（:130 `deleteProject`、:99 `duplicateProject`）
- `src/renderer/src/components/pages/NewProjectModal.tsx:279`：`const result = await window.api?.db?.createProject?.(plan.request);`
- `src/renderer/src/components/pages/AutomationPage.tsx:788`：`const rows = (await window.api?.db?.listTasks?.()) ?? [];`（同一 IPC 在 appStore:889/2174/3807/4220/4235 也有）

全 renderer 非读取调用合计 **66**（appStore 33 + components 33）。即使只统计「写」，components 侧也有 30+ 处独立的写路径。

### 3.3 与既有复核的关系（交叉验证）

同目录既有报告 `out/plan-review/T8-acceptance-scripts.md` 已独立给出 `src/ 4` 处 `new MemoryService` 的口径（其 F1 条目要求「`src/main/**` 内 `new MemoryService` ≤1 且 `new ExecutionFailureRepository` ≤1」）。该「4」与我在 §2.2 的 4 个构造点一致（3 个文件、4 个调用点），可作为交叉验证：**「三实例」是少算的**。

### 3.4 定论 C 的结论

- **是否成功证伪**：**是**。两点：①「47 行 / 48 次」与实测（46 行 / 46 次）不一致且口径不可复现；②更重要——把「appStore 的 db 直写面」等同于「renderer 的 db 直写面」是**漏算**：还有 **59 次** `api.db` 引用分布在 **24 个** components 文件（其中约 33 处为写），包含 `dismissExecutionFailure` 这类与核心恢复链同表的写、以及 `createProjectResource`/`createProjectPost` 等项目域写。
- **需要怎么修正**：
  1. 数字改为**分口径列出**：`appStore.ts` 46 行 / 46 次 `api.db` 引用（其中写方法 33 次）；**全 renderer** 105 次引用 / 105 行 / 24 个非 appStore 文件（其中 write-ish 66 次）；`window.api.db`（裸写，无可选链）1 处；根绑定 3 处。
  2. 收敛范围必须包含 components 直写（`window.api.db`），否则「统一 DB 访问层」仍会留下 24 个文件的旁路；尤其 `TaskRecoveryNotice.tsx:27` 与 `TaskRecoveryNotice.tsx:15`（`listExecutionFailures`）直接对接 A 的仓库。
  3. 断言不要写死「精确 47/48」；改为脚本化统计 + 阈值（并明确 `typeof` 守卫、根绑定、解构块的计入规则）。
- **证据级别**：全部【实测】（正则普查，逐行可复现）。

---

## 4. 定论 D：Phase 0.1「建 main-services.ts 统一前置注入」不成立

### 原文（被复核的定论）
> 规划 Phase 0.1 的「建 main-services.ts 统一前置注入」不成立，因为 memory 可正向注入（index L2692 早于 agentService L2732），而 executionFailures 只能反向（index L1854 在 registerIpc 内，晚于 agentService）。

### 4.1 精确行号与执行顺序复核【实测，全部逐行读取原文】

| 行号 | 原样引用 | 是否在 `app.whenReady()` 回调内 | 判定 |
| --- | --- | --- | --- |
| `index.ts:294` | `let db: AppDatabase;` | 模块级声明 | 无执行 |
| `index.ts:644` | `function registerIpc(): void {` | **函数定义**（模块级） | 定义时不产生动作 |
| `index.ts:1854` | `const executionFailureRepository = new ExecutionFailureRepository(db.connection);` | **在 `registerIpc` 体内**（L644 起，body 到 L2633 `}`） | **只有被调用才执行** |
| `index.ts:1855-1856` | `ipcMain.handle(DbIpc.listExecutionFailures, (_e, taskId: string) => executionFailureRepository.list(taskId));` / `... dismissExecutionFailure ...` | 同上 | 依赖 L1854 的局部变量 |
| `index.ts:2635` | `app.whenReady().then(async () => {` | 回调起点 | — |
| `index.ts:2654` | `db = new AppDatabase();` | ✅ | 全仓唯一实例化 |
| `index.ts:2692` | `const memoryKernel = new MemoryService(db);` | ✅ | #1 memory 实例 |
| `index.ts:2732` | `agentService = new AgentService(db);` | ✅ | AgentService 构造（其内部 L717 建 executionFailures） |
| `index.ts:3012` | `await agentService.init();` | ✅ | 首个跨越较大时间片的 await 之一 |
| `index.ts:3082` | `workspaceSharedContextService = new WorkspaceSharedContextService(db);` | ✅ | **第 4 个 MemoryService 在此诞生（【实测】）** |
| `index.ts:3345-3362` | `if (memoryGatewayController) { ... await memoryGatewayController.start(); ... }` / `if (remoteAccessController) { ... await remoteAccessController.start(); ... }` | ✅ | 启动期 await |
| `index.ts:3364` | `registerIpc();` | ✅（**调用点**） | L1854 此刻才执行 |

**关键结论（回答任务里的「whenReady 回调是否异步分段执行」）【实测】**：
- 该回调确实是 async 且**分段**执行（L3347 `await memoryGatewayController.start()`、L3357 `await remoteAccessController.start()`，更早还有 L3012 `await agentService.init()`），但在 **L2654 → L2692 → L2732 → L3082** 这四点之间**没有任何 `await`，也没有任何 IPC 注册**（逐行扫描 L2653–L2695 与 L2726–L2732，未发现 `await`）。
- 因此「memory 早于 agentService」是**同一同步段内的确定性事实**，不会被异步切分推翻；「executionFailureRepository 晚于 agentService」也成立，但原因**不是** L1854 的位置早于 L2732（1854 < 2732），而是 **`registerIpc()` 的调用点 L3364 晚于 L2732**——L1854 处于函数体内，其**执行时刻由 L3364 决定**。父代理用「L1854 在 registerIpc 内，晚于 agentService」表述方向正确，但「行号晚于」的说法容易误导（1854 的**文本行号**反而更小）。

### 4.2 反例：`private readonly` 证明「反向复用」被**封装**挡住，而不是被**时序**挡住

`src/main/agent/AgentService.ts:536` 原文：

```ts
  private readonly executionFailures: ExecutionFailureRepository;
```

- `private` → `index.ts` 内的 `agentService.executionFailures` 在 TypeScript 上**不可访问**（这是「收敛方案可行性」的硬约束，任务点名要点，**实测确认**）。
- `readonly` → 即使放宽为 public，也只能在 AgentService 构造器内赋值（L717），外部不能把已有实例塞进去。
- 且 `AgentServiceDependencies`（L420-423）**没有** `executionFailures` 注入点，构造签名是 `constructor(private readonly db: AppDatabase, taskWorkspace?: TaskExecutionWorkspace, dependencies: AgentServiceDependencies = {})`（L671-675）。

**所以「executionFailures 只能反向」的阻力来源是封装/签名，而不是执行顺序**。反证：同一份组合根里，`memoryKernel`（L2692）就是这样**正向**交给 AgentService 的——

`src/main/agent/AgentService.ts:700-707` 原文：

```ts
    this.projectContextResolver = new ProjectContextResolver(db, projectRepository, this.memoryService);
    this.libraryWorkspaceContext = new LibraryWorkspaceContextService(
      db,
      this.memoryService,
      this.projectContextResolver,
      () => this.settingsStore.read().memoryEnabled,
    );
    this.projectService = new ProjectService(projectRepository, this.memoryService);
```

`src/main/index.ts:2695` 原文：

```ts
  projectService = new ProjectService(projectRepository, memoryKernel);
```

也就是说：**同一个 `MemoryService` 实例已经被 `index.ts` 共享给 `ProjectService`（注入式），另一条也在 `AgentService` 内被复用**；memory 的可注入性并非「因为 L2692 早于 L2732」，而是「因为它作为参数被传下去」。把同样的手法用于 executionFailures 只需要：在 L2670 附近（早于 L2732）构造 1 个实例 → ①经 `AgentServiceDependencies` 注入 AgentService（需要新增字段），②在 `registerIpc` 内（L1854）改为闭包引用该组合根实例。此时顺序完全满足（构造点 2670 < 2732 < 3364），**`db.connection` 仍是同一个对象**，行为与现状等价（唯一差异是构造函数里的 DDL/UPDATE 从 2 次变 1 次，这正是 A/B 想要的收敛）。

### 4.3 定论 D 的结论

- **是否成功证伪**：**是（证伪其判定理由与「不成立」的结论）**。
  - 与事实相符：**方向性约束真实存在**——`index.ts:1854` 所在代码只在 `registerIpc()`（调用点 L3364）执行，必然晚于 `agentService`（L2732）；「memory 可正向（L2692 早于 L2732）」也确认为真；且 L2654→L2692 之间无 await。
  - **被证伪**：把这解释为「执行顺序决定了 executionFailures 只能反向（=> 统一前置注入不可行）」是错的。真正的阻力是 **`private readonly`（L536）+ `AgentServiceDependencies` 缺注入点（L420-423）**；这两点都是可以改的代码，不是时序约束。因此 Phase 0.1「建 main-services.ts 统一前置注入」**在执行层面可行**，前提是同步修改 AgentService 的字段可见性与依赖签名。
- **需要怎么修正**：
  1. Phase 0.1 的结论从「不成立」改为「**可行但需附带 2 处代码改动**」：`AgentService.ts` 新增 `executionFailures?: ExecutionFailureRepository` 依赖（或在组合根注入 repository），并把 `private readonly executionFailures`（L536）改为可外部传入；`index.ts` 把 L1854 改为引用组合根实例。
  2. 描述时序时用**执行点**而非文本行号：写成「`registerIpc()` 的调用点在 L3364，晚于 `AgentService` 构造 L2732；L1854 在函数体内，其执行时刻由 L3364 决定」。
  3. 顺序校验基线可保留：`db(2654) → memoryKernel(2692) → agentService(2732) → workspaceSharedContextService(3082) → registerIpc(3364)`；若要新增 `main-services.ts`，其构造段必须插在 **L2692 之前**（不依赖 L2692 的话，插在 L2655 之后即可）。
  4. 顺带把 B 的第 4 个 memory 实例（L3082 触发的 `WorkspaceSharedContextService`）纳入同一收敛清单，否则「统一前置注入」仍会漏一处 `new MemoryService`。
- **证据级别**：行号、`await` 分布、字段可见性、`AgentServiceDependencies` 字段、L2695/L3191 注入实例均为【实测】；「改造后行为等价」为【推断】（需改造后跑 `pnpm -s typecheck` 与相关 `test:*` 才能坐实）。

---

## 5. 汇总

| 定论 | 结果 | 反例（文件:行号） | 需要的修正 |
| --- | --- | --- | --- |
| A 双实例「无状态 + 纯幂等 DDL」 | **部分证伪**（核心 bug 判定未推翻，机制描述被推翻） | `ExecutionFailureRepository.ts:14`（构造器内 `UPDATE ... dismissed_at`）；`AgentService.ts:719`（恢复只挂一边） | 描述改为「构造器含一次依赖构造时刻的写」；两实例能力不等价 |
| B 三实例「全 semantic ON、无分歧」 | **部分证伪**（indexing 命题成立，清单与副作用被推翻） | `WorkspaceSharedContextService.ts:52` 经 `LibraryWorkspaceContextService.ts:42` → 第 4 实例；`MemoryService.ts:247` + `MemoryRepository.ts:421-423`（reap 写库、10 分钟窗） | 改为 ≥4 实例 / 2 份 WSCS；收敛目标含「reap 只跑一次」 |
| C appStore 47 行 / 48 次「精确」 | **证伪** | 全 renderer 105 次引用 / 24 个非 appStore 文件（`TaskRecoveryNotice.tsx:27`、`ProjectActivity.tsx:95`、`ProjectAssets.tsx:146`、`NewProjectModal.tsx:279` …）；裸写 `ProjectMaterials.tsx:100` | 分口径统计；收敛范围含 components 直写 |
| D Phase 0.1 统一前置注入「不成立」 | **证伪（判定）** | `AgentService.ts:536` `private readonly`；`AgentService.ts:420-423` 依赖接口无注入点；`index.ts:2695`/`3191` 已存在正向注入先例 | 改为「可行，需同步改 AgentService 字段与依赖签名」；时序用执行点表述 |

**refutes_parent = true**（B/C/D 均找到可复现实例或结构性反例；A 的机制描述亦被证伪）。

**未能证伪的部分（明确声明）**：①「当前生产代码中 A 的双实例不构成可复现功能 bug」；②「B 中三/四个 MemoryService 的 semantic 解析一致、不会产生索引维度分歧」；③「D 的方向性约束本身（registerIpc 晚于 agentService）为真」。

---

## 6. 备注（本次未做的事）

- 未启动应用做运行时验证（无 GUI/Electron 冷启动条件）：A 的「窗口期数据损失」、B 的「>10 分钟批次被 reap」都是**基于代码的推断**，如需坐实应写一个一次性脚本：造 `memory_candidates` 的 pending 老行（`created_at = now-11min`）→ 构造 `MemoryService` → 断言其状态被改为 `needs_review`；以及造 `shell-exit-nonzero` 未决行 → 构造两次仓库 → 断言第二次会 `dismiss`。
- 源码零改动；`out/plan-review/T10-falsify-parent.md` 与 `diagrams/t10-falsify-parent-evidence.svg` 为本次唯一写产物。
