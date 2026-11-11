# 历史提问只显示一条：实时窗口不是完整会话

日期：2026-11-11。现象：长时间、多轮续跑的任务里，任务头「历史提问」只列出最近一条用户提问。

## 只读证据

- 任务 `帮我搜索github nsh项目`（durable store `~/.mybuddy/durable/514f2dd8…`）的用户 entry 共 4 条：
  10:25:44「帮我搜索github nsh项目」、10:35:29「与rust有关的」、11:12:06「主要看longbridge/nsh」、13:19:49「tsx架构帮我查下是干嘛的」。
- entry id 范围 9–318（310 条 entry）；`DurableHistoryProjection` 的实时窗口上限是 200 条
  （`DURABLE_HISTORY_ENTRY_LIMIT`），更早的 entry 只能通过「上拉到顶 / 更早历史」分页读取。
- 旧 `HistoryPopup` 只遍历 `task.messages`（实时窗口）里的 user 行，因此只剩最近一条提问；
  早期提问并没有丢，只是在窗口外、弹窗没有去读。

## 修复

- 新 IPC `agent:listTaskUserQuestions`：durable 会话由 `DurableBotRuntime.loadUserQuestions()`
  只读扫描完整已提交 entry 流（上限 2 万条），按与投影相同的 `durable-<entryId>` id 和
  `displayText` 返回全部提问；无绑定/旧会话退回 `loadTaskHistory` 的 user 消息。只读路径
  复用 `readDurableUserQuestions`，不提升成 writer。
- 「历史提问」弹窗优先用完整索引；索引未返回时退回实时窗口。合并规则抽到
  `src/renderer/src/lib/historyQuestions.ts`（索引升序 + 窗口倒序 + 按 id 去重，整体最新在上）。
- 点击窗口外的旧提问：先按 `loadTaskHistory` 向前分页加载历史块（最多 40 页，沿用 epoch /
  游标 / seed 校验与 `mergeHistoryWindow`），加载到目标消息后再滚动定位；已在视图内则直接跳。

## 验证

- 真实数据（拷贝 nsh durable store 到 workspace，用真实 ModelRuntime 只读打开）：
  `loadUserQuestions()` 返回 4 条，id `durable-7/88/164/261`，与投影消息 id 一致。
- `test:durable-history-block` 扩展为 240 条用户提问 / 100 个历史块：完整索引返回 240 条，
  实时窗口只含 66 条用户消息，索引 id 与投影消息 id 完全一致。
- `test:history-questions`：窗口退回、完整索引倒序、id 去重、空索引/空窗口。
- `test:history-prepend-scroll`、`test:app-permission-ui-removal`、`typecheck`：通过。
- 未验证：应用重启后的端到端点击跳转视觉（需要真实 dev 会话）；`loadUserQuestions` 对超过
  2 万条 entry 的超长任务只索引最近 2 万条（有界扫描，避免弹窗打开时全量遍历）。
