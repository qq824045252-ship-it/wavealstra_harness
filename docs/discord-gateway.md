# Discord 官方 Bot Gateway

使用 Discord Developer Portal 中的官方 Bot，不支持个人账号 token 或 self-bot。配置 Application ID、Bot Token、允许的用户 ID，以及允许的服务器 ID。私聊默认关闭，需明确勾选；启用私聊也不会绕过用户白名单。服务器消息须来自允许的服务器、允许的用户，且明确 @Bot；机器人的消息和 webhook 消息不触发任务。

仅请求 GUILDS、GUILD_MESSAGES，以及启用私聊时的 DIRECT_MESSAGES intents，不请求 MESSAGE_CONTENT 特权；被 @ 的消息及私聊使用 Discord 的内容访问例外。将 Bot 安装到目标服务器，赋予其查看目标频道、发送消息所需的权限。本实现不代为安装 Bot 或修改服务器权限。

官方 Gateway v10 长连接不需要公网回调；应用及机器人身份通过官方 REST API 验证，READY 再核验连接身份。连接正常后才激活入站处理。凭据使用操作系统 safeStorage 加密后保存，界面回填只有占位符。系统加密不可用时拒绝连接保存，不回退明文。

任务沿用现有 Gateway 入口，会话身份绑定 Application ID、已验证的 Bot 用户 ID 及频道。当前仅支持文本入站和原频道回复，暂不支持主动 Work 通知、附件或历史频道消息读取。出站受 Discord 的频道权限、内容和限流限制；连接中断、身份更换、回执不确定时可能无法回复。

`pnpm -s test:discord-gateway` 使用 mock HTTP/WebSocket，不需要真实凭据。上线前仍需在测试应用验证 DM、服务器 @ 提及、撤销权限、断线续传及真实限流。没有真实账号验收时，不能将单元测试通过称为生产连接验证通过。

官方文档：
- https://docs.discord.com/developers/events/gateway
- https://docs.discord.com/developers/events/gateway-events
- https://docs.discord.com/developers/resources/message#create-message
