# Bot 对话关联事项入口去重

## 问题与修复

用户截图来自 Bot 模式的团队对话：同一事项入口同时出现在用户“继续做”和对应 Bot 回复下面，正文不是重复消息。

`BotConversationRepository.linkWork` 为追溯与上下文保留，向同一请求的用户/助手两条持久消息写入相同 Work ID。`BotMessage` 原来直接逐条渲染 `workIds`，把一个关联显示成两个入口。

新增纯展示函数 `botMessageWorkLinks`：同一 request、conversation、Bot、team 内，用户输入已显示的 Work ID 不再在对应前台回复下重复。用户侧入口保留；回复新增 Work、不同 ID（即使标题相同）、独立后台反馈、缺少输入的部分历史均保留入口。不按文本去重，不改变消息、持久关联、后台执行或模型请求。Bot 工作空间和工作空间原始对话详情共用此规则。

## 验证

- 先添加复现断言，旧实现稳定失败（回复链接数量实际 1、期望 0），修复后通过。
- `test:bot-workspace`：同轮重复、额外/不同 ID、6 种状态、跨 request/conversation/Bot/team 隔离、后台反馈、部分历史、重新反序列化、原始记录不变。
- `test:bot-work-conversation-desktop`：Omarchy 真实 Electron 隔离窗口，生产样式与隔离设置夹具。13 类场景，1100/390 宽度；输入卡片打开/返回、刷新快照；原有 1100/760/390 宽度详情导航、滚动/焦点恢复和过期团队查询通过。已查看截图，用户侧仅一个入口，Bot 正文保留。
- `test:bot-workspace-navigation-ui`：直接断言工作空间原始对话详情的同轮卡片仅一份，外加原有导航/分页/会话隔离检查。此套件是 DOM 行为测试，不算真实布局验证。
- `test:bot-conversation-ui`、`test:bot-reply-segments`、`test:bot-workspace-navigation`、`test:work-conversation-feedback` 通过，覆盖重复帧、乱序、断线/丢回执、取消、持久反馈与归档恢复。
- `pnpm -s typecheck`、`node scripts/test-all.mjs --audit`、`git diff --check` 通过。

范围仅展示逻辑，按风险运行 7 个相关套件，未跑全量回归、未调用真实模型、未构建/打包/部署。真实 UI 使用临时 userData 与夹具，不连接生产实例。Omarchy 当前生产库仅只读诊断，未找到截图对应轮次，因此不宣称以该原始记录完成重放。

测试窗口出现 Electron 开发模式提示，以及夹具 renderer 的异步 URL 初始化告警（未归因）；卡片断言与交互均通过。没有改动依赖或扩展本次修复范围。
