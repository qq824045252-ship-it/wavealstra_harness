import { createHash } from 'node:crypto';
import { withGatewayMedia, type GatewayMediaSource } from './GatewayMedia';
import { gatewayConnectionKey } from './work-outbound';
import type { ChannelAdapter, ChannelConfig, GatewayInboundHandler } from './channels';

export interface DiscordSocket {
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}
export interface DiscordGatewayOptions {
  fetch?: typeof fetch;
  socketFactory?: (url: string) => DiscordSocket;
  onStatus?: (status: string) => void;
  deferInboundUntilActivated?: boolean;
  reconnectDelayMs?: number;
  helloTimeoutMs?: number;
}
interface Config { botToken: string; applicationId: string; allowUsers: string[]; guildIds: string[]; allowDirectMessages: boolean; replyToMode: 'off' | 'first' | 'all' }
const snowflake = (value: unknown): value is string => typeof value === 'string' && /^\d{1,22}$/.test(value);
function parseConfig(raw: ChannelConfig): Config {
  const list = (key: string): string[] => Array.isArray(raw[key]) ? [...new Set((raw[key] as unknown[]).filter(snowflake))] : [];
  const config = { botToken: String(raw.botToken ?? '').trim(), applicationId: String(raw.applicationId ?? '').trim(),
    allowUsers: list('allowUsers'), guildIds: list('guildIds'), allowDirectMessages: raw.allowDirectMessages === true,
    replyToMode: (raw.replyToMode === 'off' || raw.replyToMode === 'all' ? raw.replyToMode : 'first') as Config['replyToMode'] };
  if (!config.botToken || /\s/.test(config.botToken) || !snowflake(config.applicationId)) throw new Error('Discord 需要官方 Bot Token 和 Application ID');
  if (!config.allowUsers.length) throw new Error('Discord 必须设置明确的允许用户 ID');
  if (!config.guildIds.length && !config.allowDirectMessages) throw new Error('Discord 必须指定服务器 ID 或明确启用私信');
  return config;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Official Bot Gateway v10 only. No user-token login, account creation or agent execution lives here. */
export class DiscordGatewayAdapter implements ChannelAdapter {
  readonly type = 'discord' as const;
  private config: Config | null = null;
  private generation = 0;
  private stopped = true;
  private connected = false;
  private activated = false;
  private socket: DiscordSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private ack = true;
  private sequence: number | null = null;
  private sessionId = '';
  private resumeUrl = '';
  private botId = '';
  private attempts = 0;
  private lastError = '';
  private seen = new Set<string>();
  private pending: Array<{ data: Record<string, unknown>; generation: number }> = [];
  private queues = new Map<string, Promise<void>>();
  private connectionWaiters = new Set<() => void>();
  private restQueue: Promise<unknown> = Promise.resolve();
  private rateLimitUntil = 0;
  private onInbound: GatewayInboundHandler | null = null;
  private fetcher: typeof fetch;
  constructor(readonly id: string, readonly name: string, private readonly options: DiscordGatewayOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
  }
  setInboundHandler(handler: GatewayInboundHandler): void { this.onInbound = handler; }
  isConnected(): boolean { return this.connected; }
  statusText(): string { return this.lastError || (this.connected ? '已连接（Discord 官方 Bot Gateway）' : '未连接'); }
  gatewayConnectionGeneration(): unknown { return this.socket; }
  workConnectionKey(): string | undefined {
    return this.connected && this.activated && this.config && this.botId
      ? gatewayConnectionKey(this.type, [this.config.applicationId, this.botId]) : undefined;
  }
  activate(): void {
    if (this.stopped) return;
    this.activated = true;
    const pending = this.pending; this.pending = [];
    for (const frame of pending) if (this.current(frame.generation)) this.receive(frame.data, frame.generation);
  }
  private report(text: string): void { this.lastError = text; this.options.onStatus?.(text); }
  private current(generation: number): boolean { return !this.stopped && this.generation === generation; }
  private wakeConnectionWaiters(): void {
    const waiters = [...this.connectionWaiters]; this.connectionWaiters.clear();
    for (const wake of waiters) wake();
  }
  private async waitForConnection(generation: number): Promise<void> {
    this.check(generation);
    while (!this.connected) {
      await new Promise<void>(resolve => this.connectionWaiters.add(resolve));
      this.check(generation);
    }
  }
  private check(generation: number): void { if (!this.current(generation)) throw new Error('Discord 连接已更换，本次未发送'); }
  async connect(raw: ChannelConfig): Promise<void> {
    const config = parseConfig(raw);
    await this.disconnect();
    const generation = this.generation;
    this.config = config; this.stopped = false;
    try {
      const user = await this.api('/users/@me', generation);
      const app = await this.api('/oauth2/applications/@me', generation);
      this.check(generation);
      if (user.bot !== true || !snowflake(user.id) || app.id !== config.applicationId) throw new Error('Discord 凭据不是指定应用的官方 Bot');
      this.botId = user.id;
      const gateway = await this.api('/gateway/bot', generation);
      const limit = object(gateway.session_start_limit);
      if (typeof limit.remaining === 'number' && limit.remaining < 1) throw new Error('Discord 会话启动配额已用尽，请稍后重试');
      await this.open(generation, this.gatewayUrl(gateway.url));
      if (!this.options.deferInboundUntilActivated) this.activate();
    } catch (error) {
      if (this.generation === generation) { await this.disconnect(); this.report(error instanceof Error && error.message.startsWith('Discord ') ? error.message : 'Discord 连接失败'); }
      throw new Error(this.lastError || 'Discord 连接已取消');
    }
  }
  async disconnect(): Promise<void> {
    this.stopped = true; this.connected = false; this.activated = false; this.generation++;
    this.wakeConnectionWaiters();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.heartbeat = this.reconnect = null;
    const socket = this.socket; this.socket = null; socket?.close();
    this.pending = [];
    this.config = null; this.botId = ''; this.sessionId = ''; this.resumeUrl = ''; this.sequence = null;
    this.lastError = ''; this.attempts = 0;
    // Seen IDs stay on this adapter across reconnects/account changes, namespaced by application and bot.
  }
  private gatewayUrl(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Discord Gateway 地址无效');
    const url = new URL(value);
    if (url.protocol !== 'wss:' || !(url.hostname === 'gateway.discord.gg' || url.hostname.endsWith('.discord.gg'))
      || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Discord Gateway 地址未获信任');
    return `${url.origin}/?v=10&encoding=json`;
  }
  private async api(path: string, generation: number, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const run = async (): Promise<Record<string, unknown>> => {
      for (let attempt = 0; attempt < 4; attempt++) {
        this.check(generation);
        const delay = this.rateLimitUntil - Date.now();
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        this.check(generation);
        let response: Response;
        try { response = await this.fetcher('https://discord.com/api/v10' + path, {
          method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: { Authorization: 'Bot ' + this.config!.botToken, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }); } catch { throw new Error('Discord 网络请求失败，发送结果可能未知；不会盲目重发'); }
        this.check(generation);
        const data = object(await response.json().catch(() => ({})));
        if (response.status === 429) {
          const retry = Number(data.retry_after ?? response.headers.get('retry-after'));
          if (!Number.isFinite(retry) || retry < 0 || retry > 300) throw new Error('Discord 限流等待时间无效或过长，请稍后重试');
          this.rateLimitUntil = Date.now() + Math.max(100, retry * 1000); continue;
        }
        if (response.headers.get('x-ratelimit-remaining') === '0') {
          const reset = Number(response.headers.get('x-ratelimit-reset-after'));
          if (Number.isFinite(reset) && reset > 0) this.rateLimitUntil = Date.now() + Math.min(reset * 1000, 300000);
        }
        if (!response.ok) throw new Error('Discord HTTP ' + response.status + '；请检查 Bot 权限和配置');
        return data;
      }
      throw new Error('Discord 请求持续限流，请稍后重试');
    };
    const request = this.restQueue.catch(() => undefined).then(run);
    this.restQueue = request;
    return request;
  }
  private async open(generation: number, url: string): Promise<void> {
    this.check(generation);
    const socket = this.options.socketFactory?.(url) ?? new WebSocket(url) as unknown as DiscordSocket;
    this.socket = socket;
    let ready = false;
    const resuming = Boolean(this.sessionId);
    const replay: Array<{ data: Record<string, unknown> }> = [];
    const live = (): boolean => this.current(generation) && socket === this.socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => { if (!settled) { settled = true; clearTimeout(timeout); error ? reject(error) : resolve(); } };
      const timeout = setTimeout(() => { finish(new Error('Discord Gateway 身份确认超时')); socket.close(); }, this.options.helloTimeoutMs ?? 15000);
      socket.onmessage = event => {
        if (!live()) return;
        let frame: Record<string, unknown>;
        try { frame = object(JSON.parse(String(event.data))); } catch { return; }
        // Resume replays dispatches before RESUMED. Keep the last committed sequence
        // until the replay can be delivered with a verified, connected account.
        if (typeof frame.s === 'number' && (ready || frame.t === 'READY' || frame.t === 'RESUMED')) this.sequence = frame.s;
        const data = object(frame.d);
        const send = (op: number, d: unknown): void => socket.send(JSON.stringify({ op, d }));
        if (frame.op === 10) {
          const interval = Number(data.heartbeat_interval);
          if (!Number.isFinite(interval) || interval < 100 || interval > 120000) { finish(new Error('Discord 心跳配置无效')); socket.close(); return; }
          if (this.heartbeat) clearInterval(this.heartbeat);
          this.ack = true;
          this.heartbeat = setInterval(() => {
            if (!live()) return;
            if (!this.ack) { socket.close(); return; }
            this.ack = false; send(1, this.sequence);
          }, interval);
          if (this.sessionId) send(6, { token: this.config!.botToken, session_id: this.sessionId, seq: this.sequence });
          else send(2, { token: this.config!.botToken,
            // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES. No privileged MESSAGE_CONTENT intent:
            // Discord includes content for bot mentions and direct messages, the only accepted inputs.
            intents: 1 | 512 | (this.config!.allowDirectMessages ? 4096 : 0),
            properties: { os: 'linux', browser: 'wavealstra', device: 'wavealstra' } });
        } else if (frame.op === 11) this.ack = true;
        else if (frame.op === 1) send(1, this.sequence);
        else if (frame.op === 7 || frame.op === 9) {
          if (frame.op === 9 && frame.d !== true) { this.sessionId = ''; this.resumeUrl = ''; this.sequence = null; }
          socket.close();
        } else if (frame.op === 0 && frame.t === 'READY') {
          if (object(data.user).id !== this.botId || object(data.user).bot !== true || object(data.application).id !== this.config!.applicationId
            || typeof data.session_id !== 'string') {
            this.stopped = true; finish(new Error('Discord Gateway Bot 身份不匹配')); socket.close(); return;
          }
          try { this.resumeUrl = this.gatewayUrl(data.resume_gateway_url); } catch { finish(new Error('Discord 恢复地址无效')); socket.close(); return; }
          this.sessionId = data.session_id; ready = true; this.connected = true; this.attempts = 0; this.report(''); this.wakeConnectionWaiters(); finish();
        } else if (frame.op === 0 && frame.t === 'RESUMED') {
          ready = true; this.connected = true; this.attempts = 0; this.report(''); this.wakeConnectionWaiters();
          for (const entry of replay) this.receive(entry.data, generation);
          replay.length = 0; finish();
        } else if (!ready && resuming && frame.op === 0 && frame.t === 'MESSAGE_CREATE') {
          // Bound recovery memory. Closing keeps the pre-resume sequence so Discord
          // can replay again; never acknowledge unseen events by advancing it.
          if (replay.length >= 1000) { finish(new Error('Discord 恢复消息过多，请稍后重试')); socket.close(); return; }
          replay.push({ data });
        } else if (ready && frame.op === 0 && frame.t === 'MESSAGE_CREATE') this.receive(data, generation);
      };
      socket.onclose = event => {
        finish(new Error('Discord Gateway 连接关闭'));
        if (socket !== this.socket || generation !== this.generation) return;
        this.socket = null; this.connected = false;
        if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null;
        if (this.stopped) { this.wakeConnectionWaiters(); return; }
        if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code ?? 0)) {
          this.stopped = true; this.wakeConnectionWaiters(); this.report('Discord 身份、Intents 或分片配置被拒绝，请检查官方 Bot 设置'); return;
        }
        if ([4007, 4009].includes(event.code ?? 0)) { this.sessionId = ''; this.resumeUrl = ''; this.sequence = null; }
        if (ready) this.schedule(generation);
      };
      socket.onerror = () => { finish(new Error('Discord WebSocket 连接失败')); socket.close(); };
    });
  }
  private schedule(generation: number): void {
    if (!this.current(generation) || this.reconnect) return;
    this.report('Discord 连接中断，正在重连');
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      void this.open(generation, this.resumeUrl || 'wss://gateway.discord.gg/?v=10&encoding=json').catch(() => {
        if (this.current(generation)) this.schedule(generation);
      });
    }, this.options.reconnectDelayMs ?? Math.min(60000, 5000 * 2 ** Math.min(this.attempts++, 4)));
  }
  private receive(data: Record<string, unknown>, generation: number): void {
    if (!this.activated) {
      if (this.pending.length < 100) this.pending.push({ data, generation });
      else this.report('Discord 启用前消息队列已满，请重发未处理消息');
      return;
    }
    const config = this.config;
    const author = object(data.author);
    if (!config || !this.activated || !this.onInbound || !snowflake(data.id) || !snowflake(data.channel_id)
      || !snowflake(author.id) || author.bot || data.webhook_id || !config.allowUsers.includes(author.id)
      || typeof data.content !== 'string' || (data.type !== undefined && data.type !== 0 && data.type !== 19)) return;
    const guild = data.guild_id;
    if (guild ? !snowflake(guild) || !config.guildIds.includes(guild) : !config.allowDirectMessages) return;
    const reference = object(data.message_reference), referenced = object(data.referenced_message);
    const repliesToBot = data.type === 19 && snowflake(reference.message_id)
      && reference.channel_id === data.channel_id && referenced.id === reference.message_id
      && object(referenced.author).id === this.botId && object(referenced.author).bot === true;
    if (guild && !repliesToBot && (!Array.isArray(data.mentions) || !data.mentions.some(value => object(value).id === this.botId))) return;
    const text = data.content.replace(new RegExp(`<@!?${this.botId}>`, 'g'), '').trim().split(config.botToken).join('[凭据已隐藏]');
    const media = Array.isArray(data.attachments) ? data.attachments : [];
    if (!text && !media.length) return;
    const scope = [this.id, config.applicationId, this.botId, guild || 'dm', data.channel_id, author.id].join(':');
    const key = `${config.applicationId}:${this.botId}:${data.id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value!);
    const messageId = data.id, channelId = data.channel_id;
    const previous = this.queues.get(scope) ?? Promise.resolve();
    let enteredGateway = false;
    const next = previous.catch(() => undefined).then(async () => {
      // A queued turn can outlive its socket. Gateway requires a live connection key;
      // keep the reserved delivery pending instead of calling it while disconnected.
      this.check(generation);
      while (!this.connected) await this.waitForConnection(generation);
      this.check(generation);
      const sources: GatewayMediaSource[] = media.map(value => {
        const item = object(value);
        // Only platform attachment records, never arbitrary links in message content.
        // The common downloader separately enforces HTTPS, host, redirect and byte limits.
        if (typeof item.url !== 'string' || typeof item.filename !== 'string'
          || !Number.isSafeInteger(item.size) || Number(item.size) < 0) throw new Error('Discord 附件元数据无效');
        const url = new URL(item.url);
        if (!/^\/attachments\/\d{1,22}\/\d{1,22}\/[^/]+$/.test(url.pathname)) throw new Error('Discord 附件地址无效');
        return { url: item.url, name: item.filename, expectedSize: Number(item.size),
          allowedHosts: ['cdn.discordapp.com', 'media.discordapp.net'], fetch: async (input, init) => {
            this.check(generation);
            const response = await this.fetcher(input, init);
            if (!this.current(generation)) {
              await response.body?.cancel().catch(() => {});
              this.check(generation);
            }
            return response;
          } };
      });
      await withGatewayMedia(sources, async attachments => {
        this.check(generation);
        while (!this.connected) await this.waitForConnection(generation);
        this.check(generation);
        // Once invoked, an error may follow real side effects: never auto-execute again.
        enteredGateway = true;
        await this.onInbound!({ channelId: this.id, chatId: scope, messageId, text, attachments, sender: { id: author.id as string },
          reply: async reply => {
            this.check(generation);
            const safe = reply.split(config.botToken).join('[凭据已隐藏]') || '任务已处理。';
            for (let index = 0; index < safe.length; index += 1900) {
              this.check(generation);
              const nonce = createHash('sha256').update(`${key}:${index}`).digest('hex').slice(0, 24);
              const receipt = await this.api(`/channels/${channelId}/messages`, generation, {
                content: safe.slice(index, index + 1900), allowed_mentions: { parse: [], replied_user: false },
                ...(config.replyToMode === 'all' || (config.replyToMode === 'first' && index === 0)
                  ? { message_reference: { message_id: messageId, fail_if_not_exists: false } } : {}), nonce, enforce_nonce: true,
              });
              if (!snowflake(receipt.id)) throw new Error('Discord 回复结果无法确认');
            }
          },
        });
      });
    }).catch(() => {
      if (!enteredGateway) this.seen.delete(key);
      if (this.current(generation)) this.report('Discord 消息处理失败，请检查任务记录；不会自动重复执行');
    })
      .finally(() => { if (this.queues.get(scope) === next) this.queues.delete(scope); });
    this.queues.set(scope, next);
  }
}
