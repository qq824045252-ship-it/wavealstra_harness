import { createServer, type Server } from "node:http";
import { GatewayPlatformRegistry, gatewayCapabilities } from "./GatewayPlatformRegistry";
import { DEFAULT_WEBHOOK_PORT, listenOnFirstAvailablePort } from "./webhook-port";
import { gatewayInboundIdentity } from "./gateway-inbound-identity";
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
import { SlackSocketModeAdapter, safeSlackError, redactSlackText } from "./SlackSocketModeAdapter";
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
import { runGatewayAgentTurn, withSlackChannelHistory } from "./GatewayAgentTurn";
import { ensureGatewayChannelSpace } from "./gateway-task-space";
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

/** 脱敏占位符：getChannelConfig 返回的 secret 类字段值；connect 时原样提交即复用已存值 */
export const GATEWAY_REDACTED = "••••••";

/** 各通道需要脱敏的字段（表单回填时打码，留空提交则保留旧值） */
const REDACTED_FIELDS: Record<GatewayChannelType, string[]> = {
  feishu: ["appSecret", "verificationToken", "encryptedSecrets"],
  wecom: ["secret", "token", "encodingAESKey", "encryptedSecrets"],
  wechat: ["appSecret", "token", "encodingAESKey"],
  telegram: ["botToken"],
  slack: ["botToken", "appToken", "encryptedSecrets"],
  dingtalk: ["clientSecret", "encryptedSecrets"],
  discord: ["botToken", "encryptedSecrets"],
  weixin: ["botToken", "encryptedSecrets"],
  qq: ["appSecret", "encryptedSecrets"],
};

/** 幂等窗口：平台重试投递的同一条消息只执行一次（10 分钟） */
const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 2000;

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function toStrArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter(Boolean);
}

/** 幂等去重守卫：同 channelId:chatId:messageId 只放行一次（窗口外自动过期，过期后可重新处理） */
export function createIdempotencyGuard(
  windowMs: number = IDEMPOTENCY_WINDOW_MS,
  maxEntries: number = IDEMPOTENCY_MAX_ENTRIES,
): ((channelId: string, chatId: string, messageId: string) => boolean) & { forget(channelId: string, chatId: string, messageId: string): void } {
  const processed = new Map<string, number>();
  const guard = (channelId: string, chatId: string, messageId: string): boolean => {
    const key = JSON.stringify([channelId, chatId, messageId]);
    const now = Date.now();
    const existing = processed.get(key);
    if (existing !== undefined) {
      if (now - existing <= windowMs) return false; // 窗口内重复投递：拒绝
      processed.delete(key); // 窗口已过期：允许重新处理
    }
    processed.set(key, now);
    if (processed.size > maxEntries) {
      const oldest = [...processed.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) processed.delete(oldest[0]);
    }
    for (const [k, t] of processed) {
      if (now - t > windowMs) processed.delete(k);
    }
    return true;
  };
  return Object.assign(guard, { forget: (channelId: string, chatId: string, messageId: string) => {
    processed.delete(JSON.stringify([channelId, chatId, messageId]));
  } });
}

/** 白名单判断：未配置（空数组）= 不限制 */
export function isAllowedUser(allowUsers: string[], senderId?: string): boolean {
  if (allowUsers.length === 0) return true;
  return Boolean(senderId && allowUsers.includes(senderId));
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
  adapters?: { feishu?: FeishuChannelAdapter; wecom?: WecomChannelAdapter; wechat?: WechatMpChannelAdapter;
    telegram?: TelegramChannelAdapter; slack?: SlackSocketModeAdapter;
    dingtalk?: DingTalkStreamAdapter; discord?: DiscordGatewayAdapter; qq?: QQChannelAdapter; weixin?: WeixinIlinkAdapter };
  weixinQrLoginFactory?: (options: ConstructorParameters<typeof WeixinQrLogin>[0]) => WeixinQrLogin;
  qqQrLoginFactory?: (options: ConstructorParameters<typeof QQBotQrLogin>[0]) => QQBotQrLogin;
}

