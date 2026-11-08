import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DEFAULT_WEBHOOK_PORT, listenOnFirstAvailablePort } from "./webhook-port";
import type { FeishuChannelAdapter, WechatMpChannelAdapter, WecomChannelAdapter } from "./channels";

const MAX_WEBHOOK_BYTES = 4 * 1024 * 1024;

interface GatewayWebhooks {
  feishu: Pick<FeishuChannelAdapter, "handleWebhookPayload">;
  wecom: Pick<WecomChannelAdapter, "handleHttp">;
  wechat: Pick<WechatMpChannelAdapter, "handleHttp">;
  safeError(error: unknown): string;
}

/** Owns the listener, including concurrent start and shutdown during port fallback.
 * Transport authentication stays inside the relevant provider adapter.
 */
export class GatewayLifecycleManager {
  server: Server | null = null;
  port = DEFAULT_WEBHOOK_PORT;
  private starting?: Promise<void>;
  private epoch = 0;

  constructor(private readonly webhooks: GatewayWebhooks) {}

  async start(): Promise<void> {
    if (this.server) return;
    if (this.starting) return this.starting;
    const epoch = this.epoch;
    const starting = (async () => {
      const { port, server } = await listenOnFirstAvailablePort(() => this.createServer(), this.port);
      if (epoch !== this.epoch) {
        await new Promise<void>(resolve => server.close(() => resolve()));
        throw new Error("Gateway 监听启动已取消");
      }
      this.server = server;
      this.port = port;
    })();
    this.starting = starting;
    try { await starting; }
    finally { if (this.starting === starting) this.starting = undefined; }
  }

  async stop(): Promise<void> {
    ++this.epoch;
    await this.starting?.catch(() => {});
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private createServer(): Server {
    return createServer((req, res) => {
      // HTTP servers do not consume an async listener's rejected promise.
      void this.handle(req, res).catch(error => {
        if (res.destroyed || res.writableEnded) return;
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(this.webhooks.safeError(error));
      });
    });
  }

  private async body(req: IncomingMessage, res: ServerResponse): Promise<string | undefined> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const value of req) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.byteLength;
      if (bytes > MAX_WEBHOOK_BYTES) {
        res.writeHead(413, { "Content-Type": "text/plain", Connection: "close" });
        res.end("Gateway webhook payload too large");
        return undefined;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const path = url.pathname.replace(/\/$/, "");
    if (req.method === "POST" && path === "/feishu") {
      const raw = await this.body(req, res);
      if (raw === undefined) return;
      let body: unknown;
      try { body = JSON.parse(raw || "{}"); }
      catch { res.writeHead(400); res.end("bad json"); return; }
      const result = await this.webhooks.feishu.handleWebhookPayload(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result ?? { ok: true }));
      return;
    }
    if ((req.method === "GET" || req.method === "POST") && (path === "/wecom" || path === "/wechat")) {
      const rawBody = req.method === "POST" ? await this.body(req, res) : "";
      if (rawBody === undefined) return;
      const adapter = path === "/wecom" ? this.webhooks.wecom : this.webhooks.wechat;
      const result = await adapter.handleHttp({ method: req.method, query: url.searchParams, rawBody });
      res.writeHead(result.status, { "Content-Type": result.contentType ?? "text/plain" });
      res.end(result.body);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  }
}
