# 只读审计：`task.model_id` 与当前模型目录漂移的影响面

- 仓库：`C:\Users\servi\Documents\GitHub\wavealstra_harness`
- 基线代码：`HEAD = e1bd55f`（下文 `HEAD:` 前缀的行号均指该提交）
- 数据：`~/.mybuddy/app.db`（`better-sqlite3` `{ readonly: true, fileMustExist: true }`）、`~/.mybuddy/models.json`、`~/.mybuddy/settings.json`、`~/.mybuddy/models-store.json`（未解析其内容，仅确认存在）
- 解析实测：`ModelRuntime.create({authPath, modelsPath})` + `refresh({allowNetwork:false})` + `getModel()`，只读、独立进程
- 只读承诺：未改 `src/`、未写 `app.db`、未 `git add/commit`、未重启/关闭 MyBuddy；本文件是唯一写入

> **审计期间工作树在并发变化（重要）**
> 1. 审计开始时 `git status` 只有 `M artifacts/*`；审计中途出现 `M src/main/agent/durable/DurableBotService.ts`、`M src/renderer/src/store/appStore.ts`、`M src/renderer/src/types.ts`、`M src/shared/agent-ipc.ts`、`M src/renderer/src/components/chat/ChatView.tsx`，以及新增未跟踪 `src/main/agent/durable/BotModelCatalog.ts`、`src/renderer/src/components/chat/TaskModelRecoveryNotice.tsx`（mtime 14:19:48–14:24:24）。这是别人在实现修复，不是本审计的写入。
> 2. 因此**本报告中「缺陷」结论一律以 HEAD（e1bd55f）为准**；涉及当前工作树（WT）的位置单独标注。
> 3. 现场 DB 也在变：两次只读快照之间，31 条 bot 任务的 `model_id` 被外部批量改写（见 §3.3），我未参与。

## 0. 结论速览

1. **只有 bot 任务的会话「打不开」是必然的、由 `model_id` 不可解析直接决定**：bot 的历史必须打开 Durable 运行时，而 `openInternal()` 在构造运行时之前就要解析模型（`HEAD:src/main/agent/durable/DurableBotService.ts:192`），`model()` 解析失败即抛 `Bot 模型不存在：<id>`（`HEAD:...:263-268`），`history()` 的 catch 把它转成 `historyError`（`HEAD:...:361-375`），渲染层显示为「会话记录打不开」（`HEAD:src/renderer/src/components/chat/ChatView.tsx:897-906`）。
2. **非 bot（working/coding）不报错是「三重兜底 + 自愈」的结果，不是没问题**：
   - 会话装配：`resolveEffectiveModelId()` 对 explicit 值**不做可用性校验**（`src/shared/mode-profile.ts:718-728`），随后 `applySessionModel()` 返回 false 只打 warn（`src/main/agent/AgentService.ts:5677-5685`、`5192-5202`）→ 静默使用 SDK 恢复/默认模型。
   - UI：boot 时把不可解析的 `model_id` 直接替换成 `defaultModelId`（`HEAD:src/renderer/src/store/appStore.ts:169` + `2494-2498`），所以 chip 看起来正确。
   - 写回：发消息时用 `activeModelId` 覆盖 DB（`HEAD:...:3776-3784`），每次 `assistant_start/end` 也会回写（`HEAD:...:3070-3078`）→ 一轮成功后 DB 被治回可解析值。
   **但「重新生成」不走兜底**：`regenerate` 把失效的 `existing.modelId` 当作**显式** `modelId` 传给 `prompt()`（`src/main/agent/AgentService.ts:4563-4566`），在 `4079-4088` 命中 `throw new Error(\`无法使用指定模型 ${intendedModelId}\`)` → `PROMPT_FAILED`。这是非 bot 侧唯一会**硬失败**的用户动作（已由代码链证明，未在 GUI 实点）。
