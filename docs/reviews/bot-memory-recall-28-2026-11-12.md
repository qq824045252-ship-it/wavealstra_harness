# Bot 历史召回与记忆过滤验收报告（issue #28）

| 项目 | 值 |
| --- | --- |
| 关联 issue | [#28 修复长历史召回、技术文本误过滤与 hybrid 入口](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/28) |
| 规格 | [Bot 历史召回与记忆过滤](../bot-memory-recall.md) |
| Issue 核验基线 | `14a650406359b5c4bd4cc358b2a7623364242298`（2026-11-11） |
| 本次工作基线 | `origin/main` `94defbf8`（2026-11-12 拉取） |
| 代码提交 | `ee919b7f`（本报告为紧随其后的文档提交） |
| 日期 | 2026-11-12 |
| 结论口径 | 通过 / 未通过 / **未测**；未测不等于通过 |

本报告只记录实际执行过的检查。方法/SQLite 回归与真实模型回合分开记录；真实模型回合只覆盖 8 类跨会话场景，**没有**跑“1000+ 组真实模型历史”的整链路（见 §8.2）。

## 1. 本次交付

| 缺口 | 改动 | 落点 |
| --- | --- | --- |
| 先取最近 300 组再过滤，旧相关讨论进不了候选 | 查询词在 SQL 中先做相关性筛选，按命中词数排序取 200 个候选；候选集不再与时间窗口绑定 | `src/main/agent/work/BotHistoryContext.ts` |
| 来源会话 `LIMIT 301`、所有来源共用 300 行 / 64000 字符检查预算 | 每个候选来源精确扫描其全部用户消息，无共享预算；来源条数不再构成禁止。禁止复用（“仅本次会话/不要保存”）与“扫描量”彻底解耦 | 同上 |
| `length<=12000/24000` 直接丢弃问答 | 单条上限 200000 字符；长答案照常召回，只截断注入引文 | 同上 |
| “预算不足”与“真正禁止”结果相同 | 取消预算状态；只存在“来源含禁止措辞”与“来源可复用”两种结果 | 同上 |
| `cookie` 关键词、40+ 位十六进制整条拒收 | 只拒收带值 Cookie/凭据形态；Git SHA、普通 cookie 术语放行 | `src/main/memory/BotMemorySource.ts` |
| 卡号正则误吃 Git SHA 的数字后缀 | 卡号规则加词边界，`…a7623364242298` 不再被当作卡号 | 同上 |
| 前台 `search` 走词法 `memory.search` | `BotConversationMemory.search` 改走 `memory.searchHybrid`（异步）；前台工具 await 结果 | `BotConversationMemory.ts`、`BotForegroundTools.ts`、`BotConversationService.ts` |
| Bot 间只读检索没有 hybrid | `memory_search` 在 `beforeTool` 预取 `recall`（hybrid），evidence 每次请求重读命中记录，删除/停用即撤销 | `BotPeerCallService.ts`、`BotConversationMemory.recall/activeFact` |
| 更正/当前要求优先级 | 以“从新到旧”预扫标记被更正词，再按相关性选 3 条；更正条目本身仍可入选；输出按来源时间倒序 | `BotHistoryContext.ts` |
| 可复现性能证据 | 新增 `pnpm -s perf:bot-history-recall`（3 万组合成数据） | `scripts/perf-bot-history-recall.ts` |

未新增表、未新增第二份记忆真源、未改 schema 版本。历史参考仍只来自 `bot_messages` + `bot_send_receipts` + `memory_turns` + `memory_forget_watermarks`。

## 2. 方法 / SQLite 回归

| 命令 | 结果 |
| --- | --- |
| `pnpm -s typecheck` | 通过（web + node + scripts，新增错误 0） |
| `pnpm -s test:bot-history-context` | PASS（约 8s） |
| `pnpm -s test:bot-memory` | PASS |
| `pnpm -s test:bot-memory-runtime` | PASS |
| `pnpm -s test:bot-peer-calls` | PASS |
| `pnpm -s test:bot-team-conversation` | PASS |
| `pnpm -s test:memory` / `test:memory-gateway` / `test:memory-cognition` / `test:external-cli-memory` | PASS |
| `pnpm -s test:work-memory-capture` / `test:bot-work-review-memory` | PASS |
| `pnpm -s perf:bot-history-recall` | PASS（见 §6） |

`test:bot-history-context` 当前覆盖（均为真实 SQLite，不是源码文本断言）：

1. 基本跨会话召回、来源引用、非指令提示词、非长期事实（`listExactScope` 仍为 0）。
2. Bot / 用户 / 团队隔离；同团队跨 Bot；当前会话不作为历史证据；未来完成的回答不泄漏。
3. 更正覆盖旧说法；遗忘水位后不复活；删除来源、坏 receipt、缺 receipt、未完成回答不召回。
4. 明确“不要保存”“仅本次会话”与 13 种临时措辞全部阻断（包含长来源内的禁止）。
5. 输出有界（≤6000 字符、≤3 组），长回答只截断引文。
6. **Issue #28 新增**：1400+ 组交错历史（个人 / 团队 / 其它 Bot）中，位于最早期的相关问答仍被检索到，且带原始 message id、会话 id、`sourceTime`。
7. **新增**：来源会话 299 / 300 / 301 条全部可召回（旧实现的 300/301 断崖消失）。
8. **新增**：6 个 250 条的大来源不消耗共享预算，不饿死另一来源。
9. **新增**：被禁止来源不会挡住同一查询的合法来源。
10. **新增**：Git SHA、普通 cookie 讨论可保存/召回；`password=…`、`Set-Cookie: …`、`api_key=…` 仍被拒；超过 200000 字符的单条按确定规则排除而不是截断。

## 3. 边界矩阵（实际记录）

| 场景 | 旧实现 | 现在 | 证据 |
| --- | --- | --- | --- |
| 来源 299 / 300 / 301 条，相关问答在第 1 条 | ≥300 条时整段排除 | 三个来源都召回 | `test:bot-history-context` 的 `Boundary299/300/301Topic` |
| 6 个 250 条无关来源 + 1 个相关来源 | 共享预算耗尽后相关来源被排除 | 相关来源仍召回 | `BudgetNoise` 段 |
| 来源内任一用户消息“不要保存”（305 条，禁止在第 1 条） | 排除 | 排除（follow-up 同样不召回） | `StoneTopic` 段 |
| 来源内“仅本次对话有效” | 排除 | 排除 | `LocalScopeTopic` 段 |
| 单条助手回答 30000+ 字符 | 因 `length>24000` 丢弃 | 召回，引文截断 | `LongAnswerTopic` 段 |
| 单条 210000 字符 | 丢弃 | 丢弃（确定性单条规则，非预算） | `OversizeTopic` 段 |
| 超过 1000 组、旧相关在最早位置 | 进不了候选 | 召回并带出处 | `BuriedTopic` 段 |

“预算不足”这一状态已不存在：召回只区分“来源含禁止措辞”与“来源可复用”，不再有“扫描额度用完 ⇒ 当作禁止”。

## 4. 技术标识与秘密矩阵

| 文本 | 旧 | 现在 | 证据 |
| --- | --- | --- | --- |
| `生产只跑 TLS 1.3，提交 14a6504…` | 拒收（40 位 hex 规则） | 保存 + 召回 | `GitShaTopic`、`test:bot-memory` |
| `cookie 技术讨论：只记录主题…` | 拒收（`cookie` 关键词） | 保存 + 召回 | `CookieTopic`、`test:bot-memory` |
| `password=hunter2` | 拒收 | 拒收 | `SecretTopic` |
| `Set-Cookie: session=abc123def456` | 拒收 | 拒收 | `SecretTopic2` |
| `api_key={{API_KEY_live_9x}}` | 拒收 | 拒收 | `SecretTopic3` |
| `token={{SECRET_…}}`（带值 Token） | 拒收 | 拒收 | `test:bot-memory` |
| SSN / 13–19 位卡号 | 拒收 | 拒收（卡号规则加词边界，避免误吃 SHA 数字后缀） | `test:bot-memory` 既有用例 |

## 5. 作用域隔离

| 维度 | 结果 | 证据 |
| --- | --- | --- |
| 个人 Bot 之间 | 不互读 | `recall(..., {bot:"other"})` 不含 `BuriedTopic`；既有 `NSH`/`other` 用例 |
| 团队 ↔ 个人 | 团队查询不含个人历史；同团队跨 Bot 可读 | `team-a`/`team-long` 用例 |
| 其他用户 / 其他 bot 所有者的来源 | 不召回 | `foreign-user` 用例 |
| 当前会话 | 不作为历史证据 | `CurrentOnly` 用例 |
| 仅本次会话 | 不跨会话 | `LocalScopeTopic` 等 |
| 公共共享 | 不因“放宽召回”把个人历史提升为 global；L1 公共范围仍由 `remember` 明确措辞控制 | `test:bot-memory` 公共蓝莓用例 |

## 6. 性能（合成数据，方法级）

命令：`pnpm -s perf:bot-history-recall`（30000 组 / 200 个来源会话，时间戳跨度约 20 天）。

| 查询 | 中位 | p95 |
| --- | --- | --- |
| 相关性查询（命中被埋藏的早期方案） | 96.3ms | 105.4ms |
| 高频噪声查询（普通词命中很多） | 141.7ms | 162.0ms |
| recent 模式（24h 窗口） | 32.0ms | 42.4ms |
| 无命中查询 | 100.1ms | 120.4ms |

同一数据集上用**旧实现**（`git show d83532da:src/main/agent/work/BotHistoryContext.ts` 导入到一次性对照脚本）测得中位 105.6ms、p95 147.5ms，且**找不到**被埋藏的早期方案（返回空串）；新实现找到并返回 489 字符。旧实现的耗时主要来自“全表排序取最近 300 组”，因此新实现不是性能回退。该对照脚本是一次性的，未提交；提交的是上文 `perf:bot-history-recall`。

真实存储规模参考：本机 `~/.mybuddy/app.db` 当前 `bot_messages=96`、`bot_send_receipts=26`，该规模下召回成本可忽略。3 万组是合成压力数据，不代表日常开销。

## 7. 全量门禁与既有失败

`pnpm -s test:all`（headless，5.1 分钟）：**通过 465 / 失败 17 / baseline 已知失败 0**，失败列表：

```
test:bot-attachments            test:bot-delegation-fidelity     test:bot-memory
test:bot-reminders              test:bot-report-images           test:bot-work-automatic-recovery
test:cloudflared-cli-detect     test:durable-artifact-registration test:durable-task-projection
test:gadget-blueprint           test:gadget-runtime-lifecycle    test:gateway-media
test:pinned-public-proxy        test:session-history-recovery    test:slack-media
test:task-isolation-p2          test:work-watch-supervision
```

这些不是本 Issue 引入的：在同一 worktree、把本次改动 `git stash` 后对 `origin/main` 逐个运行同一批用例，失败集合**完全相同**（`bot-memory` 在两次单独运行中都通过，只在并行批次中偶发失败）。代表性原因：`test:durable-artifact-registration` 在本机 `EPERM: symlink`，`test:bot-reminders` 报 `openPath` undefined，`test:cloudflared-cli-detect` 缺外部二进制。**没有**修改 `scripts/test-baseline.json` 来掩盖这些失败。

本次改动相关的用例全部通过（§2），因此默认门禁在本机仍为红，但红点与 `origin/main` 一致。

## 8. 真实模型 / 真实桌面

### 8.1 已运行：`pnpm -s test:bot-history-context:live`

真实 `pnpm dev` → Electron → preload → Bot 页 → 本机 gateway（`http://127.0.0.1:3425/v1`，`opendesign/deepseek-v4.1-flash`），隔离 HOME，未使用真实用户数据。385s，8/8 场景通过，报告：`out/diagnostics/bot-history-context/live/report.json`。

| 场景 | 结果 | 模型调用 |
| --- | --- | --- |
| 框架学习连续性（新会话找回旧课堂笔记名与 NSH 全称） | passed | 2 |
| 库存演算连续性（17+29=46） | passed | 2 |
| 创作标题连续性（《银色门铃》） | passed | 2 |
| 配置更正（旧 6173 → 新 6284，且回答不含旧值） | passed | 2 |
| 遗忘 + provider 线上断言（紫鲸273 不出现在请求体） | passed | 4 |
| 跨 Bot 学习计划隔离（新 Bot 说不知道） | passed | 4 |
| 仅本次会话边界 ×3 措辞 | passed | 4×3 |
| 无关翻译不串历史（不含落叶画室/黄蜡笔646） | passed | 2 |

### 8.2 未测

- **1000+ 组真实模型历史**：需要 1000+ 次真实模型轮次，或在运行中的隔离 profile 里注入合成历史后重启（harness 目前没有 DB 注入钩子）。该组合未运行；对应能力由 §2/§3 的方法级 1400 组用例与 `perf:bot-history-recall` 覆盖，本次没有把它写成“已通过”。
- **Team / Work / 项目范围的实时模型召回**：live 脚本覆盖个人 Bot 与团队会话隔离；Work/项目的记忆范围由既有 `test:bot-work-review-memory` 等方法级用例覆盖，未做实时模型复核。
- **打包产物**：本 Issue 不涉及构建产物；未运行 `pack:*` / ARTIFACT 门禁（按仓库约定，非发布请求不打包）。

## 9. 已知限制

1. 相关性检索是 `LIKE` 扫描（按 scope + 200 个候选），不是倒排索引；超大数据集成本见 §6。若后续需要更快，可加索引，但不应重新引入时间窗口断崖。
2. 来源级“禁止复用”按整个会话判定（与修复前语义一致）：只要会话里出现过禁止措辞，该会话全部历史不召回；这是保守方向，未放宽。
3. `memory_search` 的上下文投影（`resolveContext`）仍是同步词法路径；它是 evidence hook，不是检索工具，本次未改。
4. 单条 200000 字符以上仍然不召回；这是确定性的单条规则，避免截断扫描漏掉秘密尾部。
5. `test:all` 在本机存在 16 个与本次改动无关的既有失败（§7），未清理 baseline。
