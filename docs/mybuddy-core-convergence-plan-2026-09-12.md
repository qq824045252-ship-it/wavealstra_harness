# MyBuddy 核心收敛实施计划

> 已退役边界：本计划中的 Completion Gate 与四核心工具宿主验证不再是现行架构。2026-10-02 已删除 verified write/edit/bash、目录拦截与自动备份，现行实现及验收要求见 [Pi 四核心工具原生化](MyBuddy-Pi-native-core-tools_2026-10-02.md)，不要按本文件恢复旧覆盖。

日期：2026-09-12。范围：执行可靠性、项目产品模型、入口收敛、故障恢复、外部执行、性能。
这是跨阶段改造。A0/A1、B 项目主流程、C 恢复、D Delegated Run 与 E 性能基线均已按阶段推进；各阶段的测试边界与尚未覆盖的真实外部系统仍以下文完成记录为准，不用测试数量替代真实环境证明。

## 目标与当前事实

产品主模型确定为：**项目是工作容器，包含任务、文件、知识、记忆；运行上下文是本次执行实际取用的材料。** 独立任务仍可不属于项目。UI 不再要求用户理解 Space、Library、Pinned Context、Shared Context 的内部层级。

执行统一遵循 Intent → Plan → Execute → Observe → Verify → Recover/Retry → Finish。简单问答可用轻量隐式计划，不强迫每次问答建立多步骤计划；任何具有副作用的执行都必须能够声明结果要求、关联真实观察、判断是否验证通过。工具传输成功与任务结果通过分别记录。

代码核对依据：

| 领域 | 当前实现 | 缺口 |
| --- | --- | --- |
| 意图与计划 | `ExecutionIntentAnalyzer`、`ExecutionRouter`、`ConversationPlanService`、`conversation-runtime-extension` 已有 direct/todo/plan、持久化、续跑 Gate | Gate 仍接受模型提交的 passed/evidence 文本；direct/todo 未被结果协议覆盖 |
| Computer Use | `ComputerUseOutcome`、`ComputerUseRunCoordinator` 已有观察、语义判断和有界恢复 | 通用执行不能把截图成功等同于业务结果成功，也不能直接搬用窗口重试策略 |
| 工具边界 | 原生工具由 `PlanSideEffectPolicy` 判定；MCP 由 `mcp-side-effect-extension` 与实际 provider/tool 判定 | 两条路径都需要接入证据失效和后续结果验证；不能另用工具名猜测替代权限判定 |
| 项目 | `ProjectService` 已有 Shared Context 引用、知识检索；ProjectWorkspace 有六个主标签及能力/设置 | 多个概念暴露给用户；`project-v1-stable.md` 的知识范围已落后于实现 |
| 外部执行 | `external-agent.ts`、`ExternalAgentRuntime` 已有 runId/status/cwd/session/continuation/cancel；`HerdrLauncher` 是另一入口 | protocol 目前固定 ACP；进程结束即 completed；重启把活跃执行统一标 failed；需统一输出、产物、恢复能力和验证 |

此次工作树另有 `docs/remote-architecture-review-2026-09-12.md`，不属于本计划修改范围。用户提到的 Architecture 304/304 是历史基线，不作为当前已跑验证。

## 实施顺序与交付门槛

### A0：修复现有 Completion Gate 的证据生命周期（本轮）

- 修改步骤内容/状态、重新 start、跨 execution 恢复，旧验证不得继续作为完成依据。
- 原生与 MCP 已识别的副作用尝试开始前失效旧验证；失败也可能留下部分副作用，所以不能只在 success 时失效。后续门禁拒绝导致保守失效可接受。
- blocked/cancelled 不能因残留 passed 证据变为 completed；completed 结算幂等。
- 旧 version 的迟到结算不能覆写最新计划；终态不能被迟到 mutation 重新打开。
- 用内存 SQLite 服务回归和 extension hook 回归证明，不把这些测试称为真实 Electron/设备验证。

### A1：统一验证协议与第一个真实适配器

复用现有 Conversation Plan 和 executionId，不新建平行的顶层计划域。增加执行步骤/工具尝试记录：taskId、executionId、stepId、attemptId、toolCallId、phase、输入摘要、目标指纹、起止时间、结果与错误分类。身份和 cwd 由主进程注入。

每个验证结果包含 verifierId/version、expected、observed、evidenceRefs、attemptId、目标指纹和时间；结果区分 passed / failed / inconclusive / not_run。模型可以提出检查要求，不能自己生成可信 verifier 证明。模型陈述保留为 finding 或声明式检查，不自动升级为独立验证。

