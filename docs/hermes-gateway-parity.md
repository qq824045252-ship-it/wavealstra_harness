# Hermes Gateway 能力差距审计

## 固定基线与口径

- Hermes：`72d4433130823f506081cc1189a923b5aa67dbf0`。引用 `H:` 均指该提交里的路径，通过 `git -C ../hermes-reference show <commit>:<path>` 读取，不以稀疏工作区是否 checkout 判断文件存在。
- 本项目：媒体增量已合入 `de5a7496333f1f359991288582b504006d568c1c`；2026-11-08 在该基线上继续补齐 Gateway 缓存、凭据与收发箱。引用 `L:` 均相对此仓库当前源码。新一轮修复与实际门禁见 [Gateway 加固复核](reviews/gateway-hardening-2026-11-08.md)。
- `implemented`：所述具体能力已有实现，不代表整个渠道达到 Hermes 对等。`partial`：仅有子集或仅运行期有效。`missing`：当前整合代码没有对应端到端实现。Hermes 中无直接对应或不能证明的能力标为“不适用/未确认”，不虚构差距。
- 这是源码能力矩阵，不是真实账号联调、长时间断网测试或发行包验收。文末保留媒体增量的历史验证记录；后续加固的实际执行结果以新复核报告为准，不把夹具通过推广为真实平台验收。

## 共同边界

`L:src/main/gateway/GatewayPlatformRegistry.ts` 登记九种渠道。Feishu、Telegram、Slack、DingTalk、Discord、QQ、Weixin 声明 `media: "inbound"`；WeCom 根据模式动态声明，smart 为 `"inbound"`，callback 为 `false`，WeChat MP 仍为 `false`。所有渠道 `editStreaming`、`interactiveApproval` 仍为 `false`。Slack 使用原有独立 journal；其余渠道由默认启用的 registry SQLite 收发箱提供已接受输入的 `durableInbound`，不代表适配器本身具有历史补扫或持久化平台游标。

`L:src/main/gateway/channels.ts` 的 `GatewayInboundMessage.attachments` 已由 `L:src/main/gateway/GatewayRouter.ts` 两条原生执行路径转交 Agent。`reply(text)` 仍仅文本，没有出站文件、编辑、按钮或审批回调契约。**已实现受限入站附件，不是双向媒体全量对等**；音视频作为附件输入不意味着已完成 STT、转码或模型音视频理解。
- **implemented**：统一来源/账号摘要校验、会话 FIFO、跨会话并发、64/1024 队列上限、连接代次检查与过期回复拒绝。证据：`L:src/main/gateway/GatewayPlatformRegistry.ts` 的 `register`、`normalize`。
- **partial**：统一传输事件，`GatewayService` 保留具体渠道构造、配置、授权与激活；路由、限流、HTTP 生命周期已经拆分。不是 Hermes `H:gateway/platforms/base.py`、`event.py` 及各 `plugins/platforms/*/plugin.yaml` 的完整插件注册体系。
- **implemented（入站子集）**：受限媒体下载、缓存与 Agent 附件传递。**implemented（已接受输入的恢复）**：统一 SQLite Inbox/Outbox、原生收据复用和回复结果分类。输入落盘之前的下载/平台离线事件不在该保证内；不确定的发送保留 `unknown`，不自动重发。**missing**：通用出站媒体、编辑/流式展示、交互审批与全平台离线历史补扫。
- **implemented（局部）**：Feishu、WeCom callback、WeChat MP、Telegram、Slack 的 Work 通知。WeCom smart 模式和 DingTalk、Discord、QQ、Weixin 当前没有自主 Work sender。证据：registry 及 `L:src/main/gateway/work-outbound.ts`、`GatewayWorkTargets.ts`。

## 九渠道逐项矩阵

媒体列分别记录“渠道附件到 Agent”和“Agent 文件到渠道”；前者已补齐的子集不代表后者完成，也不把文字里的 URL 当附件。交互项同时区分输入提示/流式编辑与可点击审批。

