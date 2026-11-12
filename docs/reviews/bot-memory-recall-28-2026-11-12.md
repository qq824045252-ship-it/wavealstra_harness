# Bot 历史召回与记忆过滤验收报告（issue #28）

> 本文保留首次实施与 e35fafd6 并行修复的历史证据。随后发现的 Cookie 多值/编码、首批提前停止和同毫秒顺序缺口，以及新的独立门禁结果，见 [后续复核](bot-memory-recall-28-followup-2026-11-12.md)。

| 项目 | 值 |
| --- | --- |
| 关联 issue | [#28 修复长历史召回、技术文本误过滤与 hybrid 入口](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/28) |
| 规格 | [Bot 历史召回与记忆过滤](../bot-memory-recall.md) |
| Issue 核验基线 | `14a650406359b5c4bd4cc358b2a7623364242298`（2026-11-11） |
| 本次工作基线 | `origin/main` `94defbf8`（2026-11-12 拉取） |
| 首次代码提交 | `ee919b7f`（首个文档提交 `414bf2bf`） |
| 复审修复提交 | 本报告所在提交（复审基于 `a31dedc2` 阅读代码，见 §1.1） |
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

## 1.1 独立复审（2026-11-12）修复

复审在 `a31dedc2` 上确认了 2 个 P1、3 个 P2 与一个证据截断盲点。逐项修复并配套失败用例：

| 复审问题 | 修复 | 失败用例 → 现在 |
| --- | --- | --- |
| P1 Cookie 解析漏掉中文前缀/换行/curl/JSON，秘密会进入新会话历史 | 抽出 `src/main/memory/MemoryTextSafety.ts`；Cookie 分支不再依赖外层词边界，用 `(?:^|[^\w])` + 引号/键值解析覆盖行首、换行、中文前缀、curl、JSON，值必须是 ≥8 位 token | 复审的 5 条输入全部 `ineligible`；即使强行写入 L0 指针，最终 `botHistoryContext` 输出仍不含该 sid |
| P1 peer 预取命中在 scope 撤销/过期后仍注入 | `activeFact(botId, id)` 用接收 Bot 的精确 scope 重新授权：status、`canAccess` 的 scope 链、validFrom/validUntil | 多 scope 记录 detach target 后 target 不可见、另一 scope 仍可见；`validUntil` 已过、`validFrom` 未到都撤销 |
| P2 旧更正能排除更新的事实 | 更正按词记录“最新更正时间”；旧更正只排除比它旧的陈述，更新的陈述不受影响；较旧更正被共享查询词的更新更正取代；最新更正保留一个证据位 | `LATEST_9090` 在旧 8080 更正之后仍被选中；3 条旧更正 + 1 条最新更正时最新一条仍占位 |
| P2 内核 L1 仍拒绝 cookie/完整 SHA（入口放行、内核全拒） | `extractCandidates` 与 `buildRecord` 改用同一个 `hasSensitiveMemoryContent` | direct `memory.create` 保存 SHA/cookie 文本成功；提炼保留带 SHA 的候选；hybrid 召回能查到；password/sk_live 仍被拒 |
| P2 200 条候选截断后过滤，合法旧记录被饿死 | 与排序一致的完全序（score, created_at, ordinal）分批（200/300）读取，直到选满 3 条；达到工作上限单独输出，不冒充“无历史” | 200 条 `NSH2` 子串不挡住精确 `NSH`；200 条禁止来源 follow-up 不挡住 `MapleTopic`；1250 条假阳性返回“工作上限”而不是空串 |
| 盲点：长答案只取开头 1500 字符，命中在中后段时引文没有证据 | 按命中位置取窗口（`excerpt`） | 300×`preface` 后接 `port 9090` 的答案，引文以 `…` 开头且包含 9090 |
| 盲点：hybrid await 期间关闭记忆仍返回结果 | `search`/`recall` 在 await 之后再次检查 `enabled()` | 由实现保证（同步分支无法在测试中稳定注入延迟） |

复审提到的“不该把记录还 active 当成本 Bot 仍可读”已落到 `activeFact` 的三重校验；`searchHybrid` 自身的异步后校验仍保留，两者分别保护缓存后的引用和搜索返回本身。

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
11. **复审新增**：中文前缀/换行/curl/JSON 形式的 `Cookie: <值>` 5 条输入全部拒收；强行写入 L0 指针后最终历史输出仍不含该值。
12. **复审新增**：旧更正不排除更新的事实（`LATEST_9090`）；3 条旧更正挤不掉最新更正；200 条 `NSH2` 子串不挡住精确 `NSH`；200 条禁止来源 follow-up 不挡住合法 `MapleTopic`；1250 条假阳性返回“工作上限”。
13. **复审新增**：长答案引文以 `…` 开头并包含命中段的 `9090`。
14. **复审新增**（`test:bot-memory`）：内核 `memory.create` 与提炼接受 Git SHA/cookie 文本并可由 hybrid 召回；真实 `password`/`sk_live` 仍拒；多 scope 记录 detach target 后 target 的 `activeFact` 撤销、另一 scope 不受影响；`validUntil` 已过、`validFrom` 未到都不注入。

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
| 200 条更新的 `NSH2` 子串假阳性 + 1 条精确 `NSH` | 精确命中被截断饿死 | 精确命中召回 | `EXACT_ALLOWED_REFERENCE` 段 |
| 禁止来源的 200 条 `MapleTopic` follow-up + 1 条合法来源 | 合法来源被挤到截断之后 | 合法来源召回，禁止来源仍排除 | `MAPLE_ALLOWED_REFERENCE` 段 |
| 1250 条假阳性、没有合法证据 | 返回空串（冒充“无历史”） | 返回“达到工作上限，不能当作没有历史” | `CapTopic` 段 |
| 旧更正 8080 在前、新事实 9090 在后 | 只返回旧更正 | 返回 `LATEST_9090` | `LATEST_9090` 段 |
| 3 条旧更正（命中 4 词）+ 最新更正（命中 2 词） | 3 条旧更正占满 | 最新更正占一个证据位 | `LATEST_CORRECTION_9090` 段 |

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
| `Cookie: sid=…` / `请求头：Cookie: …` / 换行 / `curl -H "Cookie: …"` / `{"Cookie": "…"}` | JSON 与多数前缀漏过 | 全部拒收，且最终历史输出不含该值 | `test:bot-history-context` 复审段 |

## 5. 作用域隔离

| 维度 | 结果 | 证据 |
| --- | --- | --- |
| 个人 Bot 之间 | 不互读 | `recall(..., {bot:"other"})` 不含 `BuriedTopic`；既有 `NSH`/`other` 用例 |
| 团队 ↔ 个人 | 团队查询不含个人历史；同团队跨 Bot 可读 | `team-a`/`team-long` 用例 |
| 其他用户 / 其他 bot 所有者的来源 | 不召回 | `foreign-user` 用例 |
| 当前会话 | 不作为历史证据 | `CurrentOnly` 用例 |
| 仅本次会话 | 不跨会话 | `LocalScopeTopic` 等 |
| 公共共享 | 不因“放宽召回”把个人历史提升为 global；L1 公共范围仍由 `remember` 明确措辞控制 | `test:bot-memory` 公共蓝莓用例 |
| Work | Work 来源捕获与裁决记忆不读个人历史 | `test:work-memory-capture`、`test:bot-work-review-memory` |
| 项目 | 项目记忆作用域保持独立 | `test:project-memory-extraction`、`test:project-memory-agent` |
| peer 多 scope 撤销 | detach 目标 scope 后该 Bot 不可读，另一绑定 scope 仍可读 | `test:bot-memory` 复审段 |
| 遗忘后重启 / 迟到提炼 | 遗忘水位、重启、迟到结果都不复活 | `test:bot-memory-forget-watermark`、`test:memory-lifecycle`、`test:bot-memory-runtime`、`test:memory-projection-deletion` |

## 6. 性能（合成数据，方法级）

命令：`pnpm -s perf:bot-history-recall`（30000 组 / 200 个来源会话，时间戳跨度约 20 天）。

| 查询 | 中位 | p95 |
| --- | --- | --- |
| 相关性查询（命中被埋藏的早期方案） | 92.5ms | 118.6ms |
| 高频噪声查询（普通词命中很多） | 164.9ms | 181.7ms |
| recent 模式（24h 窗口） | 37.4ms | 52.1ms |
| 无命中查询 | 105.9ms | 155.1ms |

同一数据集上用**旧实现**（`git show d83532da:src/main/agent/work/BotHistoryContext.ts` 导入到一次性对照脚本）测得中位 105.6ms、p95 147.5ms，且**找不到**被埋藏的早期方案（返回空串）；新实现找到并返回 489 字符。旧实现的耗时主要来自“全表排序取最近 300 组”，因此新实现不是性能回退。该对照脚本是一次性的，未提交；提交的是上文 `perf:bot-history-recall`。

真实存储规模参考：本机 `~/.mybuddy/app.db` 当前 `bot_messages=96`、`bot_send_receipts=26`，该规模下召回成本可忽略。3 万组是合成压力数据，不代表日常开销。

## 7. 全量门禁与既有失败

`pnpm -s test:all`（headless，5.5 分钟，rebase 到 `origin/main` 后的最终运行）：**通过 468 / 失败 16 / baseline 已知失败 0**，失败列表：

```
test:bot-attachments            test:bot-delegation-fidelity     test:bot-reminders
test:bot-report-images          test:bot-work-automatic-recovery test:cloudflared-cli-detect
test:durable-artifact-registration test:durable-task-projection  test:gadget-blueprint
test:gadget-runtime-lifecycle   test:gateway-media               test:pinned-public-proxy
test:session-history-recovery   test:slack-media                 test:task-isolation-p2
test:work-watch-supervision
```

这些不是本 Issue 引入的：在同一 worktree、把本次改动 `git stash` 后对 `origin/main` 逐个运行同一批用例，失败集合**完全相同**。代表性原因：`test:durable-artifact-registration` 在本机 `EPERM: symlink`，`test:bot-reminders` 报 `openPath` undefined，`test:cloudflared-cli-detect` 缺外部二进制。**没有**修改 `scripts/test-baseline.json` 来掩盖这些失败。

复审修复过程中另有两个可归因项，已处理：

- `test:architecture-graph`：行数棘轮发现 `MemoryService.ts` 比基线 +209 行（上游增长，加上本次 +15 越过 +200 阈值）。把 peer 可见性复核移到 `BotConversationMemory.activeFact` 复用公开的 `canAccess`，`MemoryService` 只保留一行 `isSensitive` 委托，棘轮恢复 PASS。
- `test:local-workflow`：并行池负载下的 teardown 竞态（`The database connection is not open`），单独连跑 3 次全部通过，非回归。

本次改动相关的用例全部通过（§2），默认门禁在本机仍为红，但红点与 `origin/main` 一致。

## 8. 真实模型 / 真实桌面

### 8.1 已运行：`pnpm -s test:bot-history-context:live`

真实 `pnpm dev` → Electron → preload → Bot 页 → 本机 gateway（`http://127.0.0.1:3425/v1`，`opendesign/deepseek-v4.1-flash`），隔离 HOME，未使用真实用户数据。**547s，9/9 场景通过**，报告：`out/diagnostics/bot-history-context/live/report.json`。

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
| **1100 组合成历史（12 个会话、未提炼 L1、`extraction_state=skipped`）**，旧方案 `hist-u0` 在最近窗口之外 | passed | 3 |

### 8.2 未测

- ~~1000+ 组真实模型历史~~：已补齐。live 场景直接向隔离 profile 的 DB 写入 1100 组已完成问答（12 个交错会话，`memory_turns` 标记 `skipped`，不进入 L1），再由真实模型回合召回：回答复述了 `hist-u0` 的旧方案，provider 请求体包含 `B-8412`（只在被埋藏的原答案里），另一项目 `松岛项目907` 既不进回答也不进请求体。1110 条中只有 1 条相关，其余为无关噪声，时间跨越约 18 小时。
- **Team / Work / 项目范围的实时模型召回**：live 脚本覆盖个人 Bot 与团队会话隔离；Work/项目的记忆范围由既有 `test:bot-work-review-memory` 等方法级用例覆盖，未做实时模型复核。
- **打包产物**：本 Issue 不涉及构建产物；未运行 `pack:*` / ARTIFACT 门禁（按仓库约定，非发布请求不打包）。

## 9. 已知限制

1. 相关性检索是 `LIKE` 扫描（按 scope 分批取 200 个候选），不是倒排索引；超大数据集成本见 §6。达到工作上限（1200/900）会单独说明，不冒充“无历史”。若后续需要更快，可加索引，但不应重新引入时间窗口断崖。
2. 来源级“禁止复用”按整个会话判定（与修复前语义一致）：只要会话里出现过禁止措辞，该会话全部历史不召回；这是保守方向，未放宽。
3. 更正关系按“查询词 + 时间”近似，没有实体/主题模型：共享同一个查询词的更新更正会取代较旧陈述，也可能压掉共享通用词的老事实。报告与规格均已标注，未声称达到实体级语义。
4. `memory_search` 的上下文投影（`resolveContext`）仍是同步词法路径；它是 evidence hook，不是检索工具，本次未改。
5. 单条 200000 字符以上仍然不召回；这是确定性的单条规则，避免截断扫描漏掉秘密尾部。
6. `test:all` 在本机存在 16 个与本次改动无关的既有失败（§7），未清理 baseline。
