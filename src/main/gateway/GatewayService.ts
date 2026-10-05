import { createServer, type Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { BrowserWindow } from "electron";
import {
  GatewayIpc,
  type GatewayChannelDto,
  type GatewayChannelType,
  type GatewayEventDto,
  type GatewayMessageDto,
  type GatewayStatusDto,
} from "../../shared/agent-ipc";
import type { AgentService } from "../agent/AgentService";
import type { AppDatabase } from "../db/AppDatabase";
import { AppSettingsStore } from "../AppSettingsStore";
import { getGatewayDir } from "../paths";
import { SlackSocketModeAdapter, safeSlackError, redactSlackText } from "./SlackSocketModeAdapter";
import { SlackGatewayJournal } from "./SlackGatewayJournal";
import { sealSlackGatewayConfig, openSlackGatewayConfig, slackGatewayConfigView } from "./SlackGatewayCredentials";
import { runGatewayAgentTurn, withSlackChannelHistory } from "./GatewayAgentTurn";
import {
  FeishuChannelAdapter,
  TelegramChannelAdapter,
  WechatMpChannelAdapter,
  WecomChannelAdapter,
  type ChannelAdapter,
  type GatewayInboundHandler,
  type GatewayInboundMessage,
} from "./channels";

/** 脱敏占位符：getChannelConfig 返回的 secret 类字段值；connect 时原样提交即复用已存值 */
export const GATEWAY_REDACTED = "••••••";

/** 各通道需要脱敏的字段（表单回填时打码，留空提交则保留旧值） */
const REDACTED_FIELDS: Record<GatewayChannelType, string[]> = {
  feishu: ["appSecret"],
  wecom: ["secret", "token", "encodingAESKey"],
  wechat: ["appSecret", "token", "encodingAESKey"],
  telegram: ["botToken"],
  slack: ["botToken", "appToken", "encryptedSecrets"],
};

/** 幂等窗口：平台重试投递的同一条消息只执行一次（10 分钟） */
const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 2000;

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function toStrArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter(Boolean);
}

/** 幂等去重守卫：同 channelId:chatId:messageId 只放行一次（窗口外自动过期，过期后可重新处理） */
export function createIdempotencyGuard(
  windowMs: number = IDEMPOTENCY_WINDOW_MS,
  maxEntries: number = IDEMPOTENCY_MAX_ENTRIES,
): ((channelId: string, chatId: string, messageId: string) => boolean) & { forget(channelId: string, chatId: string, messageId: string): void } {
  const processed = new Map<string, number>();
  const guard = (channelId: string, chatId: string, messageId: string): boolean => {
    const key = `${channelId}:${chatId}:${messageId}`;
    const now = Date.now();
    const existing = processed.get(key);
    if (existing !== undefined) {
      if (now - existing <= windowMs) return false; // 窗口内重复投递：拒绝
      processed.delete(key); // 窗口已过期：允许重新处理
    }
    processed.set(key, now);
    if (processed.size > maxEntries) {
      const oldest = [...processed.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) processed.delete(oldest[0]);
    }
    for (const [k, t] of processed) {
      if (now - t > windowMs) processed.delete(k);
    }
    return true;
  };
  return Object.assign(guard, { forget: (channelId: string, chatId: string, messageId: string) => {
    processed.delete(`${channelId}:${chatId}:${messageId}`);
  } });
}

/** 白名单判断：未配置（空数组）= 不限制 */
export function isAllowedUser(allowUsers: string[], senderId?: string): boolean {
  if (allowUsers.length === 0) return true;
  return Boolean(senderId && allowUsers.includes(senderId));
}

/**
 * 外部项目投递钩子（可选注入）：入站消息在幂等/白名单之后、Agent 处理之前调用一次。
 * 由调用方（index.ts）解析 `@项目 <名>：内容` 指令并投递到 ProjectEventIngestor；
 * 不命中/解析失败不阻塞原消息流（fail-open，原 Agent 流程不变）。
 */
export interface GatewayProjectMessageSink {
  (msg: { text: string; channelId: string; chatId: string; messageId?: string; senderName?: string }): void;
}