| 渠道 | 媒体 | 线程/回复 | 交互 | 恢复 |
| --- | --- | --- | --- | --- |
| Feishu | **implemented（入站子集）/partial（整体）**：image/file/audio/video/media 与富文本 post 资源下载进 Agent；**missing**：出站媒体与完整媒体处理 | **implemented（回复目标）/partial（会话）**：保留 message_id/thread_id，reply_in_thread 与 Work 目标；仍按 chat 原生会话，未新增 Hermes 主题会话体系 | **missing**：Hermes 卡片审批、选择卡、编辑与反应未移植 | **implemented（接受后恢复）/partial（整体）**：SDK 重连、激活门、统一 Inbox/Outbox；保存原 chat/message/thread 回复路由，未实现任意离线补扫 |
| WeCom | **implemented（smart 入站子集）/partial（整体）**：图片、文件、mixed/appmsg 与引用附件，支持可选 AES 解密；callback 仍 **missing**；出站媒体/STT **missing** | **partial**：smart 保留 req_id 被动回复，引用图片/文件可进入附件；引用文本上下文仍未完整移植；不宣称原生线程 | **missing**：Hermes native stream 累积更新/typing 未移植；未确认 Hermes 原生按钮审批，不据此立项 | **partial**：已接受输入进入统一收发箱，callback 可恢复原用户/群回复；smart 的旧 req_id 不能假设跨连接有效，重启后回复可进入 blocked |
| WeChat MP（wechat） | **missing（项目能力）**：文本 callback/reply，无 Agent 媒体通路 | **implemented（限私聊地址）**：openid 回复；原生线程不适用 | **missing（项目能力）**：无通用交互通路；不声称 Hermes 有同款 MP 实现 | **implemented（接受后恢复）/partial（整体）**：鉴权后先落盘再 ACK，原 openid 路由恢复；仍受平台客服回复窗口限制 |
| Telegram | **implemented（入站子集）/partial（整体）**：photo/document/voice/audio/video 通过 getFile 安全下载；**missing**：video_note/animation 入站、出站媒体与 STT | **partial**：保留 reply_to_message_id、message_thread_id、direct_messages_topic_id 回复目标；原生会话仍按 chat，未移植 Hermes 主题会话/创建/重命名流程 | **missing**：Hermes callback query、审批按钮、选择器、编辑/typing 未移植 | **implemented（接受后恢复）/partial（整体）**：接受后推进内存 offset，统一收发箱复用原生收据和回复路由；429 有限重试，部分发送不整条重发；仍无持久化游标及 Hermes 完整停滞检测/重建 |
| Slack | **implemented（入站子集）/partial（整体）**：journal 文件ID，经 files.info 鉴权下载到 Agent并保留缓存；**missing**：上传、多图出站、音视频处理 | **implemented（核心）**：native task/thread 会话与 thread_ts 回复；**partial（全量）**：现有 channel history 不等于 Hermes thread context hydrate/assistant lifecycle | **missing**：Hermes interactive approval/slash action、编辑/draft/thread status 未移植 | **implemented（核心）**：先 journal 落盘再 ACK，持久化文件标识/附件，恢复时验证缓存；缺失/篡改不静默省略附件；恢复 pending/running/reply_pending 与回复分片，不推广成所有渠道恢复 |
| DingTalk | **implemented（受限入站）/partial（整体）**：downloadCode 下载图片/文件/音视频及 richText 附件；可使用平台 recognition 文本，域名严格受限，实际 CDN 可能被拒；**missing**：出站媒体、自行 STT | **partial**：sessionWebhook 被动回复；未提供线程会话契约；不推测 Hermes 原生线程能力 | **missing**：Hermes AI Card 流式创建/编辑未移植；Hermes send_typing 本身 no-op，不记作缺失 typing | **implemented（接受后恢复）/partial（整体）**：持久接受后 ACK；sessionWebhook 加密、绑定原身份且按过期时间验证；去重满额淘汰最旧记录；平台能力过期后回复不能继续 |
| Discord | **implemented（入站子集）/partial（整体）**：平台 attachments 经限定 CDN/路径下载，支持纯附件；**missing**：出站媒体、语音频道、STT/转码 | **partial**：channel_id 与 message_reference，replyToMode off/first/all，接收对机器人回复；没有 Hermes thread 元数据、论坛发帖/命名/主动创建 | **missing**：Hermes component/slash/审批视图、编辑和语音交互未移植 | **implemented（接受后恢复）/partial（整体）**：统一收发箱、原 channel/message 路由与稳定 nonce；仍有 socket resume；**missing**：独立持久化 sequence / recovery cursor 与离线历史补扫 |
| QQ bot（qq） | **implemented（入站子集）/partial（整体）**：C2C/群 attachment 下载进 Agent，限定 QQ CDN；**missing**：出站图/音/视频/文件与 Hermes 语音 STT/转码 | **partial**：C2C/群路由、被动 msg_id 回复；缺少 Hermes guild/DM 事件处理，不等于通用 thread session | **missing**：Hermes keyboard、interaction callback、审批请求未移植 | **implemented（接受后恢复）/partial（整体）**：统一收发箱、绑定原 group/C2C 路由、稳定 msg_seq；被动回复仍受有效期限制；没有平台离线补扫 |
| Weixin iLink（weixin） | **implemented（入站子集）/partial（整体）**：图片/语音/文件/视频及引用媒体，CDN 下载解密进 Agent；可使用平台现成语音文字，不是自行 STT；**missing**：接入出站媒体 | **implemented（私聊）**：context_token 回复；原生 thread 不适用，Hermes standalone 注明 iLink 无 thread | **missing**：Hermes typing ticket / start / stop 未移植；Hermes 本身不支持 message edit，不列为漏移植编辑 | **implemented（接受后恢复）/partial（整体）**：统一收发箱、加密且绑定原身份的临时回复能力；context 缓存有容量/TTL，落盘失败不推进 cursor；**missing**：持久化 sync_buf、通用 ContextTokenStore 与离线补扫 |

