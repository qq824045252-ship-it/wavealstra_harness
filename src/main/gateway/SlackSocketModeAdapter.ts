import { withGatewayMedia, GATEWAY_MEDIA_LIMITS, type GatewayMediaSource } from "./GatewayMedia";
import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { basename } from "node:path";
import type { ChannelAdapter, ChannelConfig, GatewayInboundHandler, SlackChannelHistory } from "./channels";
import { SlackGatewayJournal, slackTaskId, slackTurnIds, type SlackDelivery } from "./SlackGatewayJournal";
import { assertGatewayWorkSend, gatewayConnectionKey, gatewayWorkTarget, GatewayWorkNotSentError,
  postGatewayWork, providerRejected, unknownProviderReceipt,
  type GatewayWorkSendInput, type GatewayWorkSendResult } from "./work-outbound";

export interface SlackSocket {
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}
interface SlackConfig { botToken: string; appToken: string; teamId: string; appId: string; allowUsers: string[] }
type SlackApiResult = Record<string, unknown> & { ok?: boolean; error?: string };
export interface SlackSocketOptions {
  journal: SlackGatewayJournal;
  socketFactory?: (url: string) => SlackSocket;
  fetch?: typeof fetch;
  mediaDirectory?: string;
  reconnectDelayMs?: number;
  replyRetryDelayMs?: number;
  helloTimeoutMs?: number;
  /** Gateway commits OS-encrypted configuration before releasing accepted tasks. */
  deferInboundUntilActivated?: boolean;
  onStatus?: (text: string) => void;
  /** Diagnostics contain no message bodies or credentials. */
  onHistoryRead?: (value: { channelId: string; status: "loaded" | "unavailable"; messageCount: number; errorCode?: string; requiredScopes?: string[] }) => void;
}
class SlackApiError extends Error {
  constructor(message: string, readonly retryable = false, readonly retryMs = 3000,
    readonly code?: string, readonly requiredScopes: string[] = []) { super(message); }
}

/** Transport/provider errors may contain tokens or temporary connection URLs. Never persist/forward those values. */
export function safeSlackError(error: unknown, secrets: string[] = []): string {
  const text = redactSlackText(error instanceof Error ? error.message : "Slack 消息处理失败", secrets);
  return text.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, "[网络地址已隐藏]")
    .slice(0, 2000);
}

