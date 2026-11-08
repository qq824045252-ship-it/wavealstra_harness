import { withGatewayMedia, GatewayMediaError, GATEWAY_MEDIA_LIMITS, type GatewayMediaSource } from './GatewayMedia';
import { randomUUID } from 'node:crypto';
import { BoundedTTLCache } from './BoundedTTLCache';
import { GatewayReplyNotSentError, GatewayRouteEncodingError, type GatewayReplyRestoreInput, type GatewayRouteCodec, type GatewayReplyRoute } from './GatewayReply';
import type { ChannelAdapter, ChannelConfig, GatewayInboundHandler } from './channels';
import { gatewayConnectionKey } from './work-outbound';
import { IlinkError, WeixinIlinkClient, ilinkBase, object } from './WeixinIlinkClient';

interface ReplyContext { token: string; expiresAt: number }
const CONTEXT_RETENTION_MS = 24 * 60 * 60_000;
interface Config { accountId: string; botToken: string; baseUrl: string; userId: string; allowUsers: string[] }
/** Personal Weixin iLink, not WeChat MP or WeCom. No webhook or user password. */
export class WeixinIlinkAdapter implements ChannelAdapter {
  readonly type = 'weixin' as const;
  private controller = new AbortController();
  private config: Config | null = null;
  private connected = false;
  private activated = false;
  private status = '未连接';
  private inbound: GatewayInboundHandler | null = null;
  // Retain reply capability only within a bounded local window; the server may expire it earlier.
  private readonly contexts: BoundedTTLCache<string, ReplyContext>;
  private readonly seen: BoundedTTLCache<string, 'received' | 'rejected-capability'>;
  private readonly mediaAttempts: BoundedTTLCache<string, number>;
  private client: WeixinIlinkClient;
  constructor(readonly id: string, readonly name: string, private readonly options: {
    fetch?: typeof fetch; mediaDirectory?: string; deferInboundUntilActivated?: boolean; onStatus?: (text: string) => void;
    now?: () => number; replySecrets?: GatewayRouteCodec;
  } = {}) {
    this.client = new WeixinIlinkClient(options.fetch);
    this.contexts = new BoundedTTLCache({ maxEntries: 1024, ttlMs: CONTEXT_RETENTION_MS, now: options.now });
    this.seen = new BoundedTTLCache({ maxEntries: 4096, ttlMs: 24 * 60 * 60_000, now: options.now });
    this.mediaAttempts = new BoundedTTLCache({ maxEntries: 4096, ttlMs: 60 * 60_000, now: options.now });
  }
  setInboundHandler(handler: GatewayInboundHandler): void { this.inbound = handler; }
  isConnected(): boolean { return this.connected; }
  statusText(): string { return this.status; }
  gatewayConnectionGeneration(): unknown { return this.controller; }
  workConnectionKey(): string | undefined { return this.connected && this.activated && this.config
    ? gatewayConnectionKey(this.type, [this.config.accountId, this.config.userId]) : undefined; }
  private report(text: string): void { this.status = text; this.options.onStatus?.(text); }
  async connect(raw: ChannelConfig): Promise<void> {
    const required = ['accountId', 'botToken', 'baseUrl', 'userId'] as const;
    for (const key of required) if (typeof raw[key] !== 'string' || !(raw[key] as string).trim()) throw new Error('微信需要完整的扫码凭据');
    if (!Array.isArray(raw.allowUsers) || !raw.allowUsers.length || raw.allowUsers.some(v => typeof v !== 'string' || !v.trim())) throw new Error('微信必须设置允许用户');
    const config = { accountId: String(raw.accountId), botToken: String(raw.botToken), baseUrl: ilinkBase(String(raw.baseUrl)),
      userId: String(raw.userId), allowUsers: [...new Set(raw.allowUsers as string[])] };
    await this.disconnect();
    this.controller = new AbortController(); this.config = config; this.connected = true;
    this.report('微信已配置，等待长轮询');
    if (!this.options.deferInboundUntilActivated) this.activate();
  }
  activate(): void {
    if (!this.connected || this.activated || !this.config) return;
    this.activated = true;
    void this.poll(this.controller, this.config);
  }
  async disconnect(): Promise<void> {
    this.controller.abort(); this.connected = false; this.activated = false; this.config = null;
    this.contexts.clear(); this.seen.clear(); this.mediaAttempts.clear(); this.status = '未连接';
  }
  restoreGatewayReply(input: GatewayReplyRestoreInput): ((text: string) => Promise<void>) | undefined {
    const route = input.route, config = this.config;
    if (!config || !this.connected || !this.activated || route?.kind !== 'weixin'
      || route.peer !== input.chatId || input.sender?.id !== route.peer || !config.allowUsers.includes(route.peer)) return undefined;
    let capability: ReplyContext | undefined;
    if (route.encryptedCapability) {
      try {
        if (!this.options.replySecrets) throw new Error('codec unavailable');
        const stored = object(JSON.parse(this.options.replySecrets.open(route.encryptedCapability)));
        if (stored.kind !== 'weixin' || stored.accountKey !== this.workConnectionKey() || stored.peer !== route.peer
          || stored.messageId !== input.messageId || stored.expiresAt !== route.expiresAt
          || typeof stored.expiresAt !== 'number' || !Number.isFinite(stored.expiresAt) || this.replyNow() > stored.expiresAt
          || typeof stored.contextToken !== 'string' || !stored.contextToken || stored.contextToken.length >= 16384) throw new Error('capability mismatch');
        capability = { token: stored.contextToken, expiresAt: stored.expiresAt };
      } catch {
        return async () => { throw new GatewayReplyNotSentError('微信临时回复凭据不可恢复或已过期，请检查任务记录后从微信重新发起请求'); };
      }
    }
    return this.createReply(route.peer, this.controller, config, capability);
  }
  private replyNow(): number { return this.options.now?.() ?? Date.now(); }
  private createReply(peer: string, controller: AbortController, config: Config, capability?: ReplyContext): (reply: string) => Promise<void> {
    return async reply => {
      if (!reply.trim()) throw new GatewayReplyNotSentError('微信回复不能为空');
      // Count UTF-16 units conservatively while keeping surrogate pairs intact.
      const chunks: string[] = []; let chunk = '';
      for (const point of reply) {
        if (chunk.length + point.length > 4000) { chunks.push(chunk); chunk = ''; }
        chunk += point;
      }
      if (chunk) chunks.push(chunk);
      let sentChunks = 0;
      try {
        for (const text of chunks) {
          if (!this.current(controller)) throw new GatewayReplyNotSentError('微信连接已更换，本次未发送');
          const context = this.contexts.get(peer) ?? capability;
          if (!context || this.replyNow() > context.expiresAt) throw new GatewayReplyNotSentError('微信会话令牌缺失或本地保留期已过，请先从微信发送新消息');
          // Only an authenticated callback or a bound, decrypted capability authorizes replies.
          const receipt = await this.client.request(config.baseUrl, 'sendmessage', config.botToken, { msg: {
            from_user_id: '', to_user_id: peer, client_id: randomUUID(), message_type: 2, message_state: 2,
            context_token: context.token, item_list: [{ type: 1, text_item: { text } }],
          } }, controller.signal);
          if (receipt.ret !== 0 && receipt.errcode !== 0) throw new Error('微信发送回执未确认，未自动重发');
          sentChunks++;
        }
      } catch (error) {
        if (sentChunks && error instanceof GatewayReplyNotSentError) throw new Error('微信回复部分已发送，后续未完成；未自动重发');
        throw error;
      }
    };
  }
  private current(controller: AbortController): boolean { return this.controller === controller && !controller.signal.aborted && this.activated; }
  private async pause(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true }); });
  }
  private async poll(controller: AbortController, config: Config): Promise<void> {
    let cursor = '', failures = 0;
    while (this.current(controller)) {
      try {
        const result = await this.client.request(config.baseUrl, 'getupdates', config.botToken, { get_updates_buf: cursor }, controller.signal);
        if (!this.current(controller)) return;
        failures = 0; this.connected = true; this.report('已连接（微信 iLink 长轮询）');
        // Sequential handling provides bounded backpressure. Never checkpoint ahead of accepted messages.
        for (const value of Array.isArray(result.msgs) ? result.msgs : []) {
          if (!this.current(controller)) return;
          await this.receive(object(value), controller, config);
        }
        if (typeof result.get_updates_buf === 'string') cursor = result.get_updates_buf;
        await this.pause(250, controller.signal); // tolerate an upstream empty/fast response without spinning
      } catch (error) {
        if (!this.current(controller)) return;
        if (error instanceof IlinkError && error.code === -14) {
          this.connected = false; this.activated = false; this.contexts.clear(); controller.abort();
          this.report('微信登录已过期，请重新扫码'); return;
        }
        this.report('微信接收暂时失败，正在重连');
        await this.pause(Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)), controller.signal);
      }
    }
  }
  private remember(key: string): void {
    this.seen.set(key, 'received');
  }
  private async receive(msg: Record<string, any>, controller: AbortController, config: Config): Promise<void> {
    const peer = msg.from_user_id, id = msg.message_id;
    if (typeof peer !== 'string' || !config.allowUsers.includes(peer) || peer === config.accountId
      || msg.message_type !== 1 || msg.group_id || (msg.message_state !== undefined && msg.message_state !== 2)
      || (msg.to_user_id && msg.to_user_id !== config.accountId)
      || (typeof id !== 'string' && typeof id !== 'number') || !String(id)) return;
    const key = JSON.stringify([config.accountId, peer, id]);
    // A duplicate rejected capability must not replace a newer usable context.
    if (this.seen.get(key) === 'rejected-capability') return;
    if (typeof msg.context_token === 'string' && msg.context_token && msg.context_token.length < 16384) {
      this.contexts.set(peer, { token: msg.context_token, expiresAt: this.replyNow() + CONTEXT_RETENTION_MS });
    }
    if (this.seen.has(key)) return;
    const items = Array.isArray(msg.item_list) ? msg.item_list : [];
    let text = items.filter(item => item?.type === 1 && typeof item.text_item?.text === 'string').map(item => item.text_item.text).join('\n').trim();
    if (text.length > 64_000 || !this.inbound) return;
    const sources: GatewayMediaSource[] = [];
    try {
      for (const item of items) {
        for (const candidate of [object(item), object(object(item?.ref_msg).message_item)]) {
          const spec = ({ 2: ['image_item', 'image.jpg'], 3: ['voice_item', 'voice.silk'],
            4: ['file_item', 'document.bin'], 5: ['video_item', 'video.mp4'] } as Record<number, string[]>)[candidate.type];
          if (!spec) continue;
          const payload = object(candidate[spec[0]]), media = { ...object(payload.media) };
          if (candidate.type === 3 && !Object.keys(media).length && typeof payload.text === 'string') {
            if (!text) text = `[Voice transcription provided by Weixin]\n${payload.text}`;
            continue;
          }
          if (candidate.type === 2 && payload.aeskey) {
            if (typeof payload.aeskey !== 'string' || !/^[a-f\d]{32}$/i.test(payload.aeskey)) throw new GatewayMediaError('微信媒体密钥无效');
            media.aes_key = Buffer.from(payload.aeskey, 'hex').toString('base64');
          }
          sources.push(this.client.mediaSource(media, candidate.type === 4 && typeof payload.file_name === 'string' ? payload.file_name : spec[1], controller.signal));
          if (sources.length > GATEWAY_MEDIA_LIMITS.count) throw new GatewayMediaError('微信附件数量超过限制');
        }
      }
    } catch {
      this.remember(key); this.mediaAttempts.delete(key);
      this.report('微信附件参数无效，已拒绝此消息；后续消息继续接收'); return;
    }
    if ((!text && !sources.length) || text.length > 64_000) return;
    this.remember(key);
    let dispatched = false, admissionFailed = false;
    try { await withGatewayMedia(sources, async attachments => {
      if (!this.current(controller)) return;
      this.mediaAttempts.delete(key);
      admissionFailed = true;
      const context = this.contexts.get(peer);
      const replyRoute: Extract<GatewayReplyRoute, { kind: 'weixin' }> = { kind: 'weixin', peer };
      if (this.options.replySecrets && context) {
        replyRoute.expiresAt = context.expiresAt;
        try {
          replyRoute.encryptedCapability = this.options.replySecrets.seal(JSON.stringify({ kind: 'weixin',
            accountKey: this.workConnectionKey(), peer, messageId: String(id), expiresAt: context.expiresAt, contextToken: context.token,
          }));
        } catch (error) {
          if (!(error instanceof GatewayRouteEncodingError)) throw error;
          // Deterministic encoding failure is a terminal ingress rejection, not
          // an inbox/keyring outage. Do not let it poison this peer's next input.
          this.contexts.delete(peer);
          this.seen.set(key, 'rejected-capability');
          admissionFailed = false;
          this.report('微信临时回复凭据无法安全存储，已拒绝此消息；后续消息继续接收');
          return;
        }
      }
      admissionFailed = false;
      dispatched = true;
      const delivery = this.inbound!({ channelId: this.id, chatId: peer, messageId: String(id), sender: { id: peer }, text: text || '[微信媒体附件]', ...(attachments.length ? { attachments } : {}),
        replyRoute, reply: this.createReply(peer, controller, config),
      });
      if (delivery.accepted) {
        admissionFailed = true;
        void delivery.catch(() => { if (this.current(controller)) this.report('微信消息处理或回执未确认，请检查任务记录；未自动重发'); });
        await delivery.accepted;
        admissionFailed = false;
      } else await delivery;
    }, { directory: this.options.mediaDirectory }); } catch (error) {
      if (!this.current(controller)) return;
      if (admissionFailed) {
        this.seen.delete(key);
        // A failed inbox commit cannot advance the provider cursor or consume media retries.
        throw new Error('微信持久接收暂时失败，等待平台重新投递');
      }
      // Only retry pre-agent transient failures, and bound attempts so a broken
      // attachment cannot indefinitely block later messages behind this cursor.
      if (!dispatched) {
        const attempts = (this.mediaAttempts.get(key) ?? 0) + 1;
        if (error instanceof GatewayMediaError && error.retryable && attempts < 3) {
          this.mediaAttempts.set(key, attempts);
          this.seen.delete(key);
          throw new GatewayMediaError('微信附件准备暂时失败', true);
        }
        this.mediaAttempts.delete(key);
        this.report(error instanceof GatewayMediaError && error.retryable
          ? '微信附件连续3次准备失败，已拒绝此消息；后续消息继续接收'
          : '微信附件不符合安全、格式或缓存限制，已拒绝此消息；后续消息继续接收');
        return;
      }
      this.report('微信消息处理或回执未确认，请检查任务记录；未自动重发');
    }
  }
}
