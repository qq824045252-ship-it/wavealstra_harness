import { createFeishuLongConnection, type FeishuLongConnection } from "./FeishuLongConnection";
import { WecomSmartRobot, type WecomSmartRobotOptions } from "./WecomSmartRobot";
import type { AgentService } from "../agent/AgentService";
import { timingSafeEqual } from "node:crypto";
import { assertGatewayWorkSend, gatewayConnectionKey, gatewayWorkTarget, GatewayWorkNotSentError,
  postGatewayWork, providerRejected, unknownProviderReceipt, workRequestSignal,
  type GatewayWorkSendInput, type GatewayWorkSendResult, type GatewayWorkTarget } from "./work-outbound";
import type { GatewayChannelType, GatewayEventDto } from "../../shared/agent-ipc";
import { GatewayReplyNotSentError, type GatewayReplyRestoreInput, type GatewayReplyRoute } from "./GatewayReply";

export interface ChannelConfig {
  [key: string]: unknown;
}

export interface ChannelAdapter {
  readonly id: string;
  readonly type: GatewayChannelType;
  readonly name: string;
  connect(config: ChannelConfig): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  statusText(): string;
  workConnectionKey?(): string | undefined;
  /** Opaque transport epoch. Never persisted or exposed to the model. */
  gatewayConnectionGeneration?(): unknown;
  /** Rebuild a reply with the current verified account, never old credentials. */
  restoreGatewayReply?(input: GatewayReplyRestoreInput): ((text: string) => Promise<void>) | undefined;
  sendWorkNotification?(input: GatewayWorkSendInput): Promise<GatewayWorkSendResult>;
}

export interface GatewayInboundMessage {
  audience?: "private" | "shared";
  channelId: string;
  chatId: string;
  text: string;
  /** Adapter-downloaded, bounded local media; never platform-supplied local paths. */
  attachments?: Array<{ name: string; path: string }>;
  /** 平台消息 id：用于幂等去重（webhook 重试 / 轮询重复不重复执行） */
  messageId?: string;
  /** Stable Slack identities passed to the existing native task/session. */
  taskId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  /** Bot-read channel material; it cannot grant authority or start another task. */
  slackHistory?: SlackChannelHistory;
  sender?: { id: string; name?: string };
  /** Set only by the authenticated adapter; never parsed from user message text. */
  workTarget?: GatewayWorkTarget;
  replyRoute?: GatewayReplyRoute;
  /** Registry-owned transport metadata, never added to model instructions. */
  gatewayDelivery?: { id: string; replay: boolean };
  reply: (text: string) => Promise<void>;
}

export interface SlackChannelHistory {
  channelId: string;
  beforeTs: string;
  status: "loaded" | "unavailable";
  messages: Array<{ ts: string; userId?: string; text: string }>;
  hasMore: boolean;
  errorCode?: string;
  requiredScopes?: string[];
}

export type GatewayInboundDelivery = Promise<void> & { accepted?: Promise<void> };
export type GatewayInboundHandler = (msg: GatewayInboundMessage) => GatewayInboundDelivery;

/** Early-ACK transports wait for durable admission, not for the entire Agent turn.
 * Direct adapter tests/embedders without a registry retain their old contract. */
export function gatewayInboundAccepted(delivery: GatewayInboundDelivery): Promise<void> {
  return delivery.accepted ?? Promise.resolve();
}

