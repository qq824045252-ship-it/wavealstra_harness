import { randomUUID } from 'node:crypto';
import type { ChannelConfig, GatewayInboundHandler } from './channels';
import { gatewayConnectionKey } from './work-outbound';

export interface WecomSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}
export interface WecomSmartRobotOptions {
  deferInboundUntilActivated?: boolean;
  socketFactory?: (url: string) => WecomSocket;
  requestTimeoutMs?: number;
  reconnectDelayMs?: number;
  heartbeatMs?: number;
}
const MAX_CHAT_INBOUND = 64;
const MAX_TOTAL_INBOUND = 1024;
function* replyChunks(content: string): Generator<string> {
  for (let offset = 0; offset < content.length;) {
    let end = Math.min(offset + 4000, content.length);
    // Keep UTF-16 surrogate pairs intact while retaining the provider's size ceiling.
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]) && /[\uDC00-\uDFFF]/.test(content[end])) end--;
    yield content.slice(offset, end);
    offset = end;
  }
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
/** Hermes' official aibot protocol. Agent/session ownership remains in GatewayService. */
export class WecomSmartRobot {
  private socket: WecomSocket | null = null;
  private generation = 0;
  private stopped = true;
  private connected = false;
  private activated = false;
  private earlyFrames: Array<{ raw: unknown; generation: number; socket: WecomSocket }> = [];
  private botId = '';
  private secret = '';
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private cancelOpening?: () => void;
  private inbound: GatewayInboundHandler | null = null;
  private seen = new Set<string>();
  private lastError = "";
  private admission = { total: 0, chats: new Map<string, number>() };
  private queues = new Map<string, Promise<void>>();
  private pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly id: string, private readonly options: WecomSmartRobotOptions = {}) {}
  activate(): void {
    if (this.stopped) return;
    this.activated = true;
    const frames = this.earlyFrames; this.earlyFrames = [];
    for (const frame of frames) if (this.current(frame.generation) && this.socket === frame.socket) this.receive(frame.raw, frame.generation, frame.socket);
  }
  setInboundHandler(handler: GatewayInboundHandler): void { this.inbound = handler; }
  isConnected(): boolean { return this.connected; }
  statusText(): string { if (this.lastError) return this.lastError; return this.connected ? '已连接（企微 Smart Robot）' : this.stopped ? '未连接' : '企微 Smart Robot 重连中'; }
  gatewayConnectionGeneration(): unknown { return this.socket; }
  workConnectionKey(): string | undefined { return this.connected && this.activated ? gatewayConnectionKey('wecom', ['smart', this.botId]) : undefined; }
  async connect(config: ChannelConfig): Promise<void> {
    await this.disconnect();
    this.lastError = "";
    this.botId = string(config.botId).trim(); this.secret = string(config.secret).trim();
    if (!this.botId || !this.secret) throw new Error('企微 Smart Robot 需要 botId 和 secret');
    this.stopped = false;
    this.activated = !this.options.deferInboundUntilActivated;
    try { await this.open(this.generation); }
    catch (error) { await this.disconnect(); throw error; }
  }
  async disconnect(): Promise<void> {
    this.cancelOpening?.(); this.cancelOpening = undefined;
    this.stopped = true; this.activated = false; this.earlyFrames = []; this.generation++; this.connected = false;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = undefined;
    this.closeSocket(); this.seen = new Set(); this.queues.clear();
    this.admission = { total: 0, chats: new Map() };
  }
  private rejectOverload(reason = "接收队列已满"): void {
    // Stop intake visibly instead of silently acknowledging or growing an unbounded chain.
    // Already-running native turns are not replayed; stale reply closures cannot send.
    void this.disconnect();
    this.lastError = `企微${reason}，连接已停止；请稍后重新连接`;
  }
  private current(generation: number): boolean { return !this.stopped && generation === this.generation; }
  private closeSocket(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const socket = this.socket; this.socket = null;
    if (socket) { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; socket.close(); }
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('企微连接中断；发送结果可能未知')); }
    this.pending.clear();
  }
  private async open(generation: number): Promise<void> {
    if (!this.current(generation)) throw new Error('企微连接已取消');
    const socket = this.options.socketFactory?.('wss://openws.work.weixin.qq.com') ?? new WebSocket('wss://openws.work.weixin.qq.com') as unknown as WecomSocket;
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      this.cancelOpening = () => { clearTimeout(timeout); reject(new Error("企微连接已取消")); };
      const timeout = setTimeout(() => fail(), this.options.requestTimeoutMs ?? 20_000);
      const valid = (): boolean => this.current(generation) && this.socket === socket;
      const fail = (): void => {
        if (!valid()) return;
        clearTimeout(timeout); this.cancelOpening = undefined; this.connected = false;
        this.closeSocket();
        if (!ready) reject(new Error('企微 Smart Robot 连接失败'));
        else this.scheduleReconnect(generation);
      };
      socket.onclose = fail; socket.onerror = fail;
      socket.onmessage = event => {
        if (!valid()) return;
        const data = String(event.data);
        if (data.length > 1024 * 1024 || Buffer.byteLength(data, 'utf8') > 1024 * 1024) { this.rejectOverload('接收帧超过 1 MiB'); return; }
        try { this.receive(JSON.parse(data), generation, socket); }
        catch { /* Ignore malformed provider frames; never log secrets or raw messages. */ }
      };
      socket.onopen = () => {
        if (!valid()) return;
        void this.request('aibot_subscribe', randomUUID(), { bot_id: this.botId, secret: this.secret }, socket).then(() => {
          if (!valid()) return;
          clearTimeout(timeout); this.cancelOpening = undefined; ready = true; this.connected = true; resolve();
          this.heartbeat = setInterval(() => {
            void this.request('ping', randomUUID(), {}, socket).catch(fail);
          }, this.options.heartbeatMs ?? 30_000);
        }).catch(fail);
      };
    });
  }
  private scheduleReconnect(generation: number): void {
    if (!this.current(generation) || this.reconnect) return;
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      void this.open(generation).catch(() => this.scheduleReconnect(generation));
    }, this.options.reconnectDelayMs ?? 5_000);
  }
  private request(cmd: string, reqId: string, body: unknown, socket: WecomSocket): Promise<void> {
    if (this.socket !== socket || this.stopped) return Promise.reject(new Error('企微回复连接已改变，未发送'));
    if (this.pending.has(reqId)) return Promise.reject(new Error('企微回复正在等待确认'));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(reqId); reject(new Error('企微发送确认超时；结果未知，不自动重发')); }, this.options.requestTimeoutMs ?? 15_000);
      this.pending.set(reqId, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ cmd, headers: { req_id: reqId }, body })); }
      catch { clearTimeout(timer); this.pending.delete(reqId); reject(new Error('企微发送失败')); }
    });
  }
  private receive(raw: unknown, generation: number, socket: WecomSocket): void {
    const frame = object(raw), headers = object(frame.headers), body = object(frame.body);
    const reqId = string(headers.req_id), cmd = string(frame.cmd);
    const callback = ['aibot_msg_callback', 'aibot_callback', 'aibot_event_callback'].includes(cmd);
    if (!callback) {
      const pending = this.pending.get(reqId);
      if (pending) {
        this.pending.delete(reqId); clearTimeout(pending.timer);
        const code = frame.errcode ?? body.errcode;
        if (code === 0) pending.resolve(); else pending.reject(new Error('企微服务器拒绝请求或确认无效'));
      }
      return;
    }
    if (string(object(body.text).content).length > 64 * 1024) { this.rejectOverload('入站文本超过 64k'); return; }
    if (!this.activated) {
      // No success ack is fabricated. Retain bounded pre-activation callbacks until policy is ready.
      if (this.earlyFrames.length >= 100) { this.rejectOverload(); return; }
      this.earlyFrames.push({ raw, generation, socket }); return;
    }
    if (!this.connected || cmd === 'aibot_event_callback' || !reqId || body.msgtype !== 'text') return;
    const senderId = string(object(body.from).userid), chatId = string(body.chatid) || senderId;
    const messageId = string(body.msgid) || reqId;
    let text = string(object(body.text).content).trim();
    if (body.chattype === 'group') text = text.replace(/^@\S+\s*/, '').trim();
    if (!chatId || !senderId || !text || !this.inbound || this.seen.has(messageId)) return;
    const admission = this.admission;
    const chatCount = admission.chats.get(chatId) ?? 0;
    if (chatCount >= MAX_CHAT_INBOUND || admission.total >= MAX_TOTAL_INBOUND) { this.rejectOverload(); return; }
    admission.total++; admission.chats.set(chatId, chatCount + 1);
    const seen = this.seen;
    seen.add(messageId);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
    const run = (this.queues.get(chatId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!this.current(generation) || this.socket !== socket || !this.connected) { seen.delete(messageId); return; }
      await this.inbound!({ channelId: this.id, chatId, messageId, text, sender: { id: senderId },
        reply: async content => {
          if (!this.current(generation) || this.socket !== socket || !this.connected) throw new Error('企微回复连接已改变，未发送');
          // Correlate to this exact inbound request, never the latest request in the chat.
          for (const chunk of replyChunks(content)) {
            await this.request('aibot_respond_msg', reqId, { msgtype: 'markdown', markdown: { content: chunk } }, socket);
          }
        },
      });
    });
    this.queues.set(chatId, run);
    void run.catch(() => { /* Gateway reports turn failures; do not retry an uncertain send. */ }).finally(() => {
      admission.total--;
      const remaining = (admission.chats.get(chatId) ?? 1) - 1;
      if (remaining) admission.chats.set(chatId, remaining); else admission.chats.delete(chatId);
      if (this.queues.get(chatId) === run) this.queues.delete(chatId);
    });
  }
}
