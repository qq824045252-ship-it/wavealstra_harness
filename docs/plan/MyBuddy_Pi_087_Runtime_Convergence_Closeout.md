# MyBuddy · Pi 0.87 Runtime 收敛统一收尾计划

版本：2026-09-22 · 实现与开发模式验收记录

## 0. 本轮交付与状态口径

本轮已实施 S0–S6，并按用户范围验证开发模式。此前将模型设置页也归为全部收敛过早：用户截图暴露的显示与编辑链路问题，已在第 0.5 节单独补充修复和证据。模型事实及配置交给 Pi；Memory Kernel L1 保持长期认知真源；历史贡献由 Pi SessionManager 管理；MyBuddy 的 Context Projection 只提供本次请求的临时补充证据。

用户最终明确：**“不要安装包，只需要 pnpm dev 能用就行”**。因此 Windows 安装器、安装及安装后重启从本轮交付范围移除，已停止安装器工作，未安装应用。用户允许整体任务完成后集中验证，要求不每个小改动重复测试；本轮未新增或修改测试源文件。

本文件记录实际代码、原生 SDK 行为及真实 Electron/Provider 证据，并保留验证限制。桌面原附件、`docs/plan.md` / `docs/plan2.md` 均未覆盖；保留其他未提交工作，未 stage、commit 或 push。

### 0.1 已落盘的实现

|范围|当前实现|主要位置|
|---|---|---|
|Pi 与 canonical Session|直接 Pi 依赖固定 0.87.0，更新实际依赖图；只读历史加载使用 Pi 内存 SessionManager，先验证 ID/父链；恢复、重试和分支使用原生历史来源|包配置、`SessionFileRecovery.ts`、`session-history.ts`、`AgentService.ts`|
|稳定 Runtime 与会话|配置刷新使用原实例 refresh；Memory 内容更新不重建 Session；装配预览与实际 Windows Shell 内容一致；新任务首轮直接采用显式模型/权限，避免下一轮因装配差异重建|`AgentService.ts`|
|模型唯一来源与准入|目录来自 Pi；配置薄编辑保留未知字段；enabledModels、默认模型及思考偏好使用 Pi Settings；请求入口、鉴权/审批后回调和受支持 HTTP transport 复查模型、设置、取消与所属会话；空 scope 不放宽|`ModelsConfigStore.ts`、`ModelInvocationAdmission.ts`、`request-transport.mjs`、设置与 DTO|
|MCP sampling|保留上游协议及审批；使用宿主 Runtime；审批后重新取当前鉴权，不沿用旧 apiKey/headers；所属会话结束后，等待中的请求也不能继续发送；更新 vendor|`McpRuntimeService.ts`、`scripts/mcp/sampling-bridge.ts`、`sampling-handler.ts`|
|SubAgent|宿主统一选择模型；受信任 launcher 使用同一安装目录的 Pi 0.87 原生模块，归一 npm bundled CLI 入口；修复仅支持 ESM 的 pi-ai 定位；校验实际 worker 模型；空工具列表传 --no-tools；共享预算源码但独立账本/会话|`capabilities/subagent/index.ts`、`runtime.ts`、`worker-launcher.mjs`、构建脚本|
|网页与 Vision|网页问答、摘要、查询改写及 OpenAI/Codex hosted search 使用所属 Session Runtime；移除独立 OpenAI 鉴权/HTTP 兼容路径；保留来源标注；Vision 使用原生图像预处理及请求准入|`capabilities/web-access/`、`VisionModelCapabilityProvider.ts`|
|模型输入限制|Pi inputLimits 无损存储；图片使用 Pi resize，发送前校验数量；受支持 transport 按真正交给 fetch 的 body 字节数校验；不支持该检查的 adapter 在声明字节上限时明确拒绝|`ModelsConfigStore.ts`、`ModelInvocationAdmission.ts`、`request-transport.mjs`|
|临时 Context|不向 user entry 拼接 Memory；context hook 只修改请求副本；同一逻辑用户轮次固定正文、来源和 fingerprint；下一轮更新，撤销在下一次发送前阻止；主会话/BTW/子代理独立；关闭无活跃轮次的合成 warming，保留普通 prompt caching|`EphemeralContextProjection.ts`、`BtwSessionService.ts`、`AgentService.ts`|
|共享证据预算|Memory、Library、Project、工具证据共用配额；扣除基础上下文、输出及增长预留；ContextEdit 只裁剪工具结果的模型贡献，原始记录保留；预算/读取次数到边界后，收起工具并允许一次自然综合答复；原生用户队列仍可进入下一轮|`EvidenceBudget.ts`、`EphemeralContextProjection.ts`、`MemoryContextProjection.ts`、`LibraryWorkspaceContextService.ts`|
|Memory 与派生视图|L1 只从用户原文提取并要求 userEvidence；L2/L3 为 Proposal/Approve，绑定生成和审批时的来源版本；删除自动 L2/L3 cadence，保留 L1 调度；Loadout 读取推荐证据；删除 Project/BTW 平行 Memory 摘要|`MemoryService.ts`、`MemoryCognitionService.ts`、`MemoryProjectionRepository.ts`、`MemoryPipelineManager.ts`、Loadout/Project|
|旧历史及旧摘要|独立 L0 原文 + 精确旧生产标记作为迁移证明；支持多文本块、Goal 尾文、图片及可信父会话来源；追加 ContextEdit/哈希审计，保留原始 JSONL；旧污染 compaction/branch summary 从可验证原始分支重新生成原生检查点；取消、释放、来源变化或生成不完整均不写部分结果|`LegacyMemoryHistoryHygiene.ts`、`LegacyMemorySummaryRecovery.ts`、`MemoryTurnRepository.ts`|
|UI 与旧文件|UI 只应用有匹配审计的历史修正，不按 Memory 标题隐藏真实内容；零生产读取的旧 model-catalog/model-availability 移入备份；删除已确认的一次性模型审计脚本，保留其他临时文件|`user-prompt-display.ts`、旧文件备份目录|
|开发模式启动|修复 Rollup namespace helper 对 node:stream 继承属性读取 own descriptor 导致的启动崩溃；通过 generatedCode.constBindings=false 使用 Object.keys 生成路径，保留 live bindings；不修改生成文件充当修复|`electron.vite.config.ts`|

