import type { AgentService } from "../agent/AgentService";
import type { GatewayChannelType, GatewayEventDto } from "../../shared/agent-ipc";

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
}

export interface GatewayInboundMessage {
  channelId: string;
  chatId: string;
  text: string;
  /** 平台消息 id：用于幂等去重（webhook 重试 / 轮询重复不重复执行） */
  messageId?: string;
  /** Stable Slack identities passed to the existing native task/session. */
  taskId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  /** Bot-read channel material; it cannot grant authority or start another task. */
  slackHistory?: SlackChannelHistory;
  sender?: { id: string; name?: string };
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

export type GatewayInboundHandler = (msg: GatewayInboundMessage) => Promise<void>;

/**
 * 飞书长连接 WebSocket 机器人（MVP）。
 * 配置：{ appId, appSecret }
 * 使用飞书开放平台事件订阅「接收消息」；此处实现简易轮询式 HTTP webhook 服务端点由 GatewayService 托管。
 *
 * 说明：完整长连接需 @larksuiteoapi/node-sdk；MVP 用本地 webhook 接收 + tenant_access_token 回发。
 */
export class FeishuChannelAdapter implements ChannelAdapter {
  readonly type = "feishu" as const;
  private connected = false;
  private config: { appId?: string; appSecret?: string } = {};
  private token: string | null = null;
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
    this.config = {
      appId: String(config.appId ?? ""),
      appSecret: String(config.appSecret ?? ""),
    };
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error("飞书通道需要 appId 与 appSecret");
    }
    await this.refreshToken();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.token = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  statusText(): string {
    if (!this.connected) return "未连接";
    return this.token ? "已连接（Webhook）" : "连接中…";
  }

