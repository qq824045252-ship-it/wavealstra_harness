import type { GatewayChannelType } from "../../shared/agent-ipc";
import type { ChannelAdapter, ChannelConfig, GatewayInboundHandler, GatewayInboundMessage } from "./channels";
import { gatewayWorkTargetSchema } from "./work-outbound";

/** Implemented capabilities, not the provider's theoretical API surface. */
export interface GatewayCapabilities {
  transport: "webhook" | "polling" | "socket";
  text: true;
  media: false;
  editStreaming: false;
  interactiveApproval: false;
  durableInbound: boolean;
  workNotifications: boolean;
  threads: "none" | "reply-target" | "native-session";
}
const common = { text: true, media: false, editStreaming: false, interactiveApproval: false } as const;
export const GATEWAY_CAPABILITIES = Object.freeze({
  feishu: { ...common, transport: "webhook", durableInbound: false, workNotifications: true, threads: "none" },
  wecom: { ...common, transport: "webhook", durableInbound: false, workNotifications: true, threads: "none" },
  wechat: { ...common, transport: "webhook", durableInbound: false, workNotifications: true, threads: "none" },
  telegram: { ...common, transport: "polling", durableInbound: false, workNotifications: true, threads: "reply-target" },
  slack: { ...common, transport: "socket", durableInbound: true, workNotifications: true, threads: "native-session" },
  dingtalk: { ...common, transport: "socket", durableInbound: false, workNotifications: false, threads: "none" },
  weixin: { ...common, transport: "polling", durableInbound: false, workNotifications: false, threads: "none" },
  qq: { ...common, transport: "socket", durableInbound: false, workNotifications: false, threads: "none" },
  discord: { ...common, transport: "socket", durableInbound: false, workNotifications: false, threads: "none" },
} satisfies Record<GatewayChannelType, GatewayCapabilities>);

/** Internal transport envelope. Account is a public-identity digest, never a token.
 * Do not put this envelope or transport metadata in model instructions.
 * Native chat/session semantics intentionally remain owned by GatewayService.
 */
export interface GatewayMessageEvent {
  readonly version: 1;
  readonly platform: GatewayChannelType;
  readonly source: Readonly<{ channelId: string; accountKey: string; chatId: string; threadId?: string }>;
  readonly sender?: Readonly<{ id: string; name?: string }>;
  readonly messageId?: string;
  readonly text: string;
  readonly receivedAt: number;
  readonly capabilities: Readonly<GatewayCapabilities>;
  readonly message: GatewayInboundMessage;
}
/** Runtime mode overrides only transport and whether unsolicited Work delivery is supported. */
export function gatewayCapabilities(adapter: ChannelAdapter, config?: ChannelConfig): Readonly<GatewayCapabilities> {
  const dynamic = (adapter as ChannelAdapter & {
    gatewayCapabilities?: (config?: ChannelConfig) => Pick<GatewayCapabilities, "transport" | "workNotifications">;
  }).gatewayCapabilities?.(config);
  return Object.freeze({ ...GATEWAY_CAPABILITIES[adapter.type],
    ...(dynamic ? { transport: dynamic.transport, workNotifications: dynamic.workNotifications } : {}) });
}

export interface RegisteredGatewayAdapter extends ChannelAdapter {
  setInboundHandler(handler: GatewayInboundHandler): void;
}

export class GatewayPlatformRegistry {
  private readonly entries = new Map<string, RegisteredGatewayAdapter>();
  // Serialize only execution in the existing native session; never create a bot
  // runtime, new task identity or prompt context. Other chats remain concurrent.
  private readonly tails = new Map<string, Promise<void>>();
  private readonly depths = new Map<string, number>();
  private pending = 0;

