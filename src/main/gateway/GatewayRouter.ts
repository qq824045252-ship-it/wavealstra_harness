import type { GatewayEventDto } from "../../shared/agent-ipc";

import type { AppDatabase } from "../db/AppDatabase";
import type { AppSettingsStore } from "../AppSettingsStore";
import { gatewayInboundIdentity } from "./gateway-inbound-identity";

import { isSecureGatewayProvider } from "./GatewayProviderConfig";
import { runGatewayAgentTurn, withSlackChannelHistory, type GatewayAgentPort } from "./GatewayAgentTurn";
import { safeSlackError, redactSlackText } from "./SlackSocketModeAdapter";
import type { ChannelAdapter, GatewayInboundHandler, GatewayInboundMessage } from "./channels";
import type { createIdempotencyGuard } from "./GatewayRateLimiter";
import type { GatewayProjectMessageSink } from "./GatewayService";

interface GatewayRouterOptions {
  db: AppDatabase;
  agent: GatewayAgentPort;
  adapters: ReadonlyMap<string, ChannelAdapter>;
  readSettings(): ReturnType<AppSettingsStore["read"]>;
  isStopping(): boolean;
  slackId(): string;
  isAuthorized(channelId: string): boolean;
  isAllowed(channelId: string, senderId?: string): boolean;
  processed: ReturnType<typeof createIdempotencyGuard>;
  emitEvent(event: GatewayEventDto): void;

  projectMessageSink?: GatewayProjectMessageSink;
  restoreTrashedWorkspace?(taskId: string): void;
  redact(text: string): string;
  outboundFilter(): (text: string) => string;
  safeError(error: unknown): string;
}

/** Admission policy and native execution are independent of transport lifecycle.
 * A durable replay reuses the original native identity and never emits project input twice.
 */
export class GatewayRouter {
  constructor(private readonly options: GatewayRouterOptions) {}

  private origin(msg: GatewayInboundMessage, connectionKey: string, fallbackMessageId: string) {
    const route = msg.replyRoute;
    const privateRoute = route?.kind === "qq" && !route.group || route?.kind === "weixin" || route?.kind === "wechat"
      || route?.kind === "telegram" && route.chatId === msg.sender?.id && !route.messageThreadId
      || route?.kind === "wecom" && route.chatId === route.userId;
    return { channelId: msg.channelId, connectionKey, chatId: msg.chatId,
      senderId: msg.sender?.id ?? "", messageId: msg.messageId ?? fallbackMessageId,
      audience: msg.audience ?? (privateRoute ? "private" as const : "shared" as const), workTarget: msg.workTarget };
  }

  handler(): GatewayInboundHandler {
    return async (input) => {
      const redact = this.options.outboundFilter();
      const msg = { ...input, reply: (text: string) => input.reply(redact(text)) };
      if (this.options.isStopping()) throw new Error("Gateway 正在关闭，消息将在重连后继续");
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

      // 项目投递钩子：命中 `@项目 <名>：内容` 则记录项目事件（fail-open，不影响原流程）
      try {
        if (!msg.gatewayDelivery?.replay) this.options.projectMessageSink?.({
          text: msg.text,
          channelId: msg.channelId,
          chatId: msg.chatId,
          messageId: msg.messageId,
          senderName: msg.sender?.name,
        });
      } catch (err) {
        console.warn(`[Gateway] 项目投递钩子失败 ${msg.channelId}：`, this.options.safeError(err));
      }


      let text: string;
      try {

        const modelId = this.options.readSettings().defaultModelId?.trim();
        text = await runGatewayAgentTurn(this.options.agent, {
          taskId, text: msg.text, attachments: msg.attachments, assistantMessageId: `gw-asst-${turnId}`, userMessageId: `gw-user-${turnId}`,
          ...(modelId ? { modelId } : {}),
          gatewayOrigin: this.origin(msg, connectionKey, turnId),
        });
      } catch (err) {
        if (this.options.isStopping()) throw err;
        text = `处理失败：${this.options.safeError(err)}`;
      }
      try {
        if (this.options.isStopping() || this.options.adapters.get(msg.channelId)?.workConnectionKey?.() !== connectionKey) {
          throw new Error("Gateway 回复连接账号已改变，未发送");
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
    try {
      this.options.projectMessageSink?.({ text: msg.text, channelId: msg.channelId, chatId: msg.chatId,
        messageId: msg.messageId, senderName: msg.sender?.name });
    } catch { /* Existing project ingestion remains optional; Pi still receives the instruction. */ }
    if (msg.slackHistory?.status === "unavailable") {
      const code = msg.slackHistory.errorCode ?? "request_failed";
      const text = code === "missing_scope"
        ? "已收到你的 @，但 Bot 读取这个频道的历史被 Slack 拒绝（missing_scope）。本次尚未读到前面的聊天，需要先确认该频道的历史读取权限。"
        : "已收到你的 @，但本次未能读取前面的频道聊天（" + code + "）。请稍后重试；本次没有使用其他内容代替频道历史。";
      await msg.reply(text);
      this.options.emitEvent({ channelId: msg.channelId, direction: "out", text, at: Date.now(), chatId: msg.chatId });
      return;
    }
    let text: string;
    try {

      const settings = this.options.readSettings();
      const modelId = settings.defaultModelId?.trim() || undefined;
      text = await runGatewayAgentTurn(this.options.agent, {
        taskId: msg.taskId, text: withSlackChannelHistory(msg.text, msg.slackHistory), displayText: msg.text, userMessageId: msg.userMessageId,
        assistantMessageId: msg.assistantMessageId, attachments: msg.attachments,
        streamingBehavior: "followUp", ...(modelId ? { modelId } : {}),
        gatewayOrigin: this.origin(msg, connectionKey, msg.userMessageId),
      });
    } catch (error) {
      if (this.options.isStopping()) throw error;
      text = "任务处理失败：" + safeSlackError(error);
    }
    text = redact(redactSlackText(text));
    // Network failure is an outbox failure, not a second native task execution.
    await msg.reply(text);
    this.options.emitEvent({ channelId: msg.channelId, direction: "out", text, at: Date.now(), chatId: msg.chatId });
  }

}
