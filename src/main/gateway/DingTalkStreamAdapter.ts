import type { ChannelAdapter, ChannelConfig, GatewayInboundHandler } from "./channels";
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
function configFrom(value: ChannelConfig): Config {
  const config = { clientId: required(value.clientId), clientSecret: required(value.clientSecret),
    corpId: required(value.corpId), robotCode: required(value.robotCode),
    allowUsers: Array.isArray(value.allowUsers) ? value.allowUsers.map(required).filter(Boolean) : [] };
  if (!config.clientId || !config.clientSecret || !config.corpId || !config.robotCode || !config.allowUsers.length) {
    throw new Error("钉钉需要 Client ID、Client Secret、企业 ID、Robot Code 和明确的员工 ID 白名单");
  }
  return config;
}

/** Official application robot Stream protocol (not a custom incoming-webhook robot).
 * Authentication is TLS + a single-use ticket obtained with app credentials. Stream
 * frames have no HTTP callback signature. Never expose an unsigned public callback.
 * Session webhooks are short-lived credentials and remain only in reply closures.
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
  private readonly seen = new Map<string, number>();
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
  statusText(): string { return this.connected ? "已连接（钉钉 Stream，限定企业和员工）" : this.stopped ? "未连接" : "钉钉连接恢复中"; }
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
  private ack(socket: DingTalkSocket, messageId: string, code = 200, data: unknown = { response: null }): void {
    socket.send(JSON.stringify({ code, message: code === 200 ? "OK" : "Rejected",
      headers: { messageId, contentType: "application/json" }, data: JSON.stringify(data) }));
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
    const text = required(object(body?.text)?.content);
    const eventId = required(body?.msgId);
    if (!body || body.chatbotCorpId !== config.corpId || body.senderCorpId !== config.corpId
      || body.robotCode !== config.robotCode || !config.allowUsers.includes(senderId)
      || !chatId || !eventId || (body.conversationType !== "1" && body.conversationType !== "2")
      || (body.conversationType === "2" && body.isInAtList !== true)) {
      this.ack(socket, messageId, 403); return;
    }
    if (body.msgtype !== "text" || !text || !this.handler) { this.ack(socket, messageId); return; }
    const now = Date.now();
    for (const [key, at] of this.seen) if (at < now - 24 * 60 * 60_000) this.seen.delete(key);
    const key = JSON.stringify([chatId, eventId]);
    if (this.seen.has(key)) { this.ack(socket, messageId); return; }
    if (now - this.rateWindow >= 60_000) { this.rateWindow = now; this.receivedInWindow = this.sentInWindow = 0; }
    if (this.pending >= 32 || this.seen.size >= 10_000 || this.receivedInWindow >= 60) { this.ack(socket, messageId, 429); return; }
    const webhook = new URL(required(body.sessionWebhook));
    if (webhook.protocol !== "https:" || webhook.hostname !== "oapi.dingtalk.com" || webhook.port
      || webhook.username || webhook.password || webhook.pathname !== "/robot/sendBySession") {
      this.ack(socket, messageId, 403); return;
    }
    const expiresAt = Number(body.sessionWebhookExpiredTime);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) { this.ack(socket, messageId, 403); return; }
    this.receivedInWindow++;
    this.seen.set(key, now);
    this.pending++;
    try {
      this.ack(socket, messageId);
      await this.handler({ channelId: this.id, chatId, text, messageId: eventId,
        sender: { id: senderId, name: required(body.senderNick) || undefined },
        reply: async replyText => {
          if (!this.active(generation, socket) || Date.now() >= expiresAt) throw new Error("钉钉回复连接已改变或会话地址已过期，未发送");
          if (Date.now() - this.rateWindow >= 60_000) { this.rateWindow = Date.now(); this.receivedInWindow = this.sentInWindow = 0; }
          if (this.sentInWindow >= 20) throw new Error("钉钉回复达到本地速率上限，未发送");
          if (Buffer.byteLength(replyText) > 20_000) throw new Error("钉钉回复过长，未发送");
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
          if (!response.ok || object(receipt)?.errcode !== 0) throw new Error("钉钉未确认回复成功，已停止自动重发");
        },
      });
    } finally { this.pending--; }
  }
}
