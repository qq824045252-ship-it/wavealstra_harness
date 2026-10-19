import { RemoteImageError } from './RemoteImageService';
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { ZodError } from "zod";
import { REMOTE_API_VERSION } from "../../../shared/src/remote-contract";
import { RemotePairingError, type RemoteAccessPairing } from "./RemoteAccessPairing";
import type { RemoteAccessService } from "./RemoteAccessService";
import type { RemoteDeviceStore, RemotePrincipal } from "./RemoteDeviceStore";
import { RemoteEventBus, writeSseEvent } from "./RemoteEventBus";
import { isPrivateIpv4 } from "./RemoteNetwork";
import { RemoteConflictError, RemoteNotFoundError, RemoteTaskCommandService, RemoteValidationError } from "./RemoteTaskCommandService";
import { remoteApprovalSchema, remoteInteractionAnswerSchema, remotePairSchema, remotePromptSchema } from "./remoteSchemas";

const BODY_LIMIT = 512 * 1024;
/** prompt 路由允许携带 base64 附件：4 个 × ~3MB 原始字节（≈4M base64 字符）+ JSON 包裹 */
const PROMPT_BODY_LIMIT = 17 * 1024 * 1024;
const ALLOWED_BIND_HOSTS = new Set(["127.0.0.1", "0.0.0.0"]);

export interface RemoteAccessServerOptions {
  host?: string;
  port: number;
  baseUrl?: string;
  staticRoot?: string;
  devices: RemoteDeviceStore;
  pairing: RemoteAccessPairing;
  service: RemoteAccessService;
  commands: RemoteTaskCommandService;
  events: RemoteEventBus;
}

function sendJson(response: ServerResponse, status: number, value: unknown, origin?: string): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    ...(origin ? {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, DELETE, HEAD, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization, Last-Event-ID",
    } : {}),
  });
  response.end(body);
}

function errorBody(code: string, message: string) { return { ok: false, error: { code, message } }; }

async function readJson(request: IncomingMessage, limit = BODY_LIMIT): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw Object.assign(new Error("请求体过大"), { statusCode: 413 });
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf-8")); }
  catch { throw Object.assign(new Error("JSON 格式无效"), { statusCode: 400 }); }
}

function bearer(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  const match = typeof value === "string" ? /^Bearer ([A-Za-z0-9_-]{20,256})$/.exec(value) : null;
  return match?.[1] ?? null;
}

function mime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".ico": return "image/x-icon";
    default: return "application/octet-stream";
  }
}

export class RemoteAccessServer {
  private server: Server | null = null;
  private readonly streams = new Set<ServerResponse>();
  private readonly host: string;

