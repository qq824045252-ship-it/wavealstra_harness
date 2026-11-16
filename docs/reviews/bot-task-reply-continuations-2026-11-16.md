# 同任务回复连续性修正 — 2026-11-16

## 用户约定与复现

原要求是同一任务持续更新同一个助手回复框，框内切换任务 / 执行 / 核对 / 结果，原底部输入框保持。后续阶段正文和最终结果必须进入这个任务框。

检查基线为 `main@5dece5d8a52e26a4baa4e595f9d8ced2efcff6ed`。可直接用生产 `botTaskTimeline()` 复现：原助手回复关联 Work A、后台 `workFeedback` 关联 Work A、普通续写也关联 Work A，结果仍有原回复和续写两个外层 assistant 行，任务面板只收到了后台反馈。来源 Bot 的 `collaborationResult` 同样落在独立外层行。

这不是调度器重复创建任务。同一前台请求的工具回合和流式分段原本已更新同一消息 ID。缺陷位于任务内容归并及后续回复的归属投影。

原 `bot-workspace-test` 和 `bot-task-reply-sequence-test` 明确要求普通同任务续写留在外层，固定了错误契约。修改这些断言后，在旧实现上实际观察到失败；新增精确进度查询及 queued 引用回复断言也分别在修复前失败。原有测试通过不能作为满足上述用户要求的证明。

## 实现

### 任务内容归并

- `botTaskTimeline()` 将有明确单任务归属的原回复、普通续写、后台反馈和协作回传收进同一任务内容列表。使用原 DTO 和消息 ID，保留完整正文、分段、工具、附件、错误及状态。
- typed `workFeedback` / `collaborationResult` 是最明确的任务事实；其次使用唯一的 `workIds`。协作回传可通过宿主 `peerOrigin` 找到精确原助手回复，即使原消息的 Work 关联快照还未到达。
- 显式 `referenceMessageId` 可沿已加载、同 Bot / team / conversation 的引用链得到唯一任务。缺失、歧义、跨范围及循环引用不猜测归属；不会根据标题、文本、当前详情选择或“最近任务”合并。
- 分组按 Bot、团队、对话和 Work 标识隔离。最早已加载的关联回复作为容器；原回复在分页窗口外时保留临时容器，后续普通修改不会把它向后移动；加载到原回复时恢复原容器。
- 归属解析使用索引及迭代记忆化，不递归遍历长引用链。测试覆盖 4,000 层引用及逆序到达。解析结果作为视图 Map 传给阶段组件，避免引用目标是外层用户消息时二次过滤丢失正文；不把视图结果写回持久消息。
- 多任务综合文字没有唯一归属时保留一次，相关任务仍各有独立面板。用户输入与无关联普通对话保留原来的对话位置。

### 阶段与完整消息内容

- 普通同任务正文放在执行 Tab；typed 后台 / 协作证据决定核对或结果阶段。普通聊天回复的 `completed` 不代表 Work 成功，正文措辞也不推进任务生命周期。
- 来源 Bot 的协作回复仍显示来源 Bot 自己的正文与交付文件，不用下游报告文本替换它。
- 原单任务回复的正文也在任务面板内，不在面板外再复制一次。
- 内嵌前台回复保留真实停止回调、其自身请求 ID、对应用户问题、工具卡、文件入口、消息操作、指标及错误。
- 显式消息导航优先定位任务内记录并打开对应 Tab。普通进度到达不会自动切换读者 Tab、移动输入框或清空草稿。

### 精确查询和显式引用的后端投影

- 成功的精确 `work_query_status({ workId })` 和精确 summary 查询会给 assistant 回复关联实际读到的任务。普通列表、搜索、空结果或不可见对象不绑定。
- `linkWorkReply()` 只写 assistant 关联。原双向 `linkWork()` 语义保留：不能因为查看任务状态就把用户输入变成任务控制目标或新的投递来源。初次尝试复用双向关联时，现有模糊控制测试确实捕获了这项回归，最终采用 assistant 单向关联后通过。
- `referenceMessageId` 从发送回执投影到 assistant DTO，queued、completed、重放和历史读取保持一致。复用原有会话 scope 查询，通过完整回执主键及会话 / assistant 身份连接，不增加一次每消息查询，也不增加数据库迁移。
- 前台模型、调度策略及后台执行规则没有调整。

## 已执行验证

| 入口 | 实际结果与覆盖 |
| --- | --- |
| `pnpm -s typecheck` | 通过；web、node 和 scripts 检查，scripts 0 错误 |
| `pnpm -s test:bot-task-reply-presentation` | 34 个行为案例通过；普通 / 协作归属、阶段事实、引用链、歧义与长链 |
| `pnpm -s test:bot-task-reply-sequence` | 324 条回放轨迹、2,328 次中间状态检查通过；12 个固定种子，六种消息状态、交错任务、乱序 / 重复 / 过期事件、分页和重载 |
| `pnpm -s test:bot-task-reply-ui` | 12 个真实 React DOM 组件检查通过；原框身份、单输入框、草稿、Tab、引用、停止、完整分段、工具、文件、错误与协作正文 |
| `pnpm -s test:bot-workspace` | 通过；修正原有错误外层回复断言，并验证每条可见持久记录保留一次 |
| `pnpm -s test:bot-work-foreground-contract` | 通过；真实 SQLite 的精确状态查询、queued 引用、持久重读、回执身份、原投递来源、原有 89 项无效输入和控制目标行为 |
| `pnpm -s test:bot-conversation-ui` | 通过；真实 store 的并发发送、流修订、重复 / 归档 / 取消、输入引用与作用域 |
| `pnpm -s test:bot-collaboration-repository` | 通过；持久身份、原来源范围、重放、分页、回执和删除 |
| `pnpm -s test:bot-reply-reference-ui` | 通过；折叠原问题、长文本、附件、空输入、转义和来源切换 |
| `pnpm -s test:bot-task-reply-harness` | 11 项 HTTP / CDP 协议自检通过；包含精确状态查询后普通续写、与历史上下文中的另一任务隔离、live 转发不替换内容 |
| `git diff --check` | 通过 |

## 实机验证边界

实际执行了 `pnpm -s test:bot-task-reply:dev`，因没有 `DISPLAY` / `WAYLAND_DISPLAY` 在桌面预检阶段失败。此次没有完成 Electron 页面、真实显示布局、OS 输入、真实模型或发行包验收，没有运行 build / pack。

开发态驱动已新增 `02-followup`：用真实输入框对 A/B 分别执行精确进度查询，等待生产工具生成普通回复，断言外层 assistant ID 列表不增加、Work 数量保持两个、原回复和输入框节点保持。后续重载、主进程重启和 SQLite 读取均检查这些普通续写仍属于原任务。此驱动的 HTTP 路径已自检，完整 Electron 流程仍需有桌面会话的环境运行。

补充说明：没有任何任务事实、协作来源或显式引用的独立普通消息，不能仅凭“看起来相关”自动并入任务；没有新增关键词猜测或把 UI 当前选择当作归属的规则。
