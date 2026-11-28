import type { GatewayDotsBindings } from "./GatewayDotsBindings";
import type { GatewayBotOrigin } from "../agent/work/BotTurnOrigins";
import type { AppDatabase } from "../db/AppDatabase";
import type { GatewayEventDto } from "../../shared/agent-ipc";

import type { AppSettingsStore } from "../AppSettingsStore";
import { gatewayInboundIdentity } from "./gateway-inbound-identity";
import { gatewayConversationId } from "./GatewayConversation";
import { hasStableConversationMessageId, isNewConversationCommand, NEW_CONVERSATION_REPLY, reserveGatewayConversation, type ConversationRoute } from "./GatewayConversationSession";

import { isSecureGatewayProvider } from "./GatewayProviderConfig";
import { runGatewayAgentTurn, type GatewayAgentPort } from "./GatewayAgentTurn";
import { safeSlackError, redactSlackText } from "./SlackSocketModeAdapter";
import type { ChannelAdapter, GatewayInboundHandler, GatewayInboundMessage } from "./channels";
import type { createIdempotencyGuard } from "./GatewayRateLimiter";
import type { GatewayProjectMessageSink } from "./GatewayService";

interface GatewayRouterOptions {
  db?: AppDatabase;
  dotsBindings?: GatewayDotsBindings;
  agent: GatewayAgentPort;
  adapters: ReadonlyMap<string, ChannelAdapter>;
  readSettings(): ReturnType<AppSettingsStore["read"]>;
  isStopping(): boolean;
  slackId(): string;
  isAuthorized(channelId: string): boolean;
  isAllowed(channelId: string, senderId?: string): boolean;
  isConversationAuthorized(channelId: string, senderId?: string): boolean;
  processed: ReturnType<typeof createIdempotencyGuard>;
  emitEvent(event: GatewayEventDto): void;

  projectMessageSink?: GatewayProjectMessageSink;
  redact(text: string): string;
  outboundFilter(): (text: string) => string;
  safeError(error: unknown): string;
}

/** Admission policy and native execution are independent of transport lifecycle.
 * Replies use their own durable receipt; channel text never becomes a project-side action.
 */
export class GatewayRouter {
  constructor(private readonly options: GatewayRouterOptions) {}

  private origin(msg: GatewayInboundMessage, connectionKey: string, fallbackMessageId: string): GatewayBotOrigin {
    const route = msg.replyRoute;
    const privateRoute = route?.kind === "qq" && !route.group || route?.kind === "weixin" || route?.kind === "wechat"
      || route?.kind === "telegram" && route.chatId === msg.sender?.id && !route.messageThreadId
      || route?.kind === "wecom" && route.chatId === route.userId;
    return { channelId: msg.channelId, connectionKey, chatId: msg.chatId,
      senderId: msg.sender?.id ?? "", messageId: msg.messageId ?? fallbackMessageId,
      audience: msg.audience ?? (privateRoute ? "private" as const : "shared" as const), workTarget: msg.workTarget };
  }

