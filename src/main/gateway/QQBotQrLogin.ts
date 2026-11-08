/** QQ onboarding protocol adapted from NousResearch/hermes-agent (MIT).
 * Source: plugins/platforms/qqbot/{onboard,crypto,constants}.py at 72d4433130823f506081cc1189a923b5aa67dbf0.
 * Copyright (c) 2025 Nous Research. See docs/third-party/hermes-agent-LICENSE.txt.
 * No OpenClaw connector dependency. All keys/credentials stay in the main process.
 */
import { createDecipheriv, randomBytes, randomUUID } from "node:crypto";

export interface QQQrLoginState {
  state: "idle" | "waiting" | "binding" | "connected" | "cancelled" | "expired" | "error";
  sessionId?: string;
  qrUrl?: string;
  message: string;
  appId?: string;
}
export interface QQBoundCredentials { appId: string; appSecret: string; userOpenid: string }
export interface QQBotQrLoginOptions {
  onAuthorized: (credentials: QQBoundCredentials, assertCurrent: () => void, signal: AbortSignal) => Promise<void>;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  deadlineMs?: number;
}
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown): string => typeof v === "string" ? v : "";

export class QQBotQrLogin {
  private state: QQQrLoginState = { state: "idle", message: "尚未开始 QQ 机器人绑定" };
  private attempt?: { id: string; controller: AbortController; deadline: number };
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: QQBotQrLoginOptions) { this.fetcher = options.fetch ?? fetch; }
  getState(): QQQrLoginState { return { ...this.state }; }
  cancel(sessionId?: string): void {
    if (sessionId && sessionId !== this.attempt?.id) return;
    const attempt = this.attempt;
    this.attempt = undefined;
    attempt?.controller.abort();
    this.state = { state: "cancelled", sessionId: attempt?.id, message: "QQ 绑定已取消" };
  }
  async start(approvedPersistentAccess: boolean): Promise<QQQrLoginState> {
    if (approvedPersistentAccess !== true) throw new Error("请明确批准绑定 QQ 机器人、保存加密凭据并持续连接后再扫码");
    this.cancel();
    const attempt = { id: randomUUID(), controller: new AbortController(), deadline: Date.now() + (this.options.deadlineMs ?? 600_000) };
    this.attempt = attempt;
    const current = () => {
      if (this.attempt !== attempt || attempt.controller.signal.aborted) throw new Error("QQ 绑定已取消");
      if (Date.now() >= attempt.deadline) throw new Error("QQ 绑定已过期");
    };
    this.state = { state: "waiting", sessionId: attempt.id, message: "正在创建 QQ 官方绑定二维码" };
    let created: { taskId: string; key: Buffer } | undefined;
    try {
      const task = await this.createTask(attempt.controller.signal);
      created = task;
      current();
      this.showTask(attempt.id, task.taskId);
      void this.poll(attempt, task, current).catch(() => {
        if (this.attempt !== attempt) return;
        const expired = Date.now() >= attempt.deadline;
        attempt.controller.abort();
        this.attempt = undefined;
        this.state = { state: expired ? "expired" : "error", sessionId: attempt.id,
          message: expired ? "QQ 绑定已过期，请重新发起" : "QQ 绑定失败或凭据无法安全保存，请重新发起" };
      });
    } catch {
      created?.key.fill(0);
      if (this.attempt === attempt) {
        attempt.controller.abort(); this.attempt = undefined;
        this.state = { state: "error", sessionId: attempt.id, message: "无法创建 QQ 官方绑定二维码" };
      }
    }
    return this.getState();
  }
  private async post(path: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`https://q.qq.com${path}`, { method: "POST", redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "WaveAlstra-QQBot/1.0" },
      body: JSON.stringify(body) });
    const value = obj(await response.json());
    if (!response.ok || value.retcode !== 0) throw new Error("QQ 官方绑定服务请求失败");
    return obj(value.data);
  }
  private async createTask(signal: AbortSignal): Promise<{ taskId: string; key: Buffer }> {
    const key = randomBytes(32);
    try {
      const value = await this.post("/lite/create_bind_task", { key: key.toString("base64") }, signal);
      const taskId = str(value.task_id);
      if (!taskId || taskId.length > 1024) throw new Error("QQ 绑定任务无效");
      return { taskId, key };
    } catch (error) { key.fill(0); throw error; }
  }
  private showTask(sessionId: string, taskId: string): void {
    this.state = { state: "waiting", sessionId, message: "使用手机 QQ 扫码并在官方页面确认授权", qrUrl:
      `https://q.qq.com/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&_wv=2` };
  }
  private async poll(attempt: NonNullable<QQBotQrLogin["attempt"]>, initial: { taskId: string; key: Buffer }, current: () => void): Promise<void> {
    let task = initial;
    let refreshes = 0;
    const signal = attempt.controller.signal;
    try {
      while (true) {
        current();
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new Error("QQ 绑定已取消")); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, this.options.pollIntervalMs ?? 2000);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
        current();
        let value: Record<string, unknown>;
        try { value = await this.post("/lite/poll_bind_result", { task_id: task.taskId }, signal); }
        catch { current(); continue; } // Bounded by deadline; errors never contain provider response bodies.
        current();
        if (value.status === 3) {
          task.key.fill(0);
          if (++refreshes > 3) throw new Error("QQ 二维码过期次数过多");
          task = await this.createTask(signal);
          current(); this.showTask(attempt.id, task.taskId);
          continue;
        }
        if (value.status === 0 || value.status === 1) continue;
        if (value.status !== 2) throw new Error("QQ 绑定状态无效");
        const appId = str(value.bot_appid), userOpenid = str(value.user_openid), encoded = str(value.bot_encrypt_secret);
        if (!/^\d+$/.test(appId) || !userOpenid || userOpenid.length > 512 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 8192) throw new Error("QQ 绑定身份无效");
        const raw = Buffer.from(encoded, "base64");
        if (raw.length <= 28) throw new Error("QQ 绑定凭据无效");
        const decipher = createDecipheriv("aes-256-gcm", task.key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(-16));
        const decrypted = Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]);
        let appSecret: string;
        try { appSecret = new TextDecoder("utf-8", { fatal: true }).decode(decrypted); } finally { decrypted.fill(0); task.key.fill(0); }
        if (!appSecret.trim()) throw new Error("QQ 绑定凭据为空");
        current();
        this.state = { state: "binding", sessionId: attempt.id, message: "正在安全保存并连接 QQ 机器人" };
        await this.options.onAuthorized({ appId, appSecret, userOpenid }, current, signal);
        current();
        this.state = { state: "connected", sessionId: attempt.id, appId, message: "QQ 官方机器人已绑定" };
        this.attempt = undefined;
        return;
      }
    } finally { task.key.fill(0); }
  }
}