## 可追溯证据（方法名优先，避免行号随修改失效）

### Feishu

- L：`src/main/gateway/channels.ts` 的 `FeishuChannelAdapter.parseContent/handleMessageEvent`、`sendText`；`src/main/gateway/FeishuLongConnection.ts` 的 `retry/start/stop`。
- H：`plugins/platforms/feishu/adapter.py` 的 `_process_inbound_message`（native thread_id）、`_send_raw_message` 相关 `reply_in_thread` 路由、`_download_feishu_message_resources`、`send_voice/send_document/send_video/send_image_file`、`_send_exec_approval_prompt`、`edit_message`；`plugins/platforms/feishu/adapter_choice_cards.py`。

### WeCom / WeChat MP

- L：`src/main/gateway/WecomSmartRobot.ts` 的 `mediaSources/decryptMedia/messageText/receive` 周边 callback/req_id/seen 队列与回复；`src/main/gateway/channels.ts` 的 `WecomChannelAdapter`、`WechatMpChannelAdapter`。
- H：`plugins/platforms/wecom/adapter.py` 的 `_on_message` 调用 `_extract_media`、携带 reply_to_text；`plugins/platforms/wecom/media.py`、`streaming.py`、`send_queue.py`。`SUPPORTS_NATIVE_STREAMING=True`，但不是普通 message edit。
- 固定 Hermes 树没有 `plugins/platforms/wechat` 或 MP adapter；WeCom、个人 Weixin、公众号是不同协议，不能互相算已覆盖。

### Telegram

- L：`src/main/gateway/channels.ts` 的 `TelegramChannelAdapter.pollLoop/mediaSources/handleUpdate/sendText/sendChunk`。
- H：`plugins/platforms/telegram/adapter.py` 的 `_thread_kwargs_for_send`、`create_handoff_thread`、`rename_dm_topic`、`_handle_callback_query`、`_handle_exec_approval_callback`、`edit_message`、`_check_polling_stall`、`_verify_polling_after_reconnect`。

### Slack

- L：`src/main/gateway/SlackSocketModeAdapter.ts` 的 `resumeDeliveries/processDelivery/readChannelHistory` 与 `journal.accept` 后 ACK；`src/main/gateway/SlackGatewayJournal.ts`。
- H：`plugins/platforms/slack/adapter.py` 的 `_upload_file/_cache_slack_file/send_multiple_images`、`_hydrate_thread_context`、`_handle_assistant_thread_lifecycle_event`、`send_draft`、`_handle_approval_action`、`_handle_slash_command`。

### DingTalk / Discord

- L：`src/main/gateway/DingTalkStreamAdapter.ts` 的 `inboundContent/mediaSources`、sessionWebhook、重连/seen；`src/main/gateway/DiscordGatewayAdapter.ts` 的 `open/scheduleReconnect` 与消息处理的 `scope/message_reference/nonce/seen`。
- H：`plugins/platforms/dingtalk/adapter.py` 的 `_extract_media/_resolve_media_codes/send_image_file/send_document/_create_and_stream_card/edit_message`，`send_typing` 明确 no-op。
- H：`plugins/platforms/discord/adapter.py` 的 `_thread_id_and_chat_for_channel`、`_send_to_forum`、`_run_missed_message_backfill`、`_advance_discord_recovery_cursor`；`plugins/platforms/discord/adapter_media.py`、`adapter_exec_approval_view.py`、`adapter_component_auth.py`、`recovery.py`、`voice_mixer.py`。存在方法不代表每个部署默认开启 backfill，配置仍需核对。

