import { randomUUID } from "node:crypto";
import type { GatewayRegistrationDetails, GatewayRegistrationField, GatewayRegistrationProvider, GatewayRegistrationState } from "../../shared/gateway-registration";

export interface RegistrationCredentials {
  clientId: string;
  clientSecret: string;
  corpId?: string;
  robotCode?: string;
  ownerId?: string;
}
export interface RegistrationTicket { qrUrl: string; expiresInSeconds: number; intervalSeconds: number; token: unknown }
export type RegistrationPoll = { state: "pending"; intervalSeconds?: number } | { state: "expired" } | { state: "authorized"; credentials: RegistrationCredentials };
export interface RegistrationDriver {
  begin(signal: AbortSignal): Promise<RegistrationTicket>;
  poll(ticket: RegistrationTicket, signal: AbortSignal): Promise<RegistrationPoll>;
}
export interface BusinessBotRegistrationOptions {
  provider: GatewayRegistrationProvider;
  driver: RegistrationDriver;
  onAuthorized: (config: Record<string, unknown>, current: () => void, signal: AbortSignal) => Promise<void>;
  /** Injected only for deterministic protocol tests. */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); reject(new Error("cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, ms);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
const value = (input: unknown): string => typeof input === "string" && input.length <= 4096 ? input.trim() : "";
/** One enrollment generation owns every awaited response, including connection/save.
 * An authorized credential remains only in this process while required identity
 * fields are supplied. It is never returned to the renderer or logged. */
export class BusinessBotRegistration {
  private state: GatewayRegistrationState = { state: "idle", message: "尚未开始扫码创建机器人" };
  private attempt?: { id: string; controller: AbortController; deadline: number; credentials?: RegistrationCredentials; finishing?: Promise<GatewayRegistrationState>; expiryTimer?: ReturnType<typeof setTimeout> };
  private readonly now: () => number;
  constructor(private readonly options: BusinessBotRegistrationOptions) { this.now = options.now ?? Date.now; }
  getState(): GatewayRegistrationState { return { ...this.state, ...(this.state.missingFields ? { missingFields: [...this.state.missingFields] } : {}) }; }
  cancel(sessionId?: string): GatewayRegistrationState {
    if (sessionId !== undefined && sessionId !== this.state.sessionId) return this.getState();
    const attempt = this.attempt;
    this.attempt = undefined;
    if (attempt) { clearTimeout(attempt.expiryTimer); attempt.credentials = undefined; attempt.controller.abort(); }
    this.state = { state: "cancelled", sessionId: this.state.sessionId, message: "扫码已取消；不会保存新凭据" };
    return this.getState();
  }
  async start(approved: boolean): Promise<GatewayRegistrationState> {
    if (approved !== true) throw new Error("请先同意创建机器人并加密保存凭据用于持续连接");
    this.cancel();
    const attempt = { id: randomUUID(), controller: new AbortController(), deadline: this.now() + 600_000 };
    this.attempt = attempt;
    this.state = { state: "waiting", sessionId: attempt.id, message: "正在获取官方机器人创建二维码" };
    try {
      const ticket = await this.options.driver.begin(attempt.controller.signal);
      this.current(attempt);
      if (!Number.isFinite(ticket.expiresInSeconds) || ticket.expiresInSeconds <= 0 || !Number.isFinite(ticket.intervalSeconds) || ticket.intervalSeconds <= 0) throw new Error("invalid ticket");
      attempt.deadline = this.now() + Math.min(ticket.expiresInSeconds, 600) * 1000;
      this.state = { state: "waiting", sessionId: attempt.id, qrUrl: ticket.qrUrl, message: "请扫码并在官方页面确认创建机器人" };
      void this.poll(attempt, ticket).catch(() => this.fail(attempt));
    } catch { this.fail(attempt); }
    return this.getState();
  }
  private current(attempt: NonNullable<BusinessBotRegistration["attempt"]>): void {
    if (this.attempt !== attempt || attempt.controller.signal.aborted || this.now() >= attempt.deadline) throw new Error("registration no longer current");
  }
  private fail(attempt: NonNullable<BusinessBotRegistration["attempt"]>): void {
    if (this.attempt !== attempt) return;
    const expired = this.now() >= attempt.deadline;
    clearTimeout(attempt.expiryTimer); attempt.credentials = undefined; attempt.controller.abort(); this.attempt = undefined;
    this.state = { state: expired ? "expired" : "error", sessionId: attempt.id,
      message: expired ? "二维码或补全会话已过期，请重新扫码" : "扫码创建或连接失败；原有保存配置未覆盖，请重试或使用手工配置" };
  }
  private async poll(attempt: NonNullable<BusinessBotRegistration["attempt"]>, ticket: RegistrationTicket): Promise<void> {
    let interval = ticket.intervalSeconds;
    while (true) {
      this.current(attempt);
      await (this.options.delay ?? delay)(Math.min(interval, 30) * 1000, attempt.controller.signal);
      this.current(attempt);
      const result = await this.options.driver.poll(ticket, attempt.controller.signal);
      this.current(attempt);
      if (result.state === "pending") { if (result.intervalSeconds) interval = Math.max(interval, result.intervalSeconds); continue; }
      if (result.state === "expired") { attempt.deadline = this.now(); this.fail(attempt); return; }
      const credentials = result.credentials;
      if (!value(credentials.clientId) || !value(credentials.clientSecret)) throw new Error("missing credentials");
      attempt.credentials = credentials;
      const missing = this.missing(credentials, {});
      if (missing.length) {
        // Bound the in-memory completion window; cancellation/restart discards secrets.
        attempt.deadline = this.now() + 600_000;
        attempt.expiryTimer = setTimeout(() => { if (this.attempt === attempt) { attempt.deadline = this.now(); this.fail(attempt); } }, 600_000);
        attempt.expiryTimer.unref?.();
        this.state = { state: "configuration", sessionId: attempt.id, missingFields: missing,
          message: "机器人已创建。请补全接入身份后连接；密钥留在本机主进程，不会显示或写入日志" };
        return;
      }
      await this.finish(attempt.id, {}); return;
    }
  }
  private missing(credentials: RegistrationCredentials, details: GatewayRegistrationDetails): GatewayRegistrationField[] {
    const fields: GatewayRegistrationField[] = [];
    if (this.options.provider === "dingtalk") {
      if (!value(credentials.corpId) && !value(details.corpId)) fields.push("corpId");
      if (!value(credentials.robotCode) && !value(details.robotCode)) fields.push("robotCode");
    }
    if (!value(credentials.ownerId) && (!Array.isArray(details.allowUsers) || !details.allowUsers.length || details.allowUsers.some(id => !value(id)))) fields.push("allowUsers");
    return fields;
  }
  async finish(sessionId: string, details: GatewayRegistrationDetails): Promise<GatewayRegistrationState> {
    const attempt = this.attempt;
    if (!attempt || attempt.id !== sessionId) throw new Error("扫码会话已失效，请重新开始");
    if (attempt.finishing) return attempt.finishing;
    try { this.current(attempt); } catch { this.fail(attempt); return this.getState(); }
    if (!attempt.credentials) throw new Error("扫码尚未完成");
    if (!details || typeof details !== "object" || Array.isArray(details)) throw new Error("接入身份无效");
    const credentials = attempt.credentials;
    const missing = this.missing(credentials, details);
    if (missing.length) {
      this.state = { state: "configuration", sessionId, missingFields: missing, message: "请补全接入身份，不能开放机器人给所有人" };
      return this.getState();
    }
    const allowUsers = credentials.ownerId ? [credentials.ownerId] : [...new Set(details.allowUsers!.map(id => value(id)))];
    if (allowUsers.length > 100) throw new Error("允许的用户过多");
    const config = this.options.provider === "feishu"
      ? { appId: credentials.clientId, appSecret: credentials.clientSecret, transport: "websocket", allowUsers }
      : this.options.provider === "wecom" ? { botId: credentials.clientId, secret: credentials.clientSecret, mode: "smart", allowUsers }
      : { clientId: credentials.clientId, clientSecret: credentials.clientSecret, corpId: value(credentials.corpId) || value(details.corpId), robotCode: value(credentials.robotCode) || value(details.robotCode), allowUsers };
    this.state = { state: "binding", sessionId, message: "正在加密保存并验证连接" };
    const finishing = (async () => {
      try {
        this.current(attempt);
        await this.options.onAuthorized(config, () => this.current(attempt), attempt.controller.signal);
        this.current(attempt);
        clearTimeout(attempt.expiryTimer); attempt.credentials = undefined; this.attempt = undefined;
        this.state = { state: "connected", sessionId, message: "机器人已连接，后续启动将恢复连接" };
      } catch { this.fail(attempt); }
      return this.getState();
    })();
    attempt.finishing = finishing;
    return finishing;
  }
}
