/** New Gateway conversations have their own namespace; legacy gw-* tasks stay untouched. */
export function gatewayBotTaskId(sourceTaskId: string): string {
  return isGatewayBotTaskId(sourceTaskId) ? sourceTaskId : `gw-bot-${sourceTaskId.replace(/^gw-/, "")}`;
}

export function isGatewayBotTaskId(taskId?: string | null): boolean {
  return Boolean(taskId?.startsWith("gw-bot-"));
}

/** Display metadata uses fixed adapter IDs, never user- or message-provided labels. */
export const GATEWAY_SIDEBAR_CHANNELS = {
  "qq-default": "QQ", "weixin-default": "个人微信", "telegram-default": "Telegram",
  "dingtalk-default": "钉钉", "discord-default": "Discord", "feishu-default": "飞书",
  "wecom-default": "企微", "wechat-default": "微信公众号", "slack-default": "Slack",
} as const;
export type GatewaySidebarChannelId = keyof typeof GATEWAY_SIDEBAR_CHANNELS;
const GATEWAY_CHANNEL_SPACE_PREFIX = "sp-gw-";
export function gatewayChannelSpaceId(channelId: string): string {
  return GATEWAY_CHANNEL_SPACE_PREFIX + channelId;
}
export function gatewayChannelForSpace(spaceId: string): GatewaySidebarChannelId | undefined {
  if (!spaceId.startsWith(GATEWAY_CHANNEL_SPACE_PREFIX)) return undefined;
  const channelId = spaceId.slice(GATEWAY_CHANNEL_SPACE_PREFIX.length);
  return isGatewaySidebarChannelId(channelId) ? channelId : undefined;
}
export function isGatewaySidebarChannelId(id: string): id is GatewaySidebarChannelId {
  return Object.hasOwn(GATEWAY_SIDEBAR_CHANNELS, id);
}
export function isGatewayConversation(id: string): boolean { return /^gateway-chat-[a-f0-9]{64}$/.test(id); }