### QQ / Weixin

- L：`src/main/gateway/QQChannelAdapter.ts`；`QQBotQrLogin.ts`；`WeixinIlinkAdapter.ts` 的 `poll/receive`；`WeixinIlinkClient.ts` 的 `download/upload`；`WeixinQrLogin.ts`。扫码授权不能替代消息能力验收。
- H：`plugins/platforms/qqbot/adapter.py` 的 `send_with_keyboard/_send_exec_approval_prompt/set_interaction_callback/_upload_media/_stt_voice_attachment`；`keyboards.py`、`chunked_upload.py`。
- H：`plugins/platforms/weixin/adapter.py` 的 `_collect_media/_send_file/_save_sync_buf`、`ContextTokenStore`、`_poll_loop`、`send_typing/stop_typing`。cursor 在当前批次消息交付之后保存，不能简单把收到响应即保存游标视为相同保证。


## 已实现媒体的明确限制

- `L:src/main/gateway/GatewayMedia.ts`：HTTPS、精确 host 白名单、禁止重定向、30秒下载超时；每条最多10附件、单文件20MiB、批次40MiB、图片原生输入12MiB；缓存256MiB。缓存满时拒绝新增，不自动删除可能仍被任务引用的文件。成功附件保留用于后续回合与恢复；本次未实现引用计数/安全回收UI。
- DingTalk 只允许 `api.dingtalk.com`、`oapi.dingtalk.com`、`static.dingtalk.com`。返回其他真实 CDN 域名也会拒绝，需真实服务证据后再评估添加，不能宣称所有钉钉媒体实账号可用。
- WeCom smart 只允许 `wwcdn.weixin.qq.com`、`wework.qpic.cn`、`ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com`；未开放整个腾讯 COS 或任意外部域名。未覆盖原生音视频事件/STT、callback 模式媒体及出站文件。
- Slack 需 `files.info` 与下载权限，拒绝外部文件；Discord 只接受平台 attachment 记录与指定 CDN 路径；QQ、Weixin 同样限定来源。平台授权失败、未知来源、损坏密文、缓存满均可能使具体媒体拒收。
- 通用 attachments 已进入原生 Agent，但各模型能否理解特定音视频/文档格式仍取决于原生工具与模型；不把二进制传递等同 Hermes 的语音转写、格式转换或语音会话。
- 尚未统一持久化各渠道媒体下载状态/重试任务。现有错误处理保持“不在 Agent 已开始后因未知结果自动重跑”的边界，不能承诺 exactly-once。

## 其他平台：非本次目标

固定 Hermes 提交的 `plugins/platforms/*/plugin.yaml` 共 **26** 个。本项目九渠道对应其中八个：feishu、wecom、telegram、slack、dingtalk、discord、qqbot、weixin；多出的 `wechat` 是公众号，不能抵扣其他插件。

本次范围只包含现有九渠道，不扩展平台；用户明确不接 WhatsApp。以下清单仅解释为什么不能声称移植了全部 Hermes，不是实施待办。

以下 **18** 个插件在本项目 `GatewayChannelType` / registry / `GatewayService` 中均无对应注册，状态全部为 **missing**。每个证据路径均同时包含 `plugin.yaml` 和 `adapter.py`，仅确认平台适配器存在，不假定各插件具有相同媒体/审批/恢复能力：

| Hermes 平台 | Hermes 固定提交证据目录 |
| --- | --- |
| A2A | `plugins/platforms/a2a/` |
| BlueBubbles | `plugins/platforms/bluebubbles/` |
| Buzz | `plugins/platforms/buzz/` |
| Email | `plugins/platforms/email/` |
| Google Chat | `plugins/platforms/google_chat/` |
| IRC | `plugins/platforms/irc/` |
| LINE | `plugins/platforms/line/` |
| Matrix | `plugins/platforms/matrix/` |
| Mattermost | `plugins/platforms/mattermost/` |
| ntfy | `plugins/platforms/ntfy/` |
| Photon | `plugins/platforms/photon/` |
| Raft | `plugins/platforms/raft/` |
| Signal | `plugins/platforms/signal/` |
| SimpleX | `plugins/platforms/simplex/` |
| SMS | `plugins/platforms/sms/` |
| Teams | `plugins/platforms/teams/` |
| WhatsApp | `plugins/platforms/whatsapp/` |
| WhatsApp Cloud | `plugins/platforms/whatsapp_cloud/` |