旧文件备份：`C:\Users\servi\.mybuddy\legacy-runtime\pi-087-closeout-20260922`。

### 0.2 阶段出口与保留边界

|阶段|结果|证据范围|
|---|---|---|
|S0|完成|已记录原基线、用户范围和旧夹具契约差异|
|S1|完成|Pi 0.87 实际依赖、canonical 历史、只读恢复、重试/分支/Compaction 检查|
|S2|完成|统一调用准入、原生配置、真实模型刷新、主进程 Runtime 对象未替换|
|S3|完成|原生工具循环快照、跨轮更新、撤销；真实 Electron 两轮聊天和 JSONL/L0 核查；Session 对象未替换|
|S4|完成|共享选择/预算、L1 提取边界、L2/L3 审批及来源变化拒绝、Loadout 解耦|
|S5|完成|尾块迁移、原始分支摘要重建、幂等及附件保留；真实 Provider 恢复和失败边界验证|
|S6|完成|原生工具循环中耗尽预算后工具为零；原始结果保留；同轮固定/跨轮更新/撤销验证|
|S7|按用户修改后的范围完成|最新源码类型检查和 pnpm dev 启动、实际界面、真实聊天/Memory 更新/模型刷新、原生子代理；安装包已移出范围|

保留的实际限制：

- **历史证明**：不能证明为旧内部注入的原文不自动删改。恢复已识别的污染摘要时，如原始分支不完整、仍有缺少原文证明的旧尾块、模型窗口不足或超过 32 个恢复片段，明确拒绝本次恢复并保留源文件；不猜测或覆盖历史。
- **跨进程**：子代理只继承授权的 cwd、角色与任务文本，不获得父会话完整 Memory/Library/Project。CLI 固定 Pi 0.87.0；共享策略源码，独立会话与账本。
- **请求字节数**：支持 OpenAI Completions/Responses、Azure Responses、Codex Responses、Anthropic、Mistral Conversations、Pi Messages 的 HTTP body 检查；Codex 声明限制时走 SSE。Google/Vertex/Bedrock 声明该上限时拒绝，不宣称已检查其线协议。
- **验证覆盖**：真实模型请求覆盖当前已登录的 DeepSeek；不代表所有 Provider/OAuth 流程均已逐项联网验收。未重新执行用户登录，也不读取或输出鉴权秘密。独立搜索服务的搜索 API 仍是工具能力，不是另一套会话模型目录。
- **旧测试入口**：三个旧夹具命令仍带旧契约断言，源文件按用户要求保持不变；内存适配后的结果与原命令结果分别记录在 0.4，不能声称原命令全部零退出。

### 0.3 兼容行为变化

- 旧 reasoning 中不能无损映射到原生 effort 的值归档，不擅自转换为 low；运行偏好以 Pi Settings 为准。
- 未绑定来源版本的旧 L2/L3 待审批提案需要重新生成，不能补造来源证明。
- 等待鉴权/审批期间模型或权限被撤销，旧请求明确失败；普通 Memory 内容更新在下一逻辑用户轮次生效。
- 预算耗尽会提示资料不完整及未完成事项，不把综合答复当成业务任务已经完成。
- 旧污染摘要的重新生成需要一次或有限次当前模型请求；成功后追加原生检查点，原始条目仍可审计。

### 0.4 集中验证记录