验证器通过受控注册表调用，沿用权限和路径授权，不执行模型提供的任意验证命令。观察与验证分别存储。文件适配器首先覆盖内置 write：按主进程授权目标读回，核对内容摘要；缺失、内容不符、验证时被改写和读回失败都不能 passed。文件存在不等于内容满足要求。Artifact 只引用可信产物域记录。

然后接入 edit 的后置内容约束、MCP 的显式 provider/tool 适配器、bash 的退出码加产物/行为断言、CAD 的重建/测量/保存重开、Computer Use 已有 outcome。未知工具允许完成传输，但明确保留未验证状态；不得统一标绿。

验收：假 success、不匹配文件、跨任务证据、过期结果、验证器异常、异步迟到结果均无法完成任务。direct/todo 的副作用工具也进入协议。只有当前 attempt 对应的必要验证通过才能 Finish。

### B：项目模型与 UI 同步收敛（用户优先级最高）

先做信息架构和兼容呈现，再做持久化迁移：

| 用户概念 | 产品行为 | 内部映射 |
| --- | --- | --- |
| 项目 | 工作入口，拥有任务与长期工作材料 | Project |
| 项目文件夹 | 本地工作文件的位置，可查看和重新定位 | Space/执行目录保持主进程解析 |
| 资料 | 文件引用、导入知识、共享资料统一查看；说明是否本次使用 | Library + Project Resources + pinned/shared references |
| 记忆 | 长期事实、决策、约束，具备来源与撤销能力 | 现有 Memory 域 |
| 本次使用 | 展示实际注入与检索结果、权限及运行状态 | RuntimeContextSnapshot 与真实解析结果 |

先盘点无项目、有项目无目录、多目录、共享目录、独立任务和历史失效路径的真实绑定数量。禁止根据同名文件夹猜合并。新增项目可建议默认文件夹；旧 task.projectId/spaceId 继续原样解析，目录差异在详情说明。项目删除仍仅解绑，不删除任务、文件、Space 或 Artifact。

资料范围保留个人/项目/任务隔离，跨项目共享需要显式引用及既有授权。目录不是自动全部进上下文；“加入资料”和“本次实际使用”必须分清，预算、过滤和审计仍由 Resolver 决定。重新定位先校验路径和资源，再事务更新引用；失败可回滚。

在落实新映射时修订 `project-v1-stable.md`，明确哪些旧 UI 约束被替代，保留安全与删除边界。旧页面路由和入口做兼容跳转，不一次删除数据字段。

对话页只保留任务输入与当前任务摘要：Mode / Project / Expert / 使用能力 / 权限 / Runtime。能力配置通过同一详情面板展开，运行失败在任务内提供原因和恢复动作。ACP、Herdr、Skill 等配置名放入详情。沿用当前视觉设计和统一壳，不同时换色彩、尺寸和整体布局。

验收：从新建项目、导入资料、启动任务、查看使用材料、处理失败到继续执行完成一次真实 Electron 工作流；五类以上日常场景按操作记录统计，至少 80% 不进入全局设置。先记录基线，再报告改善，不凭主观宣布达标。

### C：故障恢复随执行协议进入，而非末尾补测试

失败分类统一为 retryable / recoverable / requires-user-action / terminal，但“可恢复”不意味着可以重复副作用。每个失败记录 causeCode、发生阶段、已知副作用、恢复动作、预算、下一步与来源证据。

- retryable：确认未产生副作用或具有幂等证明，可有界退避重试。
- recoverable：需重建连接/进程、重新观察或恢复 checkpoint，再决定是否继续。
- requires-user-action：授权、身份、路径重绑定等必须由用户处理。
- terminal：当前请求不可继续，保留可解释错误和已有产物。

工具超时/进程死亡且副作用未知时先观察与对账，绝不默认重放。用户取消不会自动转成重试。重启恢复先将未结束 attempt 标为结果未知，校验拥有者、路径和 checkpoint 后续跑；历史损坏不删除整库。

| 注入故障 | 必须证明的恢复行为 |
| --- | --- |
| 子进程在写入中被杀 | 已有内容保留；未知结果对账；不重复提交 |
| MCP 断线或模型超时 | 记录具体阶段，重连/重试有预算，取消能停止 |
| 应用重启 | 持久 attempt 可追溯，旧回调不影响新 execution |
| JSONL 截断/坏记录 | 隔离坏尾或报告需修复，保留可读历史与原件 |
| 项目目录移动 | 说明失效路径，显式重新绑定，无静默新建/误写 |
| Runtime 启动失败 | 不继续业务工具调用，给出可操作原因 |
| Computer Use 窗口消失 | 重新观察，不向其它窗口重放输入 |
| 外部 CLI 被杀 | 输出与产物保留，根据真实能力提供 resume 或新执行 |

