# 改进建议（第二版，基于复检）

本文件是第一轮评估后的**复检 + 可执行建议**。所有"已验证"的条目都是我实际跑到证据的；标注 `[未验证]` 的是我未能确证的推测。

---

## 0. 复检推翻/修正了第一轮的哪些结论

| 第一轮结论 | 复检结果 |
|---|---|
| `test:architecture` 是"产品缺陷红灯" | **修正**：不是产品缺陷，是**测试断言了已被删除的旧契约**。见 §1 |
| 只有 2 个测试失败 | **修正**：全量跑 236 个非 UI 孤儿测试，**158 通过 / 78 失败**。其中相当一部分是我沙箱环境所致，需分开看。见 §2 |
| "无 CI"是主要问题 | **降级**：真正的根因是**测试未与真实用户数据隔离**，无 CI 只是让问题不可见。见 §3 |
| `artifact-gate` 是"2 条规则失效" | **修正**：R4 是门禁白名单过时（真缺陷，已验证可修）；R15 是**同名不同概念的误报**（门禁自身缺陷）。见 §4 |

---

## 1. `test:architecture` 的真因：测试未跟随契约变更

**证据链（已复跑验证）**

1. 测试 `scripts/architecture-test.ts:1584-1589` 断言：切换专家后 `registry.get(task) === undefined`（会话被释放）。
2. `git show 95dbe28:src/main/agent/AgentService.ts` 中 `switchExpert` 会调用 `this.sessionLifecycle.releaseIfIdle(req.taskId)`。
3. `git show 3261a43:...` 中 `switchExpert` 改为只调 `saveTaskExpertBinding(...)`，**`releaseIfIdle` 在整个 AgentService 中已不存在**（grep 零命中）。
4. `git show --stat 3261a43` 显示该提交改了 `AgentService.ts`、新增 `TaskExpertBindingService.ts`，**但没有改 `architecture-test.ts`**。
5. 崩溃点 `未找到已安装专家: e1` 是因为新路径先走 `saveTaskExpertBinding → expertBindings.save → ExpertService.getDetail`，测试的 fake 环境里没有该专家。

**关键判断：新实现是更好的设计，不是回归。**
`AgentService.ts:2387-2389` 的注释明确说明理由："每个 backend 只在下一个空闲输入时才采纳 desired，**绝不在 UI 保存或恢复时**进行……Pi 仍有可能在已受理请求准备附件时报 idle。不要在这里 dispose 那个会话。" 变更检测改由 `SessionRegistry.assemblyInputsChanged()`（`SessionRegistry.ts:169-190`）通过 `requestedExpertId` + connector 集合 + `assemblyDirty` 完成。

**建议**：改测试适配新契约，**不要**改回产品。具体：
- 把 `:1584-1589` 改为断言"切换后 `entry.assemblyDirty === true` 且 `requestedExpertId` 已更新，且会话未被 dispose"。
- 为 `switchExpert` 补一个真实 `TaskExpertBindingService` + fake expert 的最小夹具，避免再次因缺 fixture 而崩溃。
- **加重试/护栏**：该测试因未捕获异常直接崩掉整个进程，导致后续断言全部不执行。建议在测试主流程包一层，让单个 section 失败不吞掉其余断言。

---

## 2. 全量测试的真实健康度（这一条仓库自己也不知道）

**已实测**：236 个非 UI 孤儿测试，**总耗时 6.7 分钟**，结果 **158 PASS / 78 FAIL**。

这个数据本身是本次复检最重要的产出：**没有任何门禁会跑这 236 个测试，所以 78 个红灯长期无人知晓。**

**务必区分两类失败（我的采样）：**

- **环境所致（我的沙箱）**：`~/.mybuddy` 写入被沙箱拒绝（实测 `WRITE BLOCKED`）；`spawn EPERM`（skill-root-guard、consult-selection）；`electron.exe ... EPERM`（svg-preview-resize）。这类**不代表产品有缺陷**。
- **疑似真实问题（无 EPERM，纯断言失败）**：`test:pi-native-control`（正则 `/等待模型/` 不匹配）、`test:gadget-blueprint`、`test:terminal`、`test:durable-bot`、`test:subagent-mapper`、`test:conversation-branch-service`、`test:capability-packaging`、`test:models-settings-overlay`、`test:workspace-navigation-ux`、`test:chat-markdown`、`test:project-task-defaults`、`test:workspace-tree`、`test:chat-selection`、`test:library-domain`。

