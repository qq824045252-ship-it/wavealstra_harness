export interface GatewaySetupGuide { title: string; url: string; steps: readonly string[] }
/** Product setup instructions, not a claim that a provider supports QR enrollment. */
export const GATEWAY_SETUP_GUIDES: Record<string, GatewaySetupGuide> = {
  "telegram-default": { title: "在 BotFather 创建机器人", url: "https://t.me/BotFather", steps: ["打开官方 BotFather，使用 /newbot 创建机器人，或为已有机器人取得 Token。", "填写 Bot Token；填写允许使用的用户 ID，避免机器人被陌生人触发。", "点击连接后，在 Telegram 打开该机器人的对话并发送 /start，再发一条消息验证。"] },
  "slack-default": { title: "打开 Slack 应用管理", url: "https://api.slack.com/apps", steps: ["创建或选择 Slack 应用，启用 Socket Mode；配置所需事件和机器人权限后安装到目标工作区。", "填写该应用的 App ID、工作区 ID、xapp App Token（connections:write）及安装所得 xoxb Bot Token；填写允许的 Member ID。", "点击连接。频道使用需先邀请机器人加入频道；在私聊或频道 @ 机器人验证。"] },
  "discord-default": { title: "打开 Discord 开发者后台", url: "https://discord.com/developers/applications", steps: ["创建或选择应用并启用 Bot，按机器人所需事件配置 Gateway Intents；通过官方安装链接将 Bot 加入服务器。", "填写 Application ID 与 Bot Token（不是个人账号 Token），限定服务器和允许的用户；需要私聊时显式开启。", "点击连接，在允许的服务器 @ Bot 验证；网页账号登录或邀请二维码不等于机器人凭据授权。"] },
  "dingtalk-default": { title: "打开钉钉开发者后台", url: "https://open-dev.dingtalk.com/", steps: ["创建企业内部应用并添加机器人能力，选择 Stream 模式，按后台要求发布并配置可见范围。", "填写 Client ID、Client Secret、企业 Corp ID 与 Robot Code，以及允许的员工 senderStaffId。", "点击连接，在机器人单聊或企业群 @ 机器人验证。当前此表单是已有应用手工接入。"] },
  "feishu-default": { title: "打开飞书开发者后台", url: "https://open.feishu.cn/app", steps: ["创建或选择企业应用，启用机器人及所需事件/权限，并发布到目标企业。", "推荐选择 WebSocket 长连接，只填写 App ID、App Secret 和允许用户；Webhook 还需校验令牌及可达公网回调。", "点击连接后在飞书向机器人发送消息验证。当前此表单是已有应用手工接入。"] },
  "wecom-default": { title: "打开企业微信管理后台", url: "https://work.weixin.qq.com/", steps: ["优先创建智能机器人并选择长连接方式；已有自建应用回调则选择 callback。", "Smart 仅需 Bot ID、Secret 与允许用户；Callback 需 Corp ID、Agent ID、Secret、Token、AES Key 及可达公网回调。", "点击连接，再向机器人发送消息验证；平台管理员权限和机器人可见范围仍须在官方后台确认。"] },
  "wechat-default": { title: "打开微信公众号后台", url: "https://mp.weixin.qq.com/", steps: ["在公众号开发设置中取得 App ID、App Secret，配置消息接收服务器。", "填写与公众号后台一致的 Token 和 EncodingAESKey；回调必须是可达的公网 HTTPS 地址，不能填写 127.0.0.1。", "点击连接并在平台完成回调验证，再向公众号发消息验证；这不是个人微信扫码接入。"] },
};
export function visibleGatewayFields<T extends { key: string }>(channelId: string, values: Record<string,string>, fields: readonly T[]): T[] {
  if (channelId === "feishu-default") {
    const mode = values.transport || (values.verificationToken ? "webhook" : "websocket");
    return fields.filter(field => mode === "webhook" || field.key !== "verificationToken");
  }
  if (channelId === "wecom-default") {
    const mode = values.mode || (values.botId ? "smart" : "callback");
    return fields.filter(field => mode === "smart" ? ["mode","botId","secret"].includes(field.key) : field.key !== "botId");
  }
  return [...fields];
}
