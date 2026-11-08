import { GatewayPlatformRegistry, gatewayCapabilities } from "./GatewayPlatformRegistry";
import { GatewayRouter } from "./GatewayRouter";
import { GatewaySecrets, GATEWAY_SECRET_FIELDS, GATEWAY_REDACTED } from "./GatewaySecrets";
import { createIdempotencyGuard, isAllowedUser } from "./GatewayRateLimiter";
export { createIdempotencyGuard, isAllowedUser } from "./GatewayRateLimiter";
export { GATEWAY_REDACTED } from "./GatewaySecrets";
import { GatewayLifecycleManager } from "./GatewayLifecycleManager";
import { GatewayDeliveryJournal } from "./GatewayDeliveryJournal";
import { gatewayReplySecretCodec } from "./GatewayRouteCredentials";
import { join } from "node:path";
import { BrowserWindow } from "electron";
import {
  GatewayIpc,
  type GatewayChannelDto,
  type GatewayChannelType,
  type GatewayEventDto,
  type GatewayMessageDto,
  type GatewayStatusDto,
  type GatewayWeixinQrLoginStateDto,
  type GatewayQQQrLoginStateDto,
} from "../../shared/agent-ipc";
import type { AgentService } from "../agent/AgentService";
import type { AppDatabase } from "../db/AppDatabase";
import { AppSettingsStore } from "../AppSettingsStore";
import { getGatewayDir } from "../paths";
import { SlackSocketModeAdapter } from "./SlackSocketModeAdapter";
import { DingTalkStreamAdapter } from "./DingTalkStreamAdapter";
import { WeixinIlinkAdapter } from "./WeixinIlinkAdapter";
import { WeixinQrLogin, type WeixinQrState } from "./WeixinQrLogin";
import { QQChannelAdapter } from "./QQChannelAdapter";
import { QQBotQrLogin } from "./QQBotQrLogin";
import { DiscordGatewayAdapter } from "./DiscordGatewayAdapter";
import { assertGatewayProviderStorage, isSecureGatewayProvider, validateGatewayProviderConfig, sealGatewayProviderConfig,
  openGatewayProviderConfig, gatewayProviderConfigView } from "./GatewayProviderConfig";
import { SlackGatewayJournal } from "./SlackGatewayJournal";
import { sealSlackGatewayConfig, openSlackGatewayConfig, slackGatewayConfigView } from "./SlackGatewayCredentials";
import { gatewayBotTaskId } from "../../shared/gateway-task";
import { LOCAL_USER_ID } from "../../shared/bot-work";
import { GatewayWorkTargets } from "./GatewayWorkTargets";
import { gatewayWorkTargetSchema, GatewayWorkNotSentError,
  type GatewayWorkSendInput, type GatewayWorkSendResult, type GatewayWorkTarget } from "./work-outbound";
import {
  FeishuChannelAdapter,
  TelegramChannelAdapter,
  WechatMpChannelAdapter,
  WecomChannelAdapter,
  type ChannelAdapter,
  type GatewayInboundHandler,
  type GatewayInboundMessage,
} from "./channels";

const REDACTED_FIELDS = GATEWAY_SECRET_FIELDS;

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send(channel, payload); }
    catch { /* A closing observer must not fail an accepted delivery. */ }
  }
}

function toStrArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter(Boolean);
}

/**
 * 外部项目投递钩子（可选注入）：入站消息在幂等/白名单之后、Agent 处理之前调用一次。
 * 由调用方（index.ts）解析 `@项目 <名>：内容` 指令并投递到 ProjectEventIngestor；
 * 不命中/解析失败不阻塞原消息流（fail-open，原 Agent 流程不变）。
 */
export interface GatewayProjectMessageSink {
  (msg: { text: string; channelId: string; chatId: string; messageId?: string; senderName?: string }): void;
}

export interface GatewayServiceOptions {
  settingsStore?: Pick<AppSettingsStore, "read">;
  /** Production enables the SQLite inbox/outbox; fixtures may exercise memory-only admission. */
  durableInbox?: boolean;
  adapters?: { feishu?: FeishuChannelAdapter; wecom?: WecomChannelAdapter; wechat?: WechatMpChannelAdapter;
    telegram?: TelegramChannelAdapter; slack?: SlackSocketModeAdapter;
    dingtalk?: DingTalkStreamAdapter; discord?: DiscordGatewayAdapter; qq?: QQChannelAdapter; weixin?: WeixinIlinkAdapter };
  weixinQrLoginFactory?: (options: ConstructorParameters<typeof WeixinQrLogin>[0]) => WeixinQrLogin;
  qqQrLoginFactory?: (options: ConstructorParameters<typeof QQBotQrLogin>[0]) => QQBotQrLogin;
}

