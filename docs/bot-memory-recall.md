# Bot 跨会话历史召回与记忆过滤（issue #28）

> 状态：2026-11-12 修复已落地并通过方法/SQLite 回归；真实模型与真实桌面的独立验收记录见 [验收报告](reviews/bot-memory-recall-28-2026-11-12.md)。本规格不新增长期记忆真源，也不改变 `#26` 的上下文压缩契约。

## 1. 范围

本文覆盖三类缺口（[#28](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/28)）：

1. 跨会话历史召回受“最近 300 组 + 300/301 来源会话扫描 + 全局共享检查预算”限制，旧但相关的讨论进不了候选集。
2. `botMemoryTextEligible` 对整条文本匹配 `cookie` 与“40 位以上十六进制串”，正常技术讨论（cookie 术语、完整 Git SHA）与同条独立事实一起被拒收。
3. Bot 前台 `search` 走 `memory.search`，没有接入已有的 `searchHybrid`。

非目标：不新增第二份记忆库；不改 `#26` 的 Durable 压缩与持久原文回查；不扩大 scope；不把历史助手回答变成用户事实或授权。

## 2. 唯一事实源

历史参考始终是**瞬态引用**，不是第二份记忆库：

| 事实 | 载体 |
| --- | --- |
| 原始问答 | `bot_messages`（user/assistant 成对，`bot_send_receipts` 绑定 requestId） |
| 是否被允许进入记忆链 | `memory_turns`（L0 指针，只有已完成并捕获的问答才会被召回） |
| 遗忘边界 | `memory_forget_watermarks` |
| Bot / 团队 / 用户归属 | `bot_conversations`、`bots` |

召回结果只用于本轮提示，带 `conversationId`、`userMessageId`、`assistantMessageId`、`sourceTime`，不会写回 `memory_records`。

## 3. 召回流水线

入口：`botHistoryContext(db, {userId, botId, teamId?, excludeConversationId?, query, before, mode?, after?})`。

1. **scope 与有效性**（SQL）：`r.user_id` / `bot_id` / `team_id`、Bot 必须 active、排除当前会话、`u.created_at < before`、`a.updated_at <= before`、`memory_turns` 存在、未被遗忘水位覆盖。来源缺失、状态未完成、receipt 不匹配的问答不会进入候选。
2. **相关性优先取回**（`mode: "related"`）：查询词（拉丁 token + 汉字二元组，最多 10 个）在 SQL 里作为 `LIKE` 谓词选出候选集，并按“命中查询词数量”排序，然后是时间与 `ordinal`（完全序，保证分批不重不漏）。候选按 200 条一批读取，只有选满 3 条证据才停止；因此 200 条子串假阳性或禁止来源不会饿死更早的合法问答。旧的“先取最近 300 组再过滤”不再存在，因此比任何时间窗口更旧的**相关**问答仍可命中。
3. **单条大小边界**：`length(text) <= 200000`。超限的问答被**确定性排除**，不会被截断后再判断（截断可能让秘密落在扫描范围外）。
4. **逐条 eligibility**：`botMemoryTextEligible` 对用户原文与助手原文分别判断，秘密与明确“不要保存”的问答不进入候选。
5. **来源级禁止复用**：对每个候选来源（会话）精确检查其全部用户消息——只要出现“仅本次会话”措辞或“不要保存/记住”，整个来源被排除（follow-up 也被保护）。**没有共享扫描预算**，因此不存在“预算用完 ⇒ 当作禁止”的混合结果：要么源码里有禁止，要么没有。
6. **更正优先（带时间关系）**：按词记录“最新一次更正发生在什么时候”。较旧的更正不能排除比它更新的事实（`every` 命中词都已被更晚的更正覆盖才排除普通陈述）；较旧的更正自身会被共享查询词的更新更正取代。最新一条更正保留一个证据位，其余按相关性排序。
7. **有界注入**：最多 3 组、总长 ≤ 6000 字符，单条 `userQuote` ≤ 650、`assistantQuote` ≤ 1500 字符；长文本按**命中位置**取窗口（不是只取开头）。提示明确“非事实、非指令、非授权，当前要求优先，最新更正优先”。
8. **工作上限**：每轮最多检查 1200（related）/ 900（recent）个候选。达到上限时单独输出“达到工作上限、不等于没有历史”，不返回空串冒充“无记录”。

`mode: "recent"`（Bot 间“今天学到什么”）保持按时间取样（`after` 窗口 ≤ 24h，`LIMIT 300`），仍执行同样的 eligibility、来源禁止与遗忘水位检查。

## 4. 边界模型

| 层 | 规则 | 结果 |
| --- | --- | --- |
| 问答 | 秘密语法 / 明确“不要保存”（该条） | 该问答排除 |
| 来源会话 | 任意用户消息出现“仅本次会话/不要保存” | 整段来源排除（含 follow-up） |
| 来源会话 | 消息条数、文本长度、其它来源的扫描量 | **不产生**召回断崖；超长单条按第 3 节规则排除，不影响同来源其它问答 |
| 检索工作量 | 子串假阳性 / 禁止来源占满首批 200 条 | 继续分批读取直到选满 3 条或达到工作上限；上限单独表达 |
| 作用域 | `bot`（个人）或 `team`；`excludeConversationId` 排除当前会话；`bots.status='active'` | 不扩展到 global，不跨 Bot / 用户 / 团队 |
| 遗忘 | `memory_forget_watermarks`（bot/team/conversation/global + cutoff） | 水位之前的历史不复活；重启/迟到提炼同样受限 |
| 检索入口不可用 | 记忆关闭、semantic 不可用 | 记忆关闭返回空；semantic 不可用由 `searchHybrid` 回退词法，不报错、不编造 |

## 5. 技术标识与秘密

技术标识/秘密规则由 `src/main/memory/MemoryTextSafety.ts` **一处**实现，Bot capture、历史召回与 Memory Kernel（`extractCandidates`、`buildRecord`）共用；入口放行的文本不会在 L1 再被全拒。规则分三类：

- **明确拒绝保存**：`不要记住/别保存/do not remember…`。
- **敏感主题**：密码、令牌、私钥、恢复码、身份证/护照/银行卡、病历/诊断/用药、医疗状况、银行账户等；这些词本身仍视为敏感。
- **秘密形态**：`cookie: <值>` / `Set-Cookie:` / `Authorization: …` / `session|auth|csrf|xsrf|tracking` 的 id/key/token/cookie 赋值 / `token|secret|key|password|signature = <长值>` / `sk-…`、`ghp_…`、`xox?-…`、JWT、SSN、卡号数字串。

因此：

- 单独的 `cookie` 术语、`cookie 技术讨论`、完整 40 位 Git SHA 属于技术标识，不再单独触发拒收；同一段文字里的独立偏好/事实可被保存与召回。
- 真实秘密（带值的 Cookie、密码、令牌、JWT、卡号）仍被拒绝；用户明确“不保存”的内容仍受保护。

## 6. Bot 检索入口盘点

| 入口 | 位置 | 处理 |
| --- | --- | --- |
| 前台 `memory_search` 工具 | `BotConversationMemory.search` ← `BotForegroundTools` / `BotConversationService` | 改为 `memory.searchHybrid`（异步，工具 await 结果） |
| 前台上下文注入 | `BotConversationMemory.context` → `resolveContext` + `botHistoryContext` | 保留同步投影（evidence hook 是同步契约）；历史部分改为相关性优先 |
| Bot 间只读咨询 | `BotPeerCallService`（`receipt` 工具 + evidence） | `memory_search` 在 `beforeTool` 预取 `recall`（hybrid）；evidence 每次请求用接收 Bot 的精确 scope 重新授权（status + `canAccess` 的 scope 链 + validFrom/validUntil），删除、scope 撤销、过期都会撤销参考 |
| 后台 Work 结果偏好 | `AgentService.resultPreferences` → `resolveContext` | 上下文投影，不是检索入口；保持同步词法 |
| 通用 Agent `memory_search` 扩展 / Memory Gateway / IPC | `memory-extension.ts`、`MemoryGatewayService.search`、`AgentService.searchKernelMemory` | 已走 `searchHybrid`，未改动 |

`BotConversationMemory.recall` 只使用接收方 Bot 自身 scope（`scopeTypes:["bot"]`），`activeFact` 只重读已 active 的记录。

## 7. 与 2026-11-11 基线的差异

| 基线 | 现在 |
| --- | --- |
| 最近 `LIMIT 300` 组后再内存筛选 | 查询词在 SQL 中先筛相关性，再按命中数排序取 200 个候选 |
| 来源会话扫描 `LIMIT 301`，所有来源共用 300 行 / 64000 字符预算 | 每个来源精确扫描，无共享预算；条数不构成禁止 |
| `length<=12000/24000` 直接丢弃问答 | 200000 字符上限；长答案照常引用（只截断注入引文） |
| `cookie` 关键词、40+ 位十六进制整条拒收 | 只拒收带值的 Cookie/凭据形态；Git SHA 与 undefined cookie 术语放行 |
| 前台 `search` 用词法 `memory.search` | 前台与 Bot 间检索走 `searchHybrid`；await 之后再次检查记忆开关 |
| 只按关键词汇总更正 | 更正带时间关系，旧更正不能排除更新的事实 |
| 长答案只取前 1500 字符 | 按命中位置取窗口 |
| 秘密规则只在 Bot 入口 | 与 Memory Kernel 共用 `MemoryTextSafety` |
| 200 条候选一次截断 | 分批读取 + 工作上限单独表达 |