注入只在临时目录、专用子进程和测试项目进行，不杀用户当前工作的应用。先确定性服务/hook 回归，再受控真实进程与 Electron 故障演练；避免用测试数量替代恢复证明。

### D：Delegated Run 统一外部子任务

扩展现有 ExternalAgentRun 为产品可见的外部子任务，优先迁移已有 ACP 和 Herdr 入口，不扩充 CLI 清单。公共视图包含 runId、parentTaskId、agent、cwd、status、outputCursor、artifactRefs、continuation、cancel/resume 能力、verification 和 recovery；adapter/protocol 留在诊断详情。

传输完成与业务 verified 分离。resumeSupported、cancelSupported 由实际适配器能力生成；resume/load/fallback_new 如实展示，fallback_new 不冒充恢复原 session。项目终端 Herdr 入口继续保留；交互终端与后台运行明确 session 所有权，不能共享默认 session 或竞争 PTY。外部执行不变成 MyBuddy Provider。

验收：同一任务能查看输出、取消、重启后检查恢复资格、访问可信产物；取消后迟到完成不能覆盖终态；两个项目的 cwd/session/权限/产物隔离。

### E：性能与日常精致度

前述关键路径稳定后建立启动、首 token、长对话滚动、大文件、搜索、Runtime 冷启动、窗口切换、后台 session 和内存基线。固定机器/数据规模，分别记录冷/热启动及 p50/p95；先定位实测瓶颈，再设回归预算。用用户场景测量，不用泛化性能承诺。

## 分批执行与完成记录

建议按 A0 → A1 首个文件验证切片 → B 项目/资料主流程 → C 故障恢复扩展 → D 外部子任务 → E 性能推进。C 的数据结构及必要故障用例从 A1 开始伴随实施。B 优先于继续扩充工具适配器和 CLI 清单。

每批记录代码范围、验证方法、尚未覆盖的路径与可回滚边界。数据库迁移与用户可见行为单独验收；源码测试通过不等于已运行的 Electron 已更新。

- A0：已实施，验证结果见本轮交付。
- A1：已完成执行尝试/evidence 基础、受控验证器注册表与完成门禁；write/edit、shell/process、MCP、CAD 等关键副作用路径已接入真实执行证据，Computer/UI/Browser 等环境型失败的恢复策略在 C 阶段统一收口。
- B：已完成 Project / Space / Library / Context 用户模型收口、项目资料统一呈现与状态投影、项目工作目录绑定/复用/补偿，以及多目录、共享目录、项目内独立任务、失效目录的 Electron/SQLite 回归验收；底层 projectId / spaceId 仍保持独立。
- C：已完成主执行/文件写改/进程/MCP/Runtime/Provider/Computer/UI/Browser/CAD/Skill Authoring/目录失效/应用重启/会话 JSONL 损坏等恢复覆盖；未知副作用默认先观察/对账，不自动重放。
- D：已完成 ExternalAgentRun → Delegated Run 产品语义收口；ACP 是首个 adapter，Herdr 继续保留项目终端入口和专属命名 session，不扩 CLI 清单、不转成 Provider。
- E：已完成可重复性能基线、两项实测瓶颈优化、参考预算和隔离完整启动基线；默认报告，`MYBUDDY_PERF_GATE=1` 时预算超限才硬失败。

### E 性能基线与优化记录（2026-09-14）

本阶段先测后改，不按 LOC 或“感觉更快”做优化。固定合成规模覆盖：800 条资料库文档、5000 文件工作区、1000 回合会话、300 个任务 × 120 条消息、5000 条虚拟列表、16 MiB 文本预览、100 个后台 Terminal Session；Python Runtime 用 fake uv 排除下载/进程启动，仅测 MyBuddy orchestration。Electron fixture 用真实 Chromium/Electron；完整 MyBuddy 启动使用临时 `USERPROFILE/HOME/APPDATA/LOCALAPPDATA`，不读取或写入真实 `~/.mybuddy`。

实测定位并修复两项主要瓶颈：

1. Library 搜索原来在 FTS 已命中或 >=3 字符无命中时仍可能同步读取其余受管文本，800 文档精确搜索约 p50 188 ms / p95 218 ms，无结果查询约 p50 190 ms / p95 243 ms。现在 >=3 字符且 FTS 健康时以 FTS/metadata 为真源，短查询或 FTS 不可用才全量文件 fallback；缺 FTS 行和 v2 尚未迁完的 200–256 KiB 条目只走缓存的 targeted fallback，避免每次查询反扫数据库或文件。精确与 miss 查询稳定在毫秒级。FTS 正文覆盖从 200 KiB 对齐原 fallback 的 256 KiB，并增加 additive `library_index_state` + 异步恢复：一次性升级历史覆盖，后续启动只修缺失派生行。
2. `snapshotWorkspace()` 原来对最多 5000 个文件串行 `stat()`，p95 约 223 ms；现在目录遍历语义与 5000 文件上限不变，文件元数据按 64 个有限并发批次读取，p95 稳定在约 52–68 ms。没有改快照内容或路径安全边界。

