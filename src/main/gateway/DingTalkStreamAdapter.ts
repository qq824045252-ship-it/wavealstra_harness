import { gatewayInboundAccepted, type ChannelAdapter, type ChannelConfig, type GatewayInboundHandler } from "./channels";
import { GatewayReplyNotSentError, type GatewayReplyRestoreInput, type GatewayRouteCodec, type GatewayReplyRoute } from "./GatewayReply";
import { BoundedTTLCache } from "./BoundedTTLCache";
import { withGatewayMedia, GatewayMediaError, GATEWAY_MEDIA_LIMITS, type GatewayMediaSource } from "./GatewayMedia";
import { gatewayConnectionKey } from "./work-outbound";

const TOPIC = "/v1.0/im/bot/messages/get";
export interface DingTalkSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}
export interface DingTalkOptions {
  replySecrets?: GatewayRouteCodec;
  deferInboundUntilActivated?: boolean;
  fetch?: typeof fetch;
  socketFactory?: (url: string) => DingTalkSocket;
  reconnectDelayMs?: number;
  handshakeTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
}
interface Config { clientId: string; clientSecret: string; corpId: string; robotCode: string; allowUsers: string[] }
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function required(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function sessionWebhook(value: unknown): URL | undefined {
  if (typeof value !== "string" || !value || value.length > 16_384) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "oapi.dingtalk.com" && !url.port
      && !url.username && !url.password && !url.hash && url.pathname === "/robot/sendBySession" ? url : undefined;
  } catch { return undefined; }
}
function configFrom(value: ChannelConfig): Config {
  const config = { clientId: required(value.clientId), clientSecret: required(value.clientSecret),
    corpId: required(value.corpId), robotCode: required(value.robotCode),
    allowUsers: Array.isArray(value.allowUsers) ? value.allowUsers.map(required).filter(Boolean) : [] };
  if (!config.clientId || !config.clientSecret || !config.corpId || !config.robotCode || !config.allowUsers.length) {
    throw new Error("钉钉需要 Client ID、Client Secret、企业 ID、Robot Code 和明确的员工 ID 白名单");
  }
  return config;
}

// Exact provider-owned hosts only. Additional CDN hosts require verified provider evidence;
// never derive this allowlist from callback data or the returned signed download URL.
const MEDIA_HOSTS = ["api.dingtalk.com", "oapi.dingtalk.com", "static.dingtalk.com"] as const;
interface MediaCode { code: string; name: string; expectedSize?: number }
function inboundContent(body: Record<string, unknown>): { text: string; media: MediaCode[] } {
  const content = object(body.content);
  let text = required(object(body.text)?.content);
  const media: MediaCode[] = [];
  const add = (item: Record<string, unknown> | undefined, kind: string) => {
    if (!item) return;
    const code = required(item.downloadCode) || required(item.pictureDownloadCode) || required(item.download_code);
    if (!code) return;
    const extension = kind === "picture" || kind === "image" ? "png" : kind === "voice" || kind === "audio" ? "ogg" : kind === "video" ? "mp4" : "bin";
    media.push({ code, name: required(item.fileName) || `attachment-${media.length + 1}.${extension}`,
      expectedSize: typeof item.fileSize === "number" ? item.fileSize : undefined });
  };
  if (["picture", "image", "file", "video"].includes(required(body.msgtype))) add(content, required(body.msgtype));
  if (body.msgtype === "audio") {
    text ||= required(content?.recognition);
    // Hermes preserves provider recognition. Keep unrecognized voice-only messages too.
    if (!text) add(content, "audio");
  }
  if (body.msgtype === "richText") {
    const items = content?.richText;
    if (Array.isArray(items)) {
      const parts: string[] = [];
      for (const value of items) {
        const item = object(value);
        if (!item) continue;
        const part = required(item.text) || required(item.content);
        if (part) parts.push(part);
        add(item, required(item.type));
      }
      text ||= parts.join(" ");
    }
  }
  return { text, media };
}