export class GatewayService {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly secrets = new GatewaySecrets();
  private readonly platforms: GatewayPlatformRegistry;
  private readonly feishu: FeishuChannelAdapter;
  private readonly wecom: WecomChannelAdapter;
  private readonly wechat: WechatMpChannelAdapter;
  private readonly telegram: TelegramChannelAdapter;
  private readonly slack: SlackSocketModeAdapter;
  private readonly dingtalk: DingTalkStreamAdapter;
  private readonly discord: DiscordGatewayAdapter;
  private readonly qq: QQChannelAdapter;
  private readonly qqQrLogin: QQBotQrLogin;
  private qqQrPending?: Promise<void>;
  private qqQrEpoch = 0;
  private readonly weixin: WeixinIlinkAdapter;
  private readonly weixinQrLogin: WeixinQrLogin;
  private weixinQrPending?: Promise<void>;
  private weixinQrEpoch = 0;
  private readonly settingsStore: Pick<AppSettingsStore, "read">;
  private readonly workTargets: GatewayWorkTargets;
  private workNotificationWake?: () => void;
  /** 通道级策略：白名单（空 = 不限制） */
  private readonly channelPolicies = new Map<string, { allowUsers: string[] }>();
  /** 幂等去重守卫：key = channelId:chatId:messageId */
  private readonly processed = createIdempotencyGuard();
  private readonly lifecycle: GatewayLifecycleManager;
  private get webhookServer() { return this.lifecycle.server; }
  private get webhookPort() { return this.lifecycle.port; }
  private running = false;
  private stopping = false;
  /** Invalidates startup/restore work when shutdown crosses an awaited operation. */
  private lifecycleEpoch = 0;
  private readonly channelOperations = new Map<string, symbol>();

  private beginChannelOperation(channelId: string): symbol {
    const operation = Symbol(channelId);
    this.channelOperations.set(channelId, operation);
    return operation;
  }

  private ownsChannelOperation(channelId: string, operation: symbol, epoch: number): boolean {
    return this.channelOperations.get(channelId) === operation && this.lifecycleEpoch === epoch && !this.stopping;
  }
  /** 侧栏删除会把目录移进回收区，绑定仍指向原路径。下一条外部消息到来时移回。 */
  private restoreTrashedWorkspace?: (taskId: string) => void;

