# 钉钉官方应用机器人 Gateway

此适配器使用钉钉企业内部应用机器人的 Stream 模式，不是群内自定义 Webhook 机器人，也不使用用户账号自动化。无需公网 HTTP 回调地址。请在钉钉开发者后台为应用启用机器人能力并选择 Stream 接收模式，安装/发布到目标企业，并按后台要求配置可见范围和机器人权限。

## 配置

- `clientId`：应用 OAuth Client ID（企业内部应用旧称 AppKey）。
- `clientSecret`：该应用的 Client Secret（旧称 AppSecret）；作为密钥保存，不向 Agent 或日志提供。
- `corpId`：目标企业 ID。消息的机器人企业和发送者企业必须同时匹配。
- `robotCode`：机器人编码；消息必须来自这个机器人。
- `allowUsers`：明确允许使用机器人的员工 ID（`senderStaffId`）数组，不能为空。不要填写昵称。

默认通道 ID 为集成层指定的固定 ID。机器人消息只走既有 Gateway Bot 任务入口，账号作用域由企业 ID、应用 Client ID 和 Robot Code 共同确定。轮换同一应用的 Secret 不改变公开身份。群消息仅处理明确 @ 机器人的文本，单聊处理文本。外部联系人、跨企业消息和其他消息类型不会启动任务。

## 协议与安全

- 使用凭据向官方连接 API 获取一次性 ticket，再连接 API 返回的钉钉 WSS 地址。每次重连重新获取 ticket，不保存 ticket。
- Stream 使用 TLS 和 ticket 认证，不存在 HTTP 回调签名字段；不会建立免签名的 HTTP 接收入口。
- 处理系统 ping（原样返回 opaque）、disconnect、ACK 和指数退避重连。握手与 HTTP 请求有超时，120 秒没有帧会重建连接。
- 旧连接事件及旧回复闭包不能在新 socket/账号上继续使用。停用会取消在途网络请求。
- transport message ID 只用于 ACK，平台业务 `msgId` 用于重放去重；持久会话/消息去重由 Gateway 的账号作用域入口负责。适配器另有限量的 24 小时进程内去重缓存。
- 每分钟最多接收 60 个任务、发出 20 条回复，同时最多 32 个处理中回调。超限拒绝，不偷偷积压。钉钉自身配额以企业/应用当前政策为准。
- 仅向认证回调提供的 `https://oapi.dingtalk.com/robot/sendBySession` 回应，拒绝重定向、过期地址及非官方目的地。临时 URL 只保留在回复闭包，不进入任务上下文、日志或 Work 目标。
- 回复最长 20,000 UTF-8 字节。提供方拒绝、限流或回执丢失都会明确失败，不自动重试造成重复消息。
- 集成层应使用 `deferInboundUntilActivated: true`，在配置与允许名单持久化完成后调用 `activate()`。激活前只处理系统帧，不运行任务。

## 范围与验证

目前支持接收文本和在有效 sessionWebhook 内回复；不提供长周期 Work 主动通知、附件/卡片、跨企业或第三方套件能力。没有真实凭据时只能运行本地协议夹具，不能将其称为钉钉生产验收。连接成功仅代表 Stream 建连，实际企业/robot 身份还会逐条核验。

测试：`pnpm -s test:dingtalk-gateway`。测试不访问钉钉，不创建账号，不需要凭据。发布前还应使用测试企业验证后台配置、真实单聊/@群聊、服务端断线、撤销员工权限、机器人停用以及会话地址过期。

## 官方协议依据

- 钉钉开源开发者百科 Stream 协议：<https://open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol/>
- 官方 Stream 协议文档由上述页面链接，可在 <https://open.dingtalk.com/> 查阅当前应用后台对应版本。

协议中的 ticket、回调 topic、系统 ping/disconnect、msgId 与 sessionWebhook 字段均依照上述官方材料实现；不把任意回调内容当成系统指令或授权。