当前参考机基线（2026-09-14，Windows/x64，Node 24.15.0 / Electron 37.7.0；数值用于回归比较，不作为跨机器性能承诺）：

| 场景 | 当前参考 p95 | 预算 |
| --- | ---: | ---: |
| 完整 MyBuddy 冷启动 → renderer loaded | ~2.47 s | 3.5 s |
| 完整 MyBuddy 热启动 → renderer loaded | ~2.53 s | 3.0 s |
| DB schema 冷建 | ~43 ms | 100 ms |
| DB 热打开 | ~17 ms | 40 ms |
| 首 token 前本地 preflight（100 文件，不含 Provider/网络） | ~7 ms | 10 ms |
| Python Runtime orchestration 冷/热 | ~12 / 0.9 ms | 20 / 3 ms |
| Library 精确搜索 / miss（800 文档） | ~3.3 / 1.3 ms | 10 / 10 ms |
| Library 短查询（800 文档） | ~30 ms | 75 ms |
| Workspace snapshot（5000 文件） | ~68 ms | 120 ms |
| 16 MiB 文本预览 | ~42 ms | 75 ms |
| 100 后台 Terminal Session orchestration | ~55 ms | 120 ms |
| 1000 回合历史恢复 | ~15 ms | 50 ms |
| 300 任务切换同步路径 | ~0.6 ms | 5 ms |
| 5000 消息高度估算 | ~0.3 ms | 5 ms |
| Electron 5000 行虚拟滚动处理 | ~1.6 ms | 6 ms |
| Native surface 切换 | ~0.45 ms | 3 ms |

Node 重型合成场景峰值 RSS 参考约 339 MiB（预算 512 MiB）；Electron 多窗口 fixture aggregate working set 约 654 MiB（预算 850 MiB）。二者测试负载不同，不直接相减或当作单个生产窗口常驻内存。

TTFT 边界：真实首 token 时间继续由现有 Usage 真值表记录；它包含 Provider、网络、模型排队和推理波动，不适合做确定性 CI 预算。本性能门只约束 MyBuddy 可控的本地 prompt preflight。真实线上 TTFT 可用于版本/Provider 趋势观察，不把一次在线调用当成产品回归证明。

统一命令：`pnpm test:core-performance-all` 会先 production build，再运行 Node 合成基线、真实 Electron fixture 和隔离完整 MyBuddy 冷/热启动。默认只打印预算；设置 `MYBUDDY_PERF_GATE=1` 后任何预算超限返回失败。完整启动测试的 `MYBUDDY_PERF_STARTUP=1` 仅由隔离 worker 使用：窗口不显示，首个 renderer `did-finish-load` 输出 marker 后退出，正常产品启动路径不生效。
### A0 定向回归命令

```powershell
pnpm exec esbuild scripts/conversation-planning-runtime-test.ts --bundle --platform=node --format=esm --packages=external --outfile=out/tests/conversation-planning-runtime-test.mjs
node scripts/test-guard.mjs out/tests/conversation-planning-runtime-test.mjs
pnpm exec esbuild scripts/conversation-planning-hooks-test.ts --bundle --platform=node --format=esm --packages=external --outfile=out/tests/conversation-planning-hooks-test.mjs
node scripts/test-guard.mjs out/tests/conversation-planning-hooks-test.mjs
pnpm test:harness-quality
pnpm typecheck
pnpm build
```

测试边界：服务测试使用真实内存 SQLite；hook 测试用替身 SDK/MCP，证明调用边界会使旧证据失效，不证明实际 MCP 服务或 Electron 界面行为。未覆盖的未知工具识别、运行中并行 verify 与工具竞态、独立证据签发交由 A1 的 attempt 生命周期解决。

### A1 write 切片实施记录

