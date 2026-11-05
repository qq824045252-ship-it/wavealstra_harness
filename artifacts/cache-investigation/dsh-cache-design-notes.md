# DSH（DeepSeek Harness）源码学习笔记：缓存相关的设计约定

仓库：`deepseek-ai/deepseek-harness`（master，TypeScript，20,665 个文件/360MB，最后 push 2026-11-04）
主题：与我们这条缓存线程直接相关的四个设计决策
材料来源：仓库 `.agents/notes/` 下的架构决策记录（Agent Note）。这是 DSH 特别值得学的一点——**每个设计决策连同被否决的替代方案一起留在仓库里**，2692 篇 Markdown

## 结论

DSH 缓存做得好不是运气，而是有约定在管：**系统提示被当成对话的第 0 号节点（一等公民、变更留痕）、辅助调用改成贴着已有前缀、指标口径写死、压缩永不碰节点 0**。我们那条 MyBuddy 事故，在 DSH 的模型里会留下一条节点级 `system/message` 替换事件（本轮已在 26 次运行记录中见到同型事件）；但它只**记录**前缀重算，不**阻止**重算，且 section 级归因仍要 diff 文本。Pi 侧则只能靠 diff `items[]` 哈希/字节。

## 一、四个可复用的原则

### 1. 系统提示是 surface 节点，不是配置

笔记：`implemented/architecture/2026-09-02-system-prompt-as-surface-node.zh.md`

- `system/message` 是 surface 事件类型，与 `user/message`、`assistant/message`、`tool/result` 并列（`packages/core/session/src/types.ts`）。
- 提示词变更 = 对该节点做 `replace`（`startSeq/endSeq` 指向同一节点），日志用 `sourceEventSeqs` 记录被遮蔽的旧节点，`replaceGeneration` 随之前推进。
- 日志能**区分两类变更**：提示词变了 → `system/message` 替换；若同一步 config/tools 未变，随后 `request/header` reason=`series`；若 config/tools 也变，header 仍是 `change`（本轮运行记录里见过 tools 49→51 与替换同轮，reason=`change`）。原文：一个 `request/header` 里逐字节比较 `system` 会让这两种变化"在日志中无法区分（reason 都是 change），尽管它们是对对话的两种不同操作"。
- 不变量：**节点 0 永不被压缩**，由 `assertSystemHeadRewrite` 在 surface 管理器里强制，所以别的压缩实现也无法绕过。
- 作者明确承认代价："替换第 0 号节点是头部重写在 surface 上的表达：提供方前缀从第一个 token 起改变"——他们没假装能避免，而是让它**可见、可归属、可测**。

对我们的意义：MyBuddy 那次 ERP 描述改动，在 DSH 的模型里会是一条"节点 0 被替换"的事件，带时间和新旧节点引用；我这边只能靠 trace 里的字节数 175 去反推。

### 2. 辅助调用必须贴着已有前缀

笔记：`archived/bug-fix/2026-07-21-compaction-summary-prefix-cache-reuse.zh.md`

问题描述和我们的诊断一字不差：*"提供方基于请求起始的 token 序列做缓存，因此第一个 token 只要不同（即一个不同的系统提示词），整个已缓存前缀就会失效。"* 当时 DSH 的压缩摘要器用一个**独立的** `system` 提示 + 拍平的 transcript，结果每次压缩要付两遍完整提示词成本，而且恰好在对话最长的时候。

修法很干脆：把摘要指令从**前端**移到**末尾**——变成最后一条 `user` 消息，让辅助调用成为已预热请求的**前缀扩展**。两个细节值得记：

- `tools` 即便摘要器从来不调工具也照样带上，因为"工具 schema 是已缓存 token 序列的一部分；省略它们会让后续每个 token 失去对齐，破坏复用"。
- 缓存复用声明为"尽力而为"，正确性单独保证：自动压缩锚定在头部所以保证命中；手动中段压缩放弃复用但仍正确。

对我们的意义：这条给出了"可变内容该放哪"的判据——**能放到末尾的，绝不放到前面**。交互路径的**记忆证据**确实缓存友好：`EphemeralContextProjection` 在 `context` 事件里把 evidence 胶囊插在**当轮 user 消息之后**（`messages.flatMap`），Pi 的 `convertToLlm` 再把 `role:"custom"` 原位转成 `user`（事故 trace seq 53：item 27 user 89B、item 28 user 1090B 胶囊、item 29 assistant）。但 **durable 路径**例外：`DurableBotRuntime.ts:649` 把 evidence 前置到 `messages` 头部，且内容随 query 变，是另一个风险点；时间快照未找到同等证据，暂不并称"已安全"。真正该盯的是仍留在系统提示里的东西：MCP 自述、skills 目录、能力说明。

### 3. 指标口径写死，不给解释空间

笔记：`archived/feature/2026-07-21-tui-footer-cache-hit-rate.zh.md`