  constructor(
    private readonly db: AppDatabase,
    private readonly agent: Pick<AgentService, "runGatewayTurn">,
    private readonly projectMessageSink?: GatewayProjectMessageSink,
    options: GatewayServiceOptions = {},
  ) {
    this.settingsStore = options.settingsStore ?? new AppSettingsStore();
    this.workTargets = new GatewayWorkTargets(db.connection);
    this.platforms = new GatewayPlatformRegistry({
      ...(options.durableInbox !== false && db.connection ? { journal: new GatewayDeliveryJournal(db.connection) } : {}),
      replayNativeReceipts: true,
      authorize: message => !this.stopping && this.channelPolicies.has(message.channelId)
        && this.isAllowed(message.channelId, message.sender?.id),
      onStatus: (channelId, text) => this.emitEvent({ channelId, direction: "system", text, at: Date.now() }),
    });
    const inbound = this.createInboundHandler();
    this.feishu = options.adapters?.feishu ?? new FeishuChannelAdapter("feishu-default", "飞书", undefined, { deferInboundUntilActivated: true });
    this.wecom = options.adapters?.wecom ?? new WecomChannelAdapter("wecom-default", "企微", { deferInboundUntilActivated: true });
    this.wechat = options.adapters?.wechat ?? new WechatMpChannelAdapter("wechat-default", "微信");
    this.telegram = options.adapters?.telegram ?? new TelegramChannelAdapter("telegram-default", "Telegram");
    this.slack = options.adapters?.slack ?? new SlackSocketModeAdapter("slack-default", "Slack", {
      journal: new SlackGatewayJournal(() => join(getGatewayDir(), "slack-deliveries.json")),
      deferInboundUntilActivated: true,
      onStatus: text => this.emitEvent({ channelId: "slack-default", direction: "system", text, at: Date.now() }),
      onHistoryRead: value => console.info("[SlackChannelHistory] " + JSON.stringify(value)),
    });
    this.dingtalk = options.adapters?.dingtalk ?? new DingTalkStreamAdapter("dingtalk-default", "钉钉", {
      deferInboundUntilActivated: true, replySecrets: gatewayReplySecretCodec,
    });
    this.discord = options.adapters?.discord ?? new DiscordGatewayAdapter("discord-default", "Discord", {
      deferInboundUntilActivated: true,
      onStatus: text => this.emitEvent({ channelId: "discord-default", direction: "system", text: text || "Discord 连接状态已更新", at: Date.now() }),
    });
    this.qq = options.adapters?.qq ?? new QQChannelAdapter("qq-default", "QQ 扫码机器人", { deferInboundUntilActivated: true });
    const qrOptions: ConstructorParameters<typeof QQBotQrLogin>[0] = {
      onAuthorized: (credentials, assertCurrent, signal) => this.acceptQQQrLogin(credentials, assertCurrent, signal),
    };
    this.qqQrLogin = options.qqQrLoginFactory?.(qrOptions) ?? new QQBotQrLogin(qrOptions);
    this.weixin = options.adapters?.weixin ?? new WeixinIlinkAdapter("weixin-default", "微信 iLink Bot", {
      deferInboundUntilActivated: true, replySecrets: gatewayReplySecretCodec,
    });
    const weixinQrOptions: ConstructorParameters<typeof WeixinQrLogin>[0] = {
      onAuthorized: (credentials, assertCurrent, signal) => this.acceptWeixinQrLogin(credentials, assertCurrent, signal),
    };
    this.weixinQrLogin = options.weixinQrLoginFactory?.(weixinQrOptions) ?? new WeixinQrLogin(weixinQrOptions);
    this.lifecycle = new GatewayLifecycleManager({
      feishu: this.feishu, wecom: this.wecom, wechat: this.wechat,
      safeError: error => this.secrets.error(error),
    });
    for (const adapter of [this.feishu, this.wecom, this.wechat, this.telegram, this.slack, this.dingtalk, this.discord, this.qq, this.weixin]) {
      this.platforms.register(adapter, event => inbound(event.message));
      this.adapters.set(adapter.id, adapter);
    }
  }

  /** A scan is a separate, explicit persistent-access enrollment, never a generic config write. */
  async startQQQrLogin(approvedPersistentAccess: boolean): Promise<GatewayQQQrLoginStateDto> {
    if (approvedPersistentAccess !== true) throw new Error("请先明确同意 QQ 持久访问授权");
    assertGatewayProviderStorage();
    const epoch = ++this.qqQrEpoch;
    this.qqQrLogin.cancel();
    if (this.qqQrPending) {
      await this.qq.disconnect();
      await this.qqQrPending.catch(() => {});
    }
    if (epoch !== this.qqQrEpoch) throw new Error("QQ 扫码已取消");
    this.stopping = false;
    const state = await this.qqQrLogin.start(true);
    return this.publicQQQrState(state);
  }

  private publicQQQrState(state: GatewayQQQrLoginStateDto): GatewayQQQrLoginStateDto {
    return { state: state.state, message: state.message,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      ...(state.qrUrl ? { qrUrl: state.qrUrl } : {}),
      ...(state.appId ? { appId: state.appId } : {}) };
  }

  getQQQrLoginState(): GatewayQQQrLoginStateDto { return this.publicQQQrState(this.qqQrLogin.getState()); }

  async cancelQQQrLogin(sessionId?: string): Promise<GatewayQQQrLoginStateDto> {
    const current = this.qqQrLogin.getState();
    if (sessionId !== undefined && sessionId !== current.sessionId) return this.publicQQQrState(current);
    ++this.qqQrEpoch;
    this.qqQrLogin.cancel(sessionId);
    if (this.qqQrPending) {
      await this.qq.disconnect();
      await this.qqQrPending.catch(() => {});
    }
    return this.getQQQrLoginState();
  }