  private async execute(msg: GatewayInboundMessage, connectionKey: string, userMessageId: string,
    assistantMessageId: string, transportMessageId?: string): Promise<string> {
    const command = isNewConversationCommand(msg.text);
    if (command && !hasStableConversationMessageId(transportMessageId)) {
      return "这条消息没有稳定标识，无法安全开启新会话。请从支持消息标识的渠道重试 /new。";
    }
    const origin = this.origin(msg, connectionKey, userMessageId);
    const db = this.options.db;
    const core = msg.gatewayDelivery && db?.runtimeAuditReader?.supervised ? db.runtimeAuditReader : undefined;
    const assignment = await core?.readGatewayAssignment(origin);
    let route: ConversationRoute;
    if (core) {
      if (assignment?.status !== "assigned") throw new Error("Core 未确认渠道会话或收件授权");
      origin.personalMemoryBindingId = assignment.personalMemoryBindingId ?? undefined;
      route = assignment;
    } else {
      if (hasStableConversationMessageId(transportMessageId)) origin.personalMemoryBindingId = this.options.dotsBindings?.admit(origin, msg.replyRoute);
      const fixture = db?.fixtureConnection ?? (db && !db.runtimeAuditReader?.supervised ? db.connection : undefined);
      const fallback = gatewayConversationId(origin);
      if (command && !fixture) return "会话存储不可用，未开启新会话。";
      route = fixture ? reserveGatewayConversation(fixture, origin, command, undefined, db?.runtimeAuditReader)
        : { taskId: fallback, currentTaskId: fallback, command: false };
    }
    // Same provider ID cannot turn an original ordinary message into a new command on reply retry.
    if (route.command !== command) return "这条消息已按原内容处理，未改变当前会话。";
    if (route.command) return route.taskId === route.currentTaskId
      ? NEW_CONVERSATION_REPLY : "这条 /new 已处理过，当前会话未改变。";
    if (route.taskId !== route.currentTaskId) {
      const prior = core ? undefined : db?.getTask(route.taskId);
      const available = assignment?.status === "assigned" ? assignment.oldTaskAvailable
        : prior && !prior.archived && (core ? undefined : db?.getTaskExecutionWorkspaceState(route.taskId))?.state !== "trashed";
      if (!available) return "这条旧消息所属会话不可用，未转入当前新会话。";
    }
    if (!core && origin.personalMemoryBindingId) this.options.dotsBindings!.bindTask(route.taskId, origin.personalMemoryBindingId);
    const modelId = this.options.readSettings().defaultModelId?.trim();
    const answer = await runGatewayAgentTurn(this.options.agent, {
      taskId: route.taskId, text: msg.text, displayText: msg.text, attachments: msg.attachments,
      userMessageId, assistantMessageId, ...(modelId ? { modelId } : {}), gatewayOrigin: origin,
    }, route.taskId);
    const current = await core?.readGatewayAssignment(origin);
    if (core && (current?.status !== "assigned" || !current.oldTaskAvailable || current.taskId !== route.taskId
      || current.personalMemoryBindingId !== (origin.personalMemoryBindingId ?? null))) {
      throw new Error("渠道回复的会话或授权已变化，未发送本次回复");
    }
    if (!core && origin.personalMemoryBindingId && !this.options.dotsBindings!.replyCurrent({ binding_id: origin.personalMemoryBindingId })) {
      throw new Error("Dots 个人记忆授权已撤销，未发送本次回复");
    }
    return answer;
  }