**诚实声明**：上表第二类是"去掉明确的环境成因后仍然失败"，我**没有**逐个确证它们是真 bug 还是环境副作用（例如 `library-domain` 的 symlink 断言在 Windows 无特权创建符号链接时可能本就无法通过）。**建议你在正常开发者环境（无沙箱、有 GUI）重跑一遍再下结论**，我可提供脚本。

---

## 3. 根因：测试依赖真实 `~/.mybuddy`，缺隔离

**证据**：
- `src/main/paths.ts:13-17` `getMyBuddyDir()` 惰性调用 `homedir()`，**并且每次调用都 `mkdirSync`**（有副作用，71 处调用点）。
- 于是测试靠 patch `homedir` 来重定向（`scripts/artifact-characterization-test.ts:28`、`cad-skill-sync-check.ts:32` 都有此注释）。
- 实测：`scripts/*-test.ts` 中 **146 个使用了 temp/home 隔离，111 个完全没有**。
- 实测：真实 `~/.mybuddy/app.db` 16.5 MB，**LastWriteTime = 今天 08:11**（我跑测试期间）。多个失败测试含 2-7 处 `homedir/.mybuddy` 引用。

**这意味着**：一部分测试在跑的时候会**读写开发者/用户的真实数据**。这是比"没有 CI"严重得多的问题——它同时解释了为什么这些测试不敢进 CI、为什么结果不可复现、以及为什么大家默认忽略红灯。

**建议（按性价比排序）**
1. 引入一个测试专用的 home 常量：所有路径统一经 `getMyBuddyDir()`，并在测试入口用 `mkdtempSync` + `process.env.MYBUDDY_HOME` 覆盖。`paths.ts` 只需在 `getMyBuddyDir()` 里优先读该环境变量——**一个函数改动覆盖 71 处调用点**。
2. 把 `mkdirSync` 从 `getMyBuddyDir()` 移出（它是查询函数却在做写入），改为显式 `ensureMyBuddyDir()`。纯函数化后测试可注入、可断言。
3. 给 111 个无隔离的测试补隔离，或明确标记为 `:live` 并从默认套件排除。

---

## 4. `test:artifact-gate`：一个是真缺陷，一个门禁自己错了

### R4 —— 门禁白名单过时（真缺陷，**已验证可修**）
- 失败原因：`src/main/index.ts` 访问 `artifactPreviewHost.captureSurface`，但该名字不在 `scripts/artifact-machine-gate.ts:185-200` 的 `ALLOWED` 集合里。
- `captureSurface` 是 `ArtifactPreviewHost.ts:32` 的 getter，与已在白名单里的 `webContentsView` 同类（都是 WCV 访问器）。
- **实测**：把 `"captureSurface"` 加入 `ALLOWED` 后 → **R4 PASS**。

### R15 —— 名字撞车导致的误报（门禁自身缺陷，**已验证可修**）
- 失败原因：`src/main/memory/MemorySkillRevisionService.ts` 有 `markStale(id)`，命中 `artifact-machine-gate.ts:411` 的正则 `markStale|validateAgainst`。
- **但两者语义无关**：SelectionStore 的 stale 是"选中项是否过期"；`MemorySkillRevisionService.markStale` 是把 memory skill revision 候选的 DB 状态置为 `stale`（`UPDATE memory_skill_revision_candidates SET status='stale'`）。
- 门禁用**名字**做机器锁，一旦别处出现同名方法必然误报。这是门禁设计问题，不是代码问题。
- **实测**：把该文件加入 R15 的 `allowed` 集合后 → **R15 PASS**，且 R4 同时修好后 **32/32 PASS**。

> 注：两次修补我都在真实文件上跑通后**已还原**（`git status -- short scripts/artifact-machine-gate.ts` 为空）。补丁必须用 **LF**（该文件是 LF；我第一次用 CRLF 导致替换后未生效，这是我自己的失误）。

**建议**：R4 按上面加白名单；R15 要么收窄正则（限定 `SelectionStore` 关联类型的返回签名），要么显式加注释说明豁免原因。同时建议给门禁加一条自检：`ALLOWED` 里的成员若已不存在于 host 文件，应报"白名单陈旧"。

