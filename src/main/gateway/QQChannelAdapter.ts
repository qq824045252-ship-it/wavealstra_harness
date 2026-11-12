import { deliveryFileBytes } from "../agent/work/WorkDeliveryArtifacts";
import { assertGatewayWorkSend, postGatewayWork, GatewayWorkNotSentError, type GatewayWorkSendInput, type GatewayWorkSendResult } from "./work-outbound";
import { BoundedTTLCache } from './BoundedTTLCache';
import { GatewayReplyNotSentError, type GatewayReplyRestoreInput, type GatewayReplyRoute } from './GatewayReply';
/** Official QQ bot WS protocol informed by NousResearch/hermes-agent QQ adapter
 * at 72d4433130823f506081cc1189a923b5aa67dbf0 (MIT, Copyright 2025 Nous Research).
 * See docs/third-party/hermes-agent-LICENSE.txt. No personal QQ or HTTP callback.
 */
import type { ChannelAdapter, ChannelConfig, GatewayInboundHandler } from "./channels";
import { gatewayConnectionKey, gatewayWorkTarget } from "./work-outbound";
import { GATEWAY_MEDIA_LIMITS, withGatewayMedia, type GatewayMediaSource } from "./GatewayMedia";

export interface QQSocket {
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}
export interface QQChannelOptions {
  fetch?: typeof fetch;
  socketFactory?: (url: string) => QQSocket;
  deferInboundUntilActivated?: boolean;
  onStatus?: (text: string) => void;
  readyTimeoutMs?: number;
  reconnectDelayMs?: number;
}
const obj = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string => typeof value === "string" ? value : "";
const C2C_WINDOW = 60 * 60_000, GROUP_WINDOW = 5 * 60_000;

// Exact QQ media origins only. Never infer a trusted host from event content or
// download URLs embedded in message text. Unknown QQ CDN origins fail closed.
const QQ_MEDIA_HOSTS = ["multimedia.nt.qq.com", "gchat.qpic.cn", "c2cpicdw.qpic.cn", "grouptalk.c2c.qq.com"] as const;
function qqMedia(value: unknown): GatewayMediaSource[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > GATEWAY_MEDIA_LIMITS.count) throw new Error("QQ 附件列表无效");
  return value.map((raw, index) => {
    const item = obj(raw), original = str(item.url).trim();
    const url = new URL(original.startsWith("//") ? `https:${original}` : original);
    if (url.protocol !== "https:" || !QQ_MEDIA_HOSTS.some(host => host === url.hostname)
      || url.username || url.password || url.hash || (url.port && url.port !== "443")) throw new Error("QQ 附件来源不允许");
    const size = item.size;
    if (size !== undefined && (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > GATEWAY_MEDIA_LIMITS.file)) throw new Error("QQ 附件大小无效");
    const type = str(item.content_type).toLowerCase().split(";")[0].trim();
    const extension: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
      "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav", "audio/silk": "silk", "video/mp4": "mp4", "application/pdf": "pdf" };
    // Images, files, audio and video all enter the existing Agent attachment
    // pipeline as bytes. This adapter does not claim speech transcription or
    // video understanding, and does not trust asr_refer_text/voice_wav_url.
    return { url: url.href, name: str(item.filename) || `qq-attachment-${index + 1}.${extension[type] ?? "bin"}`,
      allowedHosts: QQ_MEDIA_HOSTS, expectedSize: size as number | undefined };
  });
}