export class GatewayService {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly platforms = new GatewayPlatformRegistry();
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
  private webhookServer: Server | null = null;
  /**
   * Webhook 端口。首选 52140（历史值）可能落在 Windows 的 TCP 保留区间内，
   * 此时由 webhook-port 模块按候选表自动回退；实际绑定端口会写回这里并展示给用户。
   */
  private webhookPort = DEFAULT_WEBHOOK_PORT;
  private running = false;
  private stopping = false;
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
    this.dingtalk = options.adapters?.dingtalk ?? new DingTalkStreamAdapter("dingtalk-default", "钉钉", { deferInboundUntilActivated: true });
    this.discord = options.adapters?.discord ?? new DiscordGatewayAdapter("discord-default", "Discord", {
      deferInboundUntilActivated: true,
      onStatus: text => this.emitEvent({ channelId: "discord-default", direction: "system", text: text || "Discord 连接状态已更新", at: Date.now() }),
    });
    this.qq = options.adapters?.qq ?? new QQChannelAdapter("qq-default", "QQ 扫码机器人", { deferInboundUntilActivated: true });
    const qrOptions: ConstructorParameters<typeof QQBotQrLogin>[0] = {
      onAuthorized: (credentials, assertCurrent, signal) => this.acceptQQQrLogin(credentials, assertCurrent, signal),
    };
    this.qqQrLogin = options.qqQrLoginFactory?.(qrOptions) ?? new QQBotQrLogin(qrOptions);
    this.weixin = options.adapters?.weixin ?? new WeixinIlinkAdapter("weixin-default", "微信 iLink Bot", { deferInboundUntilActivated: true });
    const weixinQrOptions: ConstructorParameters<typeof WeixinQrLogin>[0] = {
      onAuthorized: (credentials, assertCurrent, signal) => this.acceptWeixinQrLogin(credentials, assertCurrent, signal),
    };
    this.weixinQrLogin = options.weixinQrLoginFactory?.(weixinQrOptions) ?? new WeixinQrLogin(weixinQrOptions);
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
    const operation = (async () => {
      const stop = () => { void this.qq.disconnect(); };
      signal.addEventListener("abort", stop, { once: true });
      try {
        assertCurrent();
        if (signal.aborted || this.stopping) throw new Error("QQ 授权已取消");
        const config = validateGatewayProviderConfig("qq", {
          appId: credentials.appId, appSecret: credentials.appSecret, allowUsers: [credentials.userOpenid],
        });
        const savedConfig = sealGatewayProviderConfig("qq", config);
        this.channelPolicies.delete(this.qq.id);
        await this.qq.connect(config);
        assertCurrent();
        if (signal.aborted || this.stopping) throw new Error("QQ 授权已取消");
        // No await between the final cancellation check, synchronous save and activation.
        this.db.connection.transaction(() => {
          this.db.upsertGatewayChannel({ id: this.qq.id, type: this.qq.type, name: this.qq.name,
            configJson: JSON.stringify(savedConfig), connected: true, statusText: this.qq.statusText() });
          this.qq.activate();
        })();
        this.channelPolicies.set(this.qq.id, { allowUsers: [credentials.userOpenid] });
        this.running = true;
        // A closed renderer must not turn a committed authorization into a reported failure.
        try { this.emitEvent({ channelId: this.qq.id, direction: "system", text: "QQ 扫码授权完成，连接已启用", at: Date.now() }); } catch { /* state is available through status() */ }
      } catch {
        await this.qq.disconnect();
        this.channelPolicies.delete(this.qq.id);
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
    const operation = (async () => {
      const stop = () => { void this.weixin.disconnect(); };
      signal.addEventListener("abort", stop, { once: true });
      try {
        assertCurrent();
        if (signal.aborted || this.stopping) throw new Error("微信 授权已取消");
        const config = validateGatewayProviderConfig("weixin", {
          accountId: credentials.accountId, botToken: credentials.botToken, baseUrl: credentials.baseUrl, userId: credentials.userId, allowUsers: [credentials.userId],
        });
        const savedConfig = sealGatewayProviderConfig("weixin", config);
        this.channelPolicies.delete(this.weixin.id);
        await this.weixin.connect(config);
        assertCurrent();
        if (signal.aborted || this.stopping) throw new Error("微信 授权已取消");
        // No await between the final cancellation check, synchronous save and activation.
        this.db.connection.transaction(() => {
          this.db.upsertGatewayChannel({ id: this.weixin.id, type: this.weixin.type, name: this.weixin.name,
            configJson: JSON.stringify(savedConfig), connected: true, statusText: this.weixin.statusText() });
          this.weixin.activate();
        })();
        this.channelPolicies.set(this.weixin.id, { allowUsers: [credentials.userId] });
        this.running = true;
        // A closed renderer must not turn a committed authorization into a reported failure.
        try { this.emitEvent({ channelId: this.weixin.id, direction: "system", text: "微信 扫码授权完成，连接已启用", at: Date.now() }); } catch { /* state is available through status() */ }
      } catch {
        await this.weixin.disconnect();
        this.channelPolicies.delete(this.weixin.id);
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
    const result = await adapter.sendWorkNotification!({ ...input, assertCurrent: check });
    if (result.ok) this.emitEvent({ channelId: input.target.channelId, chatId: input.target.chatId,
      direction: "out", text: input.text, at: Date.now() });
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

  private markProcessed(channelId: string, chatId: string, messageId: string): boolean {
    return this.processed(channelId, chatId, messageId);
  }

  setTrashedWorkspaceRestorer(restore: (taskId: string) => void): void {
    this.restoreTrashedWorkspace = restore;
  }

  /** 已删除的网关会话还有同一条外部聊天。执行前把工作目录从回收区移回，避免「目录不存在」。 */
  private reviveTrashedGatewayTask(sourceTaskId: string): void {
    if (!this.restoreTrashedWorkspace) return;
    const taskId = gatewayBotTaskId(sourceTaskId);
    if (this.db.getTaskExecutionWorkspaceState(taskId)?.state !== "trashed") return;
    this.restoreTrashedWorkspace(taskId);
  }

  /** 还没有文件夹的会话归入渠道空间。已经有归属的不搬走，失败也不挡住这条消息。 */
  private spaceIdForUnfiledGatewayTask(channelId: string, sourceTaskId: string): string | undefined {
    if (this.db.getTask(gatewayBotTaskId(sourceTaskId))?.spaceId) return undefined;
    try {
      return ensureGatewayChannelSpace(this.db, channelId, this.adapters.get(channelId)?.name ?? channelId);
    } catch (error) {
      console.warn(`[Gateway] 未能为 ${channelId} 建立渠道文件夹：`, error);
      return undefined;
    }
  }

  private createInboundHandler(): GatewayInboundHandler {
    return async (msg) => {
      if (this.stopping) throw new Error("Gateway 正在关闭，消息将在重连后继续");
      // Slack validates its binding and persists dedupe before acknowledging events.
      if (msg.channelId === this.slack.id) return this.handleSlackInbound(msg);
      const inboundAdapter = this.adapters.get(msg.channelId);
      if (inboundAdapter && isSecureGatewayProvider(inboundAdapter.type) && !this.channelPolicies.has(msg.channelId)) {
        throw new Error("Gateway 授权配置尚未生效，未执行");
      }
      // ① 白名单：未授权用户直接忽略（不发系统事件，避免噪音）
      if (!this.isAllowed(msg.channelId, msg.sender?.id)) {
        console.warn(`[Gateway] 拒绝未授权用户 ${msg.sender?.id ?? "(unknown)"} @ ${msg.channelId}`);
        return;
      }
      // Bind native sessions, receipts and dedupe to the verified account before
      // any persistent side effect. Never adopt an unscoped legacy conversation.
      const connectionKey = this.adapters.get(msg.channelId)?.workConnectionKey?.();
      if (!connectionKey) throw new Error("Gateway 缺少已核验的连接账号身份，未执行");
      if (msg.workTarget && msg.workTarget.connectionKey !== connectionKey) {
        throw new Error("Gateway 入站连接账号已改变，未执行");
      }
      const { taskId, turnId } = gatewayInboundIdentity(msg.channelId, connectionKey, msg.chatId, msg.messageId);
      // ② 幂等：平台失败重试投递同一条消息时不再执行
      if (msg.messageId && !this.markProcessed(taskId, msg.chatId, msg.messageId)) {
        console.warn(`[Gateway] 忽略重复消息 ${msg.messageId} @ ${msg.channelId}`);
        return;
      }

      this.emitEvent({
        channelId: msg.channelId,
        direction: "in",
        text: msg.text,
        at: Date.now(),
        chatId: msg.chatId,
        senderId: msg.sender?.id,
        senderName: msg.sender?.name,
        messageId: msg.messageId,
      });

      // 项目投递钩子：命中 `@项目 <名>：内容` 则记录项目事件（fail-open，不影响原流程）
      try {
        this.projectMessageSink?.({
          text: msg.text,
          channelId: msg.channelId,
          chatId: msg.chatId,
          messageId: msg.messageId,
          senderName: msg.sender?.name,
        });
      } catch (err) {
        console.warn(`[Gateway] 项目投递钩子失败 ${msg.channelId}：`, err);
      }

      const spaceId = this.spaceIdForUnfiledGatewayTask(msg.channelId, taskId);
      try { this.recordWorkTarget(msg, taskId, `gw-user-${turnId}`); }
      catch (error) {
        if (msg.messageId) this.processed.forget(taskId, msg.chatId, msg.messageId);
        throw error;
      }
      let text: string;
      try {
        this.reviveTrashedGatewayTask(taskId);
        const modelId = this.settingsStore.read().defaultModelId?.trim();
        text = await runGatewayAgentTurn(this.agent, {
          taskId, text: msg.text, assistantMessageId: `gw-asst-${turnId}`, userMessageId: `gw-user-${turnId}`,
          ...(modelId ? { modelId } : {}),
          ...(spaceId ? { spaceId } : {}),
        });
      } catch (err) {
        if (this.stopping) throw err;
        text = `处理失败：${err instanceof Error ? err.message : String(err)}`;
      }
      try {
        if (this.stopping || this.adapters.get(msg.channelId)?.workConnectionKey?.() !== connectionKey) {
          throw new Error("Gateway 回复连接账号已改变，未发送");
        }
        await msg.reply(text);
        this.emitEvent({
          channelId: msg.channelId,
          direction: "out",
          text,
          at: Date.now(),
          chatId: msg.chatId,
        });
      } catch (err) {
        // Re-delivery reuses the native receipt, including after process restart.
        if (msg.messageId) this.processed.forget(taskId, msg.chatId, msg.messageId);
        this.emitEvent({
          channelId: msg.channelId,
          direction: "system",
          text: `回复发送失败：${err instanceof Error ? err.message : String(err)}`,
          at: Date.now(),
          chatId: msg.chatId,
        });
        throw err;
      }
    };
  }

  private async handleSlackInbound(msg: GatewayInboundMessage): Promise<void> {
    if (!msg.taskId || !msg.userMessageId || !msg.assistantMessageId) throw new Error("Slack 任务身份缺失，未执行");
    this.recordWorkTarget(msg, msg.taskId, msg.userMessageId);
    this.emitEvent({
      channelId: msg.channelId, direction: "in", text: msg.text, at: Date.now(),
      chatId: msg.chatId, senderId: msg.sender?.id, messageId: msg.messageId,
    });
    try {
      this.projectMessageSink?.({ text: msg.text, channelId: msg.channelId, chatId: msg.chatId,
        messageId: msg.messageId, senderName: msg.sender?.name });
    } catch { /* Existing project ingestion remains optional; Pi still receives the instruction. */ }
    if (msg.slackHistory?.status === "unavailable") {
      const code = msg.slackHistory.errorCode ?? "request_failed";
      const text = code === "missing_scope"
        ? "已收到你的 @，但 Bot 读取这个频道的历史被 Slack 拒绝（missing_scope）。本次尚未读到前面的聊天，需要先确认该频道的历史读取权限。"
        : "已收到你的 @，但本次未能读取前面的频道聊天（" + code + "）。请稍后重试；本次没有使用其他内容代替频道历史。";
      await msg.reply(text);
      this.emitEvent({ channelId: msg.channelId, direction: "out", text, at: Date.now(), chatId: msg.chatId });
      return;
    }
    let text: string;
    try {
      this.reviveTrashedGatewayTask(msg.taskId);
      const settings = this.settingsStore.read();
      const modelId = settings.defaultModelId?.trim() || undefined;
      const spaceId = this.spaceIdForUnfiledGatewayTask(msg.channelId, msg.taskId);
      text = await runGatewayAgentTurn(this.agent, {
        taskId: msg.taskId, text: withSlackChannelHistory(msg.text, msg.slackHistory), displayText: msg.text, userMessageId: msg.userMessageId,
        assistantMessageId: msg.assistantMessageId,
        streamingBehavior: "followUp", ...(modelId ? { modelId } : {}),
        ...(spaceId ? { spaceId } : {}),
      });
    } catch (error) {
      if (this.stopping) throw error;
      text = "任务处理失败：" + safeSlackError(error);
    }
    text = redactSlackText(text);
    // Network failure is an outbox failure, not a second native task execution.
    await msg.reply(text);
    this.emitEvent({ channelId: msg.channelId, direction: "out", text, at: Date.now(), chatId: msg.chatId });
  }

  async start(): Promise<void> {
    this.stopping = false;
    if (this.webhookServer) return;
    await this.startWebhookServer();
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
    this.stopping = false;
    for (const row of this.db.listGatewayChannels()) {
      if (!row.connected) continue;
      const adapter = this.adapters.get(row.id);
      if (!adapter) continue;
      let config: Record<string, unknown> = {};
      try {
        config = JSON.parse(row.configJson || "{}") as Record<string, unknown>;
      } catch {
        console.warn(`[Gateway] ${row.id} 配置损坏，跳过恢复`);
        continue;
      }
      try {
        // Upgrade legacy callback credentials before enabling any transport.
        if ((adapter.type === "feishu" || adapter.type === "wecom") && !config.encryptedSecrets) {
          config = sealGatewayProviderConfig(adapter.type, validateGatewayProviderConfig(adapter.type, config));
          this.db.upsertGatewayChannel({ ...row, configJson: JSON.stringify(config) });
        }
        const opened = adapter.type === "slack" ? openSlackGatewayConfig(config)
          : isSecureGatewayProvider(adapter.type) ? openGatewayProviderConfig(adapter.type, config) : config;
        if (!this.isSocketOnly(adapter, opened)) await this.start();
        await adapter.connect(opened);
        if (this.isSocketOnly(adapter)) this.running = true;
        this.channelPolicies.set(row.id, { allowUsers: toStrArray(config.allowUsers) });
        if (adapter.type === "feishu") this.feishu.activate();
        if (adapter.type === "wecom") this.wecom.activate();
        if (adapter.type === "slack") this.slack.activate();
        if (adapter.type === "discord") this.discord.activate();
        if (adapter.type === "dingtalk") this.dingtalk.activate();
    if (adapter.type === "qq") this.qq.activate();
    if (adapter.type === "weixin") this.weixin.activate();
        this.emitEvent({
          channelId: row.id,
          direction: "system",
          text: `${adapter.name} 已恢复连接`,
          at: Date.now(),
        });
      } catch (err) {
        const message = adapter.type === "slack" ? safeSlackError(err) : err instanceof Error ? err.message : String(err);
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
    this.stopping = true;
    await this.cancelQQQrLogin();
    await this.cancelWeixinQrLogin();
    for (const a of this.adapters.values()) {
      if (a.isConnected() || this.isSocketOnly(a)) await a.disconnect();
    }
  }

  async stop(): Promise<void> {
    await this.suspend();
    await new Promise<void>((resolve) => {
      if (!this.webhookServer) return resolve();
      this.webhookServer.close(() => resolve());
    });
    this.webhookServer = null;
    this.running = false;
  }

  status(): GatewayStatusDto {
    return {
      running: this.running,
      channels: this.listChannels(),
    };
  }

  listChannels(): GatewayChannelDto[] {
    return [...this.adapters.values()].map((a) => ({
      id: a.id,
      type: a.type,
      name: a.name,
      connected: a.isConnected(),
      statusText: a.statusText(),
    }));
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
    if (channelId === this.weixin.id) throw new Error("微信请使用专用扫码授权入口，不接收手工提交的凭据");
    if (channelId === this.qq.id) throw new Error("QQ 请使用专用扫码授权入口，不接收手工提交的凭据");
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
    if (!this.isSocketOnly(adapter, merged)) await this.start();
    if (isSecureGatewayProvider(adapter.type)) this.channelPolicies.delete(adapter.id);
    await adapter.connect(merged);
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
      this.channelPolicies.delete(adapter.id);
      this.running = this.webhookServer !== null || [...this.adapters.values()].some(channel => channel.isConnected());
      throw new Error(`${adapter.name} 安全配置保存失败，接收已暂停；原有配置保留`);
    }
    if (adapter.type === "feishu") this.feishu.activate();
    if (adapter.type === "wecom") this.wecom.activate();
    if (adapter.type === "slack") this.slack.activate();
    if (adapter.type === "discord") this.discord.activate();
    if (adapter.type === "dingtalk") this.dingtalk.activate();
    if (adapter.type === "qq") this.qq.activate();
    if (adapter.type === "weixin") this.weixin.activate();
    this.emitEvent({
      channelId,
      direction: "system",
      text: `${adapter.name} 已连接`,
      at: Date.now(),
    });
    return this.status();
  }

  async disconnect(channelId: string): Promise<GatewayStatusDto> {
    if (channelId === this.qq.id) await this.cancelQQQrLogin();
    if (channelId === this.weixin.id) await this.cancelWeixinQrLogin();
    const adapter = this.adapters.get(channelId);
    if (!adapter) throw new Error(`unknown channel: ${channelId}`);
    await adapter.disconnect();
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
      console.warn("[Gateway] 消息落库失败", err);
    }
    broadcast(GatewayIpc.event, ev);
    this.workNotificationWake?.();
  }

  private isSocketOnly(adapter: ChannelAdapter, config?: Record<string, unknown>): boolean {
    return gatewayCapabilities(adapter, config).transport !== "webhook";
  }

  private createWebhookServer(): Server {
    return createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.webhookPort}`);
      const path = url.pathname;

      if (req.method === "POST" && path.startsWith("/feishu")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: unknown = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
        } catch {
          res.writeHead(400);
          res.end("bad json");
          return;
        }
        try {
          const result = await this.feishu.handleWebhookPayload(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result ?? { ok: true }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.writeHead(500);
          res.end(message);
        }
        return;
      }

      if (
        (req.method === "GET" || req.method === "POST") &&
        (path.startsWith("/wecom") || path.startsWith("/wechat"))
      ) {
        const chunks: Buffer[] = [];
        if (req.method === "POST") {
          for await (const chunk of req) chunks.push(chunk as Buffer);
        }
        const rawBody = Buffer.concat(chunks).toString("utf-8");
        const adapter = path.startsWith("/wecom") ? this.wecom : this.wechat;
        try {
          const result = await adapter.handleHttp({
            method: req.method ?? "GET",
            query: url.searchParams,
            rawBody,
          });
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "text/plain",
          });
          res.end(result.body);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.writeHead(500);
          res.end(message);
        }
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });
  }

  private async startWebhookServer(): Promise<void> {
    if (this.webhookServer) return;
    // 首选端口在 Windows 保留区间内会 EACCES，这里自动回退到可用候选端口。
    const { port, server } = await listenOnFirstAvailablePort(() => this.createWebhookServer(), this.webhookPort);
    this.webhookServer = server;
    this.webhookPort = port;
  }
}
