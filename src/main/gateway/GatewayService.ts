import { flushGatewayConversationReservations, hasStableConversationMessageId, isNewConversationCommand, reserveGatewayConversation, type ConversationAdmission } from "./GatewayConversationSession";
import { BusinessBotRegistration } from "./BusinessBotRegistration";
import { createFeishuRegistrationDriver, createDingTalkRegistrationDriver, createWecomRegistrationDriver } from "./BusinessBotRegistrationDrivers";
import type { GatewayRegistrationProvider, GatewayRegistrationDetails } from "../../shared/gateway-registration";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { GatewayPlatformRegistry, gatewayCapabilities } from "./GatewayPlatformRegistry";
import { GatewayDotsBindings } from "./GatewayDotsBindings";
import { GatewayRouter } from "./GatewayRouter";
import { GatewaySecrets, GATEWAY_SECRET_FIELDS, GATEWAY_REDACTED } from "./GatewaySecrets";
import { createIdempotencyGuard, isAllowedUser } from "./GatewayRateLimiter";
export { createIdempotencyGuard, isAllowedUser } from "./GatewayRateLimiter";
export { GATEWAY_REDACTED } from "./GatewaySecrets";
import { GatewayLifecycleManager } from "./GatewayLifecycleManager";
import { GatewayDeliveryJournal } from "./GatewayDeliveryJournal";
import type { GatewayBotOrigin } from "../agent/work/BotTurnOrigins";
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
import type { GatewayChannelRecord } from "../db/gateway-channel-store";
import type { RuntimeGatewayChannelTransition } from "../platform/runtime-audit";
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
type GatewayChannelState = { channel: GatewayChannelRecord | null; revision?: number };

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
  private readonly businessQr = new Map<GatewayRegistrationProvider, BusinessBotRegistration>();
  private readonly businessQrPending = new Map<GatewayRegistrationProvider, Promise<void>>();
  private readonly businessQrEpoch = new Map<GatewayRegistrationProvider, number>();
  private readonly weixin: WeixinIlinkAdapter;
  private readonly weixinQrLogin: WeixinQrLogin;
  private weixinQrPending?: Promise<void>;
  private weixinQrEpoch = 0;
  private readonly settingsStore: Pick<AppSettingsStore, "read">;
  private workNotificationWake?: () => void;
  /** 通道级策略：白名单（空 = 不限制） */
  private readonly channelPolicies = new Map<string, { allowUsers: string[] }>();
  /** 幂等去重守卫：key = channelId:chatId:messageId */
  private readonly processed = createIdempotencyGuard();
  private readonly lifecycle: GatewayLifecycleManager;
  private get webhookServer() { return this.lifecycle.server; }
  private get webhookPort() { return this.lifecycle.port; }
  private announcedWebhookServer?: NonNullable<GatewayLifecycleManager["server"]>;
  private suspending?: Promise<void>;
  private running = false;
  private stopping = false;
  /** Invalidates startup/restore work when shutdown crosses an awaited operation. */
  private lifecycleEpoch = 0;
  private readonly channelOperations = new Map<string, symbol>();
  private readonly dotsBindings?: GatewayDotsBindings;
  private coreIsolationInstalledAt?: number;
  private qqDotsConsent = false;
  private weixinDotsConsent = false;
  private readonly bindingSessionId = randomUUID();
  private readonly bindingGenerations = new Map<string, number>();
  private readonly deliveryJournal?: GatewayDeliveryJournal;
  private readonly pendingHistoryWrites = new Set<Promise<void>>();

  private async readChannelState(channelId: string): Promise<GatewayChannelState> {
    const core = this.db.runtimeAuditReader;
    if (!core?.supervised) {
      const [channel] = await this.db.readGatewayChannels(channelId);
      return { channel: channel ?? null };
    }
    const state = await core.readGatewayChannelState(channelId);
    if (!state || !Number.isSafeInteger(state.revision) || !Number.isSafeInteger(state.isolationInstalledAt)) {
      throw new Error("Core 未确认 Gateway 渠道版本和授权状态");
    }
    this.coreIsolationInstalledAt = state.isolationInstalledAt;
    return state;
  }

  private preparedAccountKey(adapter: ChannelAdapter): string | null {
    return adapter.gatewayPreparedConnectionKey?.() ?? adapter.workConnectionKey?.() ?? null;
  }

  private writeChannel(channel: GatewayChannelRecord, state: GatewayChannelState, transition?: RuntimeGatewayChannelTransition): Promise<boolean> {
    return this.db.writeGatewayChannel(channel, state.channel, { expectedRevision: state.revision, transition,
      applyFixture: () => {
        if (transition?.kind === "connect" && transition.personalMemoryOwnerId) {
          this.dotsBindings?.replace(channel.id, transition.accountKey ?? undefined, transition.personalMemoryOwnerId, true);
        } else if (transition?.kind === "connect" || transition?.kind === "disconnect") {
          this.dotsBindings?.revoke(channel.id);
        }
      },
    });
  }

  private async channelWriteCurrent(channel: GatewayChannelRecord, before: GatewayChannelState): Promise<boolean> {
    if (before.revision === undefined) return true;
    const latest = await this.readChannelState(channel.id);
    return latest.revision === before.revision + 1 && isDeepStrictEqual(latest.channel, channel);
  }

  private async persistRegistration(adapter: ChannelAdapter & { activate(): void }, savedConfig: Record<string, unknown>,
    state: GatewayChannelState, allowUsers: string[], assertCurrent: () => void, personalMemoryOwnerId?: string): Promise<void> {
    assertCurrent();
    const accountKey = this.preparedAccountKey(adapter);
    const generation = adapter.gatewayConnectionGeneration?.();
    if (personalMemoryOwnerId && !accountKey) throw new Error("扫码身份不可验证，无法关联 Dots 个人记忆");
    const channel = { id: adapter.id, type: adapter.type, name: adapter.name, configJson: JSON.stringify(savedConfig),
      connected: true, statusText: adapter.statusText() };
    if (!await this.writeChannel(channel, state, { kind: "connect", accountKey, personalMemoryOwnerId })) {
      throw new Error("扫码期间渠道配置已更新");
    }
    const committed = { channel, revision: state.revision === undefined ? undefined : state.revision + 1 };
    try {
      if (!await this.channelWriteCurrent(channel, state)) throw new Error("扫码配置已被更新");
      assertCurrent();
      if (!adapter.isConnected() || this.preparedAccountKey(adapter) !== accountKey
          || adapter.gatewayConnectionGeneration?.() !== generation) throw new Error("扫码连接已变化");
      this.channelPolicies.set(adapter.id, { allowUsers });
      adapter.activate();
      this.platforms.resume(adapter.id);
      this.running = true;
    }
    catch (error) {
      // Cancellation may race the receipt. Remove only the enrollment that actually committed.
      await this.writeChannel({ ...channel, configJson: state.channel?.configJson ?? "{}", connected: false },
        committed, { kind: "disconnect" });
      throw error;
    }
  }

  private beginChannelOperation(channelId: string): symbol {
    const operation = Symbol(channelId);
    this.channelOperations.set(channelId, operation);
    this.bindingGenerations.set(channelId, (this.bindingGenerations.get(channelId) ?? 0) + 1);
    return operation;
  }

  private ownsChannelOperation(channelId: string, operation: symbol, epoch: number): boolean {
    return this.channelOperations.get(channelId) === operation && this.lifecycleEpoch === epoch && !this.stopping;
  }
  /** 侧栏删除会把目录移进回收区，绑定仍指向原路径。下一条外部消息到来时移回。 */
  private restoreTrashedWorkspace?: (taskId: string) => unknown;

  constructor(
    private readonly db: AppDatabase,
    private readonly agent: Pick<AgentService, "runGatewayTurn"> & Partial<Pick<AgentService, "completeBotContinuation" | "canSendBotContinuation">>,
    private readonly projectMessageSink?: GatewayProjectMessageSink,
    options: GatewayServiceOptions = {},
  ) {
    this.settingsStore = options.settingsStore ?? new AppSettingsStore();
    const native = db.runtimeAuditReader;
    const inboxFixture = native?.supervised ? undefined : db.connection;
    const journal = options.durableInbox !== false && (native?.supervised || inboxFixture)
      ? new GatewayDeliveryJournal(inboxFixture, { native }) : undefined;
    this.dotsBindings = inboxFixture ? new GatewayDotsBindings(inboxFixture, native) : undefined;
    this.deliveryJournal = journal;
    const reserve = (channelId: string, accountKey: string, chatId: string, senderId: string | undefined, messageId: string, text: string, admission: ConversationAdmission, message?: import("./channels").GatewayInboundMessage) => {
      if (!senderId || this.stopping || !this.channelPolicies.get(channelId)?.allowUsers.includes(senderId)) return;
      if (native?.supervised) throw new Error("Slack 原会话预留尚未接入 Core");
      if (!inboxFixture) return;
      if (admission.recovered && this.dotsBindings && !this.dotsBindings.coversDelivery(admission.acceptedAt)) {
        throw new Error("旧渠道消息缺少当前记忆隔离授权，请重新发送");
      }
      const command = isNewConversationCommand(text);
      if (command && !hasStableConversationMessageId(messageId)) return; // Router responds without model work.
      const origin = { channelId, connectionKey: accountKey, chatId, senderId, messageId, audience: message?.audience ?? "shared" as const };
      const personalMemoryBindingId = message && hasStableConversationMessageId(messageId)
        ? this.dotsBindings?.admit(origin, message.replyRoute, admission.acceptedAt) : undefined;
      reserveGatewayConversation(inboxFixture, { ...origin, personalMemoryBindingId }, command, admission, native);
    };
    this.platforms = new GatewayPlatformRegistry({
      reserveConversation: (message, accountKey, messageId, admission) => reserve(message.channelId, accountKey, message.chatId, message.sender?.id, messageId, message.text, admission, message),
      ...(journal ? { journal } : {}),
      onReplySent: (_deliveryId, operationId) => {
        if (operationId) this.agent.completeBotContinuation?.(operationId);
      },
      replyCurrent: (deliveryId, operationId) => {
        if (journal?.usesCoreAdmission) return !operationId || this.agent.canSendBotContinuation?.(operationId) === true;
        const entry = journal?.get(deliveryId);
        if (entry && this.dotsBindings && (!this.dotsBindings.coversDelivery(entry.created_at)
          || !this.dotsBindings.replyCurrent(this.dotsBindings.privateAdmission(entry.channel_id, entry.account_key, entry.chat_id, entry.message_id)))) return false;
        return !operationId || this.agent.canSendBotContinuation?.(operationId) !== false;
      },
      replayNativeReceipts: true,
      coreControlled: Boolean(db.runtimeAuditReader?.supervised),
      onScheduleRecover: (channelId, delayMs) => {
        void db.runtimeAuditReader?.gatewayScheduler?.({ action: "scheduleRecover", channelId, delayMs }).catch(() => undefined);
      },
      onOutboundUnknown: info => {
        void db.runtimeAuditReader?.gatewayScheduler?.({
          action: "trackOutbound",
          deliveryId: info.deliveryId,
          attempt: info.attempt,
          channelId: info.channelId,
          channelType: info.channelType,
          accountKey: info.accountKey,
          queryable: info.queryable,
          state: "unknown",
          detail: "provider_receipt_unknown",
        }).catch(() => undefined);
      },
      authorize: message => !this.stopping && Boolean(message.sender?.id
        && this.channelPolicies.get(message.channelId)?.allowUsers.includes(message.sender.id)),
      onStatus: (channelId, text) => this.emitEvent({ channelId, direction: "system", text, at: Date.now() }),
    });
    const inbound = this.createInboundHandler();
    this.feishu = options.adapters?.feishu ?? new FeishuChannelAdapter("feishu-default", "飞书", undefined, { deferInboundUntilActivated: true });
    this.wecom = options.adapters?.wecom ?? new WecomChannelAdapter("wecom-default", "企微", { deferInboundUntilActivated: true });
    this.wechat = options.adapters?.wechat ?? new WechatMpChannelAdapter("wechat-default", "微信");
    this.telegram = options.adapters?.telegram ?? new TelegramChannelAdapter("telegram-default", "Telegram");
    this.slack = options.adapters?.slack ?? new SlackSocketModeAdapter("slack-default", "Slack", {
      journal: new SlackGatewayJournal(() => join(getGatewayDir(), "slack-deliveries.json")),
      reserveConversation: (delivery, accountKey, recovered) => reserve("slack-default", accountKey,
        [delivery.teamId, delivery.channel, delivery.threadTs].join(":"), delivery.userId, delivery.eventId, delivery.text, { acceptedAt: delivery.acceptedAt, recovered }),
      replyAllowed: delivery => native?.supervised
        ? this.coreIsolationInstalledAt !== undefined && delivery.acceptedAt >= this.coreIsolationInstalledAt
        : this.dotsBindings?.coversDelivery(delivery.acceptedAt) ?? true,
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
    for (const provider of ["feishu", "dingtalk", "wecom"] as const) {
      this.businessQr.set(provider, new BusinessBotRegistration({ provider,
        driver: provider === "feishu" ? createFeishuRegistrationDriver() : provider === "wecom" ? createWecomRegistrationDriver() : createDingTalkRegistrationDriver(),
        onAuthorized: (config, current, signal, personalMemoryOwnerId) => this.acceptBusinessRegistration(provider, config, current, signal, personalMemoryOwnerId),
      }));
    }
    this.lifecycle = new GatewayLifecycleManager({
      feishu: this.feishu, wecom: this.wecom, wechat: this.wechat,
      safeError: error => this.secrets.error(error),
    });
    for (const adapter of [this.feishu, this.wecom, this.wechat, this.telegram, this.slack, this.dingtalk, this.discord, this.qq, this.weixin]) {
      this.platforms.register(adapter, event => inbound(event.message));
      this.adapters.set(adapter.id, adapter);
    }
  }

  private registration(provider: GatewayRegistrationProvider): BusinessBotRegistration {
    if (provider !== "feishu" && provider !== "dingtalk" && provider !== "wecom") throw new Error("不支持的扫码渠道");
    return this.businessQr.get(provider)!;
  }
  private async readEmptyBusinessChannel(provider: GatewayRegistrationProvider): Promise<GatewayChannelState> {
    const adapter = provider === "feishu" ? this.feishu : provider === "wecom" ? this.wecom : this.dingtalk;
    const state = await this.readChannelState(adapter.id);
    const stored = state.channel;
    if (adapter.isConnected() || stored?.connected || (stored && stored.configJson.trim() !== "" && stored.configJson.trim() !== "{}")) {
      throw new Error("此渠道已有配置或连接，请管理现有机器人；扫码创建不会替换已有账号");
    }
    return state;
  }
  getBusinessRegistration(provider: GatewayRegistrationProvider) { return this.registration(provider).getState(); }
  async startBusinessRegistration(provider: GatewayRegistrationProvider, approved: boolean, dotsConsent?: boolean) {
    const registration = this.registration(provider);
    if (approved !== true) throw new Error("请明确同意创建机器人并保存凭据");
    assertGatewayProviderStorage();
    const lifecycle = this.lifecycleEpoch;
    await this.readEmptyBusinessChannel(provider);
    if (lifecycle !== this.lifecycleEpoch) throw new Error("扫码接入已取消");
    const cancelled = this.cancelBusinessRegistration(provider);
    const epoch = this.businessQrEpoch.get(provider);
    await cancelled;
    if (epoch !== this.businessQrEpoch.get(provider)) return registration.getState();
    this.stopping = false;
    const result = await registration.start(true, dotsConsent === true);
    if (epoch !== this.businessQrEpoch.get(provider)) return registration.getState();
    return result;
  }
  finishBusinessRegistration(provider: GatewayRegistrationProvider, sessionId: string, details: GatewayRegistrationDetails) {
    return this.registration(provider).finish(sessionId, details);
  }
  async cancelBusinessRegistration(provider: GatewayRegistrationProvider, sessionId?: string) {
    const registration = this.registration(provider);
    if (sessionId !== undefined && registration.getState().sessionId !== sessionId) return registration.getState();
    this.businessQrEpoch.set(provider, (this.businessQrEpoch.get(provider) ?? 0) + 1);
    registration.cancel(sessionId);
    const pending = this.businessQrPending.get(provider);
    if (pending) await pending.catch(() => {});
    return registration.getState();
  }
  private acceptBusinessRegistration(provider: GatewayRegistrationProvider, input: Record<string, unknown>, current: () => void, signal: AbortSignal, personalMemoryOwnerId?: string): Promise<void> {
    const adapter = provider === "feishu" ? this.feishu : provider === "wecom" ? this.wecom : this.dingtalk;
    const epoch = this.lifecycleEpoch;
    const owner = this.beginChannelOperation(adapter.id);
    const operation = (async () => {
      const stop = () => { if (this.channelOperations.get(adapter.id) === owner) void adapter.disconnect().catch(() => {}); };
      signal.addEventListener("abort", stop, { once: true });
      try {
        const assertCurrent = () => {
          current();
          if (signal.aborted || !this.ownsChannelOperation(adapter.id, owner, epoch)) throw new Error("cancelled");
        };
        assertCurrent();
        const state = await this.readEmptyBusinessChannel(provider);
        assertCurrent();
        const config = validateGatewayProviderConfig(provider, input);
        const saved = sealGatewayProviderConfig(provider, config);
        this.secrets.remember(adapter.id, adapter.type, config);
        this.channelPolicies.delete(adapter.id);
        await adapter.connect(config);
        await this.persistRegistration(adapter, saved, state, toStrArray(config.allowUsers), assertCurrent,
          provider === "feishu" ? personalMemoryOwnerId : undefined);
        try { this.emitEvent({ channelId: adapter.id, direction: "system", text: "扫码接入完成", at: Date.now() }); } catch { /* state remains readable */ }
      } catch {
        if (this.channelOperations.get(adapter.id) === owner) {
          await adapter.disconnect().catch(() => {});
          if (this.channelOperations.get(adapter.id) === owner) this.channelPolicies.delete(adapter.id);
        }
        throw new Error("扫码接入失败；原有保存配置未覆盖");
      } finally { signal.removeEventListener("abort", stop); }
    })();
    this.businessQrPending.set(provider, operation);
    void operation.finally(() => { if (this.businessQrPending.get(provider) === operation) this.businessQrPending.delete(provider); }).catch(() => {});
    return operation;
  }

  /** A scan is a separate, explicit persistent-access enrollment, never a generic config write. */
  async startQQQrLogin(approvedPersistentAccess: boolean, dotsConsent?: boolean): Promise<GatewayQQQrLoginStateDto> {
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
    this.qqDotsConsent = dotsConsent === true;
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
    current: () => void, signal: AbortSignal): Promise<void> {
    const epoch = this.lifecycleEpoch;
    const owner = this.beginChannelOperation(this.qq.id);
    const dotsConsent = this.qqDotsConsent;
    const operation = (async () => {
      const stop = () => { if (this.channelOperations.get(this.qq.id) === owner) void this.qq.disconnect().catch(() => {}); };
      signal.addEventListener("abort", stop, { once: true });
      try {
        const assertCurrent = () => {
          current();
          if (signal.aborted || !this.ownsChannelOperation(this.qq.id, owner, epoch)) throw new Error("QQ 授权已取消");
        };
        assertCurrent();
        const state = await this.readChannelState(this.qq.id);
        assertCurrent();
        const config = validateGatewayProviderConfig("qq", {
          appId: credentials.appId, appSecret: credentials.appSecret, allowUsers: [credentials.userOpenid],
        });
        const savedConfig = sealGatewayProviderConfig("qq", config);
        this.secrets.remember(this.qq.id, this.qq.type, config);
        this.channelPolicies.delete(this.qq.id);
        await this.qq.connect(config);
        await this.persistRegistration(this.qq, savedConfig, state, [credentials.userOpenid], assertCurrent,
          dotsConsent ? credentials.userOpenid : undefined);
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
  async startWeixinQrLogin(approvedPersistentAccess: boolean, dotsConsent?: boolean): Promise<GatewayWeixinQrLoginStateDto> {
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
    this.weixinDotsConsent = dotsConsent === true;
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
    current: () => void, signal: AbortSignal): Promise<void> {
    const epoch = this.lifecycleEpoch;
    const owner = this.beginChannelOperation(this.weixin.id);
    const dotsConsent = this.weixinDotsConsent;
    const operation = (async () => {
      const stop = () => { if (this.channelOperations.get(this.weixin.id) === owner) void this.weixin.disconnect().catch(() => {}); };
      signal.addEventListener("abort", stop, { once: true });
      try {
        const assertCurrent = () => {
          current();
          if (signal.aborted || !this.ownsChannelOperation(this.weixin.id, owner, epoch)) throw new Error("微信 授权已取消");
        };
        assertCurrent();
        const state = await this.readChannelState(this.weixin.id);
        assertCurrent();
        const config = validateGatewayProviderConfig("weixin", {
          accountId: credentials.accountId, botToken: credentials.botToken, baseUrl: credentials.baseUrl, userId: credentials.userId, allowUsers: [credentials.userId],
        });
        const savedConfig = sealGatewayProviderConfig("weixin", config);
        this.secrets.remember(this.weixin.id, this.weixin.type, config);
        this.channelPolicies.delete(this.weixin.id);
        await this.weixin.connect(config);
        await this.persistRegistration(this.weixin, savedConfig, state, [credentials.userId], assertCurrent,
          dotsConsent ? credentials.userId : undefined);
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

  sendBotContinuation(origin: GatewayBotOrigin, operationId: string, text: string): Promise<void> {
    return this.platforms.continueBotReply(origin, operationId, this.secrets.redact(text));
  }

  async sendWorkNotification(input: GatewayWorkSendInput): Promise<GatewayWorkSendResult> {
    const check = () => {
      const rejected = this.checkWorkTarget(input.target);
      if (rejected) throw new GatewayWorkNotSentError(rejected);
      input.assertCurrent();
    };
    check();
    const adapter = this.adapters.get(input.target.channelId)!;
    if (input.files?.length && !["discord", "dingtalk", "qq"].includes(input.target.channelType)) throw new GatewayWorkNotSentError("当前渠道尚未支持成果附件，未发送或降级为文本成功");
    const text = this.secrets.redact(input.text);
    const result = await adapter.sendWorkNotification!({ ...input, text, assertCurrent: check });
    if (result.ok) this.emitEvent({ channelId: input.target.channelId, chatId: input.target.chatId,
      direction: "out", text, at: Date.now() });
    return result;
  }

  connectedWorkIdentity(channelId: string): { channelId: string; connectionKey: string } | undefined {
    const adapter = this.adapters.get(channelId);
    const connectionKey = adapter?.isConnected() ? adapter.workConnectionKey?.() : undefined;
    return connectionKey ? { channelId, connectionKey } : undefined;
  }

  connectedBindingIdentity(channelId: string): { connectionKey: string; connectionRevision: string } | undefined {
    const identity = this.connectedWorkIdentity(channelId);
    if (!identity || this.stopping) return undefined;
    return { connectionKey: identity.connectionKey, connectionRevision: createHash("sha256")
      .update(JSON.stringify([this.bindingSessionId, this.lifecycleEpoch, channelId,
        this.bindingGenerations.get(channelId) ?? 0, identity.connectionKey])).digest("hex") };
  }
  setTrashedWorkspaceRestorer(restore: (taskId: string) => unknown): void {
    this.restoreTrashedWorkspace = restore;
  }

  private createInboundHandler(): GatewayInboundHandler {
    return new GatewayRouter({
      db: this.db, adapters: this.adapters, dotsBindings: this.dotsBindings,
      agent: {
        runGatewayTurn: async request => {
          // The router has already resolved the authorized sender's canonical conversation ID.
          if (this.restoreTrashedWorkspace && this.db.getTaskExecutionWorkspaceState(request.taskId)?.state === "trashed") {
            await this.restoreTrashedWorkspace(request.taskId);
          }
          return this.agent.runGatewayTurn(request);
        },
      },
      readSettings: () => this.settingsStore.read(), isStopping: () => this.stopping,
      slackId: () => this.slack.id, isAuthorized: channelId => this.channelPolicies.has(channelId),
      isConversationAuthorized: (channelId, senderId) => Boolean(senderId && this.channelPolicies.get(channelId)?.allowUsers.includes(senderId)),
      isAllowed: (channelId, senderId) => this.isAllowed(channelId, senderId), processed: this.processed,
      emitEvent: event => this.emitEvent(event),
      projectMessageSink: this.projectMessageSink,
      redact: text => this.secrets.redact(text), safeError: error => this.secrets.error(error),
      outboundFilter: () => this.secrets.outboundFilter(),
    }).handler();
  }

  async start(): Promise<void> {
    const epoch = this.lifecycleEpoch;
    if (this.suspending) await this.suspending;
    if (epoch !== this.lifecycleEpoch) throw new Error("Gateway 启动已取消");
    this.stopping = false;
    if (this.webhookServer) {
      this.running = true;
      return;
    }
    await this.startWebhookServer();
    if (epoch !== this.lifecycleEpoch || this.stopping) throw new Error("Gateway 启动已取消");
    const server = this.webhookServer;
    if (!server || this.announcedWebhookServer === server) return;
    this.announcedWebhookServer = server;
    this.running = true;
    this.emitEvent({
      channelId: "system",
      direction: "system",
      text: `Gateway 已启动 · 飞书 /feishu · 企微 /wecom · 微信 /wechat · 端口 ${this.webhookPort}`,
      at: Date.now(),
    });
  }

  async runCoreControlCycle(cycle: string, channelId: string, extra?: Record<string, unknown>): Promise<void> {
    if (this.stopping) return;
    if (cycle === "recoverOutbox") {
      this.platforms.recoverScheduled(channelId);
      return;
    }
    if (cycle === "reconnect") {
      await this.restoreChannels(channelId);
      return;
    }
    if (cycle === "reconcileUnknown") {
      const deliveryId = typeof extra?.deliveryId === "string" ? extra.deliveryId : undefined;
      const attempt = typeof extra?.attempt === "number" ? extra.attempt : undefined;
      const accountKey = typeof extra?.accountKey === "string" ? extra.accountKey : undefined;
      const adapter = this.adapters.get(channelId) as (ChannelAdapter & {
        lookupOutboundDelivery?: (deliveryId: string, providerMessageId?: string) => Promise<"confirmed_sent" | "confirmed_not_sent" | "still_unknown">;
      }) | undefined;
      if (!deliveryId || attempt === undefined || !Number.isSafeInteger(attempt) || attempt < 1 || !accountKey
        || !adapter?.isConnected() || adapter.workConnectionKey?.() !== accountKey) return;
      if (typeof adapter.lookupOutboundDelivery !== "function") {
        await this.db.runtimeAuditReader?.gatewayScheduler?.({
          action: "settleUnknown",
          deliveryId,
          attempt,
          outcome: "unqueryable",
          detail: "adapter_lookup_unavailable",
        }).catch(() => undefined);
        return;
      }
      const outcome = await adapter.lookupOutboundDelivery(
        deliveryId,
        typeof extra?.providerMessageId === "string" ? extra.providerMessageId : undefined,
      ).catch(() => "still_unknown" as const);
      if (!adapter.isConnected() || adapter.workConnectionKey?.() !== accountKey) return;
      await this.db.runtimeAuditReader?.gatewayScheduler?.({
        action: "settleUnknown",
        deliveryId,
        attempt,
        outcome,
      }).catch(() => undefined);
    }
  }

  /** 应用启动时恢复上次已连接的通道（配置从 DB 读回，无需重新手输） */
  async restoreChannels(channelId?: string): Promise<void> {
    if (channelId === undefined && this.suspending) await this.suspending;
    const epoch = this.lifecycleEpoch;
    const priorOperations = new Map(this.channelOperations);
    if (channelId === undefined) {
      this.stopping = false;
      if (this.db.runtimeAuditReader?.supervised) await this.db.runtimeAuditReader.gatewayScheduler({ action: "start" });
    }
    const rows = await this.db.readGatewayChannels(channelId);
    await Promise.all(rows.map(row => this.restoreChannel(row, priorOperations.get(row.id), epoch)));
  }

  private async restoreChannel(row: GatewayChannelRecord, priorOperation: symbol | undefined, epoch: number): Promise<void> {
    if (!row.connected || this.stopping || epoch !== this.lifecycleEpoch) return;
    // A user connect/disconnect/QR operation after restore began takes precedence.
    if (this.channelOperations.get(row.id) !== priorOperation) return;
    const adapter = this.adapters.get(row.id);
    if (!adapter) return;
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(row.configJson || "{}") as Record<string, unknown>;
    } catch {
      console.warn(`[Gateway] ${row.id} 配置损坏，跳过恢复`);
      return;
    }
    const operation = this.beginChannelOperation(row.id);
    const current = () => this.ownsChannelOperation(row.id, operation, epoch);
    try {
      let state = await this.readChannelState(row.id);
      if (!current() || !isDeepStrictEqual(state.channel, row)) return;
      // Encrypt existing plaintext configuration before enabling its transport.
      if (isSecureGatewayProvider(adapter.type) && !config.encryptedSecrets) {
        config = sealGatewayProviderConfig(adapter.type, validateGatewayProviderConfig(adapter.type, config));
        const sealed = { ...row, configJson: JSON.stringify(config) };
        if (!await this.writeChannel(sealed, state)) return;
        row = sealed;
        state = { channel: sealed, revision: state.revision === undefined ? undefined : state.revision + 1 };
      }
      if (!current()) return;
      const opened = adapter.type === "slack" ? openSlackGatewayConfig(config)
        : isSecureGatewayProvider(adapter.type) ? openGatewayProviderConfig(adapter.type, config) : config;
      this.secrets.remember(adapter.id, adapter.type, opened);
      this.channelPolicies.delete(adapter.id);
      const socketOnly = this.isSocketOnly(adapter, opened);
      if (!socketOnly) await this.start();
      if (!current()) return;
      await adapter.connect(opened);
      if (!current()) return;
      const restored = this.db.runtimeAuditReader?.supervised
        ? await this.writeChannel(row, state, { kind: "restore", accountKey: this.preparedAccountKey(adapter) })
          && await this.channelWriteCurrent(row, state)
        : isDeepStrictEqual((await this.db.readGatewayChannels(row.id))[0], row);
      if (!current()) return;
      if (!restored) {
        await adapter.disconnect();
        return;
      }
      if (socketOnly) this.running = true;
      this.channelPolicies.set(row.id, { allowUsers: toStrArray(config.allowUsers) });
      if (adapter.type === "feishu") this.feishu.activate();
      if (adapter.type === "wecom") this.wecom.activate();
      if (adapter.type === "slack") this.slack.activate();
      if (adapter.type === "discord") this.discord.activate();
      if (adapter.type === "dingtalk") this.dingtalk.activate();
      if (adapter.type === "qq") this.qq.activate();
      if (adapter.type === "weixin") this.weixin.activate();
      this.platforms.resume(adapter.id);
      this.emitEvent({ channelId: row.id, direction: "system", text: `${adapter.name} 已恢复连接`, at: Date.now() });
    } catch (err) {
      if (!current()) return;
      this.channelPolicies.delete(row.id);
      await adapter.disconnect().catch(() => undefined);
      if (!current()) return;
      const message = this.secrets.error(err);
      console.warn(`[Gateway] 恢复 ${row.id} 失败: ${message}`);
      this.emitEvent({ channelId: row.id, direction: "system", text: `${adapter.name} 恢复连接失败：${message}`, at: Date.now() });
    }
  }

  async suspend(): Promise<void> {
    if (this.suspending) return this.suspending;
    ++this.lifecycleEpoch;
    this.stopping = true;
    this.running = false;
    this.platforms.suspend();
    const suspension = Promise.resolve().then(() => this.suspendChannels());
    this.suspending = suspension;
    try { await suspension; }
    finally { if (this.suspending === suspension) this.suspending = undefined; }
  }

  private async suspendChannels(): Promise<void> {
    const results = await Promise.allSettled([
      this.webhookServer ? Promise.resolve() : this.lifecycle.stop(),
      ...[...this.adapters.values()].map(async adapter => {
        try {
          if (adapter.id === this.feishu.id) await this.cancelBusinessRegistration("feishu");
          if (adapter.id === this.dingtalk.id) await this.cancelBusinessRegistration("dingtalk");
          if (adapter.id === this.wecom.id) await this.cancelBusinessRegistration("wecom");
          if (adapter.id === this.qq.id) await this.cancelQQQrLogin();
          if (adapter.id === this.weixin.id) await this.cancelWeixinQrLogin();
        } finally {
          // Also invalidates an adapter still awaiting provider authorization.
          await adapter.disconnect();
        }
      }),
    ]);
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  async stop(): Promise<void> {
    await this.db.runtimeAuditReader?.gatewayScheduler?.({ action: "stop" }).catch(() => undefined);
    await this.suspend();
    await this.lifecycle.stop();
    this.announcedWebhookServer = undefined;
    await this.dotsBindings?.flush();
    await this.deliveryJournal?.flush();
    if (this.db.fixtureConnection) await flushGatewayConversationReservations(this.db.fixtureConnection);
    await this.db.flushGatewayWrites?.();
    await Promise.all(this.pendingHistoryWrites);
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
        bindingRevision: this.connectedBindingIdentity(adapter.id)?.connectionRevision,
        bindingConnectionKey: this.connectedWorkIdentity(adapter.id)?.connectionKey,
        statusText: this.secrets.redact([adapter.statusText(), ...pending].join("；")) };
    });
  }

  /** 已保存配置的脱敏视图（secret 打码；原样提交 connect 即复用旧值） */
  async getChannelConfig(channelId: string): Promise<{ hasConfig: boolean; config: Record<string, unknown> }> {
    const [row] = await this.db.readGatewayChannels(channelId);
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
    if (this.suspending) await this.suspending;
    if (channelId === this.feishu.id) await this.cancelBusinessRegistration("feishu");
    if (channelId === this.dingtalk.id) await this.cancelBusinessRegistration("dingtalk");
    if (channelId === this.wecom.id) await this.cancelBusinessRegistration("wecom");
    if (channelId === this.weixin.id) throw new Error("微信请使用专用扫码授权入口，不接收手工提交的凭据");
    if (channelId === this.qq.id) throw new Error("QQ 请使用专用扫码授权入口，不接收手工提交的凭据");
    const epoch = this.lifecycleEpoch;
    this.stopping = false;
    const adapter = this.adapters.get(channelId);
    if (!adapter) throw new Error(`unknown channel: ${channelId}`);

    // 脱敏占位符字段 → 复用已存配置的旧值
    const priorOperation = this.channelOperations.get(channelId);
    const state = await this.readChannelState(channelId);
    const stored = state.channel;
    if (this.channelOperations.get(channelId) !== priorOperation || this.lifecycleEpoch !== epoch || this.stopping) {
      throw new Error("Gateway 连接已取消");
    }
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
    this.channelPolicies.delete(adapter.id);
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
    let confirmed = false;
    try {
      const channel = {
        id: adapter.id, type: adapter.type, name: adapter.name,
        configJson: JSON.stringify(savedConfig), connected: true, statusText: adapter.statusText(),
      };
      confirmed = await this.writeChannel(channel, state, { kind: "connect", accountKey: this.preparedAccountKey(adapter) })
        && await this.channelWriteCurrent(channel, state);
    } catch {
      const credentials = adapter.type === "slack" || isSecureGatewayProvider(adapter.type);
      throw new Error(`${adapter.name} ${credentials ? "安全配置" : "配置"}保存失败，请刷新渠道状态`);
    } finally {
      if (!confirmed && this.ownsChannelOperation(channelId, operation, epoch)) {
        this.channelPolicies.delete(adapter.id);
        await adapter.disconnect().catch(() => undefined);
        if (this.ownsChannelOperation(channelId, operation, epoch)) {
          this.running = this.webhookServer !== null || [...this.adapters.values()].some(channel => channel.isConnected());
        }
      }
    }
    if (!this.ownsChannelOperation(channelId, operation, epoch)) throw new Error("Gateway 连接已取消");
    if (!confirmed) throw new Error("渠道配置已被另一窗口更新，请刷新渠道状态");
    if (this.isSocketOnly(adapter)) this.running = true;
    this.channelPolicies.set(adapter.id, { allowUsers: toStrArray(merged.allowUsers) });
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
    this.channelPolicies.delete(channelId);
    if (channelId === this.feishu.id) await this.cancelBusinessRegistration("feishu");
    if (channelId === this.dingtalk.id) await this.cancelBusinessRegistration("dingtalk");
    if (channelId === this.wecom.id) await this.cancelBusinessRegistration("wecom");
    if (channelId === this.qq.id) await this.cancelQQQrLogin();
    if (channelId === this.weixin.id) await this.cancelWeixinQrLogin();
    if (!current()) return this.status();
    const retainConfig = adapter.type === "slack" || isSecureGatewayProvider(adapter.type);
    let saved = false;
    try {
      const state = await this.readChannelState(channelId);
      if (!current()) return this.status();
      saved = await this.writeChannel({ id: adapter.id, type: adapter.type, name: adapter.name,
        configJson: retainConfig ? state.channel?.configJson ?? "{}" : "{}", connected: false, statusText: "未连接",
      }, state, { kind: "disconnect" });
    } finally {
      if (current()) await adapter.disconnect();
    }
    if (!current()) return this.status();
    if (!saved) throw new Error("渠道配置已被另一窗口更新，请刷新渠道状态");
    this.emitEvent({
      channelId,
      direction: "system",
      text: `${adapter.name} 已断开`,
      at: Date.now(),
    });
    return this.status();
  }

  listMessages(opts: { channelId?: string; chatId?: string; limit?: number }): Promise<GatewayMessageDto[]> {
    return this.db.readGatewayMessages(opts);
  }

  private emitEvent(ev: GatewayEventDto): void {
    ev = { ...ev, text: this.secrets.redact(ev.text),
      ...(ev.senderName ? { senderName: this.secrets.redact(ev.senderName) } : {}) };
    // Every event writes independently. Shutdown waits for the outstanding acknowledgements.
    const persisted = this.db
      .writeGatewayMessage({
        channelId: ev.channelId,
        chatId: ev.chatId ?? "",
        direction: ev.direction,
        senderId: ev.senderId,
        senderName: ev.senderName,
        text: ev.text,
        at: ev.at,
      })
      .catch((err) => {
        console.warn("[Gateway] 消息落库失败", this.secrets.error(err));
      });
    this.pendingHistoryWrites.add(persisted);
    void persisted.then(() => this.pendingHistoryWrites.delete(persisted));
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