export class GatewayService {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly feishu: FeishuChannelAdapter;
  private readonly wecom: WecomChannelAdapter;
  private readonly wechat: WechatMpChannelAdapter;
  private readonly telegram: TelegramChannelAdapter;
  private readonly slack: SlackSocketModeAdapter;
  private readonly settingsStore = new AppSettingsStore();
  /** 通道级策略：白名单（空 = 不限制） */
  private readonly channelPolicies = new Map<string, { allowUsers: string[] }>();
  /** 幂等去重守卫：key = channelId:chatId:messageId */
  private readonly processed = createIdempotencyGuard();
  private webhookServer: Server | null = null;
  private webhookPort = 52140;
  private running = false;
  private stopping = false;

  constructor(
    private readonly db: AppDatabase,
    private readonly agent: AgentService,
    private readonly projectMessageSink?: GatewayProjectMessageSink,
  ) {
    const inbound = this.createInboundHandler();
    this.feishu = new FeishuChannelAdapter("feishu-default", "飞书");
    this.wecom = new WecomChannelAdapter("wecom-default", "企微");
    this.wechat = new WechatMpChannelAdapter("wechat-default", "微信");
    this.telegram = new TelegramChannelAdapter("telegram-default", "Telegram");
    this.slack = new SlackSocketModeAdapter("slack-default", "Slack", {
      journal: new SlackGatewayJournal(() => join(getGatewayDir(), "slack-deliveries.json")),
      deferInboundUntilActivated: true,
      onStatus: text => this.emitEvent({ channelId: "slack-default", direction: "system", text, at: Date.now() }),
      onHistoryRead: value => console.info("[SlackChannelHistory] " + JSON.stringify(value)),
    });
    this.feishu.setInboundHandler(inbound);
    this.wecom.setInboundHandler(inbound);
    this.wechat.setInboundHandler(inbound);
    this.telegram.setInboundHandler(inbound);
    this.slack.setInboundHandler(inbound);

    this.adapters.set(this.feishu.id, this.feishu);
    this.adapters.set(this.wechat.id, this.wechat);
    this.adapters.set(this.wecom.id, this.wecom);
    this.adapters.set(this.telegram.id, this.telegram);
    this.adapters.set(this.slack.id, this.slack);
  }

  private isAllowed(channelId: string, senderId?: string): boolean {
    return isAllowedUser(this.channelPolicies.get(channelId)?.allowUsers ?? [], senderId);
  }

  private markProcessed(channelId: string, chatId: string, messageId: string): boolean {
    return this.processed(channelId, chatId, messageId);
  }

