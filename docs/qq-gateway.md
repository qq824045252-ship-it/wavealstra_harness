# QQ 官方机器人扫码 / WebSocket Gateway

本实现参考 NousResearch/hermes-agent 的 QQ gateway/onboarding 协议，保留应用既有 Gateway 执行链路，没有嵌入 Hermes/OpenClaw agent runtime，也没有新增 Bot 隔离层。只使用腾讯官方 QQ 机器人账号，不是个人 QQ 自动登录。

## 接入与授权

用户需在专门的扫码 UI 明确批准：绑定机器人、由腾讯返回机器人凭据、在本机加密保存并保持后续连接。未批准不得创建绑定任务。`QQBotQrLogin.start(true)` 的 true 必须来自该 UI 的明确授权，不能由默认配置补上。

主进程调用腾讯 `q.qq.com/lite/create_bind_task`，用进程内随机 AES-256-GCM 密钥接收加密 AppSecret；轮询 `poll_bind_result`，认证解密成功且有扫码者 user_openid 才进入授权回调。没有 user_openid 时安全拒绝，不建立全开放账号。临时二维码 URL 可传给 renderer，AppSecret、AES 密钥和 token 不可传给 renderer 或日志。

- `QQBotQrLogin({onAuthorized(credentials, assertCurrent, signal)})` 提供 start / getState / cancel。
- 回调由集成层负责系统加密保存、连接及激活。每个异步步骤后检查 assertCurrent 和 signal，取消或被新尝试替代时不得保存/激活旧账号。
- `QQChannelAdapter(..., {deferInboundUntilActivated:true})` 的 connect 等待 READY；完成安全保存与发送者策略配置后调用 activate。激活前不执行入站任务。
- 仅保存用户授权的机器人凭据。拒绝无安全加密后端的明文或弱加密保存；这由主进程集成层的凭据存储实现。
- 初始白名单使用扫码返回的 user_openid。群 member_openid 与 C2C user_openid 不同，不能假定通用，群聊需明确允许对应成员。

扫码总轮询期限为 10 分钟，二维码过期最多刷新 3 次。cancel 会中止当前网络请求和等待；取消旧 sessionId 不影响新会话。二维码链接不伪称 source=hermes/openclaw。即便路径带 openclaw，也是腾讯官方的绑定页路径。

## 长连接和消息限制

只创建出站 WSS 连接，不注册 QQ HTTP 回调，因而不需要公网端口、反向代理或签名挑战。鉴权从固定腾讯 HTTPS API 获取 token 和 gateway URL；拒绝重定向和非 QQ 的 WSS 网关地址。HELLO/IDENTIFY/READY、心跳 ACK、重连和 RESUME 在 adapter 内处理。凭据及 session 仅在主进程使用，不继承 OpenClaw 明文凭据备份。

仅订阅 C2C/群 @ 消息（intent 1<<25），只处理非机器人发送者的 C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE 纯文本。其余事件不进入 agent。无图库/媒体下载、群普通消息监听、频道或第三方协议兼容。

保留 AppID 连接身份、群/C2C 会话前缀、发送者白名单及入站去重。重连保留相同账号的去重记录，显式换号会让旧回复闭包失效。这里不声称 exactly-once：进程内 replay ledger 不跨重启持久化，重启后的去重还需既有应用消息任务身份保障。

被动回复必须包含原消息 msg_id 和单调 msg_seq。C2C 自原消息时间起 60 分钟，群聊 5 分钟，每条消息最多 5 次；并发发送先占用额度，失败/不确定回执不自动重试。超过 4000 字符不发送，避免静默截断或占用不可预期次数。过期、超限不降级为主动消息，不提供 Work 主动通知。平台权限、消息 URL 白名单、审核与额度仍可能拒绝请求。

## 来源、许可及验收

协议参考版本：NousResearch/hermes-agent `72d4433130823f506081cc1189a923b5aa67dbf0`。

- https://github.com/NousResearch/hermes-agent/blob/72d4433130823f506081cc1189a923b5aa67dbf0/plugins/platforms/qqbot/onboard.py
- https://github.com/NousResearch/hermes-agent/blob/72d4433130823f506081cc1189a923b5aa67dbf0/plugins/platforms/qqbot/crypto.py
- https://github.com/NousResearch/hermes-agent/blob/72d4433130823f506081cc1189a923b5aa67dbf0/plugins/platforms/qqbot/adapter.py
- https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md

保留 Hermes 的 MIT 版权许可于 `docs/third-party/hermes-agent-LICENSE.txt`。未引入 UNLICENSED 的 qqbot-connector，未增加 npm 依赖；使用现有宿主 native WebSocket/fetch 和 node:crypto。老 bot-docs 的 WebSocket 下线描述与当前 Hermes/腾讯插件支持情况不一致，真实账号的线上可用性仍须实际验收。

mock 测试覆盖明确授权前无请求、AES认证解密/坏tag/缺失扫码身份、取消/期限/回调取消、连接READY/RESUME、心跳、旧socket失效、非QQ gateway拒绝、账号和白名单、去重及回复限制。没有真实凭据、没有生成真实二维码或扫码授权；未声称真实平台端到端验收通过。
