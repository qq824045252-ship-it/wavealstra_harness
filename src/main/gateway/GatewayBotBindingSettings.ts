import { gatewayBotBindingRequestSchema, type GatewayBotBinding } from "../../shared/gateway-bot-binding";

type BindingDependencies = {
  current: Record<string, GatewayBotBinding>;
  connectedIdentity(channelId: string): { connectionKey: string; connectionRevision: string } | undefined;
  ownsActiveBot(botId: string): boolean;
};
/** Only the desktop host supplies the current account identity and available personal Bots. */
export function configureGatewayBotBinding(input: unknown, dependencies: BindingDependencies): Record<string, GatewayBotBinding> {
  const request = gatewayBotBindingRequestSchema.parse(input);
  const next = { ...dependencies.current };
  if (request.action === "unbind") {
    delete next[request.channelId];
    return next;
  }
  const identity = dependencies.connectedIdentity(request.channelId);
  if (!identity) throw new Error("请先连接渠道，再绑定自己的账号与个人 Bot");
  if (identity.connectionRevision !== request.connectionRevision) throw new Error("渠道连接或账号已变化，请重新选择本人账号后保存");
  if (!dependencies.ownsActiveBot(request.botId)) throw new Error("所选个人 Bot 不可用或不属于当前用户");
  next[request.channelId] = { botId: request.botId, connectionKey: identity.connectionKey,
    ownerSenderIds: [...new Set(request.ownerSenderIds)] };
  return next;
}

/** Read within the queue, not at IPC admission. One failure must not poison later writes. */
export function createGatewayBotBindingUpdater(dependencies: Omit<BindingDependencies, "current"> & {
  readCurrent(): Record<string, GatewayBotBinding>;
  writeCurrent(next: Record<string, GatewayBotBinding>): void | Promise<void>;
}) {
  let tail: Promise<unknown> = Promise.resolve();
  return (input: unknown): Promise<Record<string, GatewayBotBinding>> => {
    const request = gatewayBotBindingRequestSchema.parse(input);
    const result = tail.then(async () => {
      const next = configureGatewayBotBinding(request, { ...dependencies, current: dependencies.readCurrent() });
      // Production persistence is synchronous: identity validation and disk write
      // share one turn, without the unrelated asynchronous model-settings flush.
      await dependencies.writeCurrent(next);
      return next;
    });
    tail = result.catch(() => {});
    return result;
  };
}