export class QQChannelAdapter implements ChannelAdapter {
  readonly type = "qq" as const;
  private generation = 0;
  private connected = false;
  private activated = false;
  private stopped = true;
  private config?: { appId: string; appSecret: string; allowUsers: string[] };
  private controller?: AbortController;
  private socket?: QQSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private lastError = "";
  private sessionId = "";
  private seq: number | null = null;
  private token = "";
  private tokenExpiry = 0;
  private tokenRequest?: Promise<string>;
  private inbound?: GatewayInboundHandler;
  private readonly seen = new BoundedTTLCache<string, { expires: number }>({ maxEntries: 10_000, ttlMs: C2C_WINDOW });
  // READY precedes Gateway persistence. Keep validated messages until activation,
  // including across a resumable socket replacement within this generation.
  private readonly pendingInbound = new Map<string, { payload: Record<string, unknown>; bytes: number; expires: number }>();
  private pendingInboundBytes = 0;
  private readonly fetcher: typeof fetch;
  constructor(readonly id: string, readonly name: string, private readonly options: QQChannelOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
  }
  setInboundHandler(handler: GatewayInboundHandler): void { this.inbound = handler; }
  isConnected(): boolean { return this.connected; }
  gatewayConnectionGeneration(): unknown { return this.socket; }
  statusText(): string { return this.lastError || (this.connected ? "已连接（QQ 官方机器人 WebSocket）" : "未连接"); }
  workConnectionKey(): string | undefined {
    return this.connected && this.activated && this.config ? gatewayConnectionKey(this.type, [this.config.appId]) : undefined;
  }
  async sendWorkNotification(input: GatewayWorkSendInput): Promise<GatewayWorkSendResult> {
    const check = () => {
      assertGatewayWorkSend(input, this);
      if (input.target.channelType !== "qq" || !this.config?.allowUsers.includes(input.target.senderId)) throw new GatewayWorkNotSentError("QQ 原始发送者未获授权");
      if (Date.now() >= input.target.address.expiresAt) throw new GatewayWorkNotSentError("QQ 原消息回复窗口已过期；官方主动推送能力未获确认，未发送");
      if (typeof input.qqMessageSequence !== "number" || !Number.isInteger(input.qqMessageSequence) || input.qqMessageSequence < 2 || input.qqMessageSequence > 5) throw new GatewayWorkNotSentError("QQ 通知缺少有效的持久回复槽位，未发送");
    };
    check();
    if (input.target.channelType !== "qq") throw new GatewayWorkNotSentError("QQ 路由不一致");
    const target = input.target;
    // One immutable effect owns one reply slot. Never send a separate caption or
    // silently select the first file from a multi-file result.
    const files = input.files ?? [];
    if (files.length > 1 || (files.length && target.address.group)) {
      throw new GatewayWorkNotSentError("fileunsupported: QQ 当前仅支持 C2C 单文件通知；多文件或群文件未发送，摘要也未发送");
    }
    const file = files[0] ? { ...files[0] } : undefined;
    if (file && (!file.name || file.name.length > 180 || /[\\/\x00-\x1f\x7f]/.test(file.name)
      || file.bytes > 10 * 1024 * 1024 || file.bytes <= 0)) throw new GatewayWorkNotSentError("QQ 文件名称无效或不在 0 < 大小 ≤ 10 MiB 的单次上传范围，未发送");
    let fileData: string | undefined;
    try { if (file) fileData = Buffer.from(deliveryFileBytes(file)).toString("base64"); }
    catch { throw new GatewayWorkNotSentError("冻结附件哈希不一致，未发送"); }
    const token = await this.refreshToken(this.generation);
    check();
    const headers = { Authorization: `QQBot ${token}`, "X-Union-Appid": this.config!.appId };
    const base = `https://api.sgroup.qq.com/v2/${target.address.group ? "groups" : "users"}/${encodeURIComponent(target.address.recipient)}`;
    let fileInfo: string | undefined;
    if (file) {
      // Tencent qqbot-nodejs media.ts: FILE=4, base64 upload does not send a message.
      const upload = await postGatewayWork({ url: base + "/files", headers, signal: input.signal, fetcher: this.fetcher, label: "QQ 文件上传",
        body: { file_type: 4, file_data: fileData, file_name: file.name, srv_send_msg: false },
        interpret: (data, response) => response.ok && str(data.file_info) && (data.code === undefined || data.code === 0)
          ? { ok: true, receipt: str(data.file_info) }
          : { ok: false, retryable: false, responseLost: false, error: "QQ 文件上传未成功，消息未发送；请核对账号文件权限" } });
      if (!upload.ok) return { ...upload, responseLost: false, retryable: false };
      fileInfo = upload.receipt;
      // Upload completion is not delivery. Cancellation, revision, expiry and account
      // changes must stop the message even when the upload already succeeded.
      check();
    }
    const result = await postGatewayWork({ url: base + "/messages", headers, signal: input.signal, fetcher: this.fetcher, label: "QQ",
      body: { content: input.text, msg_type: fileInfo ? 7 : 0,
        ...(fileInfo ? { media: { file_info: fileInfo } } : {}),
        msg_id: target.address.messageId, msg_seq: input.qqMessageSequence },
      interpret: (data, response) => response.ok && str(data.id) && (data.code === undefined || data.code === 0)
        ? { ok: true, receipt: str(data.id) }
        : { ok: false, retryable: false, responseLost: response.status >= 500 || response.ok, error: "QQ 未确认通知；可能超过回复次数或账号能力限制" } });
    if (file && result.ok) {
      // The ID acknowledges the official media+content request, not a separate
      // text message. Client rendering is a live acceptance concern.
      const receipt = JSON.stringify([{ part: `file:${file.sha256}`, name: file.name, receipt: result.receipt },
        { part: "text", receipt: result.receipt, via: "media_content" }]);
      input.recordProgress?.(receipt);
      return { ok: true, receipt };
    }
    return result;
  }