- `cacheHitRate = round(cacheRead / (input + cacheRead + cacheWrite) * 100)`
- 四个桶互不重叠：`input`（未缓存）、`output`、`cacheRead`、`cacheWrite`；计费输入 = input + cacheRead + cacheWrite。
- **输出永不进分母**："输出 token 从不由缓存承接，把它折进分母只会无意义地拉低比率；缓存命中率是提示词的属性。"
- 空会话（分母为 0）返回 `undefined`，UI 整段隐藏，不显示 `cache 0%`——"在全新会话上打出 0% 是对一个尚不存在的值撒谎"。
- 写入桶不从分母剔除："剔除它会在写入的那一轮高估命中率"；并注明 DeepSeek 目前不上报缓存写入。

对我们的意义：我给 MyBuddy 算的 80.3%（全会话）/88.3%（主线）和 DSH 的 99.21%，公式同一；但 80.3 含子智能体独立会话、99.21 是单会话/n=8 抽样，**只能比定义，不能直接比数值**。也解释了为什么 MyBuddy 全程 `cacheWrite=0` 不是异常。

### 4. 连接态的信息也要落成日志

笔记：`archived/feature/2026-09-12-mcp-resources-and-instructions.zh.md`

- 服务器指令"为每个已配置的 MCP 服务器贡献一个作用域内的字面系统提示词段落"。
- 关键一句：**"已有的系统消息日志记录最终送达模型的组装后指令"**——机制上，MCP 自述变化会改变 `renderPrompt` 的输出，默认路由下触发对第 0 节点的 `replace`（`dsh-mcp-client` 的 section 文本 `() => connection.instructions()`；`dsh-system-prompt` 的 `renderPrompt` 逐 section 取值并丢弃空段；`dsh-agent-loop` 的 `SystemPromptProjection.project` 返回 `replace` + `sourceEventSeqs`）。**但"会记录"不等于"不会抖"**：DSH 当前 313 个会话里 0 个出现 `### MCP server` 段（唯一 MCP 不返回 instructions），所以没有自然触发；接入会返回自述的服务器仍会从 token 0 重算。
- 另外两条克制：资源内容按需读取，不预加载；"只要调用方可见的客户端仍已配置，连接失败期间共享 schema 就保持稳定"。

对我们的意义：DSH 的 mcp-client 没有 `description` 配置字段（上次查过），它靠"节点替换留痕"来**归因**，而不是"配置钉死文本"来避免——路线不同，但同样具备可归因性，也同样要付前缀重算的代价。

## 二、与我们现状的对照

| 关注点 | DSH | MyBuddy（Pi 1.5.0） |
|---|---|---|
| 系统提示存储 | surface 节点 0 事件 | 每请求重渲染 sections，变更时追加新 system 消息 |
| 中途变更的表达 | 显式 replace 事件 + 日志可区分提示词变更与工具变更 | 无变更原因事件；会话里追加一条 system 消息，审计靠 trace 的 items[] 哈希/字节 |
| MCP 自述 | 进系统提示，节点替换留痕（本轮已确认机制；当前无自述） | 进系统提示，静默改写（本次事故） |
| 事故归因手段 | seq / sourceEventSeqs / contextTimeline | CacheRequestTracer 的 sharedItems/changedFields/prefix；能定位“哪变了”，不能答“为什么变” |
| 指标口径 | 文档固定公式 + UI 显示 | 已有同式（usage-stats.ts:375；ContextUsageControl:247；UsageStatsModal:389）；缺聚合范围标签与 trace 派生 |
| 压缩对缓存的影响 | 明确设计为复用前缀 | 未评估 |

## 三、能搬回 MyBuddy 的三件事（按性价比排序）

1. **让系统提示变更留痕**。MCP section 真的变了的时候打一条结构化日志（哪个 section、字节差、触发原因），而不是靠每日巡检反推。DSH 的日志是**节点级**（只记 replace + 旧节点引用），section 级归因仍要自己 diff 文本；成本最低，不动结构。
2. **守住"可变内容不进系统提示"**。交互路径的记忆证据已锚点插入，不要挪回 system prompt；**durable 路径的 evidence 是前置的**（`DurableBotRuntime.ts:649`），应优先改为尾部/锚点；时间快照待核；重点看 MCP 自述、skills 目录、能力说明。
3. **补命中率口径的"范围"与 trace 派生**。公式已有（`usage-stats.ts:375` / `ContextUsageControl:247` / `UsageStatsModal:389`，输出不进分母、空会话不显示）；缺的是主会话 vs 含子智能体的聚合标签，以及 cache-trace 的逐轮派生。

## 四、本轮读过的材料（边界）

| 文件 | 用途 |
|---|---|
| `2026-09-02-system-prompt-as-surface-node.zh.md` | 系统提示作为节点 0 |
| `2026-07-21-compaction-summary-prefix-cache-reuse.zh.md` | 摘要调用改前缀扩展 |
| `2026-07-21-tui-footer-cache-hit-rate.zh.md` | 命中率口径 |
| `2026-09-12-mcp-resources-and-instructions.zh.md` | MCP 指令进系统提示并留痕 |
| `2026-07-27-stable-snapshot-refresh-volatiles.zh.md` | 误命中（讲测试 fixture 归一化，与缓存无关） |