/** 飞书官方 SDK 长连接；保留已验证的旧 Webhook 配置。 */
export class FeishuChannelAdapter implements ChannelAdapter {
  readonly type = "feishu" as const;
  private connected = false;
  private activated = false;
  private activationWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  private generation = 0;
  private config: { appId?: string; appSecret?: string; verificationToken?: string } = {};
  private allowUsers: string[] = [];
  private transport: "webhook" | "websocket" = "webhook";
  private longConnection: FeishuLongConnection | null = null;
  private token: string | null = null;
  private tokenExpireAt = 0;
  private onInbound: GatewayInboundHandler | null = null;

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly createConnection = createFeishuLongConnection,
    private readonly options: { deferInboundUntilActivated?: boolean } = {},
  ) {}

  gatewayCapabilities(config?: ChannelConfig): { transport: "socket" | "webhook"; workNotifications: boolean } {
    const socket = config ? config.transport === "websocket" || (!config.transport && !config.verificationToken) : this.transport === "websocket";
    return { transport: socket ? "socket" : "webhook", workNotifications: true };
  }

  activate(): void {
    if (!this.connected) return;
    this.activated = true;
    for (const waiter of this.activationWaiters) waiter.resolve();
    this.activationWaiters.clear();
  }

  setInboundHandler(handler: GatewayInboundHandler): void {
    this.onInbound = handler;
  }

  async connect(config: ChannelConfig): Promise<void> {
    await this.disconnect();
    const generation = this.generation;
    this.config = {
      appId: String(config.appId ?? ""),
      appSecret: String(config.appSecret ?? ""),
      verificationToken: String(config.verificationToken ?? ""),
    };
    this.allowUsers = Array.isArray(config.allowUsers) ? config.allowUsers.map(value => String(value).trim()).filter(Boolean) : [];
    this.transport = config.transport === "websocket" || (!config.transport && !this.config.verificationToken) ? "websocket" : "webhook";
    if (config.transport && !["websocket", "webhook"].includes(String(config.transport))) throw new Error("飞书 transport 必须是 websocket 或 webhook");
    if (!this.config.appId || !this.config.appSecret || (this.transport === "webhook" && !this.config.verificationToken)) {
      throw new Error("飞书通道需要 appId、appSecret 与 verificationToken，未核验的 Webhook 不会启动任务");
    }
    await this.refreshToken();
    if (generation !== this.generation) throw new Error("Gateway 连接已取消");
    this.connected = true;
    this.activated = !this.options.deferInboundUntilActivated;
    if (this.transport === "websocket") {
      const connection = this.createConnection(this.config.appId, this.config.appSecret);
      this.longConnection = connection;
      try {
        await connection.start(async event => {
          if (generation !== this.generation || !this.connected) return;
          await this.handleMessageEvent(event);
        });
        if (generation !== this.generation) { connection.close(); throw new Error("Gateway 连接已取消"); }
      } catch (error) {
        connection.close();
        if (generation === this.generation) await this.disconnect();
        throw error;
      }
    }
  }

  async disconnect(): Promise<void> {
    this.generation++;
    this.activated = false;
    for (const waiter of this.activationWaiters) waiter.reject(new Error("飞书连接已取消"));
    this.activationWaiters.clear();
    this.longConnection?.close(); this.longConnection = null;
    this.connected = false;
    this.token = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  statusText(): string {
    if (!this.connected) return "未连接";
    return this.transport === "websocket" ? "已启动（飞书官方长连接）" : "已连接（Webhook）";
  }

  /** 供 Gateway HTTP webhook 调用 */
  async handleWebhookPayload(body: unknown): Promise<{ challenge?: string } | void> {
    if (this.transport !== "webhook" || !this.activated || !this.connected || !this.config.verificationToken) throw new Error("飞书 Webhook 身份校验未配置或通道已停用");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("飞书 Webhook 请求无效");
    const payload = body as {
      schema?: string;
      type?: string;
      token?: string;
      encrypt?: string;
      challenge?: string;
      header?: { event_type?: string; app_id?: string; token?: string };
      event?: {
        message?: {
          chat_id?: string;
          message_id?: string;
          content?: string;
          message_type?: string;
        };
        sender?: { sender_id?: { open_id?: string } };
      };
    };

    if (payload.encrypt) throw new Error("此飞书通道尚未配置加密事件解密，拒绝接纳请求");
    const expectedToken = Buffer.from(this.config.verificationToken);
    const suppliedToken = Buffer.from(payload.type === "url_verification" ? payload.token ?? "" : payload.header?.token ?? "");
    const tokenMatches = expectedToken.length === suppliedToken.length && timingSafeEqual(expectedToken, suppliedToken);
    if (!tokenMatches) throw new Error("飞书 Webhook 身份校验失败");
    if (payload.type === "url_verification" && typeof payload.challenge === "string" && payload.challenge) {
      return { challenge: payload.challenge };
    }
    if (payload.schema !== "2.0" || payload.header?.app_id !== this.config.appId) throw new Error("飞书事件版本或 App 身份不匹配");

    const eventType = payload.header?.event_type;
    if (eventType !== "im.message.receive_v1") return;
    await this.handleMessageEvent(payload.event);
  }

  private parseContent(type: string, raw: string): { text: string; media: Array<{ key: string; type: "image" | "file"; name: string }> } {
    const result: { text: string; media: Array<{ key: string; type: "image" | "file"; name: string }> } = { text: "", media: [] };
    let content: Record<string, unknown>;
    try { content = JSON.parse(raw); } catch { if (type === "text") result.text = raw; return result; }
    if (!content || typeof content !== "object" || Array.isArray(content)) return result;
    const str = (value: unknown): string => typeof value === "string" ? value : "";
    const media = (item: Record<string, unknown>, kind: string): void => {
      const image = kind === "image" || kind === "img";
      const key = str(image ? item.image_key : item.file_key);
      if (!key || result.media.some(entry => entry.key === key)) return;
      if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error("飞书媒体资源标识无效");
      result.media.push({ key, type: image ? "image" : "file", name: str(item.file_name) ||
        (image ? "image.jpg" : kind === "audio" ? "audio.ogg" : ["video", "media"].includes(kind) ? "video.mp4" : "attachment.bin") });
    };
    if (type === "text") result.text = str(content.text);
    else if (["image", "file", "audio", "video", "media"].includes(type)) media(content, type);
    else if (type === "post") {
      const wrapper = (content.post && typeof content.post === "object" ? content.post : content) as Record<string, unknown>;
      const post = (Array.isArray(wrapper.content) ? wrapper : [wrapper.zh_cn, wrapper.en_us, ...Object.values(wrapper)]
        .find(value => value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).content))) as Record<string, unknown> | undefined;
      if (!post) return result;
      const lines = [str(post.title)];
      for (const row of post.content as unknown[]) {
        if (!Array.isArray(row)) continue;
        let line = "";
        for (const value of row) {
          if (!value || typeof value !== "object") continue;
          const item = value as Record<string, unknown>;
          const tag = str(item.tag);
          if (["text", "md", "a", "at"].includes(tag)) line += str(item.text) || str(item.user_name);
          else if (["img", "image", "media", "file", "audio", "video"].includes(tag)) media(item, tag);
        }
        lines.push(line);
      }
      result.text = lines.filter(Boolean).join("\n");
    } else throw new Error(`飞书暂不支持此消息类型: ${type}`);
    return result;
  }

  private async handleMessageEvent(event: unknown): Promise<void> {
    const generation = this.generation;
    const epoch = this.gatewayConnectionGeneration();
    if (!this.activated) {
      if (!this.connected || this.activationWaiters.size >= 100) throw new Error("飞书接收尚未激活");
      await new Promise<void>((resolve, reject) => this.activationWaiters.add({ resolve, reject }));
    }
    const assertCurrent = (): void => this.assertReplyGeneration(generation, epoch);
    assertCurrent();
    if (!event || typeof event !== "object") return;
    const payload = event as { message?: { chat_id?: string; message_id?: string; content?: string; message_type?: string; thread_id?: string }; sender?: { sender_type?: string; sender_id?: { open_id?: string } } };
    if (payload.sender?.sender_type === "app") return;
    const senderId = payload.sender?.sender_id?.open_id;
    if (this.allowUsers.length && (!senderId || !this.allowUsers.includes(senderId))) return;
    const msg = payload.message;
    if (!msg?.chat_id || !msg.content || !this.onInbound) return;
    const parsed = this.parseContent(msg.message_type || "text", msg.content);
    if (!parsed.text.trim() && !parsed.media.length) return;
    if (parsed.media.length && (!msg.message_id || !/^[a-zA-Z0-9_-]+$/.test(msg.message_id))) throw new Error("飞书媒体消息缺少有效消息标识");
    const sources: GatewayMediaSource[] = [];
    if (parsed.media.length) {
      const token = await this.refreshToken();
      assertCurrent();
      for (const item of parsed.media) sources.push({
        url: `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(msg.message_id!)}/resources/${encodeURIComponent(item.key)}?type=${item.type}`,
        name: item.name, allowedHosts: ["open.feishu.cn"], headers: { Authorization: `Bearer ${token}` },
        fetch: async (url, init) => {
          assertCurrent();
          const response = await fetch(url, init);
          assertCurrent();
          if ((response.headers.get("content-type") || "").includes("application/json")) throw new Error("飞书媒体资源返回错误");
          return response;
        },
      });
    }
    await withGatewayMedia(sources, async attachments => {
      assertCurrent();
      await this.onInbound!({
        channelId: this.id, chatId: msg.chat_id!,
        workTarget: gatewayWorkTarget({ version: 1, channelType: this.type, channelId: this.id,
          connectionKey: this.workConnectionKey(), chatId: msg.chat_id!, senderId: payload.sender?.sender_id?.open_id,
          address: { chatId: msg.chat_id!, ...(msg.message_id ? { replyToMessageId: msg.message_id } : {}),
            ...(msg.thread_id ? { threadId: msg.thread_id } : {}) } }),
        text: parsed.text.trim(), attachments: attachments.length ? attachments : undefined, messageId: msg.message_id,
        sender: payload.sender?.sender_id?.open_id ? { id: payload.sender.sender_id.open_id } : undefined,
        replyRoute: { kind: "feishu", chatId: msg.chat_id!, messageId: msg.message_id, inThread: Boolean(msg.thread_id) },
        reply: async text => { await this.sendText(msg.chat_id!, text, generation, epoch, msg.message_id, Boolean(msg.thread_id)); },
      });
    });
  }

  private async refreshToken(signal?: AbortSignal): Promise<string> {
    const generation = this.generation;
    if (this.token && Date.now() < this.tokenExpireAt - 60_000) return this.token;
    const res = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST", redirect: "error", signal: workRequestSignal(signal),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      },
    );
    const data = (await res.json()) as {
      code: number;
      msg: string;
      tenant_access_token?: string;
      expire?: number;
    };
    if (!res.ok || data.code !== 0 || !data.tenant_access_token) {
      throw new Error("飞书 token 获取失败");
    }
    if (generation !== this.generation) throw new Error("Gateway 连接已改变");
    this.token = data.tenant_access_token;
    this.tokenExpireAt = Date.now() + (data.expire ?? 7200) * 1000;
    return this.token;
  }

  gatewayConnectionGeneration(): unknown { return this.longConnection?.generation?.() ?? this.generation; }

  restoreGatewayReply(input: GatewayReplyRestoreInput): (text: string) => Promise<void> {
    const route = input.route;
    if (route?.kind !== "feishu" || route.chatId !== input.chatId || (route.messageId && route.messageId !== input.messageId)
      || (this.allowUsers.length && (!input.sender || !this.allowUsers.includes(input.sender.id)))) {
      throw new GatewayReplyNotSentError("飞书已保存回复地址或授权不匹配");
    }
    const generation = this.generation, epoch = this.gatewayConnectionGeneration();
    return text => this.sendText(route.chatId, text, generation, epoch, route.messageId, route.inThread);
  }

  workConnectionKey(): string | undefined {
    return this.connected && this.activated && this.config.appId ? gatewayConnectionKey(this.type, [this.config.appId]) : undefined;
  }

  async sendWorkNotification(input: GatewayWorkSendInput): Promise<GatewayWorkSendResult> {
    assertGatewayWorkSend(input, this);
    if (input.target.channelType !== "feishu") throw new GatewayWorkNotSentError("飞书通知目标不匹配");
    let token: string;
    try { token = await this.refreshToken(input.signal); }
    catch { throw new GatewayWorkNotSentError("飞书连接授权不可用，本次未发送", true); }
    assertGatewayWorkSend(input, this);
    return postGatewayWork({ label: "飞书", signal: input.signal,
      url: input.target.address.replyToMessageId
        ? `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(input.target.address.replyToMessageId)}/reply`
        : "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=" + (input.target.address.threadId ? "thread_id" : "chat_id"),
      headers: { Authorization: `Bearer ${token}` },
      body: { ...(input.target.address.replyToMessageId ? { reply_in_thread: Boolean(input.target.address.threadId) }
        : { receive_id: input.target.address.threadId || input.target.address.chatId }),
        msg_type: "text", content: JSON.stringify({ text: input.text }) },
      interpret(data, response) {
        if (typeof data.code === "number" && data.code !== 0) return providerRejected("飞书", data.code);
        const detail = data.data as { message_id?: unknown; chat_id?: unknown } | undefined;
        return response.ok && data.code === 0 && typeof detail?.message_id === "string" && detail.message_id.length > 0
          && (!detail.chat_id || detail.chat_id === input.target.chatId)
          ? { ok: true, receipt: `feishu:${detail.message_id}` } : unknownProviderReceipt("飞书");
      } });
  }

  private assertReplyGeneration(generation: number, epoch: unknown): void {
    if (!this.connected || generation !== this.generation || epoch !== this.gatewayConnectionGeneration()) throw new GatewayReplyNotSentError("Gateway 回复连接已改变，未发送");
  }

  private async sendText(chatId: string, text: string, generation: number, epoch: unknown, messageId?: string, inThread = false): Promise<void> {
    this.assertReplyGeneration(generation, epoch);
    const token = await this.refreshToken().catch(() => {
      this.assertReplyGeneration(generation, epoch);
      throw new GatewayReplyNotSentError("飞书回复授权暂不可用，未发送", true);
    });
    this.assertReplyGeneration(generation, epoch);
    const response = await fetch(messageId
      ? `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`
      : "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST", redirect: "error", signal: workRequestSignal(),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...(messageId ? { reply_in_thread: inThread } : { receive_id: chatId }),
        msg_type: "text", content: JSON.stringify({ text }) }),
    }).catch(() => { throw new Error("飞书回复回执未确认"); });
    const result = await response.json().catch(() => { throw new Error("飞书回复回执无效"); }) as { code?: number };
    if (typeof result.code === "number" && result.code !== 0) throw new GatewayReplyNotSentError("飞书回复失败，平台明确拒绝", response.status === 429);
    if (!response.ok || result.code !== 0) throw new Error("飞书回复失败，回执未确认");
  }
}