- `ExecutionAttemptRepository` 使用新增 `execution_attempts` 表记录当前 task/execution/assistantMessage、toolCallId、attemptId、目标、期望/观察摘要、阶段、判定和恢复分类。正文不入库；旧失败记录保留，同一执行同一目标之后的成功写入可解除该目标阻塞。
- `verified-write-extension` 在主会话装配末尾覆盖 write 实现，继续经过既有权限、目录授权与备份钩子，沿用 Pi 的文件修改队列；读回位于队列内部。SDK 解析结果与已授权路径不一致时拒绝，要求模型使用明确的普通路径，绝不静默改写到另一目标。
- `FileContentVerifier` 对 UTF-8 字节流计算 SHA-256，检查文件大小、文件身份/修订、canonical 路径和当前执行身份。成功只表示该次写入的内容核对通过，不表示代码或业务正确，也不保证外部程序此后不会修改文件。
- 运行中、失败和无法判定的最新目标记录都会阻止当前 Plan 通过；模型提交的 passed/evidence 无法覆盖这些记录。direct/todo 的 assistant_end、遥测和生命周期结束事件同样报失败；steer 切换的前一回复保留验证错误，新执行不受旧执行错误污染。
- 启动后未结束 attempt 转为 inconclusive/recoverable；取消和旧执行迟到为 terminal，访问被拒绝为 requires-user-action。没有自动重放副作用操作。

验证：`pnpm test:verified-write` 在真实 Node + Pi SDK + 磁盘 + SQLite 上通过，包含假 success、等长错误内容、短写、文件消失、读回期间改写、取消、迟到身份、并发写、只读/拒绝/允许一次权限、持久化重开、专用子进程在部分写入后被杀、完成事件与模型伪造 passed。`pnpm test:verified-write-electron` 在 Electron 37.7.0 上通过同一套用例。专用 Electron 使用临时 userData；没有重启用户当前 MyBuddy，也未调用在线模型。

当前范围明确限定于主会话内置 write。edit、bash、MCP、CAD、委托/子 Agent 还没有此读回适配器；跨 execution 恢复后的产物重新验收、通用 verifier 注册、验证证据 UI 和后续其它工具修改产物的失效规则仍待实现。A0 的旧模型声明式检查保留，但没有升级为主进程验证证据。

本批收尾：已有 conversation-planning-runtime / conversation-planning-hooks 回归、Harness quality、全量 typecheck、生产 build 均通过。构建有动态/静态混合导入及依赖纯函数注释提示，无构建错误。新版主进程 bundle 已包含验证器与建表逻辑；用户当前运行实例未重启。

### B1 项目资料入口（2026-09-13）

用户已确认上一批 write 改动实机验证无问题。继续推进项目产品模型的第一个 UI 切片：项目主标签「资产」改为「资料」，保留 assets/context/library 路由兼容。项目文档可在项目内导入、搜索文件名和标题、阅读 Markdown/文本；需外部应用的文件提供「打开文件位置」。既有任务参考仍保留文件引用、短文本、链接及文件夹操作，不再要求跳到全局资料库。

项目文档以 Library Space 的准确 projectId 关联呈现，个人与其它项目材料不会混入列表；多个历史资料位置全部保留，导入需要选择位置，不猜测合并。没有项目资料位置时，仅在用户点击导入后通过既有 createSpace API 建立。未修改 DB schema、Task/Space 绑定或现有文件。

只读盘点（2026-09-13）：现有 152 个任务，1 个 project_id 非空，66 个 space_id 非空；有任务绑定的项目中无多目录绑定；当前项目资料库数量为 0。统计不包含任务正文，也没有写入用户数据库。

新增 ProjectMaterials 作为呈现层，服务层仍沿用 LibraryService 与 ProjectService。异步加载、导入及阅读在项目卸载后不回写新项目 UI；两个用途视图保持挂载，切换不丢弃已有参考资料编辑状态。文档阅读不新增编辑或附加到全局当前任务的动作，避免误用其它项目的任务绑定。

验证命令：`pnpm test:project-materials-ui`、`pnpm test:project-workspace-ui`、`pnpm test:library-domain`、`pnpm typecheck`、`pnpm build`。Electron 测试使用真实组件、CSS 与 DOM 交互，但 IPC/数据是隔离 fixture；覆盖导入、阅读、用途切换、项目/个人隔离、多目标选择、失败和迟到响应。原后端 library-domain 回归独立验证真实服务与临时数据库；不将两者合称生产数据端到端验证。

人工检查截图：`out/tests/project-materials-before.png`（改前源码 fixture）、`out/tests/project-materials-after.png`、`out/tests/project-materials-document.png`。这些不是用户正在运行实例的截图。后续仍需推进项目默认文件夹、固定/共享资料归并、实际使用上下文入口及整体设置收口；B 阶段尚未完成。

B1 收尾结果：以上五项命令均通过，截图已检查。构建更新了产物，未重启用户运行实例；尚未执行用户真实数据上的项目资料 UI 端到端验证。


### B2 第一片：项目默认目录与执行资料呈现（2026-09-13）

已落地资料页默认目录选择（数据库持久化、主进程校验、删除引用清理）、新建任务与项目 dock 目录默认值、按项目任务查看运行快照的项目段/实际 cwd。旧任务不重新绑定，旧记录不从现配置补造。