**本轮仍以设计笔记为主；已补读解包快照中的 `dsh-mcp-client` / `dsh-system-prompt` / `dsh-agent-loop` 实现**（见 §五）。这些是决策记录，其中三篇已归档（compaction/tui/mcp；system-prompt 是 `implemented`），可能与当前 master 实现有偏差。

## 五、本轮补充验证（2026-11-05 17:18）

### ① MyBuddy 交互路径的 evidence 注入位置

结论：**不是前置到 messages 头部**。

- 代码：`EphemeralContextProjection` 在 Pi 的 `context` 事件里把证据胶囊插到锚点之后：`messages.flatMap((message, i) => [message, ...(inserts.get(i) ?? [])])`；锚点是 `anchors.get(record.anchor)`，正常轮次就是最新 user 消息（`src/main/agent/EphemeralContextProjection.ts:302-324`）。
- 胶囊以 `role: "custom"` 生成；Pi 的 `convertToLlm` 把它原位转成 `role: "user"`（`@earendil-works/pi-coding-agent` bundle `chunk-44DLKSKE.js:546`），没有“被提到系统提示/头部”的路径。
- 运行时：事故会话 trace `seq 53`（本地 15:04:18）items 共 29 项：`[0] developer 13265B`，`[27] user 89B`，`[28] user 1090B`（胶囊，末项）；胶囊在 user 之后。会话 ledger 的 `timestamp` 是 `2026-11-05T07:04:18Z`（本地 15:04:18），anchor=`dee8c4b1`，正是该轮 user。
- 代价：evidence 的**内容**随 query 变（`projectMemoryContext` 用最后一条 user 查询），但位置在当前 user 之后，属于新增尾部 token，不是前缀重写。
- 例外：**durable 路径** `DurableBotRuntime.ts:649` 是 `[evidence, ...messages]`，前置到 messages 头部；这是另一个应单独修的风险点。时间快照没有找到同等证据，建议单列。

### ② DSH 的 MCP 变化是否触发 system/message 节点替换

结论：**默认路由下会；但当前没有自然触发，且它只记录不阻止。**

- 代码：`dsh-mcp-client` 的 `registerServerContext` 把 section 文本设为 `() => connection.instructions()`；连接成功后 `serverInstructions` 为 `### MCP server: name\n\n...`，初始为空（快照 `dsh-mcp-client/lib/index.js:654-655, 684, 740`）。`renderPrompt` 逐 section 求值并 `filter(text => text.length > 0)`（`dsh-system-prompt/lib/index.js:113-114`）。`step()` 每步 `renderPrompt(assembly)`，`SystemPromptProjection.project` 在文本不同时返回 `surfaceOp: { op: "replace", startSeq, endSeq }` + `sourceEventSeqs`；`session.append("system/message", ..., intent)`（`dsh-agent-loop/lib/index.js:264-295, 1047-1060`）。
- 运行时：扫描本机 313 个 DSH 会话（`~/.dsh/sessions/**/session.v4.jsonl.zstd`），共 310 个 `system/message`，其中 **26 个 replace**（分布 17 个会话）都带 `surfaceOp` 与 `sourceEventSeqs`；**0 个**会话出现 `### MCP server` 段——唯一 MCP 不返回 instructions，所以没有 MCP 专属触发。
- 因此：**默认路由下，MCP 自述变化会触发第 0 节点替换**；若配置 `systemPromptUpdate: "in-history"`，则追加历史内 system 消息，不替换节点 0（本机 profile 未设该值）。
- 一个修正：替换后的 `request/header` 不一定是 `series`。本次样本里替换同轮 tools 49→51，header reason=`change`；只有 config/tools 未变时才是 `series`。

## 六、未验证

1. DSH 源码来自 `C:\Users\servi\AppData\Local\Temp\mybuddy-81-36fdd95\artifacts\dsh-inspect\pkg` 的 2026-11-03 解包快照，不是 2026-11-05 的运行中构建；版本差异未逐项对比。
2. 没确认 DSH 在“系统提示被替换”时是否给用户提示或做任何降级——只看到事件被记录；system-prompt 笔记 L52 提到 Web 请求卡片会显示该节点，但不是运行时告警。
3. MCP 专属触发未观测到（313 个会话 0 个 `### MCP server` 段）；机制由代码路径 + 其他提示词变化的 26 次 replace 事件确认。
4. 时间快照是否追加未验证；durable 路径 evidence 前置已确认，交互路径 evidence 锚点插入已确认。
5. 仓库规模（20,665 文件/360MB）、2,692 篇、最后 push 日期仍无法在本机复核（没有 clone；`dsh-src` 只有 5 个文件）。另：指标口径、归档数、可比性问题已按核对结果修正。