import { extractXmlTag, WxCrypt } from "./wx-crypt";

export interface WxHttpResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * 企业微信自建应用回调（HTTP Webhook MVP）
 * 配置：{ corpId, agentId, secret, token, encodingAESKey }
 */
export class WecomChannelAdapter implements ChannelAdapter {
  readonly type = "wecom" as const;
  private connected = false;
  private activated = false;
  private smart: WecomSmartRobot | null = null;
  private generation = 0;
  private config: {
    corpId?: string;
    agentId?: string;
    secret?: string;
    token?: string;
    encodingAESKey?: string;
  } = {};
  private crypt: WxCrypt | null = null;
  private accessToken: string | null = null;
  private tokenExpireAt = 0;
  private onInbound: GatewayInboundHandler | null = null;

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly smartOptions: WecomSmartRobotOptions = {},
  ) {}

  gatewayCapabilities(config?: ChannelConfig): { transport: "socket" | "webhook"; workNotifications: boolean; media?: false | "inbound" } {
    const smart = config ? config.mode === "smart" || (!config.mode && Boolean(config.botId)) : Boolean(this.smart);
    return { transport: smart ? "socket" : "webhook", workNotifications: !smart, media: smart ? "inbound" : false };
  }

  activate(): void {
    this.activated = true;
    this.smart?.activate();
  }

  setInboundHandler(handler: GatewayInboundHandler): void {
    this.onInbound = handler;
    this.smart?.setInboundHandler(handler);
  }

  async connect(config: ChannelConfig): Promise<void> {
    await this.disconnect();
    const generation = this.generation;
    this.activated = !this.smartOptions.deferInboundUntilActivated;
    if (config.mode && !["smart", "callback"].includes(String(config.mode))) throw new Error("企微 mode 必须是 smart 或 callback");
    if (config.mode === "smart" || (!config.mode && config.botId)) {
      const smart = new WecomSmartRobot(this.id, this.smartOptions);
      this.smart = smart;
      if (this.onInbound) smart.setInboundHandler(this.onInbound);
      try { await smart.connect(config); }
      catch (error) { if (this.smart === smart) this.smart = null; await smart.disconnect(); throw error; }
      if (generation !== this.generation) { await smart.disconnect(); throw new Error("Gateway 连接已取消"); }
      return;
    }
    this.config = {
      corpId: String(config.corpId ?? ""),
      agentId: String(config.agentId ?? ""),
      secret: String(config.secret ?? ""),
      token: String(config.token ?? ""),
      encodingAESKey: String(config.encodingAESKey ?? ""),
    };
    if (
      !this.config.corpId ||
      !this.config.agentId ||
      !this.config.secret ||
      !this.config.token ||
      !this.config.encodingAESKey
    ) {
      throw new Error("企微通道需要 corpId、agentId、secret、token、encodingAESKey");
    }
    this.crypt = new WxCrypt(this.config.token, this.config.encodingAESKey, this.config.corpId);
    await this.refreshToken();
    if (generation !== this.generation) throw new Error("Gateway 连接已取消");
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.generation++;
    this.activated = false;
    const smart = this.smart; this.smart = null;
    await smart?.disconnect();
    this.connected = false;
    this.accessToken = null;
    this.crypt = null;
  }

  isConnected(): boolean {
    return this.smart ? this.smart.isConnected() : this.connected;
  }

  statusText(): string {
    if (this.smart) return this.smart.statusText();
    if (!this.connected) return "未连接";
    return this.accessToken ? "已连接（Webhook）" : "连接中…";
  }

  async handleHttp(opts: {
    method: string;
    query: URLSearchParams;
    rawBody: string;
  }): Promise<WxHttpResult> {
    if (!this.activated || !this.connected || !this.crypt) {
      return { status: 503, body: "wecom not connected" };
    }
    const msgSignature = opts.query.get("msg_signature") ?? "";
    const timestamp = opts.query.get("timestamp") ?? "";
    const nonce = opts.query.get("nonce") ?? "";

    if (opts.method === "GET") {
      const echostr = opts.query.get("echostr") ?? "";
      if (!this.crypt.verify(msgSignature, timestamp, nonce, echostr)) {
        return { status: 403, body: "invalid signature" };
      }
      const { message } = this.crypt.decrypt(echostr);
      return { status: 200, body: message, contentType: "text/plain" };
    }

    if (opts.method !== "POST") {
      return { status: 405, body: "method not allowed" };
    }

    const encrypt = extractXmlTag(opts.rawBody, "Encrypt");
    if (!encrypt || !this.crypt.verify(msgSignature, timestamp, nonce, encrypt)) {
      return { status: 403, body: "invalid signature" };
    }
    const { message } = this.crypt.decrypt(encrypt);
    const msgType = extractXmlTag(message, "MsgType");
    if (msgType !== "text") {
      return { status: 200, body: "success", contentType: "text/plain" };
    }
    const text = extractXmlTag(message, "Content");
    const fromUser = extractXmlTag(message, "FromUserName");
    const chatId = extractXmlTag(message, "ChatId") || fromUser;
    if (!text.trim() || !chatId || !this.onInbound) {
      return { status: 200, body: "success", contentType: "text/plain" };
    }

    // The registry commits to SQLite before the callback can acknowledge success.
    const replyGeneration = this.generation;
    const delivery = this.onInbound({
      channelId: this.id,
      chatId,
      workTarget: gatewayWorkTarget({ version: 1, channelType: this.type, channelId: this.id,
        connectionKey: this.workConnectionKey(), chatId, senderId: fromUser, address: { chatId, userId: fromUser } }),
      text: text.trim(),
      messageId: extractXmlTag(message, "MsgId"),
      sender: { id: fromUser, name: fromUser },
      replyRoute: { kind: "wecom", chatId, userId: fromUser },
      reply: async (replyText: string) => {
        await this.sendText(chatId, fromUser, replyText, replyGeneration);
      },
    });
    void delivery.catch(() => console.warn("[Wecom] inbound completion failed; transport journal retained"));
    await gatewayInboundAccepted(delivery);

    return { status: 200, body: "success", contentType: "text/plain" };
  }

  private async refreshToken(signal?: AbortSignal): Promise<string> {
    const generation = this.generation;
    if (this.accessToken && Date.now() < this.tokenExpireAt - 60_000) return this.accessToken;
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.config.corpId!)}&corpsecret=${encodeURIComponent(this.config.secret!)}`;
    const res = await fetch(url, { signal: workRequestSignal(signal) });
    const data = (await res.json()) as {
      errcode?: number;
      errmsg?: string;
      access_token?: string;
      expires_in?: number;
    };
    if (data.errcode && data.errcode !== 0) {
      throw new Error(`企微 token 失败: ${data.errmsg ?? data.errcode}`);
    }
    if (!data.access_token) throw new Error("企微 token 失败: 无 access_token");
    if (generation !== this.generation) throw new Error("Gateway 连接已改变");
    this.accessToken = data.access_token;
    this.tokenExpireAt = Date.now() + (data.expires_in ?? 7200) * 1000;
    return this.accessToken;
  }

  gatewayConnectionGeneration(): unknown { return this.smart?.gatewayConnectionGeneration() ?? this.generation; }

  restoreGatewayReply(input: GatewayReplyRestoreInput): ((text: string) => Promise<void>) | undefined {
    if (this.smart) return undefined; // req_id is scoped to the departed Smart Robot socket.
    const route = input.route;
    if (route?.kind !== "wecom" || route.chatId !== input.chatId || route.userId !== input.sender?.id) {
      throw new GatewayReplyNotSentError("企微已保存回复地址不匹配");
    }
    const generation = this.generation;
    return text => this.sendText(route.chatId, route.userId, text, generation);
  }

  workConnectionKey(): string | undefined {
    if (!this.activated) return undefined;
    if (this.smart) return this.smart.workConnectionKey();
    return this.connected && this.config.corpId && this.config.agentId
      ? gatewayConnectionKey(this.type, [this.config.corpId, this.config.agentId]) : undefined;
  }

  async sendWorkNotification(input: GatewayWorkSendInput): Promise<GatewayWorkSendResult> {
    if (this.smart) throw new GatewayWorkNotSentError("企微 Smart Robot 暂不支持主动 Work 通知");
    assertGatewayWorkSend(input, this);
    if (input.target.channelType !== "wecom") throw new GatewayWorkNotSentError("企微通知目标不匹配");
    let token: string;
    try { token = await this.refreshToken(input.signal); }
    catch { throw new GatewayWorkNotSentError("企微连接授权不可用，本次未发送", true); }
    assertGatewayWorkSend(input, this);
    const { chatId, userId } = input.target.address;
    const room = chatId !== userId;
    return postGatewayWork({ label: "企微", signal: input.signal,
      url: `https://qyapi.weixin.qq.com/cgi-bin/${room ? "appchat" : "message"}/send?access_token=${encodeURIComponent(token)}`,
      body: room ? { chatid: chatId, msgtype: "text", text: { content: input.text } }
        : { touser: userId, agentid: Number(this.config.agentId), msgtype: "text", text: { content: input.text } },
      interpret(data, response) {
        if (typeof data.errcode === "number" && data.errcode !== 0) return providerRejected("企微", data.errcode);
        if (typeof data.invaliduser === "string" && data.invaliduser.split("|").includes(userId)) return providerRejected("企微", "invalid_user");
        return response.ok && data.errcode === 0
          ? { ok: true, receipt: typeof data.msgid === "string" ? `wecom:${data.msgid}` : `wecom:accepted:${input.effectKey}` }
          : unknownProviderReceipt("企微");
      } });
  }

  private assertReplyGeneration(generation: number): void {
    if (!this.connected || generation !== this.generation) throw new GatewayReplyNotSentError("Gateway 回复连接已改变，未发送");
  }

  private async sendText(chatId: string, fromUser: string, text: string, generation: number): Promise<void> {
    this.assertReplyGeneration(generation);
    const token = await this.refreshToken().catch(() => {
      this.assertReplyGeneration(generation);
      throw new GatewayReplyNotSentError("企微回复授权暂不可用，未发送", true);
    });
    this.assertReplyGeneration(generation);
    const isRoom = chatId !== fromUser && chatId.length > 0;
    const body = isRoom
      ? {
          chatid: chatId,
          msgtype: "text",
          agentid: Number(this.config.agentId),
          text: { content: text },
        }
      : {
          touser: fromUser || chatId,
          msgtype: "text",
          agentid: Number(this.config.agentId),
          text: { content: text },
        };
    const response = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/${isRoom ? "appchat" : "message"}/send?access_token=${encodeURIComponent(token)}`,
      {
        method: "POST", redirect: "error", signal: workRequestSignal(),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ).catch(() => { throw new Error("企微回复回执未确认"); });
    const result = await response.json().catch(() => { throw new Error("企微回复回执无效"); }) as { errcode?: number; invaliduser?: string };
    if (typeof result.errcode === "number" && result.errcode !== 0) throw new GatewayReplyNotSentError("企微平台拒绝回复", response.status === 429 || result.errcode === 45009);
    if (result.invaliduser?.split("|").includes(fromUser)) throw new GatewayReplyNotSentError("企微回复目标无效");
    if (!response.ok || result.errcode !== 0) throw new Error("企微回复回执未确认");
  }
}

/**
 * 微信公众号/服务号回调（HTTP Webhook MVP）
 * 配置：{ appId, appSecret, token, encodingAESKey }
 */
export class WechatMpChannelAdapter implements ChannelAdapter {
  readonly type = "wechat" as const;
  private connected = false;
  private generation = 0;
  private config: {
    appId?: string;
    appSecret?: string;
    token?: string;
    encodingAESKey?: string;
  } = {};
  private crypt: WxCrypt | null = null;
  private accessToken: string | null = null;
  private tokenExpireAt = 0;
  private onInbound: GatewayInboundHandler | null = null;

  constructor(
    readonly id: string,
    readonly name: string,
  ) {}

  setInboundHandler(handler: GatewayInboundHandler): void {
    this.onInbound = handler;
  }

  async connect(config: ChannelConfig): Promise<void> {
    await this.disconnect();
    const generation = this.generation;
    this.config = {
      appId: String(config.appId ?? ""),
      appSecret: String(config.appSecret ?? ""),
      token: String(config.token ?? ""),
      encodingAESKey: String(config.encodingAESKey ?? ""),
    };
    if (
      !this.config.appId ||
      !this.config.appSecret ||
      !this.config.token ||
      !this.config.encodingAESKey
    ) {
      throw new Error("微信通道需要 appId、appSecret、token、encodingAESKey");
    }
    this.crypt = new WxCrypt(this.config.token, this.config.encodingAESKey, this.config.appId);
    await this.refreshToken();
    if (generation !== this.generation) throw new Error("Gateway 连接已取消");
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.generation++;
    this.connected = false;
    this.accessToken = null;
    this.crypt = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  statusText(): string {
    if (!this.connected) return "未连接";
    return this.accessToken ? "已连接（公众号 Webhook）" : "连接中…";
  }

  async handleHttp(opts: {
    method: string;
    query: URLSearchParams;
    rawBody: string;
  }): Promise<WxHttpResult> {
    if (!this.connected || !this.crypt) {
      return { status: 503, body: "wechat not connected" };
    }
    const msgSignature = opts.query.get("msg_signature") ?? opts.query.get("signature") ?? "";
    const timestamp = opts.query.get("timestamp") ?? "";
    const nonce = opts.query.get("nonce") ?? "";

    if (opts.method === "GET") {
      const echostr = opts.query.get("echostr") ?? "";
      // 兼容明文模式：仅 token 签名
      if (opts.query.get("signature") && !opts.query.get("msg_signature")) {
        const plain = [this.config.token!, timestamp, nonce].sort().join("");
        const { createHash } = await import("node:crypto");
        const sig = createHash("sha1").update(plain).digest("hex");
        if (sig !== msgSignature) return { status: 403, body: "invalid signature" };
        return { status: 200, body: echostr, contentType: "text/plain" };
      }
      if (!this.crypt.verify(msgSignature, timestamp, nonce, echostr)) {
        return { status: 403, body: "invalid signature" };
      }
      const { message } = this.crypt.decrypt(echostr);
      return { status: 200, body: message, contentType: "text/plain" };
    }

    if (opts.method !== "POST") {
      return { status: 405, body: "method not allowed" };
    }

    let messageXml = opts.rawBody;
    const encrypt = extractXmlTag(opts.rawBody, "Encrypt");
    if (encrypt) {
      if (!this.crypt.verify(msgSignature, timestamp, nonce, encrypt)) {
        return { status: 403, body: "invalid signature" };
      }
      messageXml = this.crypt.decrypt(encrypt).message;
    } else {
      // Official plaintext compatibility still requires the platform token signature.
      // Without this check anyone could forge a sender and invoke the native agent.
      const { createHash } = await import("node:crypto");
      const expected = createHash("sha1").update([this.config.token!, timestamp, nonce].sort().join("")).digest("hex");
      const supplied = opts.query.get("signature") ?? "";
      if (!timestamp || !nonce || !/^[a-f0-9]{40}$/.test(supplied)
        || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return { status: 403, body: "invalid signature" };
    }

    const msgType = extractXmlTag(messageXml, "MsgType");
    if (msgType !== "text") {
      return { status: 200, body: "success", contentType: "text/plain" };
    }
    const text = extractXmlTag(messageXml, "Content");
    const fromUser = extractXmlTag(messageXml, "FromUserName");
    if (!text.trim() || !fromUser || !this.onInbound) {
      return { status: 200, body: "success", contentType: "text/plain" };
    }

    const replyGeneration = this.generation;
    const delivery = this.onInbound({
      channelId: this.id,
      chatId: fromUser,
      workTarget: gatewayWorkTarget({ version: 1, channelType: this.type, channelId: this.id,
        connectionKey: this.workConnectionKey(), chatId: fromUser, senderId: fromUser, address: { openId: fromUser } }),
      text: text.trim(),
      messageId: extractXmlTag(messageXml, "MsgId"),
      sender: { id: fromUser, name: fromUser },
      replyRoute: { kind: "wechat", openId: fromUser },
      reply: async (replyText: string) => {
        await this.sendText(fromUser, replyText, replyGeneration);
      },
    });
    void delivery.catch(() => console.warn("[Wechat] inbound completion failed; transport journal retained"));
    await gatewayInboundAccepted(delivery);

    return { status: 200, body: "success", contentType: "text/plain" };
  }

  private async refreshToken(signal?: AbortSignal): Promise<string> {
    const generation = this.generation;
    if (this.accessToken && Date.now() < this.tokenExpireAt - 60_000) return this.accessToken;
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(this.config.appId!)}&secret=${encodeURIComponent(this.config.appSecret!)}`;
    const res = await fetch(url, { signal: workRequestSignal(signal) });
    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      errmsg?: string;
      errcode?: number;
    };
    if (!data.access_token) {
      throw new Error(`微信 token 失败: ${data.errmsg ?? data.errcode ?? "unknown"}`);
    }
    if (generation !== this.generation) throw new Error("Gateway 连接已改变");
    this.accessToken = data.access_token;
    this.tokenExpireAt = Date.now() + (data.expires_in ?? 7200) * 1000;
    return this.accessToken;
  }

  gatewayConnectionGeneration(): unknown { return this.generation; }

  restoreGatewayReply(input: GatewayReplyRestoreInput): (text: string) => Promise<void> {
    const route = input.route;
    if (route?.kind !== "wechat" || route.openId !== input.chatId || route.openId !== input.sender?.id) {
      throw new GatewayReplyNotSentError("公众号已保存回复地址不匹配");
    }
    const generation = this.generation;
    return text => this.sendText(route.openId, text, generation);
  }

  workConnectionKey(): string | undefined {
    return this.connected && this.config.appId ? gatewayConnectionKey(this.type, [this.config.appId]) : undefined;
  }

  async sendWorkNotification(input: GatewayWorkSendInput): Promise<GatewayWorkSendResult> {
    assertGatewayWorkSend(input, this);
    if (input.target.channelType !== "wechat") throw new GatewayWorkNotSentError("微信通知目标不匹配");
    let token: string;
    try { token = await this.refreshToken(input.signal); }
    catch { throw new GatewayWorkNotSentError("微信连接授权不可用，本次未发送", true); }
    assertGatewayWorkSend(input, this);
    return postGatewayWork({ label: "微信", signal: input.signal,
      url: `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`,
      body: { touser: input.target.address.openId, msgtype: "text", text: { content: input.text } },
      interpret(data, response) {
        if (typeof data.errcode === "number" && data.errcode !== 0) return providerRejected("微信", data.errcode);
        return response.ok && data.errcode === 0 ? { ok: true, receipt: `wechat:accepted:${input.effectKey}` }
          : unknownProviderReceipt("微信");
      } });
  }

  private assertReplyGeneration(generation: number): void {
    if (!this.connected || generation !== this.generation) throw new GatewayReplyNotSentError("Gateway 回复连接已改变，未发送");
  }

  private async sendText(openId: string, text: string, generation: number): Promise<void> {
    this.assertReplyGeneration(generation);
    const token = await this.refreshToken().catch(() => {
      this.assertReplyGeneration(generation);
      throw new GatewayReplyNotSentError("公众号回复授权暂不可用，未发送", true);
    });
    this.assertReplyGeneration(generation);
    const response = await fetch(
      `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`,
      {
        method: "POST", redirect: "error", signal: workRequestSignal(),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          touser: openId,
          msgtype: "text",
          text: { content: text },
        }),
      },
    ).catch(() => { throw new Error("公众号回复回执未确认"); });
    const result = await response.json().catch(() => { throw new Error("公众号回复回执无效"); }) as { errcode?: number };
    if (typeof result.errcode === "number" && result.errcode !== 0) throw new GatewayReplyNotSentError("公众号平台拒绝回复", response.status === 429 || result.errcode === 45009);
    if (!response.ok || result.errcode !== 0) throw new Error("公众号回复回执未确认");
  }
}