  private createInboundHandler(): GatewayInboundHandler {
    return async (msg) => {
      if (this.stopping) throw new Error("Gateway 正在关闭，消息将在重连后继续");
      // Slack validates its binding and persists dedupe before acknowledging events.
      if (msg.channelId === this.slack.id) return this.handleSlackInbound(msg);
      // ① 白名单：未授权用户直接忽略（不发系统事件，避免噪音）
      if (!this.isAllowed(msg.channelId, msg.sender?.id)) {
        console.warn(`[Gateway] 拒绝未授权用户 ${msg.sender?.id ?? "(unknown)"} @ ${msg.channelId}`);
        return;
      }
      // ② 幂等：平台失败重试投递同一条消息时不再执行
      if (msg.messageId && !this.markProcessed(msg.channelId, msg.chatId, msg.messageId)) {
        console.warn(`[Gateway] 忽略重复消息 ${msg.messageId} @ ${msg.channelId}`);
        return;
      }

      this.emitEvent({
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
        this.projectMessageSink?.({
          text: msg.text,
          channelId: msg.channelId,
          chatId: msg.chatId,
          messageId: msg.messageId,
          senderName: msg.sender?.name,
        });
      } catch (err) {
        console.warn(`[Gateway] 项目投递钩子失败 ${msg.channelId}：`, err);
      }

      const taskId = `gw-${msg.channelId}-${msg.chatId}`;
      const turnId = msg.messageId
        ? createHash("sha256").update(JSON.stringify([msg.channelId, msg.chatId, msg.messageId])).digest("hex")
        : randomUUID();
      let text: string;
      try {
        const modelId = this.settingsStore.read().defaultModelId?.trim();
        text = await runGatewayAgentTurn(this.agent, {
          taskId, text: msg.text, assistantMessageId: `gw-asst-${turnId}`, userMessageId: `gw-user-${turnId}`,
          ...(modelId ? { modelId } : {}),
        });
      } catch (err) {
        if (this.stopping) throw err;
        text = `处理失败：${err instanceof Error ? err.message : String(err)}`;
      }
      try {
        await msg.reply(text);
        this.emitEvent({
          channelId: msg.channelId,
          direction: "out",
          text,
          at: Date.now(),
          chatId: msg.chatId,
        });
      } catch (err) {
        // Re-delivery reuses the native receipt, including after process restart.
        if (msg.messageId) this.processed.forget(msg.channelId, msg.chatId, msg.messageId);
        this.emitEvent({
          channelId: msg.channelId,
          direction: "system",
          text: `回复发送失败：${err instanceof Error ? err.message : String(err)}`,
          at: Date.now(),
          chatId: msg.chatId,
        });
        throw err;
      }
    };
  }

  private async handleSlackInbound(msg: GatewayInboundMessage): Promise<void> {
    if (!msg.taskId || !msg.userMessageId || !msg.assistantMessageId) throw new Error("Slack 任务身份缺失，未执行");
    this.emitEvent({
      channelId: msg.channelId, direction: "in", text: msg.text, at: Date.now(),
      chatId: msg.chatId, senderId: msg.sender?.id, messageId: msg.messageId,
    });
    try {
      this.projectMessageSink?.({ text: msg.text, channelId: msg.channelId, chatId: msg.chatId,
        messageId: msg.messageId, senderName: msg.sender?.name });
    } catch { /* Existing project ingestion remains optional; Pi still receives the instruction. */ }
    if (msg.slackHistory?.status === "unavailable") {
      const code = msg.slackHistory.errorCode ?? "request_failed";
      const text = code === "missing_scope"
        ? "已收到你的 @，但 Bot 读取这个频道的历史被 Slack 拒绝（missing_scope）。本次尚未读到前面的聊天，需要先确认该频道的历史读取权限。"
        : "已收到你的 @，但本次未能读取前面的频道聊天（" + code + "）。请稍后重试；本次没有使用其他内容代替频道历史。";
      await msg.reply(text);
      this.emitEvent({ channelId: msg.channelId, direction: "out", text, at: Date.now(), chatId: msg.chatId });
      return;
    }
    let text: string;
    try {
      const settings = this.settingsStore.read();
      const modelId = settings.defaultModelId?.trim() || undefined;
      text = await runGatewayAgentTurn(this.agent, {
        taskId: msg.taskId, text: withSlackChannelHistory(msg.text, msg.slackHistory), displayText: msg.text, userMessageId: msg.userMessageId,
        assistantMessageId: msg.assistantMessageId,
        streamingBehavior: "followUp", ...(modelId ? { modelId } : {}),
      });
    } catch (error) {
      if (this.stopping) throw error;
      text = "任务处理失败：" + safeSlackError(error);
    }
    text = redactSlackText(text);
    // Network failure is an outbox failure, not a second native task execution.
    await msg.reply(text);
    this.emitEvent({ channelId: msg.channelId, direction: "out", text, at: Date.now(), chatId: msg.chatId });
  }

  async start(): Promise<void> {
    this.stopping = false;
    if (this.webhookServer) return;
    await this.startWebhookServer();
    this.running = true;
    this.emitEvent({
      channelId: "system",
      direction: "system",
      text: `Gateway 已启动 · 飞书 /feishu · 企微 /wecom · 微信 /wechat · 端口 ${this.webhookPort}`,
      at: Date.now(),
    });
  }

  /** 应用启动时恢复上次已连接的通道（配置从 DB 读回，无需重新手输） */
  async restoreChannels(): Promise<void> {
    this.stopping = false;
    for (const row of this.db.listGatewayChannels()) {
      if (!row.connected) continue;
      const adapter = this.adapters.get(row.id);
      if (!adapter) continue;
      let config: Record<string, unknown> = {};
      try {
        config = JSON.parse(row.configJson || "{}") as Record<string, unknown>;
      } catch {
        console.warn(`[Gateway] ${row.id} 配置损坏，跳过恢复`);
        continue;
      }
      try {
        await adapter.connect(adapter.type === "slack" ? openSlackGatewayConfig(config) : config);
        if (adapter.type === "slack") this.running = true;
        this.channelPolicies.set(row.id, { allowUsers: toStrArray(config.allowUsers) });
        if (adapter.type === "slack") this.slack.activate();
        this.emitEvent({
          channelId: row.id,
          direction: "system",
          text: `${adapter.name} 已恢复连接`,
          at: Date.now(),
        });
      } catch (err) {
        const message = adapter.type === "slack" ? safeSlackError(err) : err instanceof Error ? err.message : String(err);
        console.warn(`[Gateway] 恢复 ${row.id} 失败: ${message}`);
        this.emitEvent({
          channelId: row.id,
          direction: "system",
          text: `${adapter.name} 恢复连接失败：${message}`,
          at: Date.now(),
        });
      }
    }
  }

  async suspend(): Promise<void> {
    this.stopping = true;
    for (const a of this.adapters.values()) {
      if (a.isConnected() || a.type === "slack") await a.disconnect();
    }
  }

  async stop(): Promise<void> {
    await this.suspend();
    await new Promise<void>((resolve) => {
      if (!this.webhookServer) return resolve();
      this.webhookServer.close(() => resolve());
    });
    this.webhookServer = null;
    this.running = false;
  }

  status(): GatewayStatusDto {
    return {
      running: this.running,
      channels: this.listChannels(),
    };
  }

  listChannels(): GatewayChannelDto[] {
    return [...this.adapters.values()].map((a) => ({
      id: a.id,
      type: a.type,
      name: a.name,
      connected: a.isConnected(),
      statusText: a.statusText(),
    }));
  }

  /** 已保存配置的脱敏视图（secret 打码；原样提交 connect 即复用旧值） */
  getChannelConfig(channelId: string): { hasConfig: boolean; config: Record<string, unknown> } {
    const row = this.db.listGatewayChannels().find((c) => c.id === channelId);
    if (!row) return { hasConfig: false, config: {} };
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(row.configJson || "{}") as Record<string, unknown>;
    } catch {
      return { hasConfig: true, config: {} };
    }
    const redacted = { ...config };
    if (row.type === "slack") return { hasConfig: true, config: slackGatewayConfigView(config) };
    const fields = REDACTED_FIELDS[row.type as GatewayChannelType] ?? [];
    for (const key of fields) {
      if (redacted[key]) redacted[key] = GATEWAY_REDACTED;
    }
    return { hasConfig: true, config: redacted };
  }