  handler(): GatewayInboundHandler {
    return async (input) => {
      const redact = this.options.outboundFilter();
      const msg = { ...input, reply: (text: string) => input.reply(redact(text)) };
      if (this.options.isStopping()) throw new Error("Gateway 正在关闭，消息将在重连后继续");
      if (!this.options.isConversationAuthorized(msg.channelId, msg.sender?.id)) {
        this.options.emitEvent({ channelId: msg.channelId, direction: "system", at: Date.now(),
          text: "渠道消息未执行：请在助理设置中明确配置允许的发送者；连接成功不等于对话已授权。" });
        return;
      }
      // Slack validates its binding and persists dedupe before acknowledging events.
      if (msg.channelId === this.options.slackId()) return this.handleSlackInbound(msg, redact);
      const inboundAdapter = this.options.adapters.get(msg.channelId);
      if (inboundAdapter && isSecureGatewayProvider(inboundAdapter.type) && !this.options.isAuthorized(msg.channelId)) {
        throw new Error("Gateway 授权配置尚未生效，未执行");
      }
      // ① 白名单：未授权用户直接忽略（不发系统事件，避免噪音）
      if (!this.options.isAllowed(msg.channelId, msg.sender?.id)) {
        console.warn(`[Gateway] 拒绝未授权用户 ${msg.sender?.id ?? "(unknown)"} @ ${msg.channelId}`);
        return;
      }
      // Bind native sessions, receipts and dedupe to the verified account before
      // any persistent side effect. Never adopt an unscoped legacy conversation.
      const connectionKey = this.options.adapters.get(msg.channelId)?.workConnectionKey?.();
      if (!connectionKey) throw new Error("Gateway 缺少已核验的连接账号身份，未执行");
      if (msg.workTarget && msg.workTarget.connectionKey !== connectionKey) {
        throw new Error("Gateway 入站连接账号已改变，未执行");
      }
      const { taskId, turnId } = gatewayInboundIdentity(msg.channelId, connectionKey, msg.chatId, msg.messageId);
      // ② 幂等：平台失败重试投递同一条消息时不再执行
      if (msg.messageId && !msg.gatewayDelivery && !this.options.processed(taskId, msg.chatId, msg.messageId)) {
        console.warn(`[Gateway] 忽略重复消息 ${msg.messageId} @ ${msg.channelId}`);
        return;
      }

      if (!msg.gatewayDelivery?.replay) this.options.emitEvent({
        bindingConnectionKey: connectionKey,
        channelId: msg.channelId,
        direction: "in",
        text: msg.text,
        at: Date.now(),
        chatId: msg.chatId,
        senderId: msg.sender?.id,
        senderName: msg.sender?.name,
        messageId: msg.messageId,
      });

      let text: string;
      try {
        text = await this.execute(msg, connectionKey, `gw-user-${turnId}`, `gw-asst-${turnId}`, msg.messageId);
      } catch (err) {
        if (this.options.isStopping()) throw err;
        text = `处理失败：${this.options.safeError(err)}`;
      }
      try {
        if (this.options.isStopping() || !this.options.isConversationAuthorized(msg.channelId, msg.sender?.id)
          || this.options.adapters.get(msg.channelId)?.workConnectionKey?.() !== connectionKey) {
          throw new Error("Gateway 回复连接账号或允许名单已改变，未发送");
        }
        text = redact(text);
        await msg.reply(text);
        this.options.emitEvent({
          channelId: msg.channelId,
          direction: "out",
          text,
          at: Date.now(),
          chatId: msg.chatId,
        });
      } catch (err) {
        // Re-delivery reuses the native receipt, including after process restart.
        if (msg.messageId) this.options.processed.forget(taskId, msg.chatId, msg.messageId);
        this.options.emitEvent({
          channelId: msg.channelId,
          direction: "system",
          text: `回复发送失败：${this.options.safeError(err)}`,
          at: Date.now(),
          chatId: msg.chatId,
        });
        throw err;
      }
    };
  }

  private async handleSlackInbound(msg: GatewayInboundMessage, redact: (text: string) => string): Promise<void> {
    if (!msg.taskId || !msg.userMessageId || !msg.assistantMessageId) throw new Error("Slack 任务身份缺失，未执行");

    const connectionKey = this.options.adapters.get(msg.channelId)?.workConnectionKey?.();
    if (!connectionKey) throw new Error("Slack 缺少已认证账号身份");
    if (msg.workTarget && msg.workTarget.connectionKey !== connectionKey) {
      throw new Error("Slack 入站连接账号已改变，未执行");
    }
    this.options.emitEvent({
      bindingConnectionKey: connectionKey,
      channelId: msg.channelId, direction: "in", text: msg.text, at: Date.now(),
      chatId: msg.chatId, senderId: msg.sender?.id, messageId: msg.messageId,
    });
    let text: string;
    try {
      text = await this.execute(msg, connectionKey, msg.userMessageId, msg.assistantMessageId, msg.messageId || msg.userMessageId);
    } catch (error) {
      if (this.options.isStopping()) throw error;
      text = "任务处理失败：" + safeSlackError(error);
    }
    text = redact(redactSlackText(text));
    // Recheck both account and sender authorization after the asynchronous model turn.
    if (this.options.isStopping() || !this.options.isConversationAuthorized(msg.channelId, msg.sender?.id)
      || this.options.adapters.get(msg.channelId)?.workConnectionKey?.() !== connectionKey) {
      throw new Error("渠道账号或允许名单已改变，未发送回复");
    }
    // Network failure is an outbox failure, not a second native task execution.
    await msg.reply(text);
    this.options.emitEvent({ channelId: msg.channelId, direction: "out", text, at: Date.now(), chatId: msg.chatId });
  }

}