  /** 供 Gateway HTTP webhook 调用 */
  async handleWebhookPayload(body: unknown): Promise<{ challenge?: string } | void> {
    const payload = body as {
      type?: string;
      challenge?: string;
      header?: { event_type?: string };
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

    if (payload.type === "url_verification" && payload.challenge) {
      return { challenge: payload.challenge };
    }

    const eventType = payload.header?.event_type;
    if (eventType !== "im.message.receive_v1") return;
    const msg = payload.event?.message;
    if (!msg?.chat_id || !msg.content) return;

    let text = "";
    try {
      const content = JSON.parse(msg.content) as { text?: string };
      text = content.text ?? msg.content;
    } catch {
      text = msg.content;
    }
    if (!text.trim() || !this.onInbound) return;

    await this.onInbound({
      channelId: this.id,
      chatId: msg.chat_id,
      text: text.trim(),
      messageId: msg.message_id,
      sender: payload.event?.sender?.sender_id?.open_id
        ? { id: payload.event.sender.sender_id.open_id }
        : undefined,
      reply: async (replyText: string) => {
        await this.sendText(msg.chat_id!, replyText);
      },
    });
  }

  private async refreshToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpireAt - 60_000) return this.token;
    const res = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
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
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`飞书 token 失败: ${data.msg}`);
    }
    this.token = data.tenant_access_token;
    this.tokenExpireAt = Date.now() + (data.expire ?? 7200) * 1000;
    return this.token;
  }

  private async sendText(chatId: string, text: string): Promise<void> {
    const token = await this.refreshToken();
    await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    });
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
  ) {}

  setInboundHandler(handler: GatewayInboundHandler): void {
    this.onInbound = handler;
  }

  async connect(config: ChannelConfig): Promise<void> {
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
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.accessToken = null;
    this.crypt = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  statusText(): string {
    if (!this.connected) return "未连接";
    return this.accessToken ? "已连接（Webhook）" : "连接中…";
  }

  async handleHttp(opts: {
    method: string;
    query: URLSearchParams;
    rawBody: string;
  }): Promise<WxHttpResult> {
    if (!this.connected || !this.crypt) {
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

    // 先回 success，避免企微重试；异步跑 Agent
    void this.onInbound({
      channelId: this.id,
      chatId,
      text: text.trim(),
      messageId: extractXmlTag(message, "MsgId"),
      sender: { id: fromUser, name: fromUser },
      reply: async (replyText: string) => {
        await this.sendText(chatId, fromUser, replyText);
      },
    }).catch((err) => console.warn("[Wecom] inbound failed", err));

    return { status: 200, body: "success", contentType: "text/plain" };
  }

  private async refreshToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpireAt - 60_000) return this.accessToken;
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.config.corpId!)}&corpsecret=${encodeURIComponent(this.config.secret!)}`;
    const res = await fetch(url);
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
    this.accessToken = data.access_token;
    this.tokenExpireAt = Date.now() + (data.expires_in ?? 7200) * 1000;
    return this.accessToken;
  }

  private async sendText(chatId: string, fromUser: string, text: string): Promise<void> {
    const token = await this.refreshToken();
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
    await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }
}

/**
 * 微信公众号/服务号回调（HTTP Webhook MVP）
 * 配置：{ appId, appSecret, token, encodingAESKey }
 */
export class WechatMpChannelAdapter implements ChannelAdapter {
  readonly type = "wechat" as const;
  private connected = false;
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
    this.connected = true;
  }

  async disconnect(): Promise<void> {
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

    void this.onInbound({
      channelId: this.id,
      chatId: fromUser,
      text: text.trim(),
      messageId: extractXmlTag(messageXml, "MsgId"),
      sender: { id: fromUser, name: fromUser },
      reply: async (replyText: string) => {
        await this.sendText(fromUser, replyText);
      },
    }).catch((err) => console.warn("[Wechat] inbound failed", err));

    return { status: 200, body: "success", contentType: "text/plain" };
  }

  private async refreshToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpireAt - 60_000) return this.accessToken;
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(this.config.appId!)}&secret=${encodeURIComponent(this.config.appSecret!)}`;
    const res = await fetch(url);
    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      errmsg?: string;
      errcode?: number;
    };
    if (!data.access_token) {
      throw new Error(`微信 token 失败: ${data.errmsg ?? data.errcode ?? "unknown"}`);
    }
    this.accessToken = data.access_token;
    this.tokenExpireAt = Date.now() + (data.expires_in ?? 7200) * 1000;
    return this.accessToken;
  }

  private async sendText(openId: string, text: string): Promise<void> {
    const token = await this.refreshToken();
    await fetch(
      `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          touser: openId,
          msgtype: "text",
          text: { content: text },
        }),
      },
    );
  }
}

/**
 * Telegram Bot 适配器（长轮询 getUpdates，无需公网回调）。
 * 配置：{ botToken, allowUsers? }
 * 特点：长轮询（timeout=30s）、409 冲突检测、429 退避、markdown→HTML 格式化、长消息切分。
 */
const TG_API = "https://api.telegram.org/bot";
const TG_MD_TO_HTML_MAX = 4096;

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string; title?: string };
    text?: string;
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
  private config: { botToken?: string } = {};
  private botUsername = "";
  private lastError = "";
  private offset = 0;
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
    this.config = { botToken: String(config.botToken ?? "").trim() };
    if (!this.config.botToken) {
      throw new Error("Telegram 通道需要 Bot Token（@BotFather 创建）");
    }
    const res = await fetch(`${this.apiBase}${this.config.botToken}/getMe`);
    const me = (await res.json()) as { ok?: boolean; result?: { username?: string }; description?: string };
    if (!me.ok) {
      throw new Error(`Telegram token 无效: ${me.description ?? "unknown"}`);
    }
    this.botUsername = me.result?.username ?? "";
    this.lastError = "";
    this.stopped = false;
    this.connected = true;
    this.polling = true;
    void this.pollLoop().catch((err) => {
      this.lastError = err instanceof Error ? err.message : String(err);
    });
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.polling = false;
    this.connected = false;
    this.botUsername = "";
  }

  isConnected(): boolean {
    return this.connected;
  }

  statusText(): string {
    if (!this.connected) return this.lastError ? `连接失败：${this.lastError}` : "未连接";
    return this.botUsername ? `已连接（@${this.botUsername} 轮询）` : "连接中…";
  }

  private async pollLoop(): Promise<void> {
    while (this.polling && !this.stopped) {
      try {
        const res = await fetch(
          `${this.apiBase}${this.config.botToken}/getUpdates?timeout=30&offset=${this.offset}&allowed_updates=["message"]`,
        );
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
        if (!data.ok) {
          throw new Error(`getUpdates 失败: ${data.description ?? "unknown"}`);
        }
        for (const upd of data.result ?? []) {
          this.offset = Math.max(this.offset, upd.update_id + 1);
          void this.handleUpdate(upd).catch((err) =>
            console.warn("[Telegram] handleUpdate failed", err),
          );
        }
      } catch (err) {
        if (this.stopped) return;
        this.lastError = err instanceof Error ? err.message : String(err);
        await sleep(3000);
      }
    }
  }

  private async handleUpdate(upd: TgUpdate): Promise<void> {
    const msg = upd.message;
    if (!msg?.text?.trim() || !this.onInbound) return;
    const chatId = String(msg.chat.id);
    const sender = msg.from
      ? {
          id: String(msg.from.id),
          name: msg.from.username ?? msg.from.first_name ?? `TG${msg.from.id}`,
        }
      : undefined;
    await this.onInbound({
      channelId: this.id,
      chatId,
      text: msg.text.trim(),
      messageId: String(msg.message_id),
      sender,
      reply: async (replyText: string) => {
        await this.sendText(chatId, replyText);
      },
    });
  }

  private async sendText(chatId: string, text: string): Promise<void> {
    const html = mdToHtml(text);
    for (const chunk of splitTelegramText(html)) {
      await this.sendChunk(chatId, chunk, true);
    }
  }

  private async sendChunk(chatId: string, text: string, useHtml: boolean): Promise<void> {
    const body = { chat_id: Number(chatId), text, ...(useHtml ? { parse_mode: "HTML" } : {}) };
    const res = await fetch(`${this.apiBase}${this.config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return;
    const data = (await res.json().catch(() => null)) as { description?: string } | null;
    if (useHtml && data?.description?.includes("can't parse entities")) {
      // HTML 实体解析失败：退化为纯文本重发
      await this.sendChunk(chatId, text, false);
      return;
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? 5);
      await sleep(Math.min(retryAfter, 60) * 1000 + 500);
      await this.sendChunk(chatId, text, useHtml);
      return;
    }
    throw new Error(`Telegram 发送失败: ${data?.description ?? res.status}`);
  }
}

void 0 as unknown as AgentService;
void 0 as unknown as GatewayEventDto;