/**
 * Telegram Bot 适配器（长轮询 getUpdates，无需公网回调）。
 * 配置：{ botToken, allowUsers? }
 * 特点：长轮询（timeout=30s）、409 冲突检测、429 退避、markdown→HTML 格式化、长消息切分。
 */
import { GatewayMediaError, withGatewayMedia, type GatewayMediaSource } from "./GatewayMedia";

const TG_API = "https://api.telegram.org/bot";
const TG_MD_TO_HTML_MAX = 4096;

interface TgMedia { file_id: string; file_name?: string; file_size?: number }

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    message_thread_id?: number;
    direct_messages_topic?: { topic_id: number };
    business_connection_id?: string;
    sender_chat?: unknown;
    chat: { id: number; type: string; title?: string };
    text?: string;
    caption?: string;
    photo?: TgMedia[];
    document?: TgMedia;
    video?: TgMedia;
    audio?: TgMedia;
    voice?: TgMedia;
    from?: { id: number; username?: string; first_name?: string; last_name?: string };
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 简单 markdown → Telegram HTML：代码块/行内代码/加粗/链接，其余原样转义（标签用占位符避免二次转义） */
export function mdToHtml(md: string): string {
  const placeholders: string[] = [];
  const stash = (s: string): string => {
    placeholders.push(s);
    return `\u0000${placeholders.length - 1}\u0000`;
  };
  // 1) 代码块：内容单独转义后存入
  let html = md.replace(/```([\w+-]*)\s*\n([\s\S]*?)```/g, (_m, _lang: string, code: string) => {
    return stash(`<pre><code>${escapeHtml(code.replace(/\s+$/, ""))}</code></pre>`);
  });
  // 2) 行内代码：内容单独转义后存入
  html = html.replace(/`([^`\n]+)`/g, (_m, inner: string) => stash(`<code>${escapeHtml(inner)}</code>`));
  // 3) 剩余裸文本转义（占位符不受影响；加粗/链接此时还是原文，* [ ] ( ) 不受转义影响）
  html = escapeHtml(html);
  // 4) 加粗 **x**（inner 已是转义后文本）
  html = html.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) => `<b>${inner}</b>`);
  // 5) 链接 [t](url)
  html = html.replace(/\[([^\[\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t: string, u: string) => {
    return `<a href="${u.replace(/"/g, "%22")}">${t}</a>`;
  });
  // 6) 还原已转义的代码块/行内代码
  return html.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => placeholders[Number(i)] ?? "");
}