  private acceptQQQrLogin(credentials: { appId: string; appSecret: string; userOpenid: string },
    assertCurrent: () => void, signal: AbortSignal): Promise<void> {
    const epoch = this.lifecycleEpoch;
    const owner = this.beginChannelOperation(this.qq.id);
    const operation = (async () => {
      const stop = () => { if (this.channelOperations.get(this.qq.id) === owner) void this.qq.disconnect().catch(() => {}); };
      signal.addEventListener("abort", stop, { once: true });
      try {
        assertCurrent();
        if (signal.aborted || this.stopping) throw new Error("QQ 授权已取消");
        const config = validateGatewayProviderConfig("qq", {
          appId: credentials.appId, appSecret: credentials.appSecret, allowUsers: [credentials.userOpenid],
        });
        const savedConfig = sealGatewayProviderConfig("qq", config);
        this.secrets.remember(this.qq.id, this.qq.type, config);
        this.channelPolicies.delete(this.qq.id);
        await this.qq.connect(config);
        assertCurrent();
        if (signal.aborted || !this.ownsChannelOperation(this.qq.id, owner, epoch)) throw new Error("QQ 授权已取消");
        // No await between the final cancellation check, synchronous save and activation.
        this.db.connection.transaction(() => {
          this.db.upsertGatewayChannel({ id: this.qq.id, type: this.qq.type, name: this.qq.name,
            configJson: JSON.stringify(savedConfig), connected: true, statusText: this.qq.statusText() });
          this.qq.activate();
        })();
        this.channelPolicies.set(this.qq.id, { allowUsers: [credentials.userOpenid] });
        this.platforms.resume(this.qq.id);
        this.running = true;
        // A closed renderer must not turn a committed authorization into a reported failure.
        try { this.emitEvent({ channelId: this.qq.id, direction: "system", text: "QQ 扫码授权完成，连接已启用", at: Date.now() }); } catch { /* state is available through status() */ }
      } catch {
        if (this.channelOperations.get(this.qq.id) === owner) {
          await this.qq.disconnect();
          if (this.channelOperations.get(this.qq.id) === owner) this.channelPolicies.delete(this.qq.id);
        }
        throw new Error("QQ 连接未启用，请重试扫码；原有保存配置未覆盖");
      } finally { signal.removeEventListener("abort", stop); }
    })();
    this.qqQrPending = operation;
    void operation.finally(() => { if (this.qqQrPending === operation) this.qqQrPending = undefined; }).catch(() => {});
    return operation;
  }

  /** A scan is a separate, explicit persistent-access enrollment, never a generic config write. */
  async startWeixinQrLogin(approvedPersistentAccess: boolean): Promise<GatewayWeixinQrLoginStateDto> {
    if (approvedPersistentAccess !== true) throw new Error("请先明确同意 微信 持久访问授权");
    assertGatewayProviderStorage();
    const epoch = ++this.weixinQrEpoch;
    this.weixinQrLogin.cancel();
    if (this.weixinQrPending) {
      await this.weixin.disconnect();
      await this.weixinQrPending.catch(() => {});
    }
    if (epoch !== this.weixinQrEpoch) throw new Error("微信 扫码已取消");
    this.stopping = false;
    const state = await this.weixinQrLogin.start(true);
    return this.publicWeixinQrState(state);
  }

  private publicWeixinQrState(state: WeixinQrState): GatewayWeixinQrLoginStateDto {
    const mapped = { idle: "idle", waiting: "waiting", scanned: "binding", authorized: "connected", expired: "expired", cancelled: "cancelled", error: "error" } as const;
    const messages = { idle: "尚未开始扫码授权", waiting: "请使用微信扫码并在手机端确认", scanned: "已扫码，请在手机端确认", authorized: "微信已连接", expired: "二维码已过期，请重新授权", cancelled: "扫码已取消", error: "微信扫码授权失败，请重试" };
    return { state: mapped[state.status], message: messages[state.status],
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      ...(state.status === "waiting" && state.qrUrl ? { qrUrl: state.qrUrl } : {}) };
  }

  getWeixinQrLoginState(): GatewayWeixinQrLoginStateDto { return this.publicWeixinQrState(this.weixinQrLogin.getState()); }

  async cancelWeixinQrLogin(sessionId?: string): Promise<GatewayWeixinQrLoginStateDto> {
    const current = this.weixinQrLogin.getState();
    if (sessionId !== undefined && sessionId !== current.sessionId) return this.publicWeixinQrState(current);
    ++this.weixinQrEpoch;
    this.weixinQrLogin.cancel(sessionId);
    if (this.weixinQrPending) {
      await this.weixin.disconnect();
      await this.weixinQrPending.catch(() => {});
    }
    return this.getWeixinQrLoginState();
  }