  constructor(private readonly options: RemoteAccessServerOptions) {
    this.host = options.host ?? "127.0.0.1";
    if (!ALLOWED_BIND_HOSTS.has(this.host)) throw new Error("Remote Access 只允许监听 loopback 或显式 LAN 地址");
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) return { host: this.host, port: this.addressPort() };
    const server = createServer((request, response) => void this.handle(request, response));
    this.server = server;
    await new Promise<void>((resolveStart, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.host, () => { server.off("error", reject); resolveStart(); });
    });
    return { host: this.host, port: this.addressPort() };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const response of this.streams) response.end();
    this.streams.clear();
    await new Promise<void>((resolveStop) => server.close(() => resolveStop()));
  }

  private addressPort(): number {
    const address = this.server?.address();
    return typeof address === "object" && address ? address.port : this.options.port;
  }

  private authenticate(request: IncomingMessage): { principal: RemotePrincipal; device: ReturnType<RemoteDeviceStore["list"]>[number] } | null {
    const token = bearer(request);
    return token ? this.options.devices.authenticate(token) : null;
  }

  /**
   * Origin 白名单（P0-1 修复：不再反射任意来源）。
   * 无 Origin 的请求（原生壳 / curl / Node fetch）直接放行；带 Origin 的浏览器请求必须命中：
   * - Capacitor WebView 壳（见下方第一组：无端口的 localhost 三种形式）
   * - 本机静态托管（http://localhost:<port> / http://127.0.0.1:<port>，须同端口）
   * - LAN 模式下同网段私网 IP 的同端口来源（手机浏览器直开 LAN 地址）
   * - 配置的 baseUrl origin（Tailscale serve 等反向代理）
   */
  private originAllowed(origin: string): boolean {
    // Capacitor WebView 壳的 Origin（无端口）：iOS = capacitor://localhost；
    // Android = https://localhost（androidScheme 默认 https）/ http://localhost（显式配 http）。
    // 浏览器页面的 localhost Origin 恒带端口（80/443 序列化后无端口，但那要求本机驻留服务，
    // 已在本检查的威胁模型之外——Origin 校验防的是远程网页，不是本机进程）。
    if (origin === "capacitor://localhost" || origin === "http://localhost" || origin === "https://localhost") return true;
    // baseUrl（Tailscale serve 等反向代理）必须先于协议检查匹配：
    // 浏览器对同源 POST 也会携带 Origin，https origin 若被下面的明文检查先拒，会打断反代通道
    const baseUrl = this.options.baseUrl?.trim();
    if (baseUrl) {
      try { if (new URL(baseUrl).origin === origin) return true; }
      catch { /* baseUrl 无效时由 configure 阶段兜底 */ }
    }
    let url: URL;
    try { url = new URL(origin); }
    catch { return false; }
    if (url.protocol !== "http:") return false;
    const port = String(this.addressPort());
    if ((url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.port === port) return true;
    if (this.host === "0.0.0.0" && url.port === port && isPrivateIpv4(url.hostname)) return true;
    return false;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin;
    // P0-1：拒绝白名单之外的浏览器来源（无 Origin 的原生请求不受影响），CORS 头只回显已放行来源
    if (origin && !this.originAllowed(origin)) {
      sendJson(response, 403, errorBody("origin_forbidden", "请求来源不被 Remote Access 允许"));
      return;
    }
    const replyJson = (status: number, value: unknown) => sendJson(response, status, value, origin);
    try {
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          ...(origin ? {
            "access-control-allow-origin": origin,
            "access-control-allow-methods": "GET, POST, DELETE, HEAD, OPTIONS",
            "access-control-allow-headers": "Content-Type, Authorization, Last-Event-ID",
            "access-control-max-age": "86400",
          } : {}),
        });
        response.end();
        return;
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      if (request.method === "GET" && path === "/healthz") {
        replyJson(200, { ok: true, service: "mybuddy-remote", apiVersion: REMOTE_API_VERSION });
        return;
      }
      if (request.method === "POST" && path === "/v1/pair/exchange") {
        const body = remotePairSchema.parse(await readJson(request));
        const issued = this.options.pairing.exchange(body.pairingId, body.secret, body.deviceName, body.installationId);
        replyJson(200, { deviceId: issued.device.id, deviceToken: issued.token, server: this.options.service.serverInfo() });
        return;
      }
      if (!path.startsWith("/v1/")) {
        if (request.method !== "GET" && request.method !== "HEAD") return replyJson(405, errorBody("method_not_allowed", "method not allowed"));
        return this.serveStatic(path, response, request.method === "HEAD");
      }

      const auth = this.authenticate(request);
      if (!auth) return replyJson(401, errorBody("unauthorized", "设备认证失败或已撤销"));

      if (request.method === "GET" && path === "/v1/events") return this.openEventStream(request, response);
      if (request.method === "GET" && path === "/v1/bootstrap") return replyJson(200, await this.options.service.bootstrap(auth.device));
      if (request.method === "GET" && path === "/v1/tasks") return replyJson(200, this.options.service.listTasks());
      if (request.method === "GET" && path === "/v1/device/me") return replyJson(200, auth.device);
      if (request.method === "POST" && path === "/v1/device/revoke-self") {
        this.options.devices.revoke(auth.principal.deviceId);
        return replyJson(200, { ok: true });
      }
      if (request.method === "POST" && path === "/v1/tasks") {
        const result = await this.options.commands.createAndPrompt(remotePromptSchema.parse(await readJson(request, PROMPT_BODY_LIMIT)));
        return replyJson(201, result);
      }
      const imageMatch = /^\/v1\/tasks\/([^/]+)\/artifacts\/([^/]+)\/image$/.exec(path);
      if ((request.method === 'GET' || request.method === 'HEAD') && imageMatch) {
        const rawVersion = url.searchParams.get('v');
        if ([...url.searchParams.keys()].some(key => key !== 'v') || (rawVersion !== null && (!/^[1-9]\d*$/.test(rawVersion) || !Number.isSafeInteger(Number(rawVersion))))) {
          return replyJson(400, errorBody('invalid_request', '图片版本参数无效'));
        }
        const image = await this.options.service.image(decodeURIComponent(imageMatch[1]!), decodeURIComponent(imageMatch[2]!), rawVersion === null ? undefined : Number(rawVersion));
        response.writeHead(200, {
          'content-type': image.mimeType, 'content-length': image.bytes.length,
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
          'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
          ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
        });
        response.end(request.method === 'HEAD' ? undefined : image.bytes);
        return;
      }
      const taskMatch = /^\/v1\/tasks\/([^/]+)(?:\/(history|runtime|prompt|abort|ackDone))?$/.exec(path);
      if (taskMatch) {
        const taskId = decodeURIComponent(taskMatch[1]);
        const action = taskMatch[2];
        // 手机端删除：安全回收（可恢复），与桌面端侧栏删除同一条 taskLifecycle.trash 链路
        if (request.method === "DELETE" && !action) {
          await this.options.commands.deleteTask(taskId);
          this.options.events.publish("task.changed", { taskId });
          return replyJson(200, { ok: true });
        }
        if (request.method === "GET" && action === "history") {
          const result = await this.options.service.history(taskId);
          return result ? replyJson(200, result) : replyJson(404, errorBody("not_found", "任务不存在"));
        }
        if (request.method === "GET" && action === "runtime") {
          const result = this.options.service.runtime(taskId);
          return result ? replyJson(200, result) : replyJson(404, errorBody("not_found", "任务不存在"));
        }
        if (request.method === "POST" && action === "prompt") {
          const result = await this.options.commands.promptExisting(taskId, remotePromptSchema.parse(await readJson(request, PROMPT_BODY_LIMIT)));
          return replyJson(200, result);
        }
        if (request.method === "POST" && action === "abort") {
          await this.options.commands.abort(taskId);
          return replyJson(200, { ok: true });
        }
        // 「已结束」绿点确认：手机端打开任务即已查看；广播 task.changed 让其它设备同步刷新
        if (request.method === "POST" && action === "ackDone") {
          this.options.commands.ackTaskDone(taskId);
          this.options.events.publish("task.changed", { taskId });
          return replyJson(200, { ok: true });
        }
      }
      const interactionMatch = /^\/v1\/tasks\/([^/]+)\/interactions\/([^/]+)\/(respond|cancel)$/.exec(path);
      if (request.method === "POST" && interactionMatch) {
        const taskId = decodeURIComponent(interactionMatch[1]);
        const interactionId = decodeURIComponent(interactionMatch[2]);
        if (interactionMatch[3] === "respond") {
          const body = remoteInteractionAnswerSchema.parse(await readJson(request));
          return replyJson(200, this.options.commands.respondToInteraction(taskId, interactionId, body.answer));
        }
        return replyJson(200, this.options.commands.cancelInteraction(taskId, interactionId));
      }
      const approvalMatch = /^\/v1\/tasks\/([^/]+)\/actions\/([^/]+)\/respond$/.exec(path);
      if (request.method === "POST" && approvalMatch) {
        this.options.commands.respondToAction(decodeURIComponent(approvalMatch[1]), decodeURIComponent(approvalMatch[2]), remoteApprovalSchema.parse(await readJson(request)));
        return replyJson(200, { ok: true });
      }
      if (request.method === "GET" && path === "/v1/notifications") {
        const unreadOnly = url.searchParams.get("unreadOnly") === "1";
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
        return replyJson(200, this.options.service.listNotifications(unreadOnly, limit));
      }
      const notificationRead = /^\/v1\/notifications\/([^/]+)\/read$/.exec(path);
      if (request.method === "POST" && notificationRead) {
        this.options.service.markNotificationRead(decodeURIComponent(notificationRead[1]));
        return replyJson(200, { ok: true });
      }
      if (request.method === "POST" && path === "/v1/notifications/read-all") {
        this.options.service.markAllNotificationsRead();
        return replyJson(200, { ok: true });
      }
      if (request.method === "POST" && path === "/v1/notifications/clear-all") {
        this.options.service.clearAllNotifications();
        return replyJson(200, { ok: true });
      }
      replyJson(404, errorBody("not_found", "route not found"));
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof RemoteImageError) return replyJson(error.status, errorBody("image_unavailable", error.message));
      if (error instanceof ZodError || error instanceof RemoteValidationError || error instanceof RemotePairingError) return replyJson(400, errorBody("invalid_request", error.message));
      if (error instanceof RemoteNotFoundError) return replyJson(404, errorBody("not_found", error.message));
      if (error instanceof RemoteConflictError) return replyJson(409, errorBody("stale_or_conflict", error.message));
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 400 || status === 413) return replyJson(status, errorBody(status === 413 ? "payload_too_large" : "invalid_json", (error as Error).message));
      console.warn("[RemoteAccessServer] request failed", error instanceof Error ? error.message : String(error));
      replyJson(500, errorBody("internal_error", "Remote Access 请求失败"));
    }
  }

  private openEventStream(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
      "x-accel-buffering": "no",
      ...(origin ? { "access-control-allow-origin": origin } : {}),
    });
    this.streams.add(response);
    const lastId = Number(request.headers["last-event-id"] ?? 0);
    const replay = this.options.events.replayAfter(lastId);
    if (replay === null) writeSseEvent(response, {
      apiVersion: REMOTE_API_VERSION,
      id: Number.isSafeInteger(lastId) && lastId > 0 ? lastId : 0,
      at: Date.now(),
      type: "resync_required",
      payload: {},
    });
    else for (const event of replay) writeSseEvent(response, event);
    const unsubscribe = this.options.events.subscribe((event) => writeSseEvent(response, event));
    const heartbeat = setInterval(() => response.write(": ping\n\n"), 20_000);
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      this.streams.delete(response);
    };
    request.once("close", close);
    response.once("close", close);
  }

  private serveStatic(pathname: string, response: ServerResponse, head: boolean): void {
    const root = this.options.staticRoot;
    if (!root) return sendJson(response, 404, errorBody("not_found", "Remote Web 未构建"));
    const decoded = decodeURIComponent(pathname);
    const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    let candidate = resolve(root, relative);
    const rootPrefix = resolve(root) + sep;
    if (candidate !== resolve(root) && !candidate.startsWith(rootPrefix)) return sendJson(response, 404, errorBody("not_found", "not found"));
    if (!existsSync(candidate) || !statSync(candidate).isFile()) candidate = resolve(root, "index.html");
    if (!candidate.startsWith(rootPrefix) || !existsSync(candidate)) return sendJson(response, 404, errorBody("not_found", "Remote Web 未构建"));
    response.writeHead(200, {
      "content-type": mime(candidate),
      "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": candidate.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
    });
    if (head) {
      response.end();
      return;
    }
    createReadStream(candidate).pipe(response);
  }
}