此外 Hermes 核心目录中有 `H:gateway/platforms/api_server.py`、`webhook.py`、`msgraph_webhook.py` 等适配/入口代码，本项目九渠道 registry 无等价 API server / 通用 webhook 平台注册。不要把这些核心文件再加入上述26插件计数，也不要把本项目用于平台回调的 HTTP listener 当成兼容 Hermes API server。

## 补齐验收边界

1. 媒体：下载限制、平台授权、重定向/来源约束、附件生命周期及 Agent 真实接收；逐媒体类型明确入站/出站。不能因为契约新增 attachments 就把所有渠道 `media` 改为 true。
2. 线程：区分回复目标与原生任务身份；保留既有会话隔离。引用消息不能被转换成用户授权。
3. 交互：按钮回调绑定账号、会话、操作者、待批准操作及一次性状态；仅渲染按钮不等于实现审批。
4. 恢复：分别验证传输断线、同账号重连、换账号、进程重启、ACK前后崩溃、回复未知结果。不得因缺回复自动重跑有副作用的 Agent turn。
5. 更新本表前必须检查最终整合代码、能力声明及相关测试；尚未完成的改动保持 partial/missing，并说明范围。

复核入口：`scripts/gateway-platform-registry-test.ts`、`gateway-provider-config-test.ts`、`gateway-durable-test.ts`、`slack-gateway-test.ts`、`dingtalk-gateway-test.ts`、`discord-gateway-test.ts`、`qq-gateway-test.ts`、`weixin-gateway-test.ts`、`lark-wecom-gateway-test.ts`。该列表不是测试执行报告。

本次媒体专项复核入口：`scripts/gateway-media-test.ts`、`feishu-media-test.ts`、`telegram-media-test.ts`、`slack-media-test.ts`、`dingtalk-media-test.ts`、`discord-media-test.ts`、`qq-media-test.ts`、`weixin-media-test.ts`、`wecom-media-test.ts`。专项通过由负责人报告；完整 typecheck/test:all 结果请以最终整合报告为准。

## 额外安全修复

- 公众号兼容明文 POST 现在先验证官方 token/timestamp/nonce 签名，缺失或错误签名返回 403，不进入原生 Agent。加密回调仍沿用原验证流程。`scripts/wechat-callback-auth-test.ts` 覆盖此边界；不把这项鉴权修复称为公众号媒体对齐。
- Telegram 与 Weixin 的媒体永久拒绝及有限次临时重试耗尽会明确记录状态并前进，不让坏附件永久卡住后续消息。DingTalk 在媒体准备成功后才成功 ACK；QQ/Discord/WeCom 在进入 Agent 之前准备失败可接受平台重投，进入 Agent 后不因未知结果自动重放。
- Slack running 收据恢复验证原缓存的文件类型、大小、SHA256；缓存缺失/篡改不重新下载替换已接收输入，也不执行缺附件任务。

## 媒体增量历史验证（2026-11-08，de5a749）

- 完整 `pnpm -s typecheck` 通过，含 scripts 类型棘轮，无新增类型错误。
- 最终 `pnpm -s test:all`：376 项，372 通过，4 失败，**全量门禁未通过**。失败为 `atspi-transport`（当前 D-Bus/运行环境限制）、`image-resize-assets`、`oauth-bundle`、`pi104-features`（未生成产品 build 所需产物）；与补齐前已记录的四项一致。未修改失败基线，未违反禁止 build 的要求。
- 8 渠道新媒体测试、公共媒体安全测试、公众号签名测试，以及原生 durable 附件穿透测试均通过。媒体单独并发复验曾发现 Discord 测试固定30ms等待竞态，已改成条件等待；最终全量上述测试通过。未改动的 `media-capabilities-dom` 在额外并发压力下曾失败，单独及最终全量均通过。
- 分类自检通过，当前 headless376/GUI55/NETWORK29/DATASET2/pending0。没有真实账号、GUI、长时间断网或发行包验收；没有产品 build/pack。
- 只读复审已关闭本批发现的授权、重投、ACK、缓存恢复与可见状态问题；以上并不意味着所有 Hermes 功能已移植，剩余缺口仍以矩阵为准。
