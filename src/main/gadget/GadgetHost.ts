import type { GadgetBackend, GadgetBackendContext, GadgetJson, GadgetValues } from "../../shared/gadget-backend";
import type { GadgetManifest } from "../../shared/gadget-types";
import type { createGadgetCommandRunner } from "../platform/gadget-commands";
import type { createGadgetState } from "./GadgetState";
import type { startGadgetProcessBackend } from "./GadgetProcessBackend";

export interface GadgetHostOptions {
  gadgetId: string;
  manifest: GadgetManifest;
  dataPath: string;
  token: string;
  sdkSource: string;
  platform: NodeJS.Platform;
  nativeState: boolean;
}

/** This entire function runs in the owned Electron Node process, never in a webpage. */
export async function runGadgetHost(
  options: GadgetHostOptions,
  createState: typeof createGadgetState,
  createCommands: typeof createGadgetCommandRunner,
  startProcessBackend: typeof startGadgetProcessBackend,
): Promise<void> {
  const http: typeof import("node:http") = require("node:http");
  const fs: typeof import("node:fs") = require("node:fs");
  const path: typeof import("node:path") = require("node:path");
  const { pathToFileURL }: typeof import("node:url") = require("node:url");
  const { timingSafeEqual }: typeof import("node:crypto") = require("node:crypto");
  const { AsyncLocalStorage }: typeof import("node:async_hooks") = require("node:async_hooks");
  const invocationSignals = new AsyncLocalStorage<AbortSignal>();
  const root = fs.realpathSync(process.cwd());
  const lifetime = new AbortController();
  const state = createState(options.dataPath, options.manifest.defaultConfig ?? {}, options.nativeState);
  const declaration = options.manifest.backend;
  const processBackend = declaration && "kind" in declaration ? declaration : undefined;
  const commands = createCommands({
    platform: options.platform, cwd: root,
    allowedCommands: processBackend ? [processBackend.command] : declaration && "commands" in declaration ? declaration.commands : [],
    environment: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), nodeExecutable: process.execPath,
    onSpawn: (pid) => process.send?.({ type: "command-started", pid }),
    onExit: (pid) => process.send?.({ type: "command-exited", pid }),
  });
  type Log = { time: number; level: "info" | "error"; message: string };
  const logs: Log[] = [];
  const active = new Set<AbortController>();
  let closing = false;
  let backend: GadgetBackend = { actions: {} };
  const actions = new Map<string, GadgetBackend["actions"][string]>();
  function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function failure(code: string, message: string, status = 400): Error & { code: string; status: number } {
    return Object.assign(new Error(message), { code, status });
  }
  function note(level: Log["level"], message: string): void {
    logs.push({ time: Date.now(), level, message });
    if (logs.length > 100) logs.shift();
  }
  function context(signal: AbortSignal): GadgetBackendContext {
    const currentSignal = (): AbortSignal => invocationSignals.getStore() ?? signal;
    function values(bucket: typeof state.storage): typeof state.storage {
      return {
        async get(key) { currentSignal().throwIfAborted(); return bucket.get(key); },
        async read(key) { currentSignal().throwIfAborted(); return bucket.read(key); },
        async set(key, value, revision) { currentSignal().throwIfAborted(); return bucket.set(key, value, revision); },
        async delete(key, revision) { currentSignal().throwIfAborted(); return bucket.delete(key, revision); },
        async keys() { currentSignal().throwIfAborted(); return bucket.keys(); },
      };
    }
    return {
      gadgetId: options.gadgetId, dataPath: options.dataPath, sourcePath: root,
      get signal() { return currentSignal(); },
      storage: values(state.storage), config: values(state.config),
      exec: (command, input = {}) => {
        const effectiveSignal = currentSignal();
        effectiveSignal.throwIfAborted();
        return commands.run(command, { ...input, signal: input.signal ? AbortSignal.any([effectiveSignal, input.signal]) : effectiveSignal });
      },
    };
  }
  function safeSource(relative: string, isDirectory = false): string {
    if (!relative || relative.includes("\\") || relative.includes("\0") || relative.includes(":")) throw failure("NOT_FOUND", "Not found", 404);
    const parts = relative.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) throw failure("NOT_FOUND", "Not found", 404);
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw failure("NOT_FOUND", "Not found", 404);
    }
    const real = fs.realpathSync(current);
    const info = fs.statSync(real);
    if (!real.startsWith(root + path.sep) || !(isDirectory ? info.isDirectory() : info.isFile())) throw failure("NOT_FOUND", "Not found", 404);
    return real;
  }
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8", ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".avif": "image/avif",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm",
    ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".pdf": "application/pdf",
  };
  function respond(response: import("node:http").ServerResponse, status: number, value: unknown): void {
    const serialized = JSON.stringify({ value: value === undefined ? null : value }, (_key, item: unknown) => {
      if (typeof item === "number" && !Number.isFinite(item) || typeof item === "bigint" || typeof item === "function" || typeof item === "symbol") {
        throw failure("INVALID_RESULT", "后台返回值必须是 JSON 数据", 500);
      }
      return item;
    });
    if (Buffer.byteLength(serialized) > 1024 * 1024) throw failure("RESULT_LIMIT", "后台返回值超过 1 MiB", 413);
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(serialized);
  }
  async function body(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
    if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") throw failure("CONTENT_TYPE", "请求必须为 application/json", 415);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 1024 * 1024) throw failure("BODY_LIMIT", "请求超过 1 MiB", 413);
      chunks.push(buffer);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw failure("INVALID_JSON", "请求不是有效 JSON"); }
    if (!record(parsed)) throw failure("INVALID_JSON", "请求必须是 JSON 对象");
    return parsed;
  }
  async function valueOperation(values: GadgetValues, input: Record<string, unknown>): Promise<unknown> {
    if (input.operation === "keys") return values.keys();
    if (typeof input.key !== "string") throw failure("INVALID_KEY", "缺少数据 key");
    if (input.expectedRevision !== undefined && input.expectedRevision !== null && typeof input.expectedRevision !== "string") {
      throw failure("INVALID_REVISION", "expectedRevision 无效");
    }
    const revision = input.expectedRevision;
    switch (input.operation) {
      case "get": return values.get(input.key);
      case "read": return values.read(input.key);
      case "set": return values.set(input.key, input.value as GadgetJson, revision);
      case "delete": await values.delete(input.key, revision); return null;
      default: throw failure("UNKNOWN_OPERATION", "未知的数据操作");
    }
  }
  async function invoke(name: string, input: unknown, response: import("node:http").ServerResponse): Promise<void> {
    const action = actions.get(name);
    if (!action) throw failure("ACTION_NOT_FOUND", `后台操作不存在：${name}`, 404);
    if (active.size >= 8) throw failure("BUSY", "Gadget 正在处理过多请求，请稍后再试", 429);
    const controller = new AbortController();
    active.add(controller);
    const signal = AbortSignal.any([controller.signal, lifetime.signal]);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let rejectCancelled: (reason: unknown) => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
    const onAbort = () => {
      rejectCancelled(signal.reason);
      // A non-cooperative handler must not keep mutating data after cancellation.
      watchdog = setTimeout(() => { void shutdown(1); }, 300);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(failure("ACTION_TIMEOUT", "后台操作超时；不会自动重放", 504)), options.manifest.backend?.timeoutMs ?? 30_000);
    const disconnected = () => { if (!response.writableEnded) controller.abort(failure("CANCELLED", "请求已取消；远端写入结果可能未知", 499)); };
    response.once("close", disconnected);
    note("info", `开始 ${name}`);
    const operation = Promise.resolve().then(() => invocationSignals.run(signal, () => {
      signal.throwIfAborted();
      // input originates exclusively from parsed JSON.
      return action((input === undefined ? null : input) as GadgetJson, context(signal));
    }));
    void operation.finally(() => { if (watchdog) clearTimeout(watchdog); }).catch(() => undefined);
    try {
      const value = await Promise.race([operation, cancelled]);
      signal.throwIfAborted(); respond(response, 200, value);
      note("info", `完成 ${name}`);
    } catch (error) {
      const code = record(error) && typeof error.code === "string" ? error.code : "ACTION_FAILED";
      note("error", `失败 ${name} (${code})`); throw error;
    }
    finally { clearTimeout(timeout); active.delete(controller); response.off("close", disconnected); signal.removeEventListener("abort", onAbort); }
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cross-origin-resource-policy", "same-origin");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("vary", "Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site");
    try {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      const host = request.headers.host?.toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw failure("FORBIDDEN", "Forbidden", 403);
      const sameOrigin = `http://${host}`;
      if (request.headers.origin && request.headers.origin !== sameOrigin) throw failure("FORBIDDEN", "Forbidden", 403);
      const fetchSite = request.headers["sec-fetch-site"];
      if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none" && !(request.method === "GET" && request.headers["sec-fetch-mode"] === "navigate")) {
        throw failure("FORBIDDEN", "Forbidden", 403);
      }
      const route = decodeURIComponent((request.url ?? "/").split("?")[0]);
      if (closing) throw failure("STOPPING", "Gadget 正在停止", 503);
      if (route === "/__mybuddy_health" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}'); return;
      }
      if (route === "/__mybuddy/sdk.js" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); response.end(options.sdkSource); return;
      }
      if (route.startsWith("/__mybuddy/")) {
        const supplied = request.headers["x-mybuddy-gadget-token"];
        if (typeof supplied !== "string" || Buffer.byteLength(supplied) !== Buffer.byteLength(options.token)
          || !timingSafeEqual(Buffer.from(supplied), Buffer.from(options.token))) throw failure("UNAUTHORIZED", "Gadget 会话无效，请重新打开页面", 401);
        if (route === "/__mybuddy/runtime" && request.method === "GET") {
          respond(response, 200, { gadgetId: options.gadgetId, name: options.manifest.name, backend: Boolean(options.manifest.backend), actions: [...actions.keys()] }); return;
        }
        if (route === "/__mybuddy/logs" && request.method === "GET") { respond(response, 200, logs); return; }
        if (request.method !== "POST") throw failure("METHOD_NOT_ALLOWED", "此接口需要 POST", 405);
        const input = await body(request);
        if (route.startsWith("/__mybuddy/actions/")) { await invoke(route.slice("/__mybuddy/actions/".length), input.input, response); return; }
        if (route === "/__mybuddy/storage" || route === "/__mybuddy/config") {
          const values = route.endsWith("/config") ? state.config : state.storage;
          respond(response, 200, await valueOperation(values, input)); return;
        }
        throw failure("NOT_FOUND", "接口不存在", 404);
      }
      if (request.method !== "GET" && request.method !== "HEAD") throw failure("METHOD_NOT_ALLOWED", "静态资源只支持 GET/HEAD", 405);
      const relative = route === "/" ? options.manifest.entry : route.replace(/^\/+/, "");
      const parts = relative.split("/");
      const sensitive = /^(?:server|node_modules|package(?:-lock)?\.json|pnpm-lock\.yaml|gadget\.json|credentials?(?:\..*)?|secrets?(?:\..*)?|auth\.json|oauth\.json|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i;
      if (parts.some((part) => part.startsWith(".") || sensitive.test(part))) throw failure("NOT_FOUND", "Not found", 404);
      const file = safeSource(relative);
      const ext = path.extname(file).toLowerCase();
      const contentType = mime[ext];
      if (!contentType) throw failure("NOT_FOUND", "Not found", 404);
      response.setHeader("content-type", contentType);
      if (ext === ".html" || ext === ".htm") {
        response.setHeader("content-security-policy", "frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
        const html = fs.readFileSync(file, "utf8");
        const sdk = '<script src="/__mybuddy/sdk.js"></script>';
        const head = /<head\b[^>]*>/i.exec(html);
        const prefix = head ? head.index + head[0].length : /^\s*<!doctype[^>]*>/i.exec(html)?.[0].length ?? 0;
        response.end(request.method === "HEAD" ? undefined : `${html.slice(0, prefix)}${sdk}${html.slice(prefix)}`); return;
      }
      if (request.method === "HEAD") { response.end(); return; }
      const stream = fs.createReadStream(file);
      stream.once("error", () => response.destroy()); response.once("close", () => stream.destroy()); stream.pipe(response);
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      const code = record(error) && typeof error.code === "string" ? error.code : "INTERNAL_ERROR";
      const knownErrors: Record<string, { status: number; message: string }> = {
        COMMAND_NOT_FOUND: { status: 503, message: "声明的命令未安装或不在 PATH 中" },
        COMMAND_DENIED: { status: 403, message: "该命令未在 Gadget backend.commands 中声明" },
        UNSUPPORTED_COMMAND_SHIM: { status: 422, message: "只支持标准 npm Node 启动脚本；其他 Windows 脚本请改用真实 exe 或声明的 node 入口" },
        COMMAND_TIMEOUT: { status: 504, message: "命令执行超时；不会自动重放" },
        COMMAND_ABORTED: { status: 499, message: "命令已取消；远端写入结果可能未知" },
        COMMAND_OUTPUT_LIMIT: { status: 413, message: "命令输出超过容量限制" },
        REVISION_CONFLICT: { status: 409, message: "数据已被修改，请重新读取后再保存" },
        INVALID_JSON: { status: 400, message: "请求和持久数据必须是有效 JSON" },
      };
      const known = Object.hasOwn(knownErrors, code) ? knownErrors[code] : undefined;
      const status = record(error) && typeof error.status === "number" ? error.status : known?.status ?? (code === "ENOENT" || code === "ENOTDIR" ? 404 : 500);
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      // Do not send exception stacks, local paths or command output to webpages.
      const message = known?.message ?? (record(error) && typeof error.message === "string" && status < 500 ? error.message : code === "ACTION_TIMEOUT" ? "后台操作超时；不会自动重放" : "Gadget 操作失败，请查看后台代码与运行状态");
      response.end(JSON.stringify({ error: { code, message } }));
    }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 15_000;
  let shutdownFlight: Promise<void> | undefined;
  function shutdown(code: number): Promise<void> {
    return shutdownFlight ??= (async () => {
      closing = true; lifetime.abort(failure("STOPPING", "Gadget 已停止"));
      for (const controller of active) controller.abort(failure("STOPPING", "Gadget 已停止"));
      server.close(); server.closeAllConnections();
      const hardExit = setTimeout(() => process.exit(code || 1), 1500);
      try {
        if (processBackend) await backend.dispose?.();
        await commands.dispose();
        if (!processBackend) await backend.dispose?.();
        clearTimeout(hardExit); process.exit(code);
      } catch { clearTimeout(hardExit); process.exit(1); }
    })();
  }
  process.on("message", (message: unknown) => { if (record(message) && message.type === "shutdown") void shutdown(0); });
  process.on("disconnect", () => { void shutdown(0); });
  process.on("SIGTERM", () => { void shutdown(0); });
  process.on("SIGINT", () => { void shutdown(0); });
  if (processBackend) {
    let cwd: string;
    try { cwd = processBackend.cwd === "." ? root : safeSource(processBackend.cwd, true); }
    catch { throw new Error("Gadget 后台工作目录不存在或不在源码目录内"); }
    if (/[\\/]/.test(processBackend.command) && !path.isAbsolute(processBackend.command)) {
      throw new Error("Gadget 后台程序路径必须是当前平台的绝对路径");
    }
    backend = await startProcessBackend(commands.open(processBackend.command, processBackend.args, cwd), valueOperation, message => {
      if (closing) return;
      process.send?.({ type: "backend-failure", message });
      void shutdown(1);
    });
  } else if (declaration && "entry" in declaration) {
    const backendPath = safeSource(declaration.entry);
    const namespace: unknown = await import(pathToFileURL(backendPath).href);
    if (!record(namespace) || typeof namespace.default !== "function") throw failure("INVALID_BACKEND", "后台必须 default export 一个 createBackend(context) 函数");
    const result: unknown = await namespace.default(context(lifetime.signal));
    if (!record(result) || !record(result.actions) || (result.dispose !== undefined && typeof result.dispose !== "function")) {
      throw failure("INVALID_BACKEND", "后台必须返回 { actions, dispose? }");
    }
    for (const [name, action] of Object.entries(result.actions)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(name) || typeof action !== "function") throw failure("INVALID_BACKEND", "后台 action 名称或函数无效");
    }
    backend = result as unknown as GadgetBackend;
  }
  if (closing) return;
  for (const [name, action] of Object.entries(backend.actions)) actions.set(name, action);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address === "object") process.stdout.write(`MYBUDDY_GADGET_PORT:${address.port}\n`);
  });
  note("info", "Gadget 已启动");
}