  register(adapter: RegisteredGatewayAdapter, handler: (event: GatewayMessageEvent) => Promise<void>): void {
    if (this.entries.has(adapter.id)) throw new Error("Gateway 渠道 ID 重复");
    if (!GATEWAY_CAPABILITIES[adapter.type]) throw new Error("Gateway 渠道能力未声明");
    this.entries.set(adapter.id, adapter);
    // Bind provenance to the actual producer, not an event-controlled channelId.
    adapter.setInboundHandler(async message => {
      const event = this.normalize(adapter, message);
      const generation = adapter.gatewayConnectionGeneration?.();
      const key = JSON.stringify([adapter.id, event.source.accountKey, adapter.type === "slack" ? message.taskId ?? message.chatId : message.chatId]);
      const depth = this.depths.get(key) ?? 0;
      if (depth >= 64 || this.pending >= 1024) throw new Error("Gateway 入站队列已满，请稍后重试");
      this.depths.set(key, depth + 1);
      this.pending++;
      const previous = this.tails.get(key) ?? Promise.resolve();
      const run = previous.then(async () => {
        // A queued delivery must not execute under replacement credentials.
        if (!adapter.isConnected() || adapter.workConnectionKey?.() !== event.source.accountKey
          || adapter.gatewayConnectionGeneration?.() !== generation) {
          throw new Error("Gateway 排队消息连接账号已改变，未执行");
        }
        await handler(event);
      });
      // A failed turn must not poison later turns. Keep the rejection on the
      // returned promise so each transport owns its acknowledgement/retry policy.
      const tail = run.then(() => {}, () => {});
      this.tails.set(key, tail);
      try { await run; }
      finally {
        this.pending--;
        const remaining = (this.depths.get(key) ?? 1) - 1;
        if (remaining) this.depths.set(key, remaining); else this.depths.delete(key);
        if (this.tails.get(key) === tail) this.tails.delete(key);
      }
    });
  }

  private normalize(adapter: RegisteredGatewayAdapter, message: GatewayInboundMessage): GatewayMessageEvent {
    const accountKey = adapter.workConnectionKey?.();
    if (message.channelId !== adapter.id || this.entries.get(adapter.id) !== adapter
      || !adapter.isConnected() || !accountKey || !/^[a-f0-9]{64}$/.test(accountKey)) {
      throw new Error("Gateway 入站渠道或连接身份无效，未执行");
    }
    if (typeof message.chatId !== "string" || !message.chatId.trim() || typeof message.text !== "string"
      || typeof message.reply !== "function") throw new Error("Gateway 入站消息无效，未执行");
    const target = message.workTarget;
    if (target && (!gatewayWorkTargetSchema.safeParse(target).success || target.channelId !== adapter.id
      || target.channelType !== adapter.type || target.connectionKey !== accountKey
      || target.chatId !== message.chatId || target.senderId !== message.sender?.id)) {
      throw new Error("Gateway 入站通知地址与来源不一致，未执行");
    }
    const threadId = target?.channelType === "slack" ? target.address.threadTs
      : target?.channelType === "telegram" && target.address.messageThreadId !== undefined
        ? String(target.address.messageThreadId) : undefined;
    const reply = message.reply;
    const generation = adapter.gatewayConnectionGeneration?.();
    const boundMessage = { ...message, reply: async (text: string) => {
      if (!adapter.isConnected() || adapter.workConnectionKey?.() !== accountKey
        || adapter.gatewayConnectionGeneration?.() !== generation) {
        throw new Error("Gateway 回复连接账号已改变，未发送");
      }
      await reply(text);
    } };
    return Object.freeze({ version: 1, platform: adapter.type,
      source: Object.freeze({ channelId: adapter.id, accountKey, chatId: message.chatId, ...(threadId ? { threadId } : {}) }),
      ...(message.sender ? { sender: Object.freeze({ ...message.sender }) } : {}),
      messageId: message.messageId, text: message.text, receivedAt: Date.now(),
      capabilities: gatewayCapabilities(adapter), message: boundMessage });
  }
}