验证通过：`test:project-domain`、`test:project-workspace-ui`、`test:project-materials-ui`。后者使用真实组件与 CSS、隔离 Electron、fixture IPC，覆盖创建任务默认目录和显式独立目录，并保存 `out/tests/project-execution-materials.png`。仍待动态工具读取/Knowledge 检索证据接入统一执行资料清单；当前页面明确区分装配内容、引用与正文，未宣称全部读取已覆盖。


### B2 第二片：执行中读取证据（2026-09-13）

已接入原生 read、project_knowledge_search/read 的完成返回证据。以工具开始时的主进程执行身份归属，正文/片段/元数据分开，持久化至运行快照且计入保留预算，支持去重、100 项上限、迟到拒绝和损坏记录降级。资料页在既有折叠区展示，未增加全局入口。

通过 test:runtime-materials、test:project-knowledge（192 项）、test:project-domain、test:verified-write、test:project-materials-ui（真实组件与 fixture IPC）。后续仍需扩大 MCP/外部工具适配范围，并继续 Pinned/Shared Context 的产品收口；本轮未声称覆盖所有内部文件读取或完成六项总规划。


### B3：Pinned / Shared Context 产品呈现收口（2026-09-13）

已把目标/阶段/协作要求从设置移到资料页「项目说明」，复用原字段和未保存保护；把固定引用呈现为同页「常用资料」，支持项目文档固定和解除，不复制/删除原文档。没有增加全局页面，也没有更改运行时权限或检索作用域。

验证覆盖真实组件的 Electron 隔离交互（fixture IPC），包含保存失败草稿保留、常用写入失败、解除引用保留文档及项目切换响应隔离。截图：out/tests/project-brief.png、out/tests/project-common-materials.png。MCP / 外部执行读取适配以及总规划其余执行/恢复项仍按原路线推进。


### B4 首片：已移动目录的重新关联

项目默认文件夹旁增加重新关联入口：选择新目录后显示旧/新路径、受影响任务和文件引用，用户确认后使用主进程短期预览 token 提交。提交重新检查目录、资料指纹、项目版本、任务归属和运行状态，再事务更新 Space 路径与项目文件引用。取消预览不写入；不会移动或删除磁盘文件，不改历史运行记录。

当前严格限定为非共享、无已登记产物/产物依赖的项目目录。共享目录、子目录绑定、活动 Agent/外部执行及产物路径迁移尚需专门接入，不静默改写独立数据域。旧文件不存在时无法证明新旧内容相同，预览明确要求确认；新位置被其他 Space 占用、文件缺失/越界或资源内容变更均拒绝。

验证：test:project-folder-relocation 用真实临时目录与 SQLite 验证目录先移动、预览无写入、忙任务拒绝、迟到内容变化、共享/产物阻止、事务中途异常回滚及成功提交。test:project-materials-ui 使用真实 Electron 组件与 fixture IPC 验证预览/取消/确认；用户实际应用未重启，完整项目真实模型工作流仍待验收。


### B4 第二片：产物与依赖随目录重新关联

已将 ArtifactService 接入重新关联事务。预览列出受影响产物及文件数；主进程核对入口和依赖可读性、内容 SHA256、根目录和真实路径边界。提交重新计算包含产物元数据和文件证据的预览指纹；Space、项目引用、产物根目录/入口/依赖、产物版本和任务 revision 同事务提交，之后才刷新 Registry 与发送 updated 事件，触发原有预览和 selection 失效链。managed-content 的 storagePath 保留，不复制存储内容。

新增真实 SQLite/文件测试覆盖产物更新后项目写入异常的全量回滚、缓存与事件未泄漏、依赖文件丢失、预览后改写、跨任务产物引用拒绝、旧/新内容不一致、Windows junction 越界、托管存储不迁移及重开数据库。独立 Electron 组件 fixture 检查产物影响清单、缺失原文件提示和取消/提交交互。仍未完成共享/嵌套目录迁移、完整真实模型项目工作流；同步文件核对设 256 MiB 读取预算，大目录异步核对待后续完成。

B4 第二片验证结果：test:project-folder-relocation、test:artifact-domain（116/116）、test:project-materials-ui、typecheck、build、git diff --check 均通过。已检查 out/tests/project-folder-relocation.png；构建日志为 out/tests/project-relocation-artifacts-build.log。未重启用户实例。


### B4 第三片：共享与嵌套目录的完整影响清单

已将共享项目、共享目录的独立任务、物理嵌套 Space、无显式路径而继承父目录的任务，以及其他项目引用的文件纳入同一预览与事务。按物理路径映射，保留 Space parentId、Task projectId/spaceId；界面子项有独立外部路径时不迁移。所有受影响项目的版本同步递增。预览后新增任务或改变项目绑定会使 token 失效；共享任一任务忙碌则拒绝执行。确认区展示共享项目名称与目录变更清单，不静默扩展范围。