  private acceptWeixinQrLogin(credentials: { accountId: string; botToken: string; baseUrl: string; userId: string },
    assertCurrent: () => void, signal: AbortSignal): Promise<void> {
    const epoch = this.lifecycleEpoch;
    const owner = this.beginChannelOperation(this.weixin.id);
    const operation = (async () => {
      const stop = () => { if (this.channelOperations.get(this.weixin.id) === owner) void this.weixin.disconnect().catch(() => {}); };
      signal.addEventListener("abort", stop, { once: true });
      try {
        assertCurrent();
        if (signal.aborted || this.stopping) throw new Error("微信 授权已取消");
        const config = validateGatewayProviderConfig("weixin", {
          accountId: credentials.accountId, botToken: credentials.botToken, baseUrl: credentials.baseUrl, userId: credentials.userId, allowUsers: [credentials.userId],
        });
        const savedConfig = sealGatewayProviderConfig("weixin", config);
        this.secrets.remember(this.weixin.id, this.weixin.type, config);
        this.channelPolicies.delete(this.weixin.id);
        await this.weixin.connect(config);
        assertCurrent();
        if (signal.aborted || !this.ownsChannelOperation(this.weixin.id, owner, epoch)) throw new Error("微信 授权已取消");
        // No await between the final cancellation check, synchronous save and activation.
        this.db.connection.transaction(() => {
          this.db.upsertGatewayChannel({ id: this.weixin.id, type: this.weixin.type, name: this.weixin.name,
            configJson: JSON.stringify(savedConfig), connected: true, statusText: this.weixin.statusText() });
          this.weixin.activate();
        })();
        this.channelPolicies.set(this.weixin.id, { allowUsers: [credentials.userId] });
        this.platforms.resume(this.weixin.id);
        this.running = true;
        // A closed renderer must not turn a committed authorization into a reported failure.
        try { this.emitEvent({ channelId: this.weixin.id, direction: "system", text: "微信 扫码授权完成，连接已启用", at: Date.now() }); } catch { /* state is available through status() */ }
      } catch {
        if (this.channelOperations.get(this.weixin.id) === owner) {
          await this.weixin.disconnect();
          if (this.channelOperations.get(this.weixin.id) === owner) this.channelPolicies.delete(this.weixin.id);
        }
        throw new Error("微信 连接未启用，请重试扫码；原有保存配置未覆盖");
      } finally { signal.removeEventListener("abort", stop); }
    })();
    this.weixinQrPending = operation;
    void operation.finally(() => { if (this.weixinQrPending === operation) this.weixinQrPending = undefined; }).catch(() => {});
    return operation;
  }

  private isAllowed(channelId: string, senderId?: string): boolean {
    return isAllowedUser(this.channelPolicies.get(channelId)?.allowUsers ?? [], senderId);
  }

  setWorkNotificationWake(wake: (() => void) | undefined): void { this.workNotificationWake = wake; }

  /** Checks the live endpoint, not just its last saved "connected" flag. */
  checkWorkTarget(value: GatewayWorkTarget): string | undefined {
    const parsed = gatewayWorkTargetSchema.safeParse(value);
    if (!parsed.success) return "Gateway 通知目标身份无效";
    const target = parsed.data;
    const adapter = this.adapters.get(target.channelId);
    const saved = this.db.listGatewayChannels().find(row => row.id === target.channelId);
    if (this.stopping || !saved?.connected || !adapter?.isConnected() || !this.channelPolicies.has(target.channelId)) {
      return "Gateway 渠道未连接或已停用，通知等待恢复";
    }
    if (adapter.type !== target.channelType || saved.type !== target.channelType
      || adapter.workConnectionKey?.() !== target.connectionKey) return "Gateway 连接账号与原始通知授权不匹配";
    if (!gatewayCapabilities(adapter).workNotifications || !adapter.sendWorkNotification) return "Gateway 渠道不支持 Work 出站";
    if (!this.isAllowed(target.channelId, target.senderId)) return "原始发送者已不在 Gateway 允许名单中";
    return undefined;
  }

  async sendWorkNotification(input: GatewayWorkSendInput): Promise<GatewayWorkSendResult> {
    const check = () => {
      const rejected = this.checkWorkTarget(input.target);
      if (rejected) throw new GatewayWorkNotSentError(rejected);
      input.assertCurrent();
    };
    check();
    const adapter = this.adapters.get(input.target.channelId)!;
    const text = this.secrets.redact(input.text);
    const result = await adapter.sendWorkNotification!({ ...input, text, assertCurrent: check });
    if (result.ok) this.emitEvent({ channelId: input.target.channelId, chatId: input.target.chatId,
      direction: "out", text, at: Date.now() });
    return result;
  }