---

## 5. 空 catch：风险是真的，但优先级要重新排

- 实测全仓 **64 处**字面空 `catch {}`（我用更严格正则得 64，第一轮同事用较宽正则得 79，量级一致）。
- 最高危一处 **已核实**：`LibraryService.ts:1217-1243` `refreshChunksForItem` 中，embedding 失效失败被空 catch 吞掉且**不打日志**，而同函数 `:1240-1242` 的写入失败**有** `console.warn`。这个不对称意味着"索引悄悄变脏"无法被观测。
- **额外发现（第一轮没提到）**：`invalidateEmbeddingsForChangedChunks(itemId, _newIds, oldIds, oldHashesForKept)` 的**三个参数全部未使用**（前缀下划线即证据），函数体只做一次全表 SQL 扫描。而 `:1262-1267` 那段注释读起来像未收敛的思考过程。这说明该处逻辑经历过反复，**建议优先复审其正确性**，而不是只补日志。

**建议**：先只修 `LibraryService` 这一处（补日志 + 清理死参数），不要全仓扫荡空 catch——多数空 catch 位于 shutdown/best-effort 路径，改动收益低、回归风险高。

---

## 6. 结构与工程化（保持第一轮结论）

- **分层是干净的**（renderer→main 导入 0/261，跨层 0），**但零机械保护**：无 ESLint、无 dependency-cruiser、无 madge。建议加一条 `no-restricted-imports` 或 dependency-cruiser 规则，把"惯例"变成"保证"——半天工作量。
- `src/main/index.ts` 441 个 IPC 注册、0 导出，是导航成本而非逻辑耦合（423/441 是薄转发）。可按已有的 34 个 `*Ipc` 命名空间机械拆分。
- `AgentService.ts`（5805 行、138 import、3 export）是真正的变更放大点。

---

## 7. 仓库卫生（分清"占磁盘"与"进了版本库"）

- **不是问题**：`out/`（1084 MB）、`release-mybuddy-0.1.17/`（1283 MB）**受控文件数为 0**，已被 `.gitignore`；只占磁盘。
- **是问题（实测）**：`artifacts/` 下 **1217 个受控文件 / 67.1 MB**，含两个重复的 `pi-coding-agent` 上游树（`exy.png` SHA256 前 16 位同为 `A8F253347440AED0`，已核实）与 **7 个已提交的 APK**。
- **是问题**：20 个"已删除但未提交"的文件，`git log` 显示只有初始提交 `ff9e756` 涉及这些路径，**没有任何提交解释这些删除**。
- 2 个陈旧分支违反 `AGENTS.md` 的单分支约定；`.tmp-pi104-*` 是放弃的 rebase 残留。

---

## 8. 建议的执行顺序（按 ROI）

| # | 动作 | 成本 | 收益 | 状态 |
|---|---|---|---|---|
| 1 | 修 `LibraryService` 空 catch + 死参数 | 2-4h | 消除静默索引损坏；**唯一确定的正确性缺陷** | 待做 |
| 2 | `MYBUDDY_HOME` 测试隔离（改 `paths.ts` 一处） | 半天 | 让测试可复现、不再碰真实数据；是"能进 CI"的前提 | 待做 |
| 3 | 修 `artifact-gate` R4 + R15，并加 `test:all` | 半天 | 恢复 32/32；把 259 个孤儿测试接进回路 | **已验证** |
| 4 | 按新契约修 `architecture-test` | 半天 | 消除崩溃；`test:architecture` 是分层唯一守护测试 | 需先决策 |
| 5 | 加分层依赖门禁（dependency-cruiser/ESLint） | 半天 | 把干净分层变成不可回归 | 待做 |
| 6 | `git rm --cached artifacts/` 去重 + 提交那 20 个删除 | 1h | 版本库瘦身 ~67 MB、工作区自洽 | 待做 |
| 7 | 在真实开发环境重跑 236 个测试，给我 78 个失败定级 | 1h | 把"疑似"变成"确证" | **建议优先** |

**第 7 条建议最先做**：目前 78 这个数字里混着我的沙箱噪声，先拿到干净环境的基线，再决定 2/4 的优先级。