  async connect(channelId: string, config: Record<string, unknown>): Promise<GatewayStatusDto> {
    this.stopping = false;
    const adapter = this.adapters.get(channelId);
    if (!adapter) throw new Error(`unknown channel: ${channelId}`);

    // 脱敏占位符字段 → 复用已存配置的旧值
    const stored = this.db.listGatewayChannels().find((c) => c.id === channelId);
    let storedConfig: Record<string, unknown> = {};
    if (stored) {
      try {
        storedConfig = JSON.parse(stored.configJson || "{}") as Record<string, unknown>;
      } catch {
        // ignore
      }
    }
    const merged: Record<string, unknown> = { ...config };
    const storedSecrets = adapter.type === "slack" && storedConfig.encryptedSecrets
      ? openSlackGatewayConfig(storedConfig) : storedConfig;
    for (const [key, value] of Object.entries(merged)) {
      if (value === GATEWAY_REDACTED && storedSecrets[key]) merged[key] = storedSecrets[key];
    }

    // Socket Mode needs no HTTP listener. Seal before connecting, refuse plaintext fallback.
    const savedConfig = adapter.type === "slack" ? sealSlackGatewayConfig(merged) : merged;
    if (adapter.type !== "slack") await this.start();
    await adapter.connect(merged);
    if (adapter.type === "slack") this.running = true;
    this.channelPolicies.set(adapter.id, { allowUsers: toStrArray(merged.allowUsers) });
    try {
      this.db.upsertGatewayChannel({
        id: adapter.id, type: adapter.type, name: adapter.name,
        configJson: JSON.stringify(savedConfig), connected: true, statusText: adapter.statusText(),
      });
    } catch (error) {
      if (adapter.type !== "slack") throw error;
      await adapter.disconnect();
      this.channelPolicies.delete(adapter.id);
      this.running = this.webhookServer !== null || [...this.adapters.values()].some(channel => channel.isConnected());
      throw new Error("Slack 安全配置保存失败，接收已暂停；原有配置保留");
    }
    if (adapter.type === "slack") this.slack.activate();
    this.emitEvent({
      channelId,
      direction: "system",
      text: `${adapter.name} 已连接`,
      at: Date.now(),
    });
    return this.status();
  }