  restoreGatewayReply(input: GatewayReplyRestoreInput): ((text: string) => Promise<void>) | undefined {
    const route = input.route, senderId = input.sender?.id;
    if (!this.config || !this.connected || !this.activated || route?.kind !== "qq" || !senderId
      || !this.config.allowUsers.includes(senderId) || route.messageId !== input.messageId
      || input.chatId !== `${route.group ? "group" : "c2c"}:${route.recipient}`
      || (!route.group && route.recipient !== senderId)) return undefined;
    // The durable journal contains one final reply per inbound message. Its first
    // passive response always uses msg_seq=1, including verified pre-send retries.
    return this.createReply(route, senderId, this.generation, 1);
  }
  private createReply(route: Extract<GatewayReplyRoute, { kind: 'qq' }>, senderId: string,
    generation: number, fixedSequence?: number): (content: string) => Promise<void> {
    let sequence = 0;
    const assertReply = () => {
      try { this.assertCurrent(generation); }
      catch (error) { throw new GatewayReplyNotSentError(error instanceof Error ? error.message : "QQ 回复账号已改变"); }
      if (!this.connected || !this.activated || !this.config!.allowUsers.includes(senderId)) throw new GatewayReplyNotSentError("QQ 回复授权或连接已改变");
      if (Date.now() >= route.expiresAt || (!fixedSequence && sequence >= 5)) throw new GatewayReplyNotSentError("QQ 被动回复窗口已过期或已达 5 次上限，不支持主动推送");
    };
    return async content => {
      assertReply();
      if (!content.trim()) return;
      if (Array.from(content).length > 4000) throw new GatewayReplyNotSentError("QQ 文本回复超过 4000 字符，未发送");
      let token: string;
      try { token = await this.refreshToken(generation); }
      catch { throw new GatewayReplyNotSentError("QQ 回复授权未完成，未发送", true); }
      assertReply();
      const msgSeq = fixedSequence ?? ++sequence; // Reserve before I/O. Unknown receipts cannot be retried.
      let response: Response;
      try {
        response = await this.fetcher(`https://api.sgroup.qq.com/v2/${route.group ? "groups" : "users"}/${encodeURIComponent(route.recipient)}/messages`, {
          method: "POST", redirect: "error", signal: this.signal(), headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}`, "X-Union-Appid": this.config!.appId },
          body: JSON.stringify({ content, msg_type: 0, msg_id: route.messageId, msg_seq: msgSeq }),
        });
      } catch { throw new Error("QQ 回复回执未确认，未自动重试"); }
      const receipt = obj(await response.json().catch(() => null));
      if (response.status === 429) {
        throw new GatewayReplyNotSentError("QQ 回复被限流，未自动重试", true);
      }
      if (!response.ok && response.status >= 400 && response.status < 500) throw new GatewayReplyNotSentError("QQ 未返回成功回执，未自动重试");
      if (!response.ok || !str(receipt.id) || (receipt.code !== undefined && receipt.code !== 0)) throw new Error("QQ 未返回成功回执，未自动重试");
    };
  }
  activate(): void {
    if (!this.connected || !this.config || this.stopped) throw new Error("QQ 尚未连接");
    this.activated = true;
    const pending = [...this.pendingInbound.values()];
    this.clearPendingInbound();
    for (const { payload } of pending) this.handleMessage(payload, this.generation);
  }
  private clearPendingInbound(): void { this.pendingInbound.clear(); this.pendingInboundBytes = 0; }
  private stopInbound(): void { this.activated = false; this.clearPendingInbound(); }
  private report(message: string): void { this.lastError = message; this.options.onStatus?.(message); }
  private assertCurrent(generation: number): void {
    if (generation !== this.generation || this.stopped || !this.config || this.controller?.signal.aborted) throw new Error("QQ 连接已取消或账号已改变");
  }
  async connect(config: ChannelConfig): Promise<void> {
    const disconnected = this.disconnect();
    const generation = this.generation;
    await disconnected;
    if (generation !== this.generation) throw new Error("QQ 连接已被新请求替代");
    const appId = str(config.appId).trim(), appSecret = str(config.appSecret).trim();
    const allowUsers = Array.isArray(config.allowUsers) ? [...new Set(config.allowUsers.filter((v): v is string => typeof v === "string" && !!v.trim()).map(v => v.trim()))] : [];
    if (!/^\d+$/.test(appId) || !appSecret || !allowUsers.length) throw new Error("QQ 需要官方机器人身份与明确的允许用户，不能开放给所有人");
    this.config = { appId, appSecret, allowUsers };
    this.stopped = false; this.controller = new AbortController();
    this.activated = !this.options.deferInboundUntilActivated;
    this.attempts = 0; this.lastError = "";
    try { await this.openSocket(generation); }
    catch {
      if (generation === this.generation) { await this.disconnect(); this.report("QQ 连接失败，请检查官方机器人权限或重新绑定"); }
      throw new Error("QQ WebSocket 连接未就绪");
    }
  }
  async disconnect(): Promise<void> {
    this.generation++; this.stopped = true; this.connected = false; this.activated = false;
    this.clearPendingInbound();
    this.controller?.abort(); this.controller = undefined;
    clearInterval(this.heartbeat); clearTimeout(this.reconnectTimer);
    this.heartbeat = undefined; this.reconnectTimer = undefined;
    const socket = this.socket; this.socket = undefined;
    socket?.close();
    this.config = undefined; this.token = ""; this.tokenExpiry = 0; this.tokenRequest = undefined;
    this.sessionId = ""; this.seq = null;
  }
  private signal(): AbortSignal { return AbortSignal.any([this.controller!.signal, AbortSignal.timeout(15_000)]); }
  private async refreshToken(generation: number): Promise<string> {
    this.assertCurrent(generation);
    if (this.token && this.tokenExpiry > Date.now() + 60_000) return this.token;
    if (this.tokenRequest) return this.tokenRequest;
    const config = this.config!;
    const request = (async () => {
      const response = await this.fetcher("https://bots.qq.com/app/getAppAccessToken", { method: "POST", redirect: "error", signal: this.signal(),
        headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ appId: config.appId, clientSecret: config.appSecret }) });
      const value = obj(await response.json());
      this.assertCurrent(generation);
      const expires = Number(value.expires_in);
      if (!response.ok || !str(value.access_token) || !Number.isFinite(expires) || expires <= 0) throw new Error("QQ 授权失败");
      this.token = str(value.access_token); this.tokenExpiry = Date.now() + expires * 1000;
      return this.token;
    })();
    this.tokenRequest = request;
    try { return await request; } finally { if (this.tokenRequest === request) this.tokenRequest = undefined; }
  }
  private async openSocket(generation: number): Promise<void> {
    this.assertCurrent(generation);
    const token = await this.refreshToken(generation);
    this.assertCurrent(generation);
    const response = await this.fetcher("https://api.sgroup.qq.com/gateway", { redirect: "error", signal: this.signal(), headers: { Authorization: `QQBot ${token}` } });
    const value = obj(await response.json());
    this.assertCurrent(generation);
    const url = new URL(str(value.url));
    if (!response.ok || url.protocol !== "wss:" || !url.hostname.endsWith(".qq.com") || url.username || url.password || url.hash || (url.port && url.port !== "443")) throw new Error("QQ 网关地址无效");
    const socket = this.options.socketFactory ? this.options.socketFactory(url.href) : new WebSocket(url.href) as unknown as QQSocket;
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let ready = false, hello = false, pendingAck = false, settled = false;
      let queue = Promise.resolve();
      const live = () => generation === this.generation && !this.stopped && this.socket === socket;
      const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timeout); this.controller?.signal.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
      const abort = () => finish(new Error("QQ 连接已取消"));
      const timeout = setTimeout(() => { finish(new Error("QQ READY 超时")); socket.close(); }, this.options.readyTimeoutMs ?? 20_000);
      this.controller!.signal.addEventListener("abort", abort, { once: true });
      const fail = () => { finish(new Error("QQ WebSocket 协议错误")); socket.close(); };
      const send = (payload: unknown) => { if (live()) socket.send(JSON.stringify(payload)); };
      socket.onmessage = event => {
        queue = queue.then(async () => {
          if (!live()) return;
          if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 1024 * 1024) { fail(); return; }
          const payload = obj(JSON.parse(event.data));
          if (Number.isSafeInteger(payload.s) && Number(payload.s) >= 0) this.seq = Number(payload.s);
          const data = obj(payload.d);
          if (payload.op === 10) {
            if (hello) { fail(); return; } hello = true;
            const interval = Number(data.heartbeat_interval);
            if (!Number.isFinite(interval) || interval < 1000 || interval > 300_000) { fail(); return; }
            const accessToken = await this.refreshToken(generation);
            if (!live()) return;
            send(this.sessionId && this.seq !== null
              ? { op: 6, d: { token: `QQBot ${accessToken}`, session_id: this.sessionId, seq: this.seq } }
              : { op: 2, d: { token: `QQBot ${accessToken}`, intents: 1 << 25, shard: [0, 1], properties: { $os: "desktop", $browser: "wavealstra", $device: "wavealstra" } } });
            clearInterval(this.heartbeat);
            this.heartbeat = setInterval(() => {
              if (!live()) return;
              if (pendingAck) { socket.close(); return; }
              pendingAck = true;
              try { send({ op: 1, d: this.seq }); } catch { socket.close(); }
            }, interval * 0.8);
          } else if (payload.op === 11) pendingAck = false;
          else if (payload.op === 1) { pendingAck = true; send({ op: 1, d: this.seq }); }
          else if (payload.op === 7) socket.close();
          else if (payload.op === 9) { if (payload.d !== true) { this.sessionId = ""; this.seq = null; } socket.close(); }
          else if (payload.op === 0 && (payload.t === "READY" || payload.t === "RESUMED")) {
            if (!hello || (payload.t === "READY" && !str(data.session_id)) || (payload.t === "RESUMED" && !this.sessionId)) { fail(); return; }
            if (payload.t === "READY") this.sessionId = str(data.session_id);
            ready = true; this.connected = true; this.attempts = 0; this.report(""); finish();
          } else if (payload.op === 0 && ready) this.handleMessage(payload, generation);
        }).catch(() => { if (live()) fail(); });
      };
      socket.onerror = () => { if (live()) fail(); };
      socket.onclose = event => {
        clearTimeout(timeout);
        if (!live()) { finish(new Error("QQ 连接已取消")); return; }
        clearInterval(this.heartbeat); this.heartbeat = undefined;
        this.socket = undefined; this.connected = false;
        finish(new Error("QQ WebSocket 已关闭"));
        if ([4001, 4002, 4010, 4011, 4012, 4013, 4014].includes(event.code)) {
          this.stopped = true; this.stopInbound(); this.report("QQ 网关拒绝连接，请检查机器人权限和配置"); return;
        }
        if (event.code === 4004) { this.token = ""; this.tokenExpiry = 0; }
        if ([4006, 4007].includes(event.code) || (event.code >= 4900 && event.code <= 4913)) { this.sessionId = ""; this.seq = null; }
        if (ready) this.scheduleReconnect(generation);
      };
    });
  }
  private scheduleReconnect(generation: number): void {
    if (generation !== this.generation || this.stopped || this.reconnectTimer) return;
    if (++this.attempts > 100) { this.stopped = true; this.stopInbound(); this.report("QQ 重连次数已达上限，请重新连接"); return; }
    this.report("QQ 连接中断，正在重新连接");
    const delay = this.options.reconnectDelayMs ?? [2000, 5000, 10_000, 30_000, 60_000][Math.min(this.attempts - 1, 4)];
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.openSocket(generation).catch(() => this.scheduleReconnect(generation));
    }, delay);
  }
  private handleMessage(payload: Record<string, unknown>, generation: number): void {
    if (!this.connected || !this.inbound || !this.config || this.stopped) return;
    const group = payload.t === "GROUP_AT_MESSAGE_CREATE";
    if (!group && payload.t !== "C2C_MESSAGE_CREATE") return;
    const data = obj(payload.d), author = obj(data.author);
    const senderId = str(group ? author.member_openid : author.user_openid);
    if (author.bot === true || !this.config.allowUsers.includes(senderId)) return;
    const recipient = group ? str(data.group_openid) : senderId;
    const messageId = str(data.id), text = str(data.content).trim(), produced = Date.parse(str(data.timestamp));
    const expires = produced + (group ? GROUP_WINDOW : C2C_WINDOW);
    let media: GatewayMediaSource[];
    try { media = qqMedia(data.attachments); } catch { this.options.onStatus?.("QQ 附件被安全检查拒绝"); return; }
    if (!recipient || recipient.length > 512 || !messageId || messageId.length > 512 || senderId.length > 512 || (!text && !media.length) || text.length > 64_000 || !Number.isFinite(produced) || produced > Date.now() + 30_000 || expires <= Date.now()) return;
    const chatId = `${group ? "group" : "c2c"}:${recipient}`;
    const identity = JSON.stringify([this.config.appId, chatId, messageId]);
    if (this.seen.has(identity)) return;
    if (!this.activated) {
      for (const [key, entry] of this.pendingInbound) {
        if (entry.expires <= Date.now()) { this.pendingInbound.delete(key); this.pendingInboundBytes -= entry.bytes; }
      }
      if (this.pendingInbound.has(identity)) return;
      const buffered = { t: payload.t, d: { id: messageId, content: text, timestamp: data.timestamp, attachments: data.attachments,
        group_openid: group ? recipient : undefined, author: group ? { member_openid: senderId } : { user_openid: senderId } } };
      const bytes = Buffer.byteLength(JSON.stringify(buffered));
      if (this.pendingInbound.size >= 256 || this.pendingInboundBytes + bytes > 1024 * 1024) {
        // Never advance silently past messages we cannot retain for activation.
        // Fail the binding closed; Gateway's later activate() must reject it.
        void this.disconnect();
        this.report("QQ 待激活消息过多，连接已取消，请重新绑定");
        return;
      }
      this.pendingInbound.set(identity, { payload: buffered, bytes, expires });
      this.pendingInboundBytes += bytes;
      return;
    }
    const reservation = { expires };
    this.seen.set(identity, reservation);
    let enteredGateway = false;
    const replyRoute: Extract<GatewayReplyRoute, { kind: 'qq' }> = { kind: 'qq', recipient, group, messageId, expiresAt: expires };
    const reply = this.createReply(replyRoute, senderId, generation);
    void Promise.resolve().then(() => {
      const assertInbound = () => {
        this.assertCurrent(generation);
        if (!this.connected || !this.activated || !this.config!.allowUsers.includes(senderId) || Date.now() >= expires) throw new Error("QQ 入站授权或连接已改变");
      };
      assertInbound();
      const guardedFetch: typeof fetch = async (input, init) => {
        assertInbound();
        const response = await this.fetcher(input, { ...init, signal: AbortSignal.any([this.controller!.signal, ...(init?.signal ? [init.signal] : [])]) });
        assertInbound();
        return response;
      };
      return withGatewayMedia(media.map(item => ({ ...item, fetch: guardedFetch })), async attachments => {
        assertInbound();
        enteredGateway = true;
        const delivery = this.inbound!({ channelId: this.id, chatId, messageId, text, attachments, audience: group ? "shared" : "private", sender: { id: senderId }, workTarget: gatewayWorkTarget({ version: 1, channelType: this.type, channelId: this.id, connectionKey: this.workConnectionKey(), chatId, senderId, address: { recipient, group, messageId, expiresAt: expires } }), replyRoute, reply });
        if (delivery.accepted) {
          enteredGateway = false;
          void delivery.catch(() => {});
          await delivery.accepted;
          enteredGateway = true;
        }
        return delivery;
      });
    }).catch(() => {
      // Pre-dispatch failures have no native receipt: permit provider redelivery.
      // Once handed to Gateway the outcome may be uncertain; never start a
      // second Agent turn automatically, even if the handler later rejects.
      if (!enteredGateway && this.seen.get(identity) === reservation) this.seen.delete(identity);
      if (generation === this.generation && !this.stopped) this.options.onStatus?.(enteredGateway
        ? "QQ 消息已交给 Agent，但处理失败；为避免重复执行未自动重试"
        : "QQ 消息处理失败，尚未交给 Agent；允许平台重新投递");
    });
  }
}
