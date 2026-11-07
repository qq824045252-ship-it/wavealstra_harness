import type { AgentService } from "../agent/AgentService";
import { timingSafeEqual } from "node:crypto";
import { assertGatewayWorkSend, gatewayConnectionKey, gatewayWorkTarget, GatewayWorkNotSentError,
  postGatewayWork, providerRejected, unknownProviderReceipt, workRequestSignal,
  type GatewayWorkSendInput, type GatewayWorkSendResult, type GatewayWorkTarget } from "./work-outbound";
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
  workConnectionKey?(): string | undefined;
  sendWorkNotification?(input: GatewayWorkSendInput): Promise<GatewayWorkSendResult>;
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
  /** Set only by the authenticated adapter; never parsed from user message text. */
  workTarget?: GatewayWorkTarget;
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
  private generation = 0;
  private config: { appId?: string; appSecret?: string; verificationToken?: string } = {};
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
    await this.disconnect();
    const generation = this.generation;
    this.config = {
      appId: String(config.appId ?? ""),
      appSecret: String(config.appSecret ?? ""),
      verificationToken: String(config.verificationToken ?? ""),
    };
    if (!this.config.appId || !this.config.appSecret || !this.config.verificationToken) {
      throw new Error("飞书通道需要 appId、appSecret 与 verificationToken，未核验的 Webhook 不会启动任务");
    }
    await this.refreshToken();
    if (generation !== this.generation) throw new Error("Gateway 连接已取消");
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.generation++;
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
    if (!this.connected || !this.config.verificationToken) throw new Error("飞书 Webhook 身份校验未配置或通道已停用");
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

    const replyGeneration = this.generation;
    await this.onInbound({
      channelId: this.id,
      chatId: msg.chat_id,
      workTarget: gatewayWorkTarget({ version: 1, channelType: this.type, channelId: this.id,
        connectionKey: this.workConnectionKey(), chatId: msg.chat_id,
        senderId: payload.event?.sender?.sender_id?.open_id, address: { chatId: msg.chat_id } }),
      text: text.trim(),
      messageId: msg.message_id,
      sender: payload.event?.sender?.sender_id?.open_id
        ? { id: payload.event.sender.sender_id.open_id }
        : undefined,
      reply: async (replyText: string) => {
        await this.sendText(msg.chat_id!, replyText, replyGeneration);
      },
    });
  }

  private async refreshToken(signal?: AbortSignal): Promise<string> {
    const generation = this.generation;
    if (this.token && Date.now() < this.tokenExpireAt - 60_000) return this.token;
    const res = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST", signal: workRequestSignal(signal),
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
    if (generation !== this.generation) throw new Error("Gateway 连接已改变");
    this.token = data.tenant_access_token;
    this.tokenExpireAt = Date.now() + (data.expire ?? 7200) * 1000;
    return this.token;
  }

  workConnectionKey(): string | undefined {
    return this.connected && this.config.appId ? gatewayConnectionKey(this.type, [this.config.appId]) : undefined;
  }

  async sendWorkNotification(input: GatewayWorkSendInput): Promise<GatewayWorkSendResult> {
    assertGatewayWorkSend(input, this);
    if (input.target.channelType !== "feishu") throw new GatewayWorkNotSentError("飞书通知目标不匹配");
    let token: string;
    try { token = await this.refreshToken(input.signal); }
    catch { throw new GatewayWorkNotSentError("飞书连接授权不可用，本次未发送", true); }
    assertGatewayWorkSend(input, this);
    return postGatewayWork({ label: "飞书", signal: input.signal,
      url: "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
      headers: { Authorization: `Bearer ${token}` },
      body: { receive_id: input.target.address.chatId, msg_type: "text", content: JSON.stringify({ text: input.text }) },
      interpret(data, response) {
        if (typeof data.code === "number" && data.code !== 0) return providerRejected("飞书", data.code);
        const detail = data.data as { message_id?: unknown; chat_id?: unknown } | undefined;
        return response.ok && data.code === 0 && typeof detail?.message_id === "string" && detail.message_id.length > 0
          && (!detail.chat_id || detail.chat_id === input.target.chatId)
          ? { ok: true, receipt: `feishu:${detail.message_id}` } : unknownProviderReceipt("飞书");
      } });
  }

  private assertReplyGeneration(generation: number): void {
    if (!this.connected || generation !== this.generation) throw new Error("Gateway 回复连接已改变，未发送");
  }

  private async sendText(chatId: string, text: string, generation: number): Promise<void> {
    this.assertReplyGeneration(generation);
    const token = await this.refreshToken();
    this.assertReplyGeneration(generation);
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
  ) {}

  setInboundHandler(handler: GatewayInboundHandler): void {
    this.onInbound = handler;
  }

  async connect(config: ChannelConfig): Promise<void> {
    await this.disconnect();
    const generation = this.generation;
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
    const replyGeneration = this.generation;
    void this.onInbound({
      channelId: this.id,
      chatId,
      workTarget: gatewayWorkTarget({ version: 1, channelType: this.type, channelId: this.id,
        connectionKey: this.workConnectionKey(), chatId, senderId: fromUser, address: { chatId, userId: fromUser } }),
      text: text.trim(),
      messageId: extractXmlTag(message, "MsgId"),
      sender: { id: fromUser, name: fromUser },
      reply: async (replyText: string) => {
        await this.sendText(chatId, fromUser, replyText, replyGeneration);
      },
    }).catch((err) => console.warn("[Wecom] inbound failed", err));

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

  workConnectionKey(): string | undefined {
    return this.connected && this.config.corpId && this.config.agentId
      ? gatewayConnectionKey(this.type, [this.config.corpId, this.config.agentId]) : undefined;
  }

  async sendWorkNotification(input: GatewayWorkSendInput): Promise<GatewayWorkSendResult> {
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
    if (!this.connected || generation !== this.generation) throw new Error("Gateway 回复连接已改变，未发送");
  }

  private async sendText(chatId: string, fromUser: string, text: string, generation: number): Promise<void> {
    this.assertReplyGeneration(generation);
    const token = await this.refreshToken();
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
    void this.onInbound({
      channelId: this.id,
      chatId: fromUser,
      workTarget: gatewayWorkTarget({ version: 1, channelType: this.type, channelId: this.id,
        connectionKey: this.workConnectionKey(), chatId: fromUser, senderId: fromUser, address: { openId: fromUser } }),
      text: text.trim(),
      messageId: extractXmlTag(messageXml, "MsgId"),
      sender: { id: fromUser, name: fromUser },
      reply: async (replyText: string) => {
        await this.sendText(fromUser, replyText, replyGeneration);
      },
    }).catch((err) => console.warn("[Wechat] inbound failed", err));

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
    if (!this.connected || generation !== this.generation) throw new Error("Gateway 回复连接已改变，未发送");
  }

  private async sendText(openId: string, text: string, generation: number): Promise<void> {
    this.assertReplyGeneration(generation);
    const token = await this.refreshToken();
    this.assertReplyGeneration(generation);
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
    message_thread_id?: number;
    direct_messages_topic?: { topic_id: number };
    business_connection_id?: string;
    sender_chat?: unknown;
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
  private generation = 0;
  private config: { botToken?: string } = {};
  private botUsername = "";
  private botId = "";
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
    await this.disconnect();
    const generation = this.generation;
    this.config = { botToken: String(config.botToken ?? "").trim() };
    if (!this.config.botToken) {
      throw new Error("Telegram 通道需要 Bot Token（@BotFather 创建）");
    }
    const res = await fetch(`${this.apiBase}${this.config.botToken}/getMe`);
    const me = (await res.json()) as { ok?: boolean; result?: { id?: number; username?: string }; description?: string };
    if (!me.ok) {
      throw new Error(`Telegram token 无效: ${me.description ?? "unknown"}`);
    }
    if (generation !== this.generation) throw new Error("Telegram 连接已取消");
    this.offset = 0;
    this.botUsername = me.result?.username ?? "";
    this.botId = Number.isSafeInteger(me.result?.id) && me.result!.id! > 0 ? String(me.result!.id) : "";
    this.lastError = "";
    this.stopped = false;
    this.connected = true;
    this.polling = true;
    void this.pollLoop(generation).catch((err) => {
      if (generation !== this.generation) return;
      this.lastError = err instanceof Error ? err.message : String(err);
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
    return this.botUsername ? `已连接（@${this.botUsername} 轮询）` : "连接中…";
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
          throw new Error(`getUpdates 失败: ${data.description ?? "unknown"}`);
        }
        for (const upd of data.result ?? []) {
          this.offset = Math.max(this.offset, upd.update_id + 1);
          void this.handleUpdate(upd).catch((err) =>
            console.warn("[Telegram] handleUpdate failed", err),
          );
        }
      } catch (err) {
        if (this.stopped || generation !== this.generation) return;
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
    const replyGeneration = this.generation;
    await this.onInbound({
      channelId: this.id,
      chatId,
      text: msg.text.trim(),
      messageId: String(msg.message_id),
      sender,
      workTarget: !msg.business_connection_id && !msg.sender_chat ? gatewayWorkTarget({ version: 1,
        channelType: this.type, channelId: this.id, connectionKey: this.workConnectionKey(), chatId,
        senderId: sender?.id, address: { chatId, messageThreadId: msg.message_thread_id,
          directMessagesTopicId: msg.direct_messages_topic?.topic_id } }) : undefined,
      reply: async (replyText: string) => {
        await this.sendText(chatId, replyText, replyGeneration);
      },
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
    if (!this.connected || generation !== this.generation) throw new Error("Gateway 回复连接已改变，未发送");
  }

  private async sendText(chatId: string, text: string, generation: number): Promise<void> {
    const html = mdToHtml(text);
    for (const chunk of splitTelegramText(html)) {
      await this.sendChunk(chatId, chunk, true, generation);
    }
  }

  private async sendChunk(chatId: string, text: string, useHtml: boolean, generation: number): Promise<void> {
    this.assertReplyGeneration(generation);
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
      await this.sendChunk(chatId, text, false, generation);
      return;
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? 5);
      await sleep(Math.min(retryAfter, 60) * 1000 + 500);
      await this.sendChunk(chatId, text, useHtml, generation);
      return;
    }
    throw new Error(`Telegram 发送失败: ${data?.description ?? res.status}`);
  }
}

void 0 as unknown as AgentService;
void 0 as unknown as GatewayEventDto;