/** 按 Telegram 单消息上限切分，优先在换行处断开 */
export function splitTelegramText(text: string, max: number = TG_MD_TO_HTML_MAX): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly type = "telegram" as const;
  private connected = false;
  private generation = 0;
  private config: { botToken?: string; allowUsers?: string[] } = {};
  private botUsername = "";
  private botId = "";
  private lastError = "";
  private offset = 0;
  private mediaAttempts = new Map<number, number>();
  private polling = false;
  private stopped = true;
  private onInbound: GatewayInboundHandler | null = null;

  constructor(
    readonly id: string,
    readonly name: string,
    /** 可注入 mock 地址（测试用）；默认官方 API */
    private readonly apiBase: string = TG_API,
  ) {}

  setInboundHandler(handler: GatewayInboundHandler): void {
    this.onInbound = handler;
  }

  async connect(config: ChannelConfig): Promise<void> {
    await this.disconnect();
    const generation = this.generation;
    this.config = { botToken: String(config.botToken ?? "").trim(),
      allowUsers: Array.isArray(config.allowUsers) ? config.allowUsers.filter((value): value is string => typeof value === "string").map(value => value.trim()).filter(Boolean) : [] };
    if (!this.config.botToken) {
      throw new Error("Telegram 通道需要 Bot Token（@BotFather 创建）");
    }
    const res = await fetch(`${this.apiBase}${this.config.botToken}/getMe`)
      .catch(() => { throw new Error("Telegram 身份验证请求失败"); });
    const me = (await res.json().catch(() => { throw new Error("Telegram 身份验证响应无效"); })) as { ok?: boolean; result?: { id?: number; username?: string }; description?: string };
    if (!me.ok) {
      throw new Error("Telegram token 无效");
    }
    if (generation !== this.generation) throw new Error("Telegram 连接已取消");
    this.offset = 0;
    this.mediaAttempts.clear();
    this.botUsername = me.result?.username ?? "";
    this.botId = Number.isSafeInteger(me.result?.id) && me.result!.id! > 0 ? String(me.result!.id) : "";
    this.lastError = "";
    this.stopped = false;
    this.connected = true;
    this.polling = true;
    void this.pollLoop(generation).catch((err) => {
      if (generation !== this.generation) return;
      this.lastError = "Telegram 轮询失败，将重试";
    });
  }

  async disconnect(): Promise<void> {
    this.generation++;
    this.stopped = true;
    this.polling = false;
    this.connected = false;
    this.botUsername = "";
    this.botId = "";
  }

  isConnected(): boolean {
    return this.connected;
  }

  statusText(): string {
    if (!this.connected) return this.lastError ? `连接失败：${this.lastError}` : "未连接";
    const state = this.botUsername ? `已连接（@${this.botUsername} 轮询）` : "连接中…";
    return this.lastError ? `${state}；${this.lastError}` : state;
  }

  private async pollLoop(generation: number): Promise<void> {
    while (this.polling && !this.stopped && generation === this.generation) {
      try {
        const res = await fetch(
          `${this.apiBase}${this.config.botToken}/getUpdates?timeout=30&offset=${this.offset}&allowed_updates=["message"]`,
        );
        if (generation !== this.generation || this.stopped) return;
        if (res.status === 409) {
          // 同一 bot 已有另一实例在轮询：继续轮询只会反复 409，停掉并报错
          this.lastError = "同一 bot 已被其他实例轮询（409 Conflict）";
          this.polling = false;
          this.connected = false;
          return;
        }
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("retry-after") ?? 5);
          await sleep(Math.min(retryAfter, 60) * 1000 + 500);
          continue;
        }
        const data = (await res.json()) as {
          ok?: boolean;
          result?: TgUpdate[];
          description?: string;
        };
        if (generation !== this.generation || this.stopped) return;
        if (!data.ok) {
          throw new Error("Telegram getUpdates 失败");
        }
        if (this.lastError === "Telegram 轮询失败，将重试") this.lastError = "";
        // Never acknowledge a failed update or let a later update overtake it.
        for (const upd of [...(data.result ?? [])].sort((a, b) => a.update_id - b.update_id)) {
          if (generation !== this.generation || this.stopped) return;
          if (!Number.isSafeInteger(upd.update_id) || upd.update_id < 0) throw new Error("Telegram update_id 无效");
          if (upd.update_id < this.offset) continue;
          try { await this.handleUpdate(upd); }
          catch (error) {
            if (!(error instanceof GatewayMediaError)) throw error;
            const attempts = (this.mediaAttempts.get(upd.update_id) ?? 0) + 1;
            if (error.retryable && attempts < 3) { this.mediaAttempts.set(upd.update_id, attempts); throw error; }
            this.lastError = `Telegram 附件消息 ${upd.update_id} 已拒绝：${error.message}`;
          }
          this.mediaAttempts.delete(upd.update_id);
          if (generation !== this.generation || this.stopped) return;
          this.offset = upd.update_id + 1;
        }
      } catch (err) {
        if (this.stopped || generation !== this.generation) return;
        this.lastError = "Telegram 轮询失败，将重试";
        await sleep(3000);
      }
    }
  }

  private async mediaSources(msg: NonNullable<TgUpdate["message"]>, generation: number): Promise<GatewayMediaSource[]> {
    const media: Array<{ file: TgMedia; fallback: string }> = [];
    if (msg.photo?.length) media.push({ file: msg.photo[msg.photo.length - 1], fallback: "photo.jpg" });
    for (const [kind, fallback] of [["document", "document"], ["video", "video.mp4"], ["audio", "audio.mp3"], ["voice", "voice.ogg"]] as const) {
      if (msg[kind]) media.push({ file: msg[kind]!, fallback });
    }
    const sources: GatewayMediaSource[] = [];
    for (const { file, fallback } of media) {
      this.assertReplyGeneration(generation);
      if (typeof file.file_id !== "string" || !file.file_id || file.file_id.length > 1024
        || (file.file_size !== undefined && (!Number.isSafeInteger(file.file_size) || file.file_size < 0 || file.file_size > 20 * 1024 * 1024))) {
        throw new GatewayMediaError("Telegram 媒体标识或大小无效");
      }
      let result: { file_path?: string; file_size?: number } | undefined;
      try {
        // Local Bot API paths and arbitrary API bases must never become download URLs.
        const res = await fetch(`${TG_API}${this.config.botToken}/getFile`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_id: file.file_id }), redirect: "error", signal: AbortSignal.timeout(30_000),
        });
        const data = await res.json() as { ok?: boolean; result?: typeof result };
        if (!res.ok || !data.ok) throw new GatewayMediaError("Telegram 媒体元数据获取失败", res.status === 408 || res.status === 429 || res.status >= 500);
        result = data.result;
      } catch (error) { if (error instanceof GatewayMediaError) throw error; throw new GatewayMediaError("Telegram 媒体元数据获取失败", true); }
      this.assertReplyGeneration(generation);
      const path = result?.file_path;
      if (typeof path !== "string" || path.length > 2048
        || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(path)
        || path.split("/").some(part => part === "." || part === "..")) {
        throw new GatewayMediaError("Telegram 媒体路径无效");
      }
      const size = result?.file_size ?? file.file_size;
      if (size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > 20 * 1024 * 1024)) throw new GatewayMediaError("Telegram 媒体大小无效");
      const extension = /\.[a-zA-Z0-9]{1,10}$/.exec(path)?.[0];
      const fallbackName = extension ? fallback.replace(/\.[a-zA-Z0-9]+$/, "") + extension : fallback;
      sources.push({ url: `https://api.telegram.org/file/bot${this.config.botToken}/${path}`,
        name: file.file_name || fallbackName, allowedHosts: ["api.telegram.org"], expectedSize: size,
        fetch: async (input, init) => {
          this.assertReplyGeneration(generation);
          const response = await fetch(input, init);
          if (!this.connected || generation !== this.generation) {
            await response.body?.cancel().catch(() => {});
            this.assertReplyGeneration(generation);
          }
          return response;
        } });
    }
    return sources;
  }

  private async handleUpdate(upd: TgUpdate): Promise<void> {
    const msg = upd.message;
    if (!msg || !this.onInbound) return;
    if (this.config.allowUsers?.length && (!msg.from || !this.config.allowUsers.includes(String(msg.from.id)))) return;
    const text = (msg.text || msg.caption || "").trim();
    const replyGeneration = this.generation;
    const sources = await this.mediaSources(msg, replyGeneration);
    if (!text && !sources.length) return;
    const chatId = String(msg.chat.id);
    const sender = msg.from
      ? { id: String(msg.from.id), name: msg.from.username ?? msg.from.first_name ?? `TG${msg.from.id}` }
      : undefined;
    this.assertReplyGeneration(replyGeneration);
    // The media helper bounds bytes and disk usage; no upstream error may expose a bot-token URL.
    await withGatewayMedia(sources, async attachments => {
      this.assertReplyGeneration(replyGeneration);
      await this.onInbound!({
        channelId: this.id, chatId, text,
        ...(attachments.length ? { attachments } : {}),
        messageId: String(msg.message_id), sender,
        replyRoute: { kind: "telegram", chatId, replyToMessageId: msg.message_id,
          messageThreadId: msg.message_thread_id, directMessagesTopicId: msg.direct_messages_topic?.topic_id },
        workTarget: !msg.business_connection_id && !msg.sender_chat ? gatewayWorkTarget({ version: 1,
          channelType: this.type, channelId: this.id, connectionKey: this.workConnectionKey(), chatId,
          senderId: sender?.id, address: { chatId, messageThreadId: msg.message_thread_id,
            directMessagesTopicId: msg.direct_messages_topic?.topic_id } }) : undefined,
        reply: async (replyText: string) => {
          await this.sendText(chatId, replyText, replyGeneration, {
            reply_to_message_id: msg.message_id,
            ...(msg.message_thread_id !== undefined ? { message_thread_id: msg.message_thread_id } : {}),
            ...(msg.direct_messages_topic?.topic_id !== undefined ? { direct_messages_topic_id: msg.direct_messages_topic.topic_id } : {}),
          });
        },
      });
    }).catch(error => { if (error instanceof GatewayMediaError) throw error; throw new Error("Telegram 消息或媒体处理失败，将重试"); });
  }

  gatewayConnectionGeneration(): unknown { return this.generation; }

  restoreGatewayReply(input: GatewayReplyRestoreInput): (text: string) => Promise<void> {
    const route = input.route;
    if (route?.kind !== "telegram" || route.chatId !== input.chatId
      || (route.replyToMessageId !== undefined && String(route.replyToMessageId) !== input.messageId)
      || (this.config.allowUsers?.length && (!input.sender || !this.config.allowUsers.includes(input.sender.id)))) {
      throw new GatewayReplyNotSentError("Telegram 已保存回复地址或授权不匹配");
    }
    const generation = this.generation;
    return text => this.sendText(route.chatId, text, generation, {
      ...(route.replyToMessageId !== undefined ? { reply_to_message_id: route.replyToMessageId } : {}),
      ...(route.messageThreadId !== undefined ? { message_thread_id: route.messageThreadId } : {}),
      ...(route.directMessagesTopicId !== undefined ? { direct_messages_topic_id: route.directMessagesTopicId } : {}),
    });
  }

  workConnectionKey(): string | undefined {
    return this.connected && this.botId ? gatewayConnectionKey(this.type, [this.botId]) : undefined;
  }

  async sendWorkNotification(input: GatewayWorkSendInput): Promise<GatewayWorkSendResult> {
    assertGatewayWorkSend(input, this);
    if (input.target.channelType !== "telegram") throw new GatewayWorkNotSentError("Telegram 通知目标不匹配");
    const target = input.target.address;
    return postGatewayWork({ label: "Telegram", signal: input.signal,
      url: `${this.apiBase}${this.config.botToken}/sendMessage`,
      body: { chat_id: target.chatId, text: input.text, disable_web_page_preview: true,
        ...(target.messageThreadId !== undefined ? { message_thread_id: target.messageThreadId } : {}),
        ...(target.directMessagesTopicId !== undefined ? { direct_messages_topic_id: target.directMessagesTopicId } : {}) },
      interpret(data, response) {
        if (data.ok === false && typeof data.error_code === "number") return providerRejected("Telegram", data.error_code);
        const result = data.result as { message_id?: number; chat?: { id?: number }; message_thread_id?: number } | undefined;
        return response.ok && data.ok === true && Number.isSafeInteger(result?.message_id) && result!.message_id! > 0
          && String(result?.chat?.id) === target.chatId
          && (target.messageThreadId === undefined || result?.message_thread_id === target.messageThreadId)
          ? { ok: true, receipt: `telegram:${target.chatId}:${result!.message_id}` } : unknownProviderReceipt("Telegram");
      } });
  }

  private assertReplyGeneration(generation: number): void {
    if (!this.connected || generation !== this.generation) throw new GatewayReplyNotSentError("Gateway 回复连接已改变，未发送");
  }

  private async sendText(chatId: string, text: string, generation: number, address: Record<string, number> = {}): Promise<void> {
    const html = mdToHtml(text);
    let sent = 0;
    for (const chunk of splitTelegramText(html)) {
      try { await this.sendChunk(chatId, chunk, true, generation, address); sent++; }
      catch (error) {
        // A whole-message retry would duplicate already accepted chunks.
        if (sent && error instanceof GatewayReplyNotSentError) throw new Error("Telegram 回复部分已发送，未自动重发整条内容");
        throw error;
      }
    }
  }

  private async sendChunk(chatId: string, text: string, useHtml: boolean, generation: number, address: Record<string, number> = {}): Promise<void> {
    this.assertReplyGeneration(generation);
    const body = { chat_id: Number(chatId), ...address, text, ...(useHtml ? { parse_mode: "HTML" } : {}) };
    const res = await fetch(`${this.apiBase}${this.config.botToken}/sendMessage`, {
      method: "POST", redirect: "error", signal: workRequestSignal(),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => { throw new Error("Telegram 发送请求失败"); });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; description?: string; parameters?: { retry_after?: number } } | null;
    if (res.ok && data?.ok === true) return;
    if (useHtml && data?.description?.includes("can't parse entities")) {
      // HTML 实体解析失败：退化为纯文本重发
      await this.sendChunk(chatId, text, false, generation, address);
      return;
    }
    if (res.status === 429) {
      const retryAfter = Number(data?.parameters?.retry_after ?? res.headers.get("retry-after") ?? 5);
      throw new GatewayReplyNotSentError("Telegram 达到平台发送速率上限，未发送", true,
        (Number.isFinite(retryAfter) ? Math.max(1, Math.min(retryAfter, 300)) : 5) * 1000);
    }
    if (data?.ok === false) throw new GatewayReplyNotSentError(`Telegram 平台拒绝回复（HTTP ${res.status}）`);
    throw new Error(`Telegram 发送失败（HTTP ${res.status}）`);
  }
}

void 0 as unknown as AgentService;
void 0 as unknown as GatewayEventDto;