export function redactSlackText(value: string, secrets: string[] = []): string {
  let text = value;
  for (const secret of secrets) if (secret) text = text.split(secret).join("[凭据已隐藏]");
  return text.replace(/\b(?:xox[a-z]-|xapp-)[A-Za-z0-9-]+/gi, "[凭据已隐藏]")
    .replace(/\bBearer\s+[^\s,"'<>]+/gi, "Bearer [凭据已隐藏]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,"'}]+/gi, "$1[凭据已隐藏]");
}

export function splitSlackReply(text: string): string[] {
  const characters = Array.from(text);
  const result: string[] = [];
  for (let offset = 0; offset < characters.length; offset += 4000) result.push(characters.slice(offset, offset + 4000).join(""));
  return result.length ? result : ["任务已处理，但未产生文本回复。"];
}

function replyClientId(delivery: SlackDelivery, index: number): string {
  const hash = createHash("sha256").update([delivery.teamId, delivery.appId, delivery.eventId, index].join(":")).digest("hex");
  return hash.slice(0, 8) + "-" + hash.slice(8, 12) + "-4" + hash.slice(13, 16) + "-8" + hash.slice(17, 20) + "-" + hash.slice(20, 32);
}

function parseConfig(config: ChannelConfig): SlackConfig {
  const result: SlackConfig = {
    botToken: String(config.botToken ?? "").trim(), appToken: String(config.appToken ?? "").trim(),
    teamId: String(config.teamId ?? "").trim(), appId: String(config.appId ?? "").trim(),
    allowUsers: Array.isArray(config.allowUsers) ? [...new Set(config.allowUsers.map(String).map(value => value.trim()).filter(Boolean))] : [],
  };
  if (!result.botToken.startsWith("xoxb-")) throw new Error("Slack 需要已安装应用的 Bot Token；MCP 用户 OAuth 不能替代它");
  if (!result.appToken.startsWith("xapp-")) throw new Error("Slack Socket Mode 需要具有 connections:write 的 App Token");
  if (!/^T[A-Z0-9]+$/.test(result.teamId) || !/^A[A-Z0-9]+$/.test(result.appId)) throw new Error("Slack 需要明确的工作区 ID 和 App ID");
  if (!result.allowUsers.length || result.allowUsers.some(user => !/^[UW][A-Z0-9]+$/.test(user))) {
    throw new Error("Slack 允许用户不能为空，请填写明确的 Member ID；不会允许所有用户");
  }
  return result;
}

/**
 * Slack's documented Socket Mode protocol, using the host's native WebSocket/fetch.
 * This adapter owns delivery/ACK/outbox only; existing AgentService/Pi owns all task execution.
 */
export class SlackSocketModeAdapter implements ChannelAdapter {
  readonly type = "slack" as const;
  private config: SlackConfig | null = null;
  private onInbound: GatewayInboundHandler | null = null;
  private socket: SlackSocket | null = null;
  private stopped = true;
  private connected = false;
  private activated = false;
  private generation = 0;
  private lastError = "";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private replyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly inFlight = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();
  private botUserId = "";
  private readonly fetcher: typeof fetch;

  constructor(readonly id: string, readonly name: string, private readonly options: SlackSocketOptions) {
    this.fetcher = options.fetch ?? fetch;
  }
  setInboundHandler(handler: GatewayInboundHandler): void { this.onInbound = handler; }
  isConnected(): boolean { return this.connected; }
  statusText(): string { return this.lastError || (this.connected ? "已连接（Socket Mode，限定工作区和用户）" : "未连接"); }
  gatewayConnectionGeneration(): unknown { return this.socket; }
  workConnectionKey(): string | undefined {
    return this.connected && this.activated && this.config && this.botUserId
      ? gatewayConnectionKey(this.type, [this.config.teamId, this.config.appId, this.botUserId]) : undefined;
  }

  /** Work owns the attempt/effect ledger. Never put its delivery into the reply journal. */
  async sendWorkNotification(input: GatewayWorkSendInput): Promise<GatewayWorkSendResult> {
    assertGatewayWorkSend(input, this);
    if (input.target.channelType !== "slack" || !this.config) throw new GatewayWorkNotSentError("Slack 通知目标不匹配");
    const target = input.target.address;
    if (!this.activated || !this.allows({ ...target, userId: input.target.senderId })) {
      throw new GatewayWorkNotSentError("Slack 原发送者或目标不再获授权，本次未发送");
    }
    const hash = createHash("sha256").update(input.effectKey).digest("hex");
    const clientId = hash.slice(0, 8) + "-" + hash.slice(8, 12) + "-4" + hash.slice(13, 16) + "-8" + hash.slice(17, 20) + "-" + hash.slice(20, 32);
    return postGatewayWork({ label: "Slack", fetcher: this.fetcher, signal: input.signal,
      url: "https://slack.com/api/chat.postMessage", headers: { Authorization: "Bearer " + this.config.botToken },
      body: { channel: target.channel, thread_ts: target.threadTs,
        text: redactSlackText(input.text, [this.config.botToken, this.config.appToken]),
        client_msg_id: clientId, unfurl_links: false, unfurl_media: false, reply_broadcast: false },
      interpret(data, response) {
        if (data.ok === false && typeof data.error === "string") return providerRejected("Slack", data.error);
        return response.ok && data.ok === true && data.channel === target.channel && typeof data.ts === "string"
          && /^\d+\.\d+$/.test(data.ts) ? { ok: true, receipt: `slack:${target.teamId}:${target.channel}:${data.ts}` }
          : unknownProviderReceipt("Slack");
      } });
  }
  private report(text: string): void { this.lastError = text; this.options.onStatus?.(text); }
  private ownerUserId(): string { return this.config?.allowUsers[0] ?? ""; }
  private deliveryKey(delivery: SlackDelivery): string { return [delivery.teamId, delivery.appId, delivery.eventId].join(":"); }
  private allows(delivery: Pick<SlackDelivery, "appId" | "teamId" | "userId" | "channel">): boolean {
    return Boolean(this.config && delivery.appId === this.config.appId && delivery.teamId === this.config.teamId
      && this.config.allowUsers.includes(delivery.userId)
      && (!/^[CG]/.test(delivery.channel) || delivery.userId === this.ownerUserId()));
  }

  async connect(rawConfig: ChannelConfig): Promise<void> {
    const config = parseConfig(rawConfig);
    await this.disconnect();
    const generation = this.generation;
    this.config = config;
    this.stopped = false;
    this.report("Slack 安装与工作区核验中…");
    try {
      const identity = await this.api("auth.test", config.botToken);
      if (!identity.bot_id || !identity.user_id) throw new Error("该凭据不是已安装 Bot 的令牌");
      if (identity.team_id !== config.teamId) throw new Error("Bot 安装工作区与指定工作区不一致，未启动接收");
      if (generation !== this.generation || this.stopped) throw new Error("Slack 连接已取消");
      this.botUserId = String(identity.user_id);
      this.options.journal.list(); // Refuse to ACK if durable recovery storage is corrupt.
      await this.openSocket(generation);
      if (!this.options.deferInboundUntilActivated) this.activate();
    } catch (error) {
      await this.disconnect();
      this.config = null;
      const message = safeSlackError(error, [config.botToken, config.appToken]);
      this.report(message);
      throw new Error(message);
    }
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    this.activated = false;
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.replyTimer) clearTimeout(this.replyTimer);
    this.reconnectTimer = this.replyTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    // Existing Pi turns continue. Their replies stay in the outbox until explicitly reconnected.
    this.lastError = "";
  }

  activate(): void {
    if (this.stopped || !this.config) return;
    this.activated = true;
    this.resumeDeliveries();
  }

  private async api(method: "auth.test" | "apps.connections.open" | "chat.postMessage" | "conversations.history" | "files.info", token: string, body: Record<string, unknown> = {}): Promise<SlackApiResult> {
    let response: Response;
    try {
      const readingHistory = method === "conversations.history" || method === "files.info";
      const query = readingHistory ? "?" + new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])) : "";
      response = await this.fetcher("https://slack.com/api/" + method + query, {
        method: readingHistory ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        ...(readingHistory ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new SlackApiError("Slack 网络请求失败；连接或待发送回复会重试", true); }
    if (response.redirected) throw new SlackApiError("Slack API 重定向已拒绝");
    if (response.status === 429) {
      const delay = Math.min(60, Math.max(1, Number(response.headers.get("retry-after")) || 3)) * 1000;
      throw new SlackApiError("Slack 请求限流；待发送回复会稍后重试", true, delay);
    }
    if (!response.ok) throw new SlackApiError("Slack HTTP " + response.status, response.status >= 500);
    let data: SlackApiResult;
    try { data = await response.json() as SlackApiResult; } catch { throw new SlackApiError("Slack API 返回格式无效", true); }
    if (!data || typeof data !== "object") throw new SlackApiError("Slack API 返回格式无效", true);
    if (!data.ok) {
      const code = typeof data.error === "string" && /^[a-z_]{1,80}$/.test(data.error) ? data.error : "unknown_error";
      const hint: Record<string, string> = {
        invalid_auth: "令牌无效，请在安全输入框检查", token_revoked: "令牌已撤销，请在安全输入框检查",
        not_authed: "尚未提供有效令牌", missing_scope: "已有授权缺少此调用所需权限；不会自动扩大授权",
        not_allowed_token_type: "令牌类型不匹配", app_not_installed: "Bot 尚未有效安装到工作区",
        channel_not_found: "无法访问该会话", not_in_channel: "Bot 不在该会话中",
      };
      const requiredScopes = typeof data.needed === "string" ? data.needed.split(",").filter(scope => ["channels:history", "groups:history"].includes(scope.trim())).map(scope => scope.trim()) : [];
      throw new SlackApiError("Slack " + code + (hint[code] ? "：" + hint[code] : ""), ["internal_error", "fatal_error", "ratelimited"].includes(code), 3000, code, requiredScopes);
    }
    return data;
  }

  private async openSocket(generation: number): Promise<void> {
    if (this.stopped || !this.config || generation !== this.generation) return;
    const data = await this.api("apps.connections.open", this.config.appToken);
    if (this.stopped || generation !== this.generation) return;
    let url: URL;
    try { url = new URL(String(data.url ?? "")); } catch { throw new Error("Slack 未返回有效连接地址"); }
    if (url.protocol !== "wss:" || !url.hostname.endsWith(".slack.com") || (url.port && url.port !== "443") || url.username || url.password) {
      throw new Error("Slack 返回了非官方安全连接地址，未连接");
    }
    let socket: SlackSocket;
    try { socket = this.options.socketFactory ? this.options.socketFactory(url.href) : new WebSocket(url.href) as unknown as SlackSocket; }
    catch { throw new Error("Slack WebSocket 无法启动"); }
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let verified = false;
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        error ? reject(error) : resolve();
      };
      const timeout = setTimeout(() => { finish(new Error("Slack 连接超时，未收到 App 身份确认")); socket.close(); }, this.options.helloTimeoutMs ?? 15_000);
      socket.onmessage = event => {
        if (socket !== this.socket || generation !== this.generation || this.stopped) return;
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(String(event.data)) as Record<string, unknown>; } catch { this.report("Slack 收到无效事件，已忽略"); return; }
        if (frame.type === "hello") {
          const info = frame.connection_info as { app_id?: string } | undefined;
          if (info?.app_id !== this.config?.appId) {
            this.stopped = true;
            finish(new Error("App Token 对应的应用与指定 App ID 不一致，未启动接收"));
            socket.close(); return;
          }
          verified = true; this.connected = true; this.reconnectAttempts = 0;
          this.report("已连接（Socket Mode，限定工作区和用户）");
          finish();
          this.resumeDeliveries();
        } else if (frame.type === "disconnect") {
          if (frame.reason === "link_disabled") {
            this.stopped = true; this.connected = false;
            this.report("Slack Socket Mode 已关闭，请在应用后台检查"); socket.close();
            finish(new Error("Slack Socket Mode 已关闭"));
          } else { socket.close(); }
        } else if (verified) { this.receiveFrame(frame, socket); }
      };
      socket.onclose = () => {
        finish(new Error("Slack 连接在身份确认前关闭"));
        if (socket !== this.socket || generation !== this.generation) return;
        this.socket = null; this.connected = false;
        if (verified && !this.stopped) this.scheduleReconnect();
      };
      socket.onerror = () => { finish(new Error("Slack WebSocket 连接失败")); socket.close(); };
    });
  }

  private receiveFrame(frame: Record<string, unknown>, socket: SlackSocket): void {
    const envelopeId = typeof frame.envelope_id === "string" ? frame.envelope_id : "";
    if (!envelopeId) return;
    const ack = (): void => { socket.send(JSON.stringify({ envelope_id: envelopeId })); };
    const payload = frame.payload as Record<string, unknown> | undefined;
    const event = payload?.event as Record<string, unknown> | undefined;
    if (frame.type !== "events_api" || payload?.type !== "event_callback" || !event || !this.config
      || payload.api_app_id !== this.config.appId || payload.team_id !== this.config.teamId
      || (event.subtype && event.subtype !== "file_share") || event.bot_id
      || typeof event.user !== "string" || event.user === this.botUserId || !this.config.allowUsers.includes(event.user)
      || typeof event.channel !== "string"
      || typeof event.ts !== "string" || !/^\d+\.\d+$/.test(event.ts)
      || (event.text !== undefined && typeof event.text !== "string") || typeof payload.event_id !== "string") {
      ack(); return;
    }
    const isDirectMessage = event.type === "message" && event.channel_type === "im" && /^D[A-Z0-9]+$/.test(event.channel);
    const isChannelMention = event.type === "app_mention" && /^[CG][A-Z0-9]+$/.test(event.channel);
    if (!isDirectMessage && !isChannelMention) { ack(); return; }
    const text = typeof event.text === "string" ? event.text : "";
    const files = Array.isArray(event.files) ? event.files.slice(0, GATEWAY_MEDIA_LIMITS.count + 1).map(file => ({
      id: file && typeof file.id === "string" && /^F[A-Z0-9]+$/.test(file.id) ? file.id : "",
    })) : [];
    const botMention = "<@" + this.botUserId + ">";
    if (isChannelMention && (event.user !== this.ownerUserId() || !text.includes(botMention))) { ack(); return; }
    const instruction = isChannelMention ? text.split(botMention).join("").trim() : text;
    // A bare ping is not an instruction; ordinary channel messages never start tasks.
    if (!instruction.trim() && !files.length) { ack(); return; }
    const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : event.ts;
    if (!/^\d+\.\d+$/.test(threadTs)) { ack(); return; }
    const delivery: SlackDelivery = {
      eventId: payload.event_id, appId: this.config.appId, teamId: this.config.teamId,
      channel: event.channel, threadTs, messageTs: event.ts, userId: event.user,
      text: redactSlackText(instruction, [this.config.botToken, this.config.appToken]),
      ...(files.length ? { files } : {}),
      acceptedAt: Date.now(), state: "pending",
    };
    let fresh: boolean;
    try { fresh = this.options.journal.accept(delivery); } catch {
      // A failed commit is not ACKed: let Slack retry, and do not run the task.
      this.report("Slack 消息无法安全落盘，未执行；等待 Slack 重试");
      return;
    }
    try { ack(); } catch { this.report("Slack 确认发送失败；消息已落盘，重投递不会重复执行"); }
    if (fresh && this.activated) this.enqueue(delivery); // Never wait for model/tool work before acknowledging Slack.
  }

  private resumeDeliveries(): void {
    if (!this.activated) return;
    for (const delivery of this.options.journal.list()) {
      if (delivery.state !== "replied" && this.allows(delivery)) this.enqueue(delivery);
    }
  }

  private enqueue(delivery: SlackDelivery): void {
    const key = this.deliveryKey(delivery);
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    const taskId = slackTaskId(delivery);
    const previous = this.queues.get(taskId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(() => this.processDelivery(delivery)).catch(error => {
      this.report(safeSlackError(error, [this.config?.botToken ?? "", this.config?.appToken ?? ""]));
    }).finally(() => {
      this.inFlight.delete(key);
      if (this.queues.get(taskId) === queued) this.queues.delete(taskId);
    });
    this.queues.set(taskId, queued);
  }

  private async readChannelHistory(delivery: SlackDelivery): Promise<SlackChannelHistory | undefined> {
    if (!/^[CG]/.test(delivery.channel) || !this.config || !this.allows(delivery)) return undefined;
    const beforeTs = delivery.messageTs ?? delivery.threadTs;
    const base = { channelId: delivery.channel, beforeTs };
    let history: SlackChannelHistory;
    try {
      const result = await this.api("conversations.history", this.config.botToken, {
        channel: delivery.channel, latest: beforeTs, inclusive: false, limit: 15,
      });
      if (!Array.isArray(result.messages)) throw new SlackApiError("Slack 历史消息格式无效", false, 3000, "invalid_history_response");
      const messages: SlackChannelHistory["messages"] = [];
      let budget = 12000;
      for (const raw of result.messages.slice(0, 15)) {
        if (!raw || typeof raw !== "object") continue;
        const row = raw as Record<string, unknown>;
        if (typeof row.ts !== "string" || !/^\d+\.\d+$/.test(row.ts) || Number(row.ts) >= Number(beforeTs)
          || typeof row.text !== "string" || !row.text.trim() || budget <= 0) continue;
        const text = redactSlackText(row.text, [this.config.botToken, this.config.appToken]).slice(0, Math.min(2000, budget));
        budget -= text.length;
        messages.push({ ts: row.ts, ...(typeof row.user === "string" && /^[UW][A-Z0-9]+$/.test(row.user) ? { userId: row.user } : {}), text });
      }
      messages.sort((a, b) => Number(a.ts) - Number(b.ts));
      history = { ...base, status: "loaded", messages, hasMore: result.has_more === true || budget <= 0 };
    } catch (error) {
      history = { ...base, status: "unavailable", messages: [], hasMore: false,
        errorCode: error instanceof SlackApiError ? error.code ?? "request_failed" : "request_failed",
        ...(error instanceof SlackApiError && error.requiredScopes.length ? { requiredScopes: error.requiredScopes } : {}),
      };
    }
    this.options.onHistoryRead?.({ channelId: history.channelId, status: history.status, messageCount: history.messages.length,
      ...(history.errorCode ? { errorCode: history.errorCode } : {}), ...(history.requiredScopes ? { requiredScopes: history.requiredScopes } : {}) });
    return history;
  }

  private async processDelivery(delivery: SlackDelivery): Promise<void> {
    if (this.stopped || !this.activated || !this.allows(delivery)) return;
    let current = this.options.journal.get(delivery)!;
    if (current.state === "replied") return;
    if (current.state === "running" && current.backend !== "pi-durable") {
      current = this.options.journal.update(current, {
        state: "reply_pending",
        replyText: "上次任务因应用退出中断，执行记录已保留。请在此讨论串发送一条新消息继续原任务；不会自动重复可能已执行的操作。",
      });
    }
    if (current.state === "reply_pending") { await this.flushReply(current); return; }
    if (!this.onInbound) throw new Error("Slack 尚未绑定 MyBuddy 任务入口");
    const generation = this.generation;
    const slackHistory = current.state === "running" && current.backend === "pi-durable"
      ? current.slackHistory : await this.readChannelHistory(current);
    if (this.stopped || generation !== this.generation || !this.allows(current)) return;
    const assertActive = (): void => {
      if (this.stopped || !this.activated || generation !== this.generation || !this.allows(current)) {
        throw new Error("Slack 附件接收已取消");
      }
    };
    try {
      let attachments = current.attachments;
      if (current.files?.length && ((current.state === "running" && !attachments)
        || (attachments && attachments.length !== current.files.length))) {
        throw new Error("Slack 附件缓存丢失或校验失败；未执行任务，请发送新消息并重新上传附件");
      }
      if (!attachments && current.files?.length) {
        if (current.files.length > GATEWAY_MEDIA_LIMITS.count) throw new Error("Slack 附件数量超过限制");
        const sources: GatewayMediaSource[] = [];
        for (const file of current.files) {
          assertActive();
          if (!/^F[A-Z0-9]+$/.test(file.id)) throw new Error("Slack 附件 ID 无效");
          const result = await this.api("files.info", this.config!.botToken, { file: file.id });
          assertActive();
          const info = result.file as Record<string, unknown> | undefined;
          if (!info || info.id !== file.id || info.is_external === true) throw new Error("Slack 附件不可用");
          const url = info.url_private_download || info.url_private;
          if (typeof url !== "string") throw new Error("Slack 附件缺少安全下载地址");
          sources.push({ url, name: redactSlackText(typeof info.name === "string" ? info.name : file.id + ".bin",
            [this.config!.botToken, this.config!.appToken]), allowedHosts: ["files.slack.com"],
            ...(info.size !== undefined ? { expectedSize: Number(info.size) } : {}),
            headers: { Authorization: "Bearer " + this.config!.botToken },
            fetch: async (input, init) => {
              assertActive();
              const response = await this.fetcher(input, init);
              assertActive();
              return response;
            },
          });
        }
        attachments = await withGatewayMedia(sources, async files => { assertActive(); return files; },
          { directory: this.options.mediaDirectory });
      }
      // A native receipt must retain its exact original inputs. Never redownload or
      // silently omit a missing/corrupt cached attachment during recovery.
      for (const attachment of attachments ?? []) {
        assertActive();
        try {
          const stat = await lstat(attachment.path);
          if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > GATEWAY_MEDIA_LIMITS.file
            || (/\.(png|jpe?g|gif|webp|bmp)$/i.test(attachment.name) && stat.size > 12 * 1024 * 1024)) {
            throw new Error("invalid cached file");
          }
          const handle = await open(attachment.path, "r");
          let bytes: Buffer;
          try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) {
              throw new Error("cached file changed");
            }
            // Bounded reads also reject a file growing between stat and read.
            const buffer = Buffer.alloc(stat.size + 1);
            let offset = 0;
            while (offset < buffer.length) {
              const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
              if (!bytesRead) break;
              offset += bytesRead;
            }
            bytes = buffer.subarray(0, offset);
          } finally { await handle.close(); }
          const expected = /^([a-f0-9]{64})\.[a-z0-9]{1,10}$/.exec(basename(attachment.path))?.[1];
          if (bytes.length !== stat.size || createHash("sha256").update(bytes).digest("hex") !== expected) {
            throw new Error("invalid cached content");
          }
        } catch {
          throw new Error("Slack 附件缓存丢失或校验失败；未执行任务，请发送新消息并重新上传附件");
        }
        assertActive();
      }
      assertActive();
      current = this.options.journal.update(current, { state: "running", backend: "pi-durable", slackHistory, attachments });
      await this.onInbound({
        channelId: this.id, chatId: [current.teamId, current.channel, current.threadTs].join(":"),
        audience: current.channel.startsWith("D") ? "private" : "shared",
        workTarget: gatewayWorkTarget({ version: 1, channelType: this.type, channelId: this.id,
          connectionKey: this.workConnectionKey(), chatId: [current.teamId, current.channel, current.threadTs].join(":"),
          senderId: current.userId, address: { teamId: current.teamId, appId: current.appId,
            channel: current.channel, threadTs: current.threadTs } }),
        taskId: slackTaskId(current), ...slackTurnIds(current), text: current.text,
        ...(slackHistory ? { slackHistory } : {}),
        ...(attachments?.length ? { attachments } : {}),
        messageId: current.eventId, sender: { id: current.userId },
        reply: async text => {
          const safeText = redactSlackText(text, [this.config?.botToken ?? "", this.config?.appToken ?? ""]);
          const pending = this.options.journal.update(current, { state: "reply_pending", replyText: safeText, nextChunk: 0 });
          await this.flushReply(pending);
        },
      });
    } catch (error) {
      const latest = this.options.journal.get(current)!;
      // A closed native wait does not finish its persisted execution. Reacquire it on reconnect.
      if (this.stopped || generation !== this.generation) return;
      if (latest.state === "running" || latest.state === "pending") {
        const message = safeSlackError(error, [this.config?.botToken ?? "", this.config?.appToken ?? ""]);
        const pending = this.options.journal.update(latest, { state: "reply_pending", replyText: "任务处理失败：" + message, nextChunk: 0 });
        await this.flushReply(pending);
      } else if (latest.state === "reply_pending") {
        throw error;
      }
    }
  }

  private async flushReply(delivery: SlackDelivery): Promise<void> {
    if (this.stopped || !this.activated || !this.config || !this.allows(delivery)) return;
    const chunks = splitSlackReply(delivery.replyText ?? "");
    let current = this.options.journal.get(delivery)!;
    try {
      for (let index = current.nextChunk ?? 0; index < chunks.length; index++) {
        if (this.stopped || !this.allows(current)) return;
        await this.api("chat.postMessage", this.config.botToken, {
          channel: current.channel, thread_ts: current.threadTs, text: chunks[index],
          client_msg_id: replyClientId(current, index), unfurl_links: false, unfurl_media: false,
        });
        current = this.options.journal.update(current, { nextChunk: index + 1 });
      }
      this.options.journal.update(current, { state: "replied" });
    } catch (error) {
      if (error instanceof SlackApiError && error.retryable) this.scheduleReplies(error.retryMs);
      throw error;
    }
  }

  private scheduleReplies(delay: number): void {
    if (this.stopped || this.replyTimer) return;
    this.replyTimer = setTimeout(() => { this.replyTimer = null; this.resumeDeliveries(); }, this.options.replyRetryDelayMs ?? delay);
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.report("Slack 连接中断，正在自动重连…");
    const delay = this.options.reconnectDelayMs ?? Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts++, 5));
    const generation = this.generation;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket(generation).catch(error => {
        if (this.stopped || generation !== this.generation) return;
        this.report(safeSlackError(error, [this.config?.botToken ?? "", this.config?.appToken ?? ""]));
        this.scheduleReconnect();
      });
    }, delay);
  }
}