原有 Agent prompt/regenerate 入口会重新解析权威 cwd，并在旧 session cwd 不一致时重建会话；未改写历史运行记录和 session JSONL。当前还需完成目录失效时的执行恢复呈现，以及真实项目工作流验收，不能据目录重关联测试宣布 B 整体完成。

B4 第三片验证结果：test:project-folder-relocation、test:project-materials-ui、typecheck、build、git diff --check 通过；隔离 Electron 截图已检查。构建日志：out/tests/project-relocation-shared-build.log。用户运行实例未重启。新发现：AgentService.resolveTaskExecutionWorkspaceCwd 对缺失的绑定路径仍 mkdirSync，后续须改为明确路径恢复，避免目录移动后静默重建原目录。


### B/C：目录失效的执行前置检查

主 Agent 权威 cwd 解析已提取为 TaskWorkspaceResolver，主执行、重试/regenerate、外部 Agent 共用调用链不再对绑定路径 mkdir。执行使用 AppDatabase 的 requireExisting 严格解析：缺失目录、非目录、相对路径、断裂/循环绑定均抛 WorkspacePathError，主进程错误对象分类为 requires-user-action / prepare / sideEffects=none（尚未持久化为统一故障记录）；错误文本提示恢复原目录或重新关联。路径为空且无可继承绑定的任务仍正常建立隔离目录。目录迁移盘点使用只读宽松解析，以便看见已丢失的绑定。ConversationBranchService 的策略解析同样要求现存目录。

真实临时目录/SQLite 回归证明目录先移动后执行拒绝、旧目录不被重建、不落库错误 cwd、无绑定任务可创建隔离目录、嵌套继承任务重新关联后使用新路径。未宣称已经完成结构化恢复动作 UI 或模型端到端验收。

已知基线缺口：test:workspace-tree 当前 315 通过、6 失败，均属 v12 数据保留迁移断言。以 git HEAD 的 AppDatabase 原始实现隔离复跑，仍为同样 315/6（out/tests/workspace-tree-goal-baseline.log），来自已有 resetIncompatibleDatabaseFile 逻辑。本轮不修改这些断言，后续 C 恢复阶段需要处理该既有数据保留风险。


### C：任务内路径恢复记录与入口

新增 ExecutionFailureRepository，按任务保存 causeCode、阶段、恢复分类、已知副作用、操作说明和助手消息关联；四种恢复分类共用 DTO，目前真实接入的是主 prompt/regenerate 的工作目录准备失败。每任务保留最近 100 条，坏记录保留原件并隔离读取。执行尚未建立时不伪造 executionId。路径失败仅在后续主进程严格准备成功后标记 resolved；不会通过 UI 点击或普通工具 success 清除。

对话页新增按需出现的任务恢复提示，显示原因与操作说明；项目任务可直达项目「资料」。通过 DbIpc/preload 读取持久记录，任务切换取消旧响应，完成/失败边界和重新打开任务时刷新。此处尚无自动重试，也没有把模型超时、MCP 掉线等未经适配的错误猜成可重试。此轮依然不代表全局恢复体系已完成。

路径恢复记录验证：test:project-folder-relocation、test:project-materials-ui、typecheck、build、git diff --check 通过。conversation-branch-service 为 68/68。截图 out/tests/task-recovery-notice.png 已检查（真实组件、fixture IPC，不是用户正在运行实例）；最终构建日志 out/tests/task-recovery-build.log。已知 workspace-tree 6 项历史迁移失败仍保留，见上述基线对照。未重启用户实例。


### A1：验证器注册表与 edit 后置验证

ExecutionVerifierRegistry 只允许主进程适配器注册验证代码，按 id/version 查找；未注册结果为 not_run、验证器异常或缺少观察的 passed 结果为 inconclusive。统一结果包含 taskId/executionId/assistantMessageId/attemptId、目标及规范路径、expected/observed、验证时间。新 attempt 带协议版本；仓库拒绝不匹配的 passed 证明，Completion Gate 再次核对。旧已保存 write 记录按旧协议兼容，不复用到新 execution。

write 改为通过注册表调用原有 SHA256 文件验证器。新增 verified-edit-extension，保留实际 Pi edit 的匹配、BOM/换行、diff/patch 和文件变更队列。读取源文件时记录原始字节指纹，写入前核对源文件未被外部改变，保存 SDK 算出的完整目标内容指纹后写入并读回。每次调用独立保存执行身份；未知执行、取消、过期身份、目标替换、假成功、内容不符均不能通过。原权限与备份 hook 顺序保持。