  async disconnect(channelId: string): Promise<GatewayStatusDto> {
    const adapter = this.adapters.get(channelId);
    if (!adapter) throw new Error(`unknown channel: ${channelId}`);
    await adapter.disconnect();
    const stored = adapter.type === "slack" ? this.db.listGatewayChannels().find(row => row.id === channelId) : undefined;
    this.channelPolicies.delete(channelId);
    this.db.upsertGatewayChannel({
      id: adapter.id,
      type: adapter.type,
      name: adapter.name,
      configJson: stored?.configJson ?? "{}",
      connected: false,
      statusText: adapter.statusText(),
    });
    this.emitEvent({
      channelId,
      direction: "system",
      text: `${adapter.name} 已断开`,
      at: Date.now(),
    });
    return this.status();
  }

  listMessages(opts: { channelId?: string; chatId?: string; limit?: number }): GatewayMessageDto[] {
    return this.db.listGatewayMessages(opts);
  }

  private emitEvent(ev: GatewayEventDto): void {
    // 落库（历史可查、重启不丢）
    try {
      this.db.insertGatewayMessage({
        channelId: ev.channelId,
        chatId: ev.chatId ?? "",
        direction: ev.direction,
        senderId: ev.senderId,
        senderName: ev.senderName,
        text: ev.text,
        at: ev.at,
      });
    } catch (err) {
      console.warn("[Gateway] 消息落库失败", err);
    }
    broadcast(GatewayIpc.event, ev);
  }

  private async startWebhookServer(): Promise<void> {
    if (this.webhookServer) return;
    this.webhookServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.webhookPort}`);
      const path = url.pathname;

      if (req.method === "POST" && path.startsWith("/feishu")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: unknown = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
        } catch {
          res.writeHead(400);
          res.end("bad json");
          return;
        }
        try {
          const result = await this.feishu.handleWebhookPayload(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result ?? { ok: true }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.writeHead(500);
          res.end(message);
        }
        return;
      }

      if (
        (req.method === "GET" || req.method === "POST") &&
        (path.startsWith("/wecom") || path.startsWith("/wechat"))
      ) {
        const chunks: Buffer[] = [];
        if (req.method === "POST") {
          for await (const chunk of req) chunks.push(chunk as Buffer);
        }
        const rawBody = Buffer.concat(chunks).toString("utf-8");
        const adapter = path.startsWith("/wecom") ? this.wecom : this.wechat;
        try {
          const result = await adapter.handleHttp({
            method: req.method ?? "GET",
            query: url.searchParams,
            rawBody,
          });
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "text/plain",
          });
          res.end(result.body);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.writeHead(500);
          res.end(message);
        }
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });

    await new Promise<void>((resolve, reject) => {
      this.webhookServer!.listen(this.webhookPort, "127.0.0.1", () => resolve());
      this.webhookServer!.on("error", reject);
    });
  }
}