3. **cron 是最危险的隐形面**：`cron_jobs.model_id` 仍存着 `magpie/commandcode/deepseek/deepseek-v4.1-flash`（当前 DB 实读，未随任务修复），`CronService` 每次 run 都用它建任务并作为 explicit 传入（`src/main/cron/CronService.ts:331-334`、`366-377`），bot 型工作流因此每天稳定失败并把原因写进 `cron_runs.error`（`434-448`）。修任务行不修 job 行 = 每天重新制造一条漂移。
4. **安卓端把「打不开」伪装成「空会话」**：`RemoteTaskHistory` 契约里没有 `historyError`/`modelId`（`shared/src/remote-contract.ts:189-191`），`mapRemoteHistory()` 只投影 `messages`/`durable`（`src/main/remote/RemoteDtoMapper.ts:123-126`）→ 手机端拿到空数组；而发送时主进程抛的普通 `Error` 被兜成 500 `internal_error`（`src/main/remote/RemoteAccessServer.ts:328-331`），真实原因丢失。
5. **数据面收尾风险**：启动即执行的 `reattributeToMyBuddyModels()`（`src/main/index.ts:2838-2856`，一次启动调用两次）会按 `tasks.model_id` 重写 `usage_events` 的 provider/model（`src/main/usage/UsageStatsService.ts:768-798`）。本次批量修复之后，31 条 bot 任务的历史用量会在下次启动被改记到新模型上（幂等但**改历史**）。

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 980 560" width="980" height="560" font-family="Segoe UI, Microsoft YaHei, sans-serif">
  <rect x="0" y="0" width="980" height="560" fill="#fbfbfd"/>
  <text x="20" y="28" font-size="17" font-weight="700" fill="#1b1b1f">task.model_id 漂移 → 失败链（真实字段 / HEAD 行号）</text>
  <text x="20" y="48" font-size="12" fill="#5a5a66">✓ = 已由代码+数据+ModelRuntime 实测验证；?: = 推断（未在 GUI/手机实点）</text>

  <!-- 数据源 -->
  <rect x="16" y="66" width="250" height="86" rx="8" fill="#eef3ff" stroke="#5b7fd4"/>
  <text x="30" y="88" font-size="13" font-weight="700" fill="#1b2a4a">tasks.model_id（DB 真源）</text>
  <text x="30" y="110" font-size="12" fill="#24304a">magpie/commandcode/z-ai/glm-5.3-flash</text>
  <text x="30" y="130" font-size="12" fill="#24304a">models.json 的 magpie 只有 19 个</text>
  <text x="30" y="146" font-size="12" fill="#24304a">模型（group/workbuddy/-ai/opendesign）</text>

  <rect x="16" y="168" width="250" height="70" rx="8" fill="#eef7ee" stroke="#4c9a5c"/>
  <text x="30" y="190" font-size="13" font-weight="700" fill="#1d3a24">settings.defaultModelId</text>
  <text x="30" y="210" font-size="12" fill="#1d3a24">magpie/opendesign/deepseek-v4.1-flash</text>
  <text x="30" y="228" font-size="12" fill="#1d3a24">（可解析 ✓，enabledModels 内 ✓）</text>

  <!-- bot 路径 -->
  <rect x="330" y="66" width="270" height="172" rx="8" fill="#fff1f1" stroke="#c4535b"/>
  <text x="344" y="88" font-size="13" font-weight="700" fill="#571f23">bot：Durable 路径（46/46 有 binding）</text>
  <text x="344" y="110" font-size="12" fill="#3d2226">openInternal → this.model(task.modelId)</text>
  <text x="344" y="128" font-size="12" fill="#3d2226">DurableBotService.ts:192</text>
  <text x="344" y="150" font-size="12" fill="#3d2226">model(): getModel() = undefined</text>
  <text x="344" y="168" font-size="12" fill="#3d2226">→ throw「Bot 模型不存在：&lt;id&gt;」:268</text>
  <text x="344" y="190" font-size="12" fill="#3d2226">history() catch :371-375</text>
  <text x="344" y="208" font-size="12" fill="#3d2226">→ { messages: [], historyError }</text>
  <text x="344" y="226" font-size="12" fill="#3d2226">resumePersisted :102 启动即 open 全部</text>

  <!-- 非 bot 路径 -->
  <rect x="330" y="254" width="270" height="172" rx="8" fill="#fffaf0" stroke="#c99a3f"/>
  <text x="344" y="276" font-size="13" font-weight="700" fill="#4a3410">非 bot：Pi 路径（0 个 binding）</text>
  <text x="344" y="298" font-size="12" fill="#3d3218">createSession → resolveEffectiveModelId</text>
  <text x="344" y="316" font-size="12" fill="#3d3218">mode-profile.ts:724（explicit 不校验）</text>
  <text x="344" y="338" font-size="12" fill="#3d3218">applySessionModel()=false → 只 warn</text>
  <text x="344" y="356" font-size="12" fill="#3d3218">AgentService.ts:5677-5685</text>
  <text x="344" y="378" font-size="12" fill="#3d3218">历史 = 只读 jsonl，完全不看模型</text>
  <text x="344" y="396" font-size="12" fill="#3d3218">AgentService.ts:3800-3828</text>
  <text x="344" y="418" font-size="12" fill="#3d3218">→ 静默降级，不报错 ✓</text>

  <!-- 用户可见结果 -->
  <rect x="660" y="66" width="304" height="74" rx="8" fill="#ffffff" stroke="#8a8a99"/>
  <text x="674" y="88" font-size="13" font-weight="700" fill="#1b1b1f">桌面：ChatView 红色告警卡</text>
  <text x="674" y="108" font-size="12" fill="#33333d">「会话记录打不开」+ historyError 原文</text>
  <text x="674" y="126" font-size="12" fill="#33333d">ChatView.tsx:897-906 ✓</text>

  <rect x="660" y="152" width="304" height="68" rx="8" fill="#ffffff" stroke="#8a8a99"/>
  <text x="674" y="174" font-size="13" font-weight="700" fill="#1b1b1f">cron bot：每天失败</text>
  <text x="674" y="194" font-size="12" fill="#33333d">cron_jobs.model_id 仍为 commandcode/*</text>
  <text x="674" y="212" font-size="12" fill="#33333d">CronService.ts:331-334 / 434-448 ✓</text>

  <rect x="660" y="232" width="304" height="68" rx="8" fill="#ffffff" stroke="#8a8a99"/>
  <text x="674" y="254" font-size="13" font-weight="700" fill="#1b1b1f">安卓：静默空白 + 500</text>
  <text x="674" y="274" font-size="12" fill="#33333d">RemoteTaskHistory 无 historyError</text>
  <text x="674" y="292" font-size="12" fill="#33333d">RemoteDtoMapper.ts:123-126 ✓</text>

  <rect x="660" y="312" width="304" height="68" rx="8" fill="#ffffff" stroke="#8a8a99"/>
  <text x="674" y="334" font-size="13" font-weight="700" fill="#1b1b1f">非 bot：重新生成硬失败</text>
  <text x="674" y="354" font-size="12" fill="#33333d">AgentService.ts:4566 → 4086 throw</text>
  <text x="674" y="372" font-size="12" fill="#33333d">「无法使用指定模型 &lt;id&gt;」 ✓/?:</text>

  <rect x="660" y="392" width="304" height="82" rx="8" fill="#f6f2ff" stroke="#7b62c9"/>
  <text x="674" y="414" font-size="13" font-weight="700" fill="#2b2150">自愈路径（非 bot 才有）</text>
  <text x="674" y="434" font-size="12" fill="#2b2150">发消息 upsert modelId=activeModelId</text>
  <text x="674" y="452" font-size="12" fill="#2b2150">appStore.ts:3776-3784；assistant patch</text>
  <text x="674" y="470" font-size="12" fill="#2b2150">回写 3070-3078 → DB 被治回 ✓</text>

  <!-- 箭头 -->
  <defs>
    <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#6a6a78"/>
    </marker>
  </defs>
  <line x1="266" y1="112" x2="328" y2="112" stroke="#6a6a78" stroke-width="1.6" marker-end="url(#a)"/>
  <line x1="266" y1="300" x2="328" y2="300" stroke="#6a6a78" stroke-width="1.6" marker-end="url(#a)"/>
  <line x1="600" y1="112" x2="658" y2="102" stroke="#6a6a78" stroke-width="1.6" marker-end="url(#a)"/>
  <line x1="600" y1="200" x2="658" y2="186" stroke="#6a6a78" stroke-width="1.6" marker-end="url(#a)"/>
  <line x1="600" y1="320" x2="658" y2="346" stroke="#6a6a78" stroke-width="1.6" marker-end="url(#a)"/>
  <line x1="266" y1="203" x2="328" y2="340" stroke="#c9a24a" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#a)"/>

  <!-- 底部说明 -->
  <rect x="16" y="446" width="614" height="96" rx="8" fill="#ffffff" stroke="#c9c9d4"/>
  <text x="30" y="468" font-size="12" font-weight="700" fill="#1b1b1f">同一份失效 model_id，两条路径不同结局：</text>
  <text x="30" y="488" font-size="12" fill="#33333d">bot = 必须先拿到模型才能打开运行时 → 失败可见（好事，历史不被伪装成空会话）。</text>
  <text x="30" y="506" font-size="12" fill="#33333d">非 bot = 历史读文件、模型只影响本轮推理 → 静默降级 + 下一轮写回，所以「看起来没坏」。</text>
  <text x="30" y="524" font-size="12" fill="#33333d">因此修复只需覆盖「必须先解析模型才允许打开」的入口，而非全仓库改 model_id 语义。</text>
</svg>
```

## 1. 消费点清单（除 DurableBotService 之外）

分类：**硬失败** = 用户看到错误/动作失败；**静默降级** = 换个模型继续；**仅数据/展示** = 不影响本轮执行。

| # | 位置（文件:行） | 读取/来源 | 模型缺失时的行为 | 分类 | 证据强度 |
|---|---|---|---|---|---|
| 1 | `HEAD:src/main/agent/AgentService.ts:3799` | 任务行 | `owns()` 为 true → 转 `durableBots.history()`，即第 2 条 | 硬失败（透传 historyError） | 已验证 |
| 2 | `HEAD:src/main/agent/durable/DurableBotService.ts:192,263-268,361-375` | `task.modelId` | `getModel()` undefined → throw → historyError；`admit` 同路 | 硬失败 | 已验证（代码+DB+ModelRuntime） |
| 3 | `HEAD:...DurableBotService.ts:102-108`（resumePersisted） | 全部 binding | 启动时逐个 `open()`，31 个 bot 任务各打一条 `[Durable] Cannot resume` console.error；**不影响启动** | 日志噪音 | 已验证（代码）；错误数=数据推算 |
| 4 | `src/main/agent/AgentService.ts:3849` | 请求 | bot 的 prompt 直接进 Durable，`admit` 内 `model()` 抛错；`request.modelId` 为空时用 `task.modelId` | 硬失败 | 已验证 |
| 5 | `src/main/agent/AgentService.ts:4425` | taskId | Durable 任务禁止 regenerate（不是模型问题，但解释了 bot 为什么没有「重试」出路） | 硬失败（另一种原因） | 已验证 |
| 6 | `src/main/agent/AgentService.ts:4563-4566` → `4079-4088` | `existing.modelId` | 非 bot：失效值被当**显式** modelId → `applySessionModel` false → `throw 无法使用指定模型` → `PROMPT_FAILED`（`4591-4594`） | **硬失败（非 bot 唯一）** | 已验证（代码链）；GUI 实点为推断 |
| 7 | `src/main/agent/AgentService.ts:5677-5685` + `5192-5202` + `src/shared/mode-profile.ts:724` | `opts.modelId` | 非 bot 建会话：静默回退 SDK 恢复/默认，只 warn | 静默降级 | 已验证 |
| 8 | `src/main/agent/AgentService.ts:4079-4088` | 同上 | 发消息：`req.modelId` 为空时不抛，`entry.usageModelId` 改回真实模型 | 静默降级 | 已验证 |
| 9 | `src/main/agent/SessionRegistry.ts:144-161` | `existing.modelId` | 重启后把上次失效值作为 createSession 入参（进入第 7 条的静默降级） | 静默降级 | 已验证 |
| 10 | `src/main/agent/AgentService.ts:1221-1229`（durable `evidence`） | `task.modelId` | `getModel` undefined → `budget` undefined → 记忆/资料**无预算上限**注入 prompt | 静默（质量/成本风险，不崩） | 已验证 |
| 11 | `src/main/agent/AgentService.ts:1247-1255`（附件 Vision） | 请求/任务 modelId | model undefined → `modelSupportsImageInput=false`（`VisionRouting.ts:20-24`）→ 委托 Vision 或返回「图片识别不可用」文本 | 静默降级 | 已验证 |
| 12 | `src/main/agent/AgentService.ts:3459-3464`（记忆抽取） | `task.modelId` | 显式 fallback 到默认模型（注释已写明「历史聊天可能引用已下线的模型」） | 静默降级 | 已验证 |
| 13 | `src/main/agent/AgentService.ts:5715-5716` | createSession | `usageModelId` 取 `sessionModelId ?? opts.modelId ?? existing.modelId`（可能记失效 id） | 仅归因 | 已验证 |
| 14 | `src/main/usage/UsageStatsService.ts:768-798,811-823` + `src/main/index.ts:2838-2856` | `tasks.model_id` | 启动时把 `usage_events.provider/model` 按任务 model_id 重写；修复后会把历史行改记到新模型 | **数据改写** | 已验证 |
| 15 | `src/main/cron/CronService.ts:331-334,338-349,366-377,434-448` | `cron_jobs.model_id` → 任务 | 失效值作为 explicit 传入 → bot 型 run 抛错 → `cron_runs.status=error` + 任务 failed；**下次 run 再建一条同样的失效任务** | **硬失败（每日复发）** | 已验证（代码 + `cron_jobs` 实读） |
| 16 | `src/main/gateway/GatewayService.ts:236-245,293-301` | `settings.defaultModelId` | 每轮用全局默认作 explicit → `admit` 先 `upsertTask({modelId})` 覆盖任务行（`DurableBotService.ts:282 HEAD`）→ gateway 任务**自愈**到默认；默认模型本身失效时才报错，错误文本回发到频道「处理失败：…」 | 自愈 / 否则硬失败 | 已验证 |
| 17 | `src/main/remote/RemoteTaskCommandService.ts:104`（新建） | 请求 | bot 分支**跳过**可用性校验，直接信任客户端 `modelId`，否则用 `settings.defaultModelId` | 依赖客户端 | 已验证 |
| 18 | `src/main/remote/RemoteTaskCommandService.ts:168-175,178-195`（续聊） | `task.modelId` | `modelId = requested ?? task.modelId` 并写回任务行，然后 `await prompt` → bot 抛错直接冒泡 | 硬失败 | 已验证（代码） |
| 19 | `src/main/remote/RemoteAccessServer.ts:328-331` | — | 非 `RemoteValidationError/Conflict/NotFound` 的 Error → 500 `internal_error`，原因被吞 | 硬失败 + 信息丢失 | 已验证 |
| 20 | `src/main/remote/RemoteDtoMapper.ts:123-126` + `shared/src/remote-contract.ts:189-191` | — | `historyError`/`modelId` 不在契约里 → 安卓拿到 `{messages:[]}`，显示为空会话 | 静默假装正常 | 已验证 |
| 21 | `src/main/remote/RemoteDtoMapper.ts:31` | `task.modelId` | 直接把失效 id 发给客户端（手机模型选择器可能显示已下线项） | 仅展示 | 已验证 |
| 22 | `src/main/agent/ConversationBranchService.ts:250-265`（`261`） | `task.modelId` | 子分支任务**继承**失效 model_id（把漂移复制到新任务；子任务非 bot 时走静默降级） | 扩散 | 已验证 |
| 23 | `src/main/agent/BtwSessionService.ts:269-275,297-301` | 请求 / 父任务 | setModel 包在 try/catch 里只 warn；`usageModelId` 可能取到失效父任务值 | 静默降级 | 已验证 |
| 24 | `src/main/capabilities/subagent/config.ts:92-101` + `index.ts:332-352` | 自身配置 | 子代理模型优先级 = role frontmatter > subagent.json > 全局默认，**完全不读 task.modelId** | 不受影响 | 已验证（grep 无 task.modelId 引用） |
| 25 | `src/renderer/src/components/chat/ChatInput.tsx:660,1895-1913` | `activeModelId` | 找不到时 chip 退化成「选择模型」（无报错、无提示） | 仅展示 | 已验证 |
| 26 | `HEAD:src/renderer/src/store/appStore.ts:2021,3078,993` | 任务行 | 各类 upsert 用 `task.modelId`（渲染层已替换过的值）→ 在 patch/发消息时把 DB 治回 | 自愈 | 已验证 |
| 27 | `src/main/db/AppDatabase.ts:2918` | — | `upsertTask` 未传 modelId 时保留旧值（`task.modelId ?? prev.model_id`）→ 局部 upsert 不会清掉失效值 | 机制说明 | 已验证 |
| 28 | `src/main/agent/AgentService.ts:1351-1353` + `src/main/gateway/GatewayAgentTurn.ts:23-27` | — | gateway 轮次固定 `welcomeMode:"bot"` → 必然走 Durable | 机制说明 | 已验证 |

> 明确**没有**受影响的面：多模型会诊（`MultiModelConsult.ts:66-68`，参与者来自用户配置，缺失时明确报错）、HTML AI 编辑（`HtmlEditService.ts:189`，无模型时给「请先选择可用模型」）、CAD/artifacts、prompt enhance（`PromptEnhancementService.ts:144-149`，best-effort）。

## 2. 渲染层：`activeModelId` 回退与「有没有写回」

### 2.1 boot 与切换任务的确切表现（HEAD）

- 首次装载：`mapTaskRowToTask()`（`HEAD:src/renderer/src/store/appStore.ts:150-188`，关键行 `169`）
  `modelId: row.modelId && enabledModelIds.has(row.modelId) ? row.modelId : defaultModelId`
  `enabledModelIds` = `listModels()` 里 `enabled !== false` 的集合（`2494-2495`），`defaultModelId` 还需通过同一集合校验，否则取 `enabledModels[0]`（`2474-2478`）。
  ⇒ **DB 里的失效值在这一步被内存替换成合法模型；DB 本身不变**。这就是「chip 正常、DB 仍是脏值」的显示漂移。
- 切换任务：`setActiveTask()`（`HEAD:...:3141-3183`）
  ```
  const taskModelId =
    task?.modelId && get().models.some(m => m.id === task.modelId && m.enabled !== false)
      ? task.modelId
      : get().activeModelId;            // 3146-3149
  ```
  ⇒ 悬空时**不是**回退到默认模型，而是**沿用上一个任务的 activeModelId**（粘滞）；若该值也悬空，`ChatInput.tsx:660` 的 `activeModel` 为 undefined，chip 显示「选择模型」，且 `contextWindowTokens` 会落到上一个任务的窗口值（`3186-3188`）。
  同时 `modelExplicit` 取 `task.modelExplicit ?? false`（`3185`，`modelExplicit` 不持久化）⇒ 发请求时通常**不带** explicit（`src/renderer/src/lib/sessionContract.ts:23-26`）⇒ 主进程读 DB 失效值。

### 2.2 载入历史后是否有写回

HEAD 中**没有任何**「载入历史 → 修正 modelId」的路径：

- durable 分支：只写 `sessionRecovery` / `historyError`（`HEAD:...:3261`）。
- Pi 分支：只写 `messages/sessionFile/cwd/sessionRecovery/historyError`（`HEAD:...:3342-3355`）。

仅有的三处**写回**（都不是历史载入触发）：

1. 发送消息：`upsertTask({ ..., modelId: activeModelId })`（`HEAD:...:3776-3784`），并且 `3877` 先 await 再 `agent.prompt` ⇒ 桌面发消息是 bot 任务唯一的自愈入口（也是它「输入一句话就好了」的原因）。
2. 助手事件：`assistant_start/assistant_end` 时回写 `task.modelId`（`HEAD:...:3070-3078`）⇒ 非 bot 一轮成功即可自愈；bot 不走这两个 patch（走 `durable_snapshot`），**所以 bot 永远等不到这一步**。
3. 用户显式改选：`setActiveModel`（`HEAD:...:4651-4680`，`4673-4678` 写 DB）/`followSuggestedModel`（`4716-4724`）。

> 当前工作树已经在 durable 分支补了第 4 条（`WT:appStore.ts:3259-3275`，回传 `history.modelId` + `modelRecovery`），这正好补上 HEAD 的缺口。

## 3. 只读 DB 统计

### 3.1 总体

- `tasks` 共 **131** 行；`welcome_mode`：`bot` 46、`working` 66、`coding` 19；`model_id` 无 NULL。
- `durable_bot_bindings` 共 **46** 行，与 bot 任务集合**完全相等**（bot 无 binding 0 条；非 bot 有 binding 0 条）⇒ `owns()`（`HEAD:DurableBotService.ts:81`）= 「是 bot」，可当作「是否会走 Durable」的判据。
- `session_file`：bot 0/46 有值；working 63/66；coding 17/19 ⇒ bot 的历史**只能**经 Durable 打开，非 bot 的历史走 JSONL（`AgentService.ts:3800-3828`）。
- `models.json`：`providers.magpie.models` = 19（`group/*`、`workbuddy/*`、`workbuddy-ai/*`、`opendesign/*`），**无 `commandcode/*` 路由**；`providers.commandcode.models = []`（只有 `modelOverrides`）。
- ModelRuntime 实测（独立进程、`allowNetwork:false`）：

| id | 结果 |
|---|---|
| `magpie/commandcode/z-ai/glm-5.3-flash` | MISSING |
| `magpie/commandcode/deepseek/deepseek-v4.1-flash` | MISSING |
| `magpie/commandcode/deepseek/deepseek-v4.1-flash-fast` | MISSING |
| `commandcode/moonshotai/Kimi-K2.7-Code` | MISSING（`models-store.json` 里的 84 条缓存未进 `getModel`） |
| `magpie/workbuddy/glm-5.3-flash` | OK |
| `magpie/workbuddy/deepseek-v4.1-flash` | OK |
| `magpie/opendesign/deepseek-v4.1-flash` | OK |

### 3.2 快照 A（审计开始，约 14:20 +08:00）

不可解析共 **73/131**：

| welcome_mode | 不可解析 | 其中 durable binding | 其中已归档 |
|---|---|---|---|
| `bot` | **31** | 31 | 14 |
| `working` | 37 | 0 | 24 |
| `coding` | 5 | 0 | 2 |

失效 id 分布（快照 A）：
- bot：`magpie/commandcode/deepseek/deepseek-v4.1-flash` 21、`...-fast` 9、`magpie/commandcode/z-ai/glm-5.3-flash` 1
- working：`magpie/commandcode/deepseek/deepseek-v4.1-flash` 15、`...-fast` 10、`z-ai/glm-5.3-flash` 6、`commandcode/deepseek/deepseek-v4.1-flash` 4、`magpie/workbuddy-ai/hy4-preview-f` 1、`magpie/group/auto-space-bunny-free` 1
- coding：`.../deepseek-v4.1-flash` 3、`...-fast` 2

结论：**「打不开」只发生在 bot**——31 条 bot 全部有 durable binding 且全部不可解析；而 42 条不可解析的 working/coding 没有 binding，历史读文件，因此不报错。bot 侧同批任务里 15 条用 `google-vertex/gemini-3.8-flash` 的仍可解析（对照组），也印证失败只由模型可解析性决定。

快照 A 中「录音笔」`local-1792037952880-22`：`model_id=magpie/commandcode/z-ai/glm-5.3-flash`、status=completed、binding 目录存在且含 `main.jsonl` 等 12+ 个 jsonl（**数据本身完好，纯属模型门禁挡住**）。

### 3.3 快照 B（约 14:26 +08:00，审计期间被外部改动）

两次只读快照之间有 **31 行 bot 任务的 `model_id` 被批量改写**，全部改成可解析路由：

- `magpie/commandcode/deepseek/deepseek-v4.1-flash` → `magpie/workbuddy/deepseek-v4.1-flash`
- `magpie/commandcode/deepseek/deepseek-v4.1-flash-fast` → `magpie/workbuddy/deepseek-v4.1-flash`
- `magpie/commandcode/z-ai/glm-5.3-flash` → `magpie/workbuddy/glm-5.3-flash`
- `updated_at` 未变（例：录音笔 仍为 2026-10-16），与工作树里 `resolveTaskModel()` 注释「updatedAt 保持不变」一致
- 改的是**任务行**，**没有**改 `cron_jobs.model_id`（仍为 `magpie/commandcode/deepseek/deepseek-v4.1-flash`）

快照 B 不可解析：`working` 37 + `coding` 5 = **42**，`bot` **0**。⇒ 数据层面的 bot 症状此刻已消失，但非 bot 的 42 条与 cron job 行仍未收敛。

> 归因说明：这些写入不是本审计所为（只读连接 + 唯一写入是本文件）。改写结果与工作树里 `src/main/agent/durable/BotModelCatalog.ts`（`ROUTE_VARIANT = /-(?:fast|batch|turbo)$/i`，`modelNames()` 剥离变体后缀后按同名匹配）的规则一致，推测是修复实现的一次性修复被执行过一次（**推断**：没有代码/进程证据直接证明执行者；审计期间存在 14:21:36 启动的一批 node 进程，但当前运行的 MyBuddy 是 12:19:50 启动的 `release/win-unpacked/MyBuddy.exe`）。

## 4. 最小且诚实的修复边界

### 4.1 必须改（按优先级）

1. **`src/main/agent/durable/`（已被他人实现的 BotModelCatalog 路线，方向正确）**：把「目录里没有」当成**需要修复的配置**而不是「会话损坏」。
   - 解析规则可判、可解释（同名他路由 → 默认 → 首个可用 → 明确报错），且必须**带回 `repairedFrom`**。
   - 修复要落库到 `tasks.model_id`，但**不要动 `updatedAt`**（否则任务被顶到列表最前）。
   - `history()` 只有在**真正没有可用模型**时才返回 `historyError`；模型修复本身不应再走「会话记录打不开」。
2. **`src/renderer/src/store/appStore.ts`**：durable 历史返回的 `modelId` 必须同步到 `tasks[].modelId` 与 `activeModelId`（否则输入框继续显示旧模型，用户仍看到「显示 A 跑 B」）。同时建议在 `setActiveTask()`（HEAD:3146-3149）把「沿用上一个 activeModelId」改成「悬空 → 默认模型」，避免粘滞一个不相关模型。
3. **`cron_jobs.model_id`**：`CronService.ts:331-334` 在真正建任务前，用同一套解析把 job 的 model 解析一次并**回写 cron_jobs**（或至少在 bot 分支用解析后的值）。否则每跑一次就重新写进一条失效 id，修复永远在追。
4. **`src/renderer/src/components/chat/ChatView.tsx`**：把「模型被替换」作为**独立提示**（from → to）展示，而不是并入 `historyError`——静默换模型在 Bot 上等于换掉执行者，必须告知用户。

### 4.2 应该改（同一根因，非本次症状）

5. **`src/main/remote/RemoteDtoMapper.ts` + `shared/src/remote-contract.ts`**：`RemoteTaskHistory` 增加 `historyError`/`modelId`（或 `modelRecovery`），否则安卓端继续把「打不开」渲染成「空会话」。这是「诚实」要求里最容易漏的一条。
6. **`src/main/agent/AgentService.ts:4563-4566`**：regenerate 不该把 `existing.modelId` 当 explicit；改成 `req.modelId`（用户显式）或走 `resolveEffectiveModelId` 的可用性校验链，避免 `4086` 抛「无法使用指定模型」。
7. **标注/文档**：`resolveEffectiveModelId`（`mode-profile.ts:724`）对 explicit 值不做可用性校验是**有意为之**（保真用户显式选择），但调用方要知道这一点；建议在 `applySessionModel` 返回 false 且来自任务持久化值时记一条结构化日志（便于诊断「静默降级」）。
8. **`UsageStatsService.reattributeToMyBuddyModels`**：模型修复后它会改写历史 `usage_events`。建议：只按 `session_file` 归属、不要用「当前 model_id」覆盖历史行（或至少把原值留在 `response_model`/新列），否则用户看到的「历史用量按模型」会被追溯性改写。

### 4.3 不该动

- `src/shared/mode-profile.ts:718-728` 的 explicit 语义（显式优先、不校验可用性）——改了会让「用户显式选了一个暂时未认证的模型」变成悄悄换模型。
- `AppDatabase.upsertTask` 的「未传即保留」语义（`AppDatabase.ts:2918`）——这是局部 upsert 不误删字段的基础。
- 各处 `catch → warn` 的 best-effort（BTW、prompt enhance、vision 委托）：它们是旁路，不该升级成错误。
- 任何 `models-store.json` 缓存注入 `getModel` 的做法：缓存是「目录曾经有」，不是「路由现在可用」，用它「修好」解析会把真实下线隐藏掉（这也是本次能确诊的前提）。

### 4.4 回归风险

| 风险 | 说明 | 建议验证 |
|---|---|---|
| 静默换模型 | 同名路由替换（`.../deepseek-v4.1-flash-fast` → `workbuddy/deepseek-v4.1-flash`）会**改变速度档/计费**，且自动化任务（cron/gateway）里没人看提示 | 断言 `modelRecovery` 非空时必须回传/展示；cron run 的 error/notice 里带 from→to |
| 历史用量被追溯改写 | 修复后下次启动 `reattributeToMyBuddyModels()` 会把旧 `usage_events` 改记到新模型（见 4.2-8） | 比较修复前后 `usage_events` 行数与 provider/model 分布 |
| `updatedAt` 被踩 | 修复若用普通 upsert 带 `updatedAt: Date.now()`，会让 31 条旧任务瞬间排到列表最前 | 核对修复前后 `updated_at` 不变 |
| 并发写入 | 修复在**运行中的 MyBuddy**（12:19 启动的 release 包）之外改 DB：它内存里仍有旧 `model_id`，下一次 `upsertTask`（发消息/助手事件）可能把失效值**写回** | 修复应走「打开即解析」的幂等路径，并在 renderer 收到 `modelId` 后同步内存，避免回写旧值 |
| regenerate 侧未覆盖 | 若只改 Durable，非 bot 的 42 条任务点「重新生成」仍会硬失败 | 造一条 working 任务把 `model_id` 改成 `a/b/c/x`，点重新生成，应为降级而非报错 |
| 安卓契约变更 | 给 `RemoteTaskHistory` 加字段需要同步手机端渲染，否则仍是空白（但至少不误导） | 手机端「打不开」时显示 `historyError` 文案 |
| 目录顺序依赖 | 「同 provider 首个同名路由」依赖 `models.json` 顺序；顺序变了替换目标就变 | 单测固定目录快照，断言只做「同名/可解析」而非写死目标 id |
| `-fast` 变体降级 | 当前实现把 `-fast` 剥掉后匹配到非 fast 路由；如果产品希望「宁可报错也别换档」，需要显式策略 | 明确产品决策并在 UI 提示 |

## 5. 复现与验证方法（只读）

```js
// 1) 只读拿任务行
const Database = require("C:/Users/servi/Documents/GitHub/wavealstra_harness/node_modules/better-sqlite3");
const db = new Database(require("path").join(require("os").homedir(), ".mybuddy", "app.db"),
  { readonly: true, fileMustExist: true });
db.prepare("SELECT id,title,welcome_mode,model_id,session_file,archived FROM tasks").all();

// 2) 用真实解析器判定（与 App 同源，allowNetwork:false 不触网）
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const rt = await ModelRuntime.create({ authPath: `${home}/.mybuddy/auth.json`,
  modelsPath: `${home}/.mybuddy/models.json`, refreshOnCreate: false });
await rt.refresh({ allowNetwork: false });
rt.getModel("magpie", "commandcode/z-ai/glm-5.3-flash"); // → undefined
```

注意：`app.db` 是 WAL 模式且 App 正在运行（`app.db-wal` 一直在写），两次连接可能读到**不同**快照；做前后对比必须记录时间并把 `app.db-wal` 的 mtime 一并记下（本审计两次快照的差异即由此产生）。

## 6. 本审计的限制（诚实边界）

- **没有**启动/操作 GUI、没有连手机端、没有重跑 cron：所有「用户看到什么」的结论来自代码链 + DB 数据，GUI/手机的实际渲染未实点（表中已标「已验证（代码链）」）。其中「regenerate 会显示错误卡」依赖 `AgentRegenerateResult.ok=false` → `failPending(...)`（`HEAD:src/renderer/src/store/appStore.ts:4176-4179`）这一环，未实际点击。
- 只对 3 条代表 id 做了 ModelRuntime 实测，其余按 `models.json` 目录枚举推断（provider/model 枚举是完整 dump 的，非抽样）。
- `~/.mybuddy/models-store.json`（596KB，84 条 commandcode 模型缓存）未逐条解析；已实测其内容**不会**让 `getModel` 命中。
- 审计期间工作树与 DB 都在变（§开头的说明）：HEAD 行号可复现，WT 行号仅供指路。