  private recordWorkTarget(msg: GatewayInboundMessage, sourceTaskId: string, sourceMessageId: string): void {
    // Older/unaddressable inputs remain without an outbound route. No message text,
    // latest conversation or historical chat log may manufacture an authorized target.
    if (!msg.workTarget) return;
    const target = gatewayWorkTargetSchema.parse(msg.workTarget);
    if (target.channelId !== msg.channelId || target.chatId !== msg.chatId || target.senderId !== msg.sender?.id) {
      throw new Error("Gateway 受信任目标与原始消息身份不一致");
    }
    const rejected = this.checkWorkTarget(target);
    if (rejected) throw new Error(rejected);
    this.workTargets.record({ userId: LOCAL_USER_ID, conversationId: gatewayBotTaskId(sourceTaskId),
      sourceMessageId, target, createdAt: Date.now() });
    this.workNotificationWake?.();
  }

  setTrashedWorkspaceRestorer(restore: (taskId: string) => void): void {
    this.restoreTrashedWorkspace = restore;
  }

  private createInboundHandler(): GatewayInboundHandler {
    return new GatewayRouter({
      db: this.db, agent: this.agent, adapters: this.adapters,
      readSettings: () => this.settingsStore.read(), isStopping: () => this.stopping,
      slackId: () => this.slack.id, isAuthorized: channelId => this.channelPolicies.has(channelId),
      isAllowed: (channelId, senderId) => this.isAllowed(channelId, senderId), processed: this.processed,
      emitEvent: event => this.emitEvent(event),
      recordWorkTarget: (message, taskId, messageId) => this.recordWorkTarget(message, taskId, messageId),
      projectMessageSink: this.projectMessageSink,
      restoreTrashedWorkspace: taskId => this.restoreTrashedWorkspace?.(taskId),
      redact: text => this.secrets.redact(text), safeError: error => this.secrets.error(error),
      outboundFilter: () => this.secrets.outboundFilter(),
    }).handler();
  }

