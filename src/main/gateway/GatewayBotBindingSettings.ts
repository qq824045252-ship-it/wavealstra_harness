import { gatewayBotBindingRequestSchema, type GatewayBotBinding } from "../../shared/gateway-bot-binding";

/** Only the desktop host supplies the current account identity and available personal Bots. */
export function configureGatewayBotBinding(input: unknown, dependencies: {
  current: Record<string, GatewayBotBinding>;
  connectedIdentity(channelId: string): { connectionKey: string } | undefined;
  ownsActiveBot(botId: string): boolean;
}): Record<string, GatewayBotBinding> {
  const request = gatewayBotBindingRequestSchema.parse(input);
  const next = { ...dependencies.current };
  if (request.action === "unbind") {
    delete next[request.channelId];
    return next;
  }
  const identity = dependencies.connectedIdentity(request.channelId);
  if (!identity) throw new Error("请先连接渠道，再绑定自己的账号与个人 Bot");
  if (!dependencies.ownsActiveBot(request.botId)) throw new Error("所选个人 Bot 不可用或不属于当前用户");
  next[request.channelId] = { botId: request.botId, connectionKey: identity.connectionKey,
    ownerSenderIds: [...new Set(request.ownerSenderIds)] };
  return next;
}
