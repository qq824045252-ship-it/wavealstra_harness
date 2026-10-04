# Slack 私聊进入 MyBuddy 任务

Slack 官方 MCP 保持原样，继续提供主动读取和工具调用。私聊入站另由现有 Gateway 的 Slack Socket Mode 适配器接入，调用原来的 AgentService.prompt；模型、权限、工具、Pi 会话和任务工作区仍归现有框架管理。

## 配置入口

MyBuddy → 设置 → 助理设置 → Slack 私聊：

1. 填写已有应用的 App ID、目标工作区 ID。
2. 在密码输入框自行输入已有 App Token 和有效安装 Bot 的 Bot Token。App Token 需要现有 connections:write 权限，Bot Token 用于回复私聊。
3. 填写允许使用的 Slack Member ID。该列表必填，留空不会允许所有用户。
4. 点击连接。运行程序先验证 Bot 安装工作区，再核对 Socket Mode hello 中的 App ID；任一不匹配都不接收指令。

当前非敏感目标绑定：App A0C6PPDAB1S，工作区 T0C5V7WTE8P，允许用户 U0C750DCY4Q。已有 App-Level Token 的存在不证明本机已经安全配置，也不证明 Bot 已有效安装。MCP 用户 OAuth、Client ID 或 App Home 的 BotTokenAdded 标记均不能代替运行时 Bot 验证。

此入口不会创建、复制、轮换令牌，不会安装 Slack App 或扩大权限，不会修改其他 MCP。若 Bot 授权不存在，应先核对具体最小授权需求，不能直接接受包含广泛 User Scopes 的整包授权。

令牌由 Electron safeStorage 使用系统加密后保存到已有 gateway_channels 配置；没有可用系统加密时拒绝保存。配置回读只提供掩码，不能返回令牌或密文；断开连接保留安全配置，便于明确重连。

## 事件和任务行为

- 接收指定 App、工作区、允许用户的 message/im 私聊文本；另接收 owner U0C750DCY4Q 的 app_mention 频道提及。忽略 Bot、自循环、修改/删除等子类型、普通频道消息和其他事件。
- 不设频道白名单，但应用需已经加入目标频道。只处理包含本 Bot User ID 的明确提及，并剥离该提及；裸 @ 不创建任务。其他用户提及不触发，即使其被加入私聊允许列表。
- 频道提及使用 app_mentions:read + app_mention；owner 明确提及时，Bot 用 conversations.history 按需读取同频道、提及之前最多 15 条消息，并作为非可信资料交给原生 Agent。公开频道需要 channels:history，私有频道需要 groups:history，任何新增权限必须由用户确认后另行授权。读取失败时明确报告，不能用无关内容代替频道历史。
- 先持久化事件记录，再确认 envelope_id；不等待模型或工具执行才 ACK。落盘失败则不确认，也不执行。
- 工作区、App、私聊频道、讨论串根时间共同映射到稳定的 gw-slack 任务。同一讨论串串行调用原生任务；不同讨论串独立。回复使用原 channel 和 thread_ts。
- 监听指定 assistantMessageId 的原生完成事件。AgentPromptResult.queued 仅代表入队，不能当成最终回复；模型/任务拒绝会明确反馈。
- 已接收事件和回复进度保存在 credential-free 的 gateway/slack-deliveries.json。保留 30 天已完成回执防止重投递重复执行；待处理和待发送记录不按此窗口淘汰。
- 断线自动重连。重启恢复尚未开始的事件及待发送回复。执行中异常退出的任务保留原生会话与任务身份，回复中断说明，等待用户在同一讨论串继续；不会自动重放可能已有副作用的操作。
- 回复失败重试发送，不重新运行任务；每段回复使用稳定 client_msg_id。网络不确定性下不能宣称跨系统严格 exactly-once。
- 不增加新的模型循环或审批层，不强制切换权限模式。

## 本地验证

使用现有依赖：

    pnpm exec esbuild scripts/slack-gateway-test.ts --bundle --platform=node --format=esm --packages=external --alias:electron=./scripts/gateway-electron-stub.ts --outfile=out/tests/slack-gateway-test.mjs
    node scripts/test-guard.mjs out/tests/slack-gateway-test.mjs
    pnpm typecheck

slack-gateway-test 使用本地 Socket/API 替身测试入站、配置提交、恢复机制和生产 Gateway 的原生任务接口，并用真实 Pi agent loop、write/read 工具在临时目录完成两轮任务。模型响应为本地脚本提供，不使用用户凭据或真实 Slack。测试中的加密 codec 为明确的测试替身；生产使用系统加密。

现有 gateway-test 也需回归。当前旧的 CJS 打包命令与 Pi 1.0 的 ESM-only 导出冲突；本次以 ESM、packages=external、createRequire 测试引导运行相同断言，未改变生产运行时。不能把旧启动器的格式错误当成 Gateway 业务断言失败。

真实端到端验收还需要本地安全输入已有令牌、有效 Bot 安装验证、加载新版本，并从允许用户发送一条真实私聊及同线程续问。存在活动任务时不能通过重启直接中断它们。

频道 @ 验收：完成后台最小授权和订阅后，在应用已加入的频道由 owner 发“@MyBuddy DM 执行一项任务”，确认只出现一个任务及原线程回复；同线程再次明确 @ 继续，换频道或换根线程应隔离。不要把普通频道聊天作为触发入口。