  async start(): Promise<void> {
    const epoch = this.lifecycleEpoch;
    this.stopping = false;
    if (this.webhookServer) return;
    await this.startWebhookServer();
    if (epoch !== this.lifecycleEpoch || this.stopping) throw new Error("Gateway 启动已取消");
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
    const epoch = this.lifecycleEpoch;
    const priorOperations = new Map(this.channelOperations);
    this.stopping = false;
    const current = () => epoch === this.lifecycleEpoch && !this.stopping;
    for (const row of this.db.listGatewayChannels()) {
      if (!current()) return;
      if (!row.connected) continue;
      // A user connect/disconnect/QR operation after restore began takes precedence.
      if (this.channelOperations.get(row.id) !== priorOperations.get(row.id)) continue;
      const adapter = this.adapters.get(row.id);
      if (!adapter) continue;
      let config: Record<string, unknown> = {};
      const operation = this.beginChannelOperation(row.id);
      try {
        config = JSON.parse(row.configJson || "{}") as Record<string, unknown>;
      } catch {
        console.warn(`[Gateway] ${row.id} 配置损坏，跳过恢复`);
        continue;
      }
      try {
        // Encrypt existing plaintext configuration before enabling its transport.
        if (isSecureGatewayProvider(adapter.type) && !config.encryptedSecrets) {
          config = sealGatewayProviderConfig(adapter.type, validateGatewayProviderConfig(adapter.type, config));
          this.db.upsertGatewayChannel({ ...row, configJson: JSON.stringify(config) });
        }
        const opened = adapter.type === "slack" ? openSlackGatewayConfig(config)
          : isSecureGatewayProvider(adapter.type) ? openGatewayProviderConfig(adapter.type, config) : config;
        this.secrets.remember(adapter.id, adapter.type, opened);
        this.channelPolicies.delete(adapter.id);
        if (!this.isSocketOnly(adapter, opened)) await this.start();
        if (!current()) return;
        if (!this.ownsChannelOperation(row.id, operation, epoch)) continue;
        await adapter.connect(opened);
        if (!current()) return;
        if (!this.ownsChannelOperation(row.id, operation, epoch)) continue;
        if (this.isSocketOnly(adapter)) this.running = true;
        this.channelPolicies.set(row.id, { allowUsers: toStrArray(config.allowUsers) });
        if (adapter.type === "feishu") this.feishu.activate();
        if (adapter.type === "wecom") this.wecom.activate();
        if (adapter.type === "slack") this.slack.activate();
        if (adapter.type === "discord") this.discord.activate();
        if (adapter.type === "dingtalk") this.dingtalk.activate();
        if (adapter.type === "qq") this.qq.activate();
        if (adapter.type === "weixin") this.weixin.activate();
        this.platforms.resume(adapter.id);
        this.emitEvent({
          channelId: row.id,
          direction: "system",
          text: `${adapter.name} 已恢复连接`,
          at: Date.now(),
        });
      } catch (err) {
        if (!current()) return;
        if (!this.ownsChannelOperation(row.id, operation, epoch)) continue;
        const message = this.secrets.error(err);
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
    ++this.lifecycleEpoch;
    this.stopping = true;
    this.platforms.suspend();
    await this.cancelQQQrLogin();
    await this.cancelWeixinQrLogin();
    for (const a of this.adapters.values()) {
      // A webhook adapter can still be awaiting token verification while its
      // public connected flag is false. Disconnect also invalidates that attempt.
      await a.disconnect();
    }
  }

  async stop(): Promise<void> {
    await this.suspend();
    await this.lifecycle.stop();
    this.running = false;
  }

  status(): GatewayStatusDto {
    return {
      running: this.running,
      channels: this.listChannels(),
    };
  }

  listChannels(): GatewayChannelDto[] {
    const labels: Record<string, string> = { pending: "排队", running: "处理中", reply_pending: "回复待送达",
      blocked: "待处理", unknown: "回执待核对" };
    return [...this.adapters.values()].map((adapter) => {
      const pending = Object.entries(this.platforms.deliveryStatus(adapter.id))
        .filter(([, count]) => count > 0).map(([state, count]) => `${labels[state] ?? state} ${count}`);
      return { id: adapter.id, type: adapter.type, name: adapter.name, connected: adapter.isConnected(),
        statusText: this.secrets.redact([adapter.statusText(), ...pending].join("；")) };
    });
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
    if (isSecureGatewayProvider(row.type as GatewayChannelType)) return { hasConfig: true,
      config: gatewayProviderConfigView(row.type as import("./GatewayProviderConfig").SecureGatewayProvider, config) };
    const redacted = { ...config };
    if (row.type === "slack") return { hasConfig: true, config: slackGatewayConfigView(config) };
    const fields = REDACTED_FIELDS[row.type as GatewayChannelType] ?? [];
    for (const key of fields) {
      if (redacted[key]) redacted[key] = GATEWAY_REDACTED;
    }
    return { hasConfig: true, config: redacted };
  }

  async connect(channelId: string, config: Record<string, unknown>): Promise<GatewayStatusDto> {
    try { return await this.connectChannel(channelId, config); }
    catch (error) { throw new Error(this.secrets.error(error)); }
  }

  private async connectChannel(channelId: string, config: Record<string, unknown>): Promise<GatewayStatusDto> {
    if (channelId === this.weixin.id) throw new Error("微信请使用专用扫码授权入口，不接收手工提交的凭据");
    if (channelId === this.qq.id) throw new Error("QQ 请使用专用扫码授权入口，不接收手工提交的凭据");
    const epoch = this.lifecycleEpoch;
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
    let merged: Record<string, unknown> = { ...config };
    const storedSecrets = adapter.type === "slack" && storedConfig.encryptedSecrets
      ? openSlackGatewayConfig(storedConfig)
      : isSecureGatewayProvider(adapter.type) && storedConfig.encryptedSecrets
        && REDACTED_FIELDS[adapter.type].some(key => merged[key] === GATEWAY_REDACTED)
        ? openGatewayProviderConfig(adapter.type, storedConfig) : storedConfig;
    for (const [key, value] of Object.entries(merged)) {
      if (REDACTED_FIELDS[adapter.type].includes(key) && value === GATEWAY_REDACTED && storedSecrets[key]) merged[key] = storedSecrets[key];
    }

    // Socket Mode needs no HTTP listener. Seal before connecting, refuse plaintext fallback.
    if (isSecureGatewayProvider(adapter.type)) merged = validateGatewayProviderConfig(adapter.type, merged);
    const savedConfig = adapter.type === "slack" ? sealSlackGatewayConfig(merged)
      : isSecureGatewayProvider(adapter.type) ? sealGatewayProviderConfig(adapter.type, merged) : merged;
    this.secrets.remember(adapter.id, adapter.type, merged);
    const originalSecrets = GATEWAY_SECRET_FIELDS[adapter.type].map(key => merged[key])
      .filter((value): value is string => typeof value === "string");
    const operation = this.beginChannelOperation(channelId);
    if (!this.isSocketOnly(adapter, merged)) await this.start();
    if (!this.ownsChannelOperation(channelId, operation, epoch)) throw new Error("Gateway 连接已取消");
    if (isSecureGatewayProvider(adapter.type)) this.channelPolicies.delete(adapter.id);
    try { await adapter.connect(merged); }
    catch (error) {
      if (this.ownsChannelOperation(channelId, operation, epoch)) {
        await adapter.disconnect().catch(() => {});
        if (this.ownsChannelOperation(channelId, operation, epoch)) {
          this.channelPolicies.delete(adapter.id);
          this.running = this.webhookServer !== null || [...this.adapters.values()].some(channel => channel.isConnected());
        }
      }
      throw new Error(this.secrets.error(error, originalSecrets));
    }
    if (!this.ownsChannelOperation(channelId, operation, epoch)) throw new Error("Gateway 连接已取消");
    if (this.isSocketOnly(adapter)) this.running = true;
    this.channelPolicies.set(adapter.id, { allowUsers: toStrArray(merged.allowUsers) });
    try {
      this.db.upsertGatewayChannel({
        id: adapter.id, type: adapter.type, name: adapter.name,
        configJson: JSON.stringify(savedConfig), connected: true, statusText: adapter.statusText(),
      });
    } catch (error) {
      if (adapter.type !== "slack" && !isSecureGatewayProvider(adapter.type)) throw error;
      await adapter.disconnect();
      if (this.ownsChannelOperation(channelId, operation, epoch)) {
        this.channelPolicies.delete(adapter.id);
        this.running = this.webhookServer !== null || [...this.adapters.values()].some(channel => channel.isConnected());
      }
      throw new Error(`${adapter.name} 安全配置保存失败，接收已暂停；原有配置保留`);
    }
    if (adapter.type === "feishu") this.feishu.activate();
    if (adapter.type === "wecom") this.wecom.activate();
    if (adapter.type === "slack") this.slack.activate();
    if (adapter.type === "discord") this.discord.activate();
    if (adapter.type === "dingtalk") this.dingtalk.activate();
    if (adapter.type === "qq") this.qq.activate();
    if (adapter.type === "weixin") this.weixin.activate();
    this.platforms.resume(adapter.id);
    this.emitEvent({
      channelId,
      direction: "system",
      text: `${adapter.name} 已连接`,
      at: Date.now(),
    });
    return this.status();
  }

  async disconnect(channelId: string): Promise<GatewayStatusDto> {
    try { return await this.disconnectChannel(channelId); }
    catch (error) { throw new Error(this.secrets.error(error)); }
  }

  private async disconnectChannel(channelId: string): Promise<GatewayStatusDto> {
    const adapter = this.adapters.get(channelId);
    if (!adapter) throw new Error(`unknown channel: ${channelId}`);
    const epoch = this.lifecycleEpoch;
    const operation = this.beginChannelOperation(channelId);
    const current = () => this.channelOperations.get(channelId) === operation && this.lifecycleEpoch === epoch;
    this.platforms.pause(channelId);
    if (channelId === this.qq.id) await this.cancelQQQrLogin();
    if (channelId === this.weixin.id) await this.cancelWeixinQrLogin();
    if (!current()) return this.status();
    await adapter.disconnect();
    if (!current()) return this.status();
    const stored = adapter.type === "slack" || isSecureGatewayProvider(adapter.type) ? this.db.listGatewayChannels().find(row => row.id === channelId) : undefined;
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
    ev = { ...ev, text: this.secrets.redact(ev.text),
      ...(ev.senderName ? { senderName: this.secrets.redact(ev.senderName) } : {}) };
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
      console.warn("[Gateway] 消息落库失败", this.secrets.error(err));
    }
    broadcast(GatewayIpc.event, ev);
    try { this.workNotificationWake?.(); }
    catch { /* Observation failure cannot roll back a committed transport action. */ }
  }

  private isSocketOnly(adapter: ChannelAdapter, config?: Record<string, unknown>): boolean {
    return gatewayCapabilities(adapter, config).transport !== "webhook";
  }

  private async startWebhookServer(): Promise<void> {
    await this.lifecycle.start();
  }
}