/** Official application robot Stream protocol (not a custom incoming-webhook robot).
 * Authentication is TLS + a single-use ticket obtained with app credentials. Stream
 * frames have no HTTP callback signature. Never expose an unsigned public callback.
 * Session webhooks are short-lived credentials; durable recovery requires an injected OS-encrypted codec.
 */
export class DingTalkStreamAdapter implements ChannelAdapter {
  readonly type = "dingtalk" as const;
  private config: Config | null = null;
  private socket: DingTalkSocket | null = null;
  private handler: GatewayInboundHandler | null = null;
  private generation = 0;
  private stopped = true;
  private connected = false;
  private activated = false;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private cancelOpening?: () => void;
  private controller = new AbortController();
  private readonly seen = new BoundedTTLCache<string, number>({ maxEntries: 10_000, ttlMs: 24 * 60 * 60_000 });
  private readonly preparing = new Set<string>();
  private readonly replyCapabilities = new BoundedTTLCache<string, (text: string) => Promise<void>>({ maxEntries: 1024, ttlMs: 24 * 60 * 60_000 });
  private mediaStatus = "";
  private pending = 0;
  private rateWindow = 0;
  private receivedInWindow = 0;
  private sentInWindow = 0;
  private readonly fetcher: typeof fetch;
  constructor(readonly id: string, readonly name: string, private readonly options: DingTalkOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
  }
  activate(): void { if (!this.stopped) this.activated = true; }
  setInboundHandler(handler: GatewayInboundHandler): void { this.handler = handler; }
  isConnected(): boolean { return this.connected; }
  statusText(): string { return this.connected ? "已连接（钉钉 Stream，限定企业和员工）" + this.mediaStatus : this.stopped ? "未连接" : "钉钉连接恢复中"; }
  gatewayConnectionGeneration(): unknown { return this.socket; }
  workConnectionKey(): string | undefined {
    return this.connected && this.activated && this.config
      ? gatewayConnectionKey(this.type, [this.config.corpId, this.config.clientId, this.config.robotCode]) : undefined;
  }
  async connect(value: ChannelConfig): Promise<void> {
    await this.disconnect();
    this.config = configFrom(value);
    this.stopped = false;
    this.activated = !this.options.deferInboundUntilActivated;
    this.controller = new AbortController();
    const generation = this.generation;
    try { await this.open(generation); }
    catch {
      if (generation === this.generation) await this.disconnect();
      throw new Error("钉钉 Stream 连接失败，请检查应用凭据和 Stream 模式配置");
    }
  }
  async disconnect(): Promise<void> {
    this.generation++;
    this.stopped = true;
    this.activated = false;
    this.connected = false;
    this.controller.abort();
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.heartbeatTimer);
    this.reconnectTimer = undefined;
    this.cancelOpening?.();
    this.cancelOpening = undefined;
    const socket = this.socket;
    this.socket = null;
    if (socket) { socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null; socket.close(); }
    this.config = null;
    this.seen.clear();
    this.replyCapabilities.clear();
    this.preparing.clear();
    this.mediaStatus = "";
    this.reconnectAttempts = 0;
  }
  private current(generation: number): boolean { return !this.stopped && generation === this.generation; }
  private active(generation: number, socket: DingTalkSocket): boolean {
    return this.current(generation) && this.socket === socket && this.connected;
  }
  private async open(generation: number): Promise<void> {
    const config = this.config!;
    const response = await this.fetcher("https://api.dingtalk.com/v1.0/gateway/connections/open", {
      method: "POST", redirect: "error", signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: config.clientId, clientSecret: config.clientSecret,
        subscriptions: [{ type: "CALLBACK", topic: TOPIC }], ua: "wavealstra-stream/1.0" }),
    });
    if (!response.ok) throw new Error("钉钉授权或连接请求被拒绝");
    const data = object(await response.json());
    if (!this.current(generation)) throw new Error("连接已取消");
    const endpoint = new URL(required(data?.endpoint));
    if (endpoint.protocol !== "wss:" || !endpoint.hostname.endsWith(".dingtalk.com")
      || endpoint.username || endpoint.password || (endpoint.port && endpoint.port !== "443") || !required(data?.ticket)) {
      throw new Error("钉钉返回了无效的连接地址");
    }
    endpoint.searchParams.set("ticket", required(data?.ticket));
    const socket = this.options.socketFactory?.(endpoint.href) ?? new WebSocket(endpoint.href) as unknown as DingTalkSocket;
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.cancelOpening === cancel) this.cancelOpening = undefined;
        if (error) reject(error); else resolve();
      };
      const cancel = () => finish(new Error("连接已取消"));
      this.cancelOpening = cancel;
      const timeout = setTimeout(() => { finish(new Error("钉钉握手超时")); this.lose(generation, socket); }, this.options.handshakeTimeoutMs ?? 15_000);
      socket.onopen = () => {
        if (!this.current(generation) || this.socket !== socket) { socket.close(); return; }
        this.connected = true;
        this.reconnectAttempts = 0;
        this.heartbeat(generation, socket);
        finish();
      };
      socket.onclose = socket.onerror = () => {
        finish(new Error("钉钉连接中断"));
        this.lose(generation, socket);
      };
      socket.onmessage = event => {
        if (!this.active(generation, socket)) return;
        this.heartbeat(generation, socket);
        void this.receive(event.data, generation, socket).catch(() => {
          // No provider exception, payload, URL, or credential is logged.
          console.warn("[DingTalk] 消息处理失败");
        });
      };
    });
  }
  private heartbeat(generation: number, socket: DingTalkSocket): void {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => this.lose(generation, socket), this.options.heartbeatTimeoutMs ?? 120_000);
    this.heartbeatTimer.unref?.();
  }
  private lose(generation: number, socket: DingTalkSocket): void {
    if (!this.current(generation) || this.socket !== socket) return;
    this.socket = null;
    this.connected = false;
    clearTimeout(this.heartbeatTimer);
    socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
    socket.close();
    this.scheduleReconnect(generation);
  }
  private scheduleReconnect(generation: number): void {
    if (!this.current(generation) || this.reconnectTimer) return;
    const delay = Math.min(60_000, (this.options.reconnectDelayMs ?? 2000) * 2 ** Math.min(this.reconnectAttempts++, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.current(generation)) return;
      void this.open(generation).catch(() => this.scheduleReconnect(generation));
    }, delay);
    this.reconnectTimer.unref?.();
  }
  restoreGatewayReply(input: GatewayReplyRestoreInput): ((text: string) => Promise<void>) | undefined {
    const route = input.route;
    if (!this.config || !this.connected || !this.activated || route?.kind !== "dingtalk"
      || route.chatId !== input.chatId || !input.sender || !this.config.allowUsers.includes(input.sender.id)) return undefined;
    const cached = this.replyCapabilities.get(JSON.stringify([input.chatId, input.messageId]));
    if (cached) return cached;
    try {
      if (!this.options.replySecrets || !route.encryptedCapability || !this.socket) throw new Error("capability unavailable");
      const stored = object(JSON.parse(this.options.replySecrets.open(route.encryptedCapability)));
      const webhook = sessionWebhook(stored?.webhook);
      if (!stored || !webhook || stored.kind !== "dingtalk" || stored.accountKey !== this.workConnectionKey()
        || stored.chatId !== input.chatId || stored.messageId !== input.messageId || stored.senderId !== input.sender.id
        || stored.expiresAt !== route.expiresAt || Date.now() >= route.expiresAt) throw new Error("capability mismatch");
      return this.createReply(webhook, route.expiresAt, this.generation, this.socket);
    } catch {
      return async () => { throw new GatewayReplyNotSentError("钉钉临时回复凭据不可恢复或已过期，请检查任务记录后从钉钉重新发起请求"); };
    }
  }
  private createReply(webhook: URL, expiresAt: number, generation: number, socket: DingTalkSocket): (reply: string) => Promise<void> {
    return async replyText => {
      if (!this.active(generation, socket) || !this.activated || Date.now() >= expiresAt) throw new GatewayReplyNotSentError("钉钉回复连接已改变或会话地址已过期，未发送");
      if (Date.now() - this.rateWindow >= 60_000) { this.rateWindow = Date.now(); this.receivedInWindow = this.sentInWindow = 0; }
      if (this.sentInWindow >= 20) throw new GatewayReplyNotSentError("钉钉回复达到本地速率上限，未发送", true, Math.max(1, this.rateWindow + 60_000 - Date.now()));
      if (Buffer.byteLength(replyText) > 20_000) throw new GatewayReplyNotSentError("钉钉回复过长，未发送");
      // No automatic retry after an uncertain HTTP result (avoids duplicate replies).
      this.sentInWindow++;
      let response: Response;
      try {
        response = await this.fetcher(webhook.href, { method: "POST", redirect: "error",
          signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msgtype: "text", text: { content: replyText } }) });
      } catch { throw new Error("钉钉回复回执未确认，已停止自动重发"); }
      const receipt = await response.json().catch(() => null);
      if (response.status === 429) throw new GatewayReplyNotSentError("钉钉未确认回复成功：服务器限流", true);
      if (!response.ok || object(receipt)?.errcode !== 0) throw new Error("钉钉未确认回复成功，已停止自动重发");
    };
  }
  private ack(socket: DingTalkSocket, messageId: string, code = 200, data: unknown = { response: null }): void {
    socket.send(JSON.stringify({ code, message: code === 200 ? "OK" : "Rejected",
      headers: { messageId, contentType: "application/json" }, data: JSON.stringify(data) }));
  }
  private async mediaSources(media: MediaCode[], generation: number, socket: DingTalkSocket, config: Config): Promise<GatewayMediaSource[]> {
    if (!media.length) return [];
    const assertActive = () => {
      if (!this.active(generation, socket) || !this.activated) throw new Error("钉钉附件连接已改变");
    };
    const guardedFetch: typeof fetch = async (url, init) => {
      assertActive();
      const response = await this.fetcher(url, { ...init, redirect: "error",
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000), ...(init?.signal ? [init.signal] : [])]) });
      assertActive();
      if (response.redirected) throw new GatewayMediaError("钉钉附件不允许重定向");
      return response;
    };
    const post = async (path: string, body: unknown, token?: string) => {
      const response = await guardedFetch(`https://api.dingtalk.com/v1.0/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "x-acs-dingtalk-access-token": token } : {}) },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new GatewayMediaError("钉钉附件接口请求失败", response.status === 408 || response.status === 429 || response.status >= 500);
      const data = object(await response.json());
      assertActive();
      return data;
    };
    const auth = await post("oauth2/accessToken", { appKey: config.clientId, appSecret: config.clientSecret });
    const token = required(auth?.accessToken);
    if (!token) throw new GatewayMediaError("钉钉附件授权失败");
    const sources: GatewayMediaSource[] = [];
    for (const item of media) {
      const data = await post("robot/messageFiles/download", { downloadCode: item.code, robotCode: config.robotCode }, token);
      sources.push({ url: required(data?.downloadUrl), name: item.name, expectedSize: item.expectedSize,
        allowedHosts: MEDIA_HOSTS, fetch: guardedFetch });
    }
    return sources;
  }
  private async receive(raw: unknown, generation: number, socket: DingTalkSocket): Promise<void> {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 256_000) return;
    const frame = object(JSON.parse(raw));
    const headers = object(frame?.headers);
    if (!frame || !headers || typeof frame.data !== "string") return;
    if (frame.type === "SYSTEM" && headers.topic === "disconnect") { this.lose(generation, socket); return; }
    const messageId = required(headers.messageId);
    if (!messageId) return;
    const body = object(JSON.parse(frame.data));
    if (frame.type === "SYSTEM" && headers.topic === "ping") {
      this.ack(socket, messageId, 200, { opaque: body?.opaque }); return;
    }
    if (frame.type !== "CALLBACK" || headers.topic !== TOPIC) { this.ack(socket, messageId, 404); return; }
    if (!this.activated) { this.ack(socket, messageId, 503); return; }
    const config = this.config!;
    const senderId = required(body?.senderStaffId);
    const chatId = required(body?.conversationId);

    const eventId = required(body?.msgId);
    if (!body || body.chatbotCorpId !== config.corpId || body.senderCorpId !== config.corpId
      || body.robotCode !== config.robotCode || !config.allowUsers.includes(senderId)
      || !chatId || !eventId || (body.conversationType !== "1" && body.conversationType !== "2")
      || (body.conversationType === "2" && body.isInAtList !== true)) {
      this.ack(socket, messageId, 403); return;
    }
    const { text, media } = inboundContent(body);
    if ((!text && !media.length) || !this.handler) { this.ack(socket, messageId); return; }
    if (media.length > GATEWAY_MEDIA_LIMITS.count) {
      this.mediaStatus = "；附件数量超过限制，请减少附件后重新发送";
      this.ack(socket, messageId, 200, { response: null, error: "media_rejected" });
      return;
    }
    const now = Date.now();
    const key = JSON.stringify([chatId, eventId]);
    if (this.seen.has(key)) { this.ack(socket, messageId); return; }
    const preparingKey = JSON.stringify([generation, chatId, eventId]);
    if (this.preparing.has(preparingKey)) { this.ack(socket, messageId, 503); return; }
    if (now - this.rateWindow >= 60_000) { this.rateWindow = now; this.receivedInWindow = this.sentInWindow = 0; }
    if (this.pending >= 32 || this.receivedInWindow >= 60) { this.ack(socket, messageId, 429); return; }
    const webhook = sessionWebhook(body.sessionWebhook);
    if (!webhook) {
      this.ack(socket, messageId, 403); return;
    }
    const expiresAt = Number(body.sessionWebhookExpiredTime);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) { this.ack(socket, messageId, 403); return; }
    this.receivedInWindow++;
    this.preparing.add(preparingKey);
    this.pending++;
    let admitted = false;
    try {
      const sources = await this.mediaSources(media, generation, socket, config);
      await withGatewayMedia(sources, async attachments => {
        if (!this.active(generation, socket) || !this.activated) throw new Error("钉钉连接已改变");
        const reply = this.createReply(webhook, expiresAt, generation, socket);
        this.replyCapabilities.set(key, reply);
        const replyRoute: Extract<GatewayReplyRoute, { kind: "dingtalk" }> = { kind: "dingtalk", chatId, expiresAt };
        if (this.options.replySecrets) replyRoute.encryptedCapability = this.options.replySecrets.seal(JSON.stringify({
          kind: "dingtalk", accountKey: this.workConnectionKey(), chatId, messageId: eventId, senderId, expiresAt, webhook: webhook.href,
        }));
        const delivery = this.handler!({ channelId: this.id, chatId, text: text || "请查看附件。", attachments, messageId: eventId,
          sender: { id: senderId, name: required(body.senderNick) || undefined },
          replyRoute, reply,
        });
        // Observe execution rejection immediately while awaiting durable admission.
        // ACK only after the inbox commit; a rejected admission must be redeliverable.
        void delivery.catch(() => {});
        await gatewayInboundAccepted(delivery);
        admitted = true;
        if (this.active(generation, socket) && this.activated) {
          this.seen.set(key, now);
          this.mediaStatus = "";
          this.ack(socket, messageId);
        }
        if (delivery.accepted) {
          void delivery.catch(() => { if (this.active(generation, socket)) this.mediaStatus = "；任务处理失败，请检查任务记录"; });
        } else await delivery;
      });
    } catch (error) {
      if (!admitted && this.active(generation, socket)) {
        const permanent = error instanceof GatewayMediaError && !error.retryable;
        this.mediaStatus = permanent ? "；附件被拒绝，请检查来源、权限和大小后重新发送" : "；附件暂时未接收，等待重投或请稍后重新发送";
        if (permanent) {
          this.seen.set(key, now);
          // A terminal receipt prevents repeated downloads of a rejected file.
          this.ack(socket, messageId, 200, { response: null, error: "media_rejected" });
        } else this.ack(socket, messageId, 503);
      }
      throw error;
    } finally { this.preparing.delete(preparingKey); this.pending--; }
  }
}