- **类型与编译**：最终 `pnpm run typecheck` 通过；应用完整 main/preload/renderer 构建曾通过，最终源码经 `pnpm dev` 重新编译并实际启动。保留既有动态/静态混合 import 提示。MCP vendor 和子代理共享策略产物已生成，策略生成器拒绝意外打入第二份 Pi SDK。
- **现有检查**：最初 13 组中 10 组通过，覆盖模型架构/设置、历史恢复、Session 生命周期、Memory Kernel、Prompt Context 35 项、Prompt Enhance 113 项、子代理宿主 IPC 14 项及 WebAccess。后续历史恢复、分支 68 项、WebAccess capability 26 项、regenerate、streaming-send、model-refresh 再次通过。
- **Compaction 旧夹具**：原入口依赖旧 `context.tools` 形状而失败；在内存中改为原生 `getCurrentTools(normalizeContext(context).messages)` 后 9/9 通过，包含工具批次、阈值、失败保留、取消和排队消息。未修改测试文件。
- **SubAgent 旧夹具**：原入口 65 项通过、1 项因夹具硬编码 fixture-model 与请求 a/b 不一致而失败。在内存中让同一夹具报告实际 --model 参数，66/66 通过；生产的模型一致性检查保持严格。
- **Memory Cognition 旧夹具**：原入口期待 L2 自动 active，与 Proposal/Approve 契约冲突。内存运行原夹具的生成/审批链，确认 L2/L3 均先 pending、审批后 active、来源更新后旧提案不能批准，L1 保留；未恢复自动 cadence。
- **原生历史治理**：7 组验证覆盖简单尾块、多段文本/Goal/图片、真实用户同名标记、污染 compaction 重建及重复执行、分支回退、缺少 L0 拒绝、离开当前分支的摘要来源。另有取消、dispose、原分支变化 3 组，均拒绝写入部分恢复检查点。
- **原生 Context 与预算整组**：同一用户轮次的 3 次原生请求保持同一 Capsule；工具期间数据更新不改变本轮快照，下一用户轮次读取新 revision；预算耗尽后最后请求工具数为 0；原始 50 KB 工具结果保留、模型贡献由 ContextEdit 限制；来源撤销阻止下一请求；真实 UTF-8 body 字节边界和零预算验证通过。
- **真实 Provider 与子代理**：DeepSeek 原生会话完成旧摘要恢复及新聊天。记录到恢复请求 1900 bytes 不含临时 Capsule/旧 Memory/旧摘要，新聊天 4715 bytes 含临时 Capsule但不含旧污染；canonical 历史无 Capsule。生产子代理经 npm bundled CLI 输入和受信任 launcher 完成真实请求，返回 OK，worker 和注册表正常清理。
- **真实 Electron 开发模式**：截图中的启动异常已复现并修复。最新 pnpm dev 打开 MyBuddy，模型与记忆页面加载成功。临时任务两轮实际回复 ALPHA_087 → BETA_087；Memory revision 1 → 2；同时执行 Pi 原生模型刷新无错误。通过主进程 Inspector 对真实对象比较，Session 与 ModelRuntime 均为同一对象；两次装配 hash 相同，首轮及第二轮权限均为 readonly。真实 JSONL user entries 和 L0 只包含用户原文，没有内部 Memory 块。
- **实际 MCP 连接**：通过当前 Electron 的 MCP 入口连接 drawio-ai，返回 connected，列出 10 个工具；验证的是连接及工具发现，不冒充已经对所有工具执行了业务操作。
- **证据与清理**：开发模式界面截图保存在本地 `out/validation/pi087-dev-startup.png` 和 `out/validation/pi087-dev-chat.png`。临时检查不增加测试源文件；验证任务与记忆通过产品 API 清理，Inspector 临时引用已释放。开发模式保持运行。
- **安装器**：在用户取消前发现 app-builder-lib 26.15.3 使用 ElectronDownloadCacheMode，而旧锁定的 @electron/get 3.0.0 不提供该枚举；已限定该构建依赖为 3.1.0。之后按用户要求停止安装器，不把中断的打包或未进行的安装宣称为通过。[上游 3.1.0 说明](https://github.com/electron/get/releases/tag/v3.1.0)

### 0.5 模型设置页补充修复（2026-09-22）

- **来源核对**：Command Code 截图中的 67 条记录来自本机 `models.json` 的 `providers.commandcode.models`，65 条未声明 `contextWindow`，全部未声明 `maxTokens`。Pi 0.87 的 `provider-composer.js/modelFromJson` 对缺项使用 128000 / 16384；这不是服务商已验证的能力。用户随后继续编辑了自己的列表，条目数量不能作为固定交付值。
- **显示与调用一致**：设置页列表只使用 Main 投影的 Pi Runtime 模型；删除由 renderer 根据 ID 拼装能力的备用模型列表。逐条显示完整 ID、`models.json` 或 Pi 目录来源；本地缺省的上下文/输出明确标为 Pi 默认。Provider 凭证状态与模型启停分开，不再把能够列出模型等同于已经配置凭证。
- **原生编辑**：IPC 传递可编辑的 Pi model fields 和 modelOverrides；模型及 Provider 的未知字段、model headers/apiKey 保留在 Main。详情页允许编辑声明参数和 inputLimits 等原生字段，未填写项保持省略，不自动把运行默认值写回文件。内置模型编辑走 modelOverrides，不用缺省 models 定义替换整个目录模型。
- **思考偏好**：页面和 Subagent 选项读取 Pi supported thinking levels，移除旧主界面推理控制分支。详情保存等待 Pi settings 写入成功；失败留在弹层。模型参数由 Pi Provider 目录和本地覆盖管理。
- **验证**：`pnpm typecheck`、现有 `test:model-refresh`、`test:models-settings-overlay`（9/9）通过。未新增或修改测试源文件；通过 Node 内存执行当前生产方法并使用真实 Pi 0.87，验证字段读写、inputLimits、未知字段/请求头保留、Runtime identity、缺省来源、补全失败零写入、成功添加、校验失败回滚，以及已有目录/覆盖层的补参数行为。
- **实际界面**：pnpm dev 编译主进程和 preload 后实际进入模型页及详情页；Pi 目录模型显示真实目录参数，本地缺项显示 Pi 默认，旧“控制未知”与“元数据 手动”消失，原生思考级别可选。截图 `out/validation/pi087-model-settings.png` 为实际页面/弹层证据。最终开发进程加载最后一处覆盖层修复后保持运行。
- **验证边界**：核对时全局启用的五个模型来自 Pi 目录，未被本地缺省定义覆盖；这不是对所有 Provider 联网请求的保证。Command Code 本地记录未启用，缺失参数尚未通过服务商核验；本次没有猜填参数、自动启用或删除用户条目。Pi 默认值可能导致错误预算或不被接口接受，标签不能替代真实参数配置。

## 1. 不再讨论的架构边界

|领域|唯一事实/配置来源|MyBuddy 保留职责|禁止回退|
|---|---|---|---|
|模型定义、鉴权、目录|Pi ModelRuntime 及其原生模型、鉴权存储|生命周期管理、UI 映射、错误呈现|自建 Catalog/Registry/Auth；自行远端 `/models` discovery|
|模型启用及默认偏好|Pi SettingsManager 的有效配置|产品级调用准入检查、默认选择及受限回退策略|第二份 enabled/disabled/default/reasoning 持久状态|
|长期认知|Memory Kernel L1 / `memory_records`|scope、revision、evidence、提取、检索及治理|L2/L3、项目摘要、外部 CLI 私有记忆成为平行真源|
|会话历史及其模型可见贡献|Pi SessionManager 的 entries、branch、context edit、compaction|任务与会话映射、UI 展示、恢复集成|手工维护第二份 canonical messages；仅修改 agent messages 伪造恢复|
|本次请求的补充证据|非持久 Context Projection|选择、去重、预算、来源标注、临时 Capsule|Projection 变成另一份历史或长期记忆库|
|执行与权限|既有 MyBuddy Harness/Capability/授权控制面|任务编排、工具装配、授权、取消、审计、执行记录|把 Runtime 收敛误解为撤掉 Harness 或放开 Pi 自动续跑|

三个核心真源表述保持为：**模型：Pi ModelRuntime + SettingsManager；长期认知：Memory Kernel L1；当前模型输入：Pi SessionManager 提供 canonical 历史，Context Projection 仅提供临时补充。**

“当前模型输入”是请求级产物，不是第三个需要持久存储并双向同步的数据库。Scope、模型准入与工具权限也不是一回事：记忆和模型配置均不能扩大工具授权。

同一进程、同一 agentDir/鉴权域内的消费者共享 ModelRuntime。跨进程 CLI 无法共享 JavaScript 对象；其 Memory Gateway 继续访问同一 L1 真源，不要求不同工具的外部模型后端伪装成同一个对象。

## 2. 实施前的定向基线（历史快照）

以下保留附件编制时的观察，描述实施前状态；行号已经可能变化。当前实现以第 0 节与仓库源码为准。

|位置|本轮观察|计划处理|
|---|---|---|
|`package.json`|直接依赖 `@earendil-works/pi-ai` 为 0.86.1；开发依赖 `@earendil-works/pi-coding-agent` 为 0.86.1|尚未升级；实际传递依赖、override、patch 须在升级阶段继续核实|
|`AgentService.ts:1380–1395`|`reloadModelRuntimeFromDisk()` 调用 `ModelRuntime.create()`，替换实例并 `invalidateAll()`|优先清除刷新即重建 Runtime/Session 的模式|
|`AgentService.ts:2943–2967`、`:4360–4364`|Memory create/update/forget/promote 等调用 `invalidateMemorySessions()`；该方法标记会话 stale|内容更新改为下一逻辑用户轮次动态投影；不依赖重建会话|
|`MemoryService.ts:696–706`|`resolveContext()` 同时负责预算约束、L3/L2 组合与剩余 L1 预算|将模型输入的选择、预算和格式化职责拆出|
|`AgentLoadoutService.ts:261–270`|Loadout 仍调用 `memoryService.resolveContext()`，使用 2200 字符预算|改为读取检索/推荐证据，避免依赖 prompt 文本接口|
|`MemoryPipelineManager.ts:73–85`|仍存在 `postL1Due/completeL2/completeL3` 接口|核实生产调用后移除旧自动 cadence；存在接口不等于本轮已证实全部无调用|
|`AgentService.ts:1281–1297`|`listModels()` 仍读取配置并构建 `configuredByKey`|检查哪些只是配置编辑信息，哪些重复产生了模型事实|
|`McpRuntimeService.ts:206–221`|已读取 enabledModels、解析 scope，并对显式空 scope 返回失败；headless loader 使用 `noExtensions: true`|保留并验证；接入 Context hook 不得重新开放磁盘扩展发现|

完整路径前缀为 `C:\Users\servi\Desktop\mybuddy\src\main\`；具体目录分别为 `agent/`、`memory/`、`mcp/`。

原计划声明的 L1 真源、scope、hybrid search、revision、grounding、L2/L3 审批、Gateway 作为保留基线，不因本轮未重复全面验证而重做，也不提前宣布其 0.87 回归通过。

## 3. 对原计划必须做的六项修正

### 3.1 Canonical Session 迁移不能留到 P3

Pi 0.87 已把 SessionManager 变成 AgentSession provider context 的 canonical 来源。赋值 `session.agent.state.messages` 不再替代未来请求的历史。[P1]

因此升级阶段就必须检查恢复、重试、分支、Compaction、临时会话、SubAgent、错误恢复和所有 session entry 穷尽分支。Pi 原生恢复入口、追加 entry 后的 `refreshContext()` 和树导航须按实际接口接入；不允许版本先升级、旧 messages 状态机继续承担正确性。

同阶段核查 `shouldStopAfterTurn → finishTurn`、`turn_end`/`agent_before_settle` 事件形状及 actionable boundary。仅迁移实际使用点，不假定仓库必然使用全部接口。不得借 `continue: true` 恢复已经删除的自动续跑行为。[P1]

### 3.2 enabledModels/scopedModels 是唯一配置和解析来源，但不能仅凭字段存在就认为已强制拦截

Pi 设置文档把 `enabledModels` 定义为模型轮换的 pattern 列表。[P3] MyBuddy 将它用作产品的启用选择真源，同时必须在公共调用入口验证最终模型在有效允许集合内；这是一层无独立持久状态的准入检查，不是自建模型系统。

禁止第二套 pattern 解析、disabledModelIds 或模型目录；允许并要求对 Pi 已解析结果做 membership 检查。所有专用模型、回退、恢复模型和直接 `setModel` 路径都必须受约束。

空值语义必须显式锁定并测试：建议未设置 `enabledModels` 表示未额外收窄可用范围；显式 `[]` 表示产品“全部关闭”，不得回退成全部可用。该产品语义不冒充 Pi SDK 的自动授权保证。全局与 workspace 的有效设置使用 Pi 的解析/合并链；不得由各消费者自行读文件拼接。

### 3.3 inputLimits 必须区分“字段支持”与“实际执行”

0.87 实际应用的是 `inputLimits.images.resize`；图像在进入历史前按所选模型处理，切换模型不会重写历史图片。`maxRequestBytes`、`images.maxPerMessage`、`images.maxPerRequest` 能记录硬限制，但官方明确说明该初版不会据此自动重写或拒绝历史。[P2]

因此验收拆成：Pi-native 字段无损存储/映射；实际图像路径使用 Pi 预处理；MyBuddy 最终请求入口若承诺阻止超限，须另做有测试的薄校验。校验读取同一 Pi Model 元数据，不建第二份限制配置。尚未覆盖某条 transport 时，不得在 UI 宣称限制已强制生效。

### 3.4 Compaction 防污染前移，与临时 Capsule 一起验收

不能等 P3 才证明临时 Memory 不会进入摘要。Session JSONL 没有 Capsule，不代表自建 Compaction 输入一定没有它。

最小临时 Context 功能上线时必须证明：存储历史不含 Capsule；Compaction 与分支摘要的输入不含临时注入块；L0→L1 提取不读取临时补充本身。这里排除的是内部注入块，不是从用户真实说过的消息中删除同样的事实。

### 3.5 “每轮固定”指逻辑用户轮次，不是每个工具循环 turn

用户一次提交可能触发多次 provider 请求、tool call、retry 和 Pi 内部 turn。Capsule 在一个逻辑用户轮次只 resolve 一次，不能按每次 `turn_start` 重取。

用 `(sessionId, executionId, userTurnId, projectionEpoch)` 隔离缓存。epoch 只在明确终止旧投影并启动新执行边界时改变，不能成为随意刷新借口。

### 3.6 ContextEdit 不是任意历史清洗 API

ContextEdit 只改变未来模型可见贡献，原始历史/UI/导出仍保留；编辑是分支相关的，导航回编辑之前可能重新暴露旧贡献。[P4]

清理旧 Memory 尾块必须使用可证明的内部标记或 provenance，替换为真实用户内容并保留附件，不能将整个混合用户消息设为 `null`。只有完整条目本身就是内部消息时，才允许整体省略。

已经进入旧 compaction/branch summary 的污染不能靠编辑原用户条目自动消失；需要单独评估、在可验证历史上重建干净上下文或建立明确的新分支，不作“全文正则删除即完成”的承诺。

## 4. 统一实施顺序与阶段出口

以下保留阶段依赖，当前实施和验证结果见第 0 节。S7 已按用户最终要求改为 pnpm dev 实际可用，取消安装包和安装验证。

|阶段|优先级|工作包|依赖|退出条件|
|---|---|---|---|---|
|S0|P0|锁定边界、基线、入口清单、空 scope 和轮次语义|无|已记录现有失败；禁止项及新契约测试可运行；不把原有失败归给升级|
|S1|P0|Pi 0.87 升级 + canonical session/事件兼容|S0|实际依赖图一致；恢复/重试/分支路径真实使用 Pi 历史来源；相关检查通过|
|S2|P0/P1|模型唯一来源、稳定 Runtime、统一准入|S1|所有模型入口不绕 scope；刷新不重建 Runtime；配置、默认项及 UI 不维护重复事实|
|S3|P0/P1|Memory 临时 Capsule + per-user-turn 快照 + 稳定 Session|S1、S2|同轮固定、跨轮更新；JSONL/Compaction/L0 不收录内部 Capsule；不再靠记忆变更重建 Session|
|S4|P1/P2|拆分 Context selection、模型感知预算、派生视图治理、Loadout 解耦|S3|Memory 只提供认知/检索/派生数据；选择和预算集中；过期 grounding 不生效；无自动 L2/L3 cadence|
|S5|P2|旧历史贡献治理、UI 去伪装、旧状态与临时脚本清理|S3、S4|可继续的旧会话不再重放已识别污染；误删测试通过；清理对象确认无运行时读取|
|S6|P3|全面 Evidence Budget 与 Synthesis Boundary|S4、S5|Memory/Library/Project/Tool 共用预算；证据获取和回答阶段有明确边界；不造第二份 messages 状态机|
|S7|P4|开发模式整链、最终文档与回归闭环|各阶段|类型/原生行为和真实 Provider/Electron 各有证据；pnpm dev 启动与实际使用正确；边界明示；安装包按用户要求移出范围|

可以形成两个发布里程碑，但不是两个项目：**M1 核心 Runtime 收敛**完成 S0–S5 及对应 S7 门禁；**M2 全量 Context 治理**完成 S6 及最终 S7。未完成 S6 时，只能标“核心收敛完成”，不能标整份计划全部完成。

## 5. 完整工作清单

### A. Pi / Session / Runtime

|ID|阶段|工作项|验收要求|
|---|---|---|---|
|R01|S1|直接依赖升级至 0.87.0，核对 pi-agent-core、pi-tui、chord 等实际传递依赖|按官方 0.87 的依赖图处理，不臆定每个相关包都必须具有同一数字版本；lockfile、override、patch 无旧版本强制残留|
|R02|S1|处理 0.87 breaking changes|SessionEntry 的 `context_edit`、实际使用的边界事件和 finishTurn 适配完整；error/aborted 不被普通继续逻辑复活|
|R03|S1|恢复/重试/分支改为 Pi canonical session 链|实际 provider 请求中的消息正确；不能仅检查 UI 或 agent.state 镜像|
|R04|S3|移除记忆内容变化触发的 stale/invalidate|create/update/forget/promote/approve 后 Session identity 不变；下一有效轮次看到新记忆|
|R05|S3/S4|区分内容刷新与结构更新|纯内容更新不重建；模型 scope、memoryEnabled、工具能力优先通过安全的原生更新接口生效，只有真正不可热更新的 assembly 变化才重建|
|R06|S1/S6|保持 MyBuddy Harness 权限、取消、执行与审计控制面|Pi 生命周期 hook 不扩大授权、不绕 run/execution/参数校验，不恢复无边界自动续跑|
|R07|S1/S3|代码内接入 context hook|保持产品 Capability 单入口；可使用受控 inline factory/等价 SDK 集成，不恢复磁盘 Pi Extension 产品入口|

### B. Model

|ID|阶段|工作项|验收要求|
|---|---|---|---|
|M01|S2|ModelRuntime 唯一模型 Runtime|同一进程/配置域内 Chat、SubAgent、MCP 和 Router 等共享；消费者不私建 catalog/runtime|
|M02|S2|保护旧 Catalog 删除结果|`UpstreamModelCatalog.ts` 不复活；禁止 MyBuddy 自己执行远端模型 discovery|
|M03|S2|保护旧 Auth 删除结果|`auth-file.ts` 不复活；认证读写通过 Pi API，不手工解析/修改 auth.json|
|M04|S2|ModelsConfigStore 保持 Pi-native 薄编辑访问|不迁移私有旧 schema；编辑 Pi fields 保留未知合法字段；实际 Pi 解析测试通过|
|M05|S2|稳定 ModelRuntime 生命周期|去掉 new Runtime 式 reload；优先使用 Pi `refresh()`；对配置重载、认证变化、远端刷新分别验证实际语义，不凭方法名推定支持|
|M06|S2|enabledModels 唯一启停持久状态|只写 SettingsManager；无 disabledModelIds/私有 enabled 字段；未设置、空数组、匹配不到、全局/workspace 合并各有测试|
|M07|S2|Pi scope 解析 + 统一无状态调用校验|主模型、专用模型、恢复模型、fallback、直接调用和 MCP headless 不得使用范围外模型；空范围不得静默放宽|
|M08|S2|默认模型 Pi-native|defaultProvider/defaultModel 由 SettingsManager 保存；defaultModelId 只是 UI/IPC 组合展示，不成为另一配置源|
|M09|S2|listModels 只映射事实，不合成事实|目录、鉴权可用、用户启用、当前选择区分呈现；Pi getModels/getAvailable 等实际 API 为事实来源；“可用”不冒充已验证联网成功|
|M10|S2|远端刷新走 Pi|Provider 原生适配器负责模型发现；启动/list/refresh 使用同一 Pi Runtime|
|M11|S2|支持 inputLimits 的原生字段|maxRequestBytes/images.resize/maxPerMessage/maxPerRequest 无损读写；UI 区分声明与已执行的限制|
|M12|S2/S4|图像及最终请求限制验证|附件/read/tool-result 实際走 Pi resize；超限校验读取 Pi 元数据；切换到更小限制模型的旧图像不能被无声重写|
|M13|S2|清查所有模型入口|Chat、SubAgent、Router、Automation、Cron、Memory extraction、L2/L3 proposal、HTML Edit、Vision，以及实际存在的 BTW、Prompt Enhancement、Authoring 全部纳入|
|M14|S4|Reasoning 进一步 Pi-native|能力映射与 modelThinkingLevels/defaultThinkingLevel 单一偏好来源；删除有重复持久语义的 MyBuddy 状态；不擅自硬设 low|
|M15|S4/S5|DTO 瘦身及伪能力删除|不复制 Pi 元数据；无来源的 toolCall/structuredOutput/temperature 能力标识不硬编码；未知不等于 false|
|M16|S5|清理旧模型运行文件及临时脚本|确认 model-catalog.json/model-availability.json 等零运行读取后清理；保留真正测试，删除一次性 `.tmp-model-*` 的已确认目标，不泛删整个临时目录|

### C. Memory 与 Context

|ID|阶段|工作项|验收要求|
|---|---|---|---|
|C01|S3|删除向 user message 拼 Memory 的路径|每次用户输入以真实内容持久化；不以 UI strip 掩盖真实历史污染|
|C02|S3|通过 context hook 注入临时 Capsule|只修改本次请求副本，不调用历史 append/send API 来伪装临时；缺省不使用 context_with_system|
|C03|S3|建立逻辑用户轮次缓存|每轮只 resolve 一次；工具循环、请求重试重复使用同一个 Capsule；并发初始化合并，避免双重 resolve|
|C04|S3|清理与隔离 Capsule 生命周期|完成/异常/取消/dispose 后释放；新用户输入、恢复和分支进入明确新轮次；不同会话、任务、子代理不能共享错范围快照|
|C05|S3|新增 Memory 变更实时性测试|普通内容修改下轮生效且不重建 Session；同轮不因后台提取/审批发生漂移|
|C06|S3|防止临时块进入 Compaction/分支摘要/L0 提取|三条输入链均有测试；真实会话提到的同一事实不是需要删除的污染|
|C07|S4|拆出 resolveContext 的输入选择职责|Memory 提供 search、scope、grounded projection；Context Projection 负责选择、预算、去重、序列化|
|C08|S4|建立统一 Context Projection 入口|Memory/Library/Project 是来源；History 由 Pi 构建，Projection 不重写其状态机|
|C09|S3/S4|模型感知预算|初版就预留输出、system/tools、当前输入和工具增长空间；余额为零时 Capsule 可以为空；不再强行塞入最低字符数|
|C10|S4|L1/L2/L3 去重|根据 source memory IDs/revisions 的覆盖去重，不做不可解释的相似度删减；所有层都标来源和派生属性|
|C11|S3/S4|本轮明确指令优先于历史偏好|Capsule 明示历史事实/派生视图，不冒充 system 指令；用户本轮更新可覆盖历史偏好，仍受系统及工具权限约束|
|C12|S4|保留 L0→L1 自动提取|warmup/interval/explicit cue 保留；提取来源去除内部注入，不把模型复述当作独立新证据|
|C13|S4|保留 L2 Scenario/L3 Profile 为派生视图|Proposal + Approve/Reject；grounding 或 revision 失效后不再生效，不复制成新真源|
|C14|S4|删除 L2/L3 自动 cadence 死逻辑|核实调用后移除 postL1Due/completeL2/completeL3 及仅服务它们的计数常量/DTO；不误删 L1 调度或人工审批历史|
|C15|S4|Loadout 与 prompt 文本解耦|读取同源、可追溯的 recommendation evidence，不调用固定预算 resolveContext 来决定工具权限|
|C16|S5|清理 ProjectContext.memorySummary|移除 BTW/兼容残留；Project 保留 Goal/Plan/文件事实，不保留第二份认知摘要|
|C17|S5|历史 UI 去 strip 临时性伪装|stripInjectedUserPromptTail 仅在明确旧标记/附件等场景保留；新 Memory Context 临时性靠真实生命周期保证|
|C18|S5|append-only 历史贡献修正|精确识别旧注入；替换内容保留真实用户文字/附件；分支进入时执行幂等核对；原始历史不改写|
|C19|S4/S7|保留 Hybrid Search、Scope、Revision、Evidence|global/workspace/project/task 可见性和继承仍唯一；BM25/FTS/semantic/RRF 是检索，不兼任模型输入控制|
|C20|S4/S7|保留 Gateway|外部 CLI 访问同一 L1 truth；不私建 CLI memory，不迁回已删除旧记忆|
|C21|S6|统一 Evidence Budget|Memory/Library/Project/Tool 的选择和配额共享；来源不各自无限拼 prompt|
|C22|S6|建立 Synthesis Boundary|证据获取阶段与综合回答阶段分离；有明确终止条件，不能因收敛不足无限自动检索/续跑|
|C23|S1/S6|Pi canonical context 完整接管历史贡献|修改历史贡献用 ContextEdit，临时补充用 context hook，持久摘要用 Compaction，各负其责|

## 6. Capsule 与请求链的最小契约

### 6.1 正确顺序

用户真实输入进入 Pi 会话 → 建立逻辑 userTurn/execution → 根据有效模型配置完成准入和本轮模型选择 → 基于真实 Pi context 计算剩余预算 → 从可见的 Memory 真源/派生视图生成一次 Capsule → 每次 provider 请求先做当前授权/模型准入检查，再通过 context hook 叠加相同 Capsule → Pi 正常保存用户、助手、工具及结构 entries，绝不持久化该 Capsule。

若 Loadout/Router 在确定模型前需要 Memory 证据，可以先固定候选事实快照，等模型与工具装配确定后只做一次最终投影；不能因此进行两次不一致的 Memory resolve，更不能构成“Memory 选模型—模型改检索—再选模型”的反馈循环。

### 6.2 快照契约

|属性|要求|
|---|---|
|缓存键|sessionId + executionId + userTurnId；只有显式新边界才增加 projectionEpoch|
|来源标识|memory ID、revision、grounding、scope stamp、projection policy version|
|模型与预算|保存本轮最终 model key、预算决策与来源估算；不要在每个 LLM call 根据新随机条件重排|
|fingerprint|对有确定顺序的来源/revision/投影内容计算；同轮正文、顺序和 fingerprint 均一致|
|时间信息|只在快照建立时固定；不向每次请求写入不断变化的“当前时间”|
|可观测性|日志记录 fingerprint、IDs/revisions、token 估算、入选/排除原因；默认不复制完整私人 Memory 正文|
|持久化|请求级 Capsule 不写 Session 历史、不写 L1、不写派生认知真源；调试事件不是新真源|

### 6.3 单轮稳定性与撤销语义

普通 Memory 内容更新在下一逻辑用户轮次生效。模型/Memory ACL 收窄、禁用、明确删除并要求停止使用等撤销，必须在下一次对外请求前检查；固定快照不能成为继续发送被撤销信息的理由。必要时中止当前执行、清除快照并在新边界重启；无法撤回已经发送的请求。

模型中途变更原则上排队到新用户轮次；确需切换时结束旧投影 epoch，重新检查 scope 与预算并记审计。不能把重新选了较小模型后偷偷截短 Capsule 还称为“同轮相同”。子代理建立自己的窄作用域快照；不得盲拷父代理完整 Capsule。

### 6.4 预算约定

`T_base` 是 Pi 已构建的有效请求基础上下文估算，包含真实历史、当前用户输入、system、工具定义和多模态输入，不含待注入的 Capsule；计数时禁止重复计算同一部分。

```text
B_memory = max(0, min(
    policy_memory_cap,
    model_context_window * policy_fraction,
    model_context_window - T_base - output_reserve
                         - safety_reserve - other_evidence_reserve
                         - tool_growth_reserve
))
```

公式是产品预算策略，不是对 tokenizer 精确性的承诺。token 估算需要留安全余量；请求字节数、图片数量限制必须另行检查，不能用字符长度或 token 估算替代。每轮定预算后冻结 Memory Capsule；历史/工具继续增长应由 Pi compaction 与证据预算治理处理，不能反复重检索 Memory。

### 6.5 context 与 context_with_system

默认使用 `context`。0.87 的该 hook 不向 handler 暴露 system messages，Pi 在它之后恢复 prompt/tool 状态；`context_with_system` 在其后处理含 system 的完整 transcript，并将结果直接发出。[P1]

因此不为插入 Memory 而接管完整 system transcript，不伪造 toolResult，不破坏 tool-call 配对。具体 Capsule 消息类型、插入位置和返回结构以 0.87 实际 SDK 契约及真实请求测试为准，不在规划中虚构 API。

## 7. 验收责任与最终完成判定

本轮以用户最终范围执行：不新增或修改测试源文件，整体功能完成后集中验证；不制作或安装 Windows 安装器，以 pnpm dev 实际可用为交付出口。第 0.4 节区分原测试命令、内存适配、原生 SDK 与真实 Provider/Electron 证据。

当前源码已覆盖统一模型准入、L1/派生视图边界、临时 Capsule、同轮固定与跨轮更新、来源撤销、canonical 历史、旧摘要恢复、共享证据预算和综合边界。最终开发模式验证中，真实聊天、记忆更新及模型刷新成功，主进程 Session/Runtime 对象保持不变。未将缺少历史证明、未覆盖的 wire adapter 或其他 Provider 登录过程写成已实测。

## 8. 实施纪律与不做事项

本计划不重新设计 L1，不迁回已删除的旧 Memory，不恢复 MyBuddy model.json，不增加并行模型目录、启停库、CLI 私有记忆库或 Project Memory 摘要。Context Projection 不能持久管理第二份 canonical messages。

仅处理本计划范围内的改动，保留其他未提交工作；不自动 stage/commit/push，不为“清理”执行不带明确目标的批量删除。记录实际实现和剩余问题；不新增或修改测试源文件；整体任务完成后集中运行相关检查和原生/真实运行验证，不每个小改动重复执行。

对登录状态、真实模型请求与开发模式的验收，区分自动化 mock、实际网络请求及人工登录证据；不把静态 review 写成实测通过，不展示或手工处理用户 auth.json 中的秘密。

## 9. 来源与证据

### 官方资料（固定 v0.87.0）

- [P1] Pi 0.87 Release：canonical session、breaking API、context/context_with_system、boundary 变化。
  `https://github.com/earendil-works/pi/releases/tag/v0.87.0`
- [P2] Model 配置文档：Image Input Limits、声明字段与已执行预处理的区别。
  `https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/docs/models.md`
- [P3] Settings 文档：enabledModels 的 Model Cycling 定义与原生偏好字段。
  `https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/docs/settings.md`
- [P4] Session Format：ContextEditEntry、分支相对编辑、compaction 与历史投影。
  `https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/docs/session-format.md`

### 本地代码

实施过程中直接读取本仓库源码、Git 差异和已安装的 Pi 0.87 原生声明/实现，并集中运行第 0.4 节记录的检查。第 2 节只保留附件的历史快照；第 0 节记录当前实施范围、验证结果和剩余事项。没有把源码核对、应用构建或夹具结果当作真实 Provider/Electron 运行证据。