新增 test:verified-edit 使用真实 SDK/文件/SQLite，覆盖多处编辑、BOM/CRLF、并发队列、假成功、外部修改不被覆盖、取消/迟到、权限拦截、write 修复 edit 失败、未注册/异常/空证明验证器、跨任务/尝试/目标证据拒绝。尚未覆盖 MCP、bash、CAD、Computer Use 等适配器，也未把文件一致性等同于任务业务正确性。

A1 write/edit 验证结果：test:verified-write、test:verified-edit、test:verified-write-electron、test:verified-edit-electron、test:project-folder-relocation、typecheck、build、git diff --check 均通过。Electron 运行环境 37.7.0；最终构建日志 out/tests/verified-edit-build.log。未重启用户实例，未宣称真实模型完整任务验收通过。

### C 收尾：Session JSONL 只读恢复与总审计（2026-09-14）

- Pi SessionManager 对坏尾/坏中间 JSON 行会静默跳过；MyBuddy 现在在历史加载前扫描 JSONL，并将损坏记录数、首个异常行、是否仅尾部损坏作为 `sessionRecovery` 返回 UI。正常历史零新增写入。
- 对“JSON 语法有效但会话结构损坏”的情况（真实故障注入：重复 entry id，`buildContextEntries()` 抛错），MyBuddy 不修改源文件，而是在系统临时目录寻找最大可读前缀，仅用于历史恢复；恢复结束 `finally` 清理临时目录，Task 仍保存原 sessionFile。
- 专项测试证明：坏尾、坏中间行、结构损坏 fallback 均保留可读历史；故障注入后的源 JSONL SHA-256 在恢复前后完全一致；临时恢复目录无残留；ChatView 可见恢复提示不与当前执行 Failure 混为一类。
- C 阶段最终原则：自动重试只允许无副作用或有幂等证明；副作用未知时先重新观察/对账；用户取消不自动重放；应用重启将未结束 attempt 标记为未知；路径/授权等需要用户动作时明确阻断；历史损坏保留原件。
- 验证：`test:session-history-recovery`、`test:conversation-branch`（68/68）、`test:execution-restart-recovery`、`test:architecture`（304/304）、typecheck、production build、diff check 全部通过。Build 仍只有既有 Vite 动静态导入及 Markstream PURE 注释 warning。
### D 收尾：统一 Delegated Run（2026-09-14）

- 保留既有 `ExternalAgentRunDto` 与 IPC 名称作为兼容层，但公共视图已补齐 Delegated Run 语义：`runId / parentTaskId / agent / cwd / status / outputCursor / artifactRefs / continuation / cancel-resume capability / verification / recovery / diagnostics`。协议/adapter 仅留在 diagnostics，外部执行不进入 MyBuddy Provider 模型。
- `resumeSupported` 来自 ACP `initialize` 返回的真实 resume/load capability；`cancelSupported` 只在进程仍可取消时为真。历史消息的“继续”按钮只由真实 resume capability 驱动；`fallback_new` 始终显示为“新会话”，不得冒充恢复原 session。
- 运行输出和工具变化维护单调 `outputCursor`；回合结束或失败时 MyBuddy 在 canonical task cwd 做 workspace observation，经 Artifact Domain message refs 回填可信 `artifactRefs`。`workspace_observed` 只表示观察到工作目录/登记产物，不表示业务结果正确。
- 用户取消会立即持久化 `cancelled` 并关闭 cancel capability；ACP notify 后仍保留 process-kill fallback。终态守卫禁止迟到的 completed/failed 覆盖 cancelled。取消不写成执行错误。
- 应用重启会把遗留 starting/working/blocked run 收为 failed；有 session 且 adapter 支持恢复时标为 `resume-available`，否则 `new-run-required`。旧进程已不存在，因此 `cancelSupported=false`；不自动重放原 prompt。
- Runtime Observatory 将这些运行展示为「外部子任务」，显示运行状态、elapsed、output cursor、可信产物数与工作目录观察状态，并支持逐 run 停止。历史聊天保留 run/session/recovery/verification 元数据与可信 Artifact id。
- Herdr 仍是项目/Space 终端能力：`myBuddyHerdrSessionName()` 为每个 Workspace 生成确定性专属 session，所有命令显式 `--session <name>`，绝不竞争用户 Herdr `default` session，也不改造成后台 Provider。
- 专项 SQLite 故障测试证明：重启恢复资格、cursor/Artifact 保留、Task/cwd/session/产物隔离、即时 cancel、迟到 completion 终态保护。配套 `test:terminal` 通过 Host 32/32、Bridge 20/20、Store 9/9、Herdr Launcher 7/7；`test:overview-runtime` 49/49、Architecture 304/304、typecheck、production build、diff check 均通过。
