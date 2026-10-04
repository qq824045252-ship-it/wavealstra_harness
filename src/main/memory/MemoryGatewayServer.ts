import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getMyBuddyDir } from "../paths";
import { MEMORY_KINDS, MEMORY_SCOPE_TYPES, MEMORY_STATUSES } from "../../shared/memory-kernel";
import {
  MemoryGatewayError,
  type MemoryGatewayContextInput,
  type MemoryGatewayService,
} from "./MemoryGatewayService";
import { MemoryGatewayAccessControl, type MemoryGatewayAccessPrincipal } from "./MemoryGatewayAccessControl";
import { protectMemoryGatewaySecretFile } from "./MemoryGatewayFileSecurity";

export const MEMORY_GATEWAY_HOST = "127.0.0.1";
export const MEMORY_GATEWAY_DEFAULT_PORT = 3351;
export const MEMORY_GATEWAY_API_VERSION = 1;
export const MEMORY_GATEWAY_TOKEN_FILENAME = "memory-gateway.token";
const MAX_BODY_BYTES = 256 * 1024;

export interface MemoryGatewayServerOptions {
  host?: string;
  port?: number;
  token?: string;
  tokenPath?: string;
  accessControl?: MemoryGatewayAccessControl;
}

export interface MemoryGatewayServerStatus {
  running: boolean;
  host: string;
  port?: number;
  writeEnabled: boolean;
  memoryEnabled: boolean;
  tokenPath: string;
  httpBaseUrl?: string;
  mcpUrl?: string;
}

const kindSchema = z.enum(MEMORY_KINDS);
const statusSchema = z.enum(MEMORY_STATUSES);
const scopeSchema = z.enum(MEMORY_SCOPE_TYPES);
const idSchema = z.string().trim().min(1).max(200);
const contextShape = {
  taskId: idSchema.optional(),
  projectId: idSchema.optional(),
  workspaceId: idSchema.optional(),
  includeInherited: z.boolean().optional(),
};
const searchSchema = z.object({
  ...contextShape,
  query: z.string().max(1000).optional(),
  kinds: z.array(kindSchema).max(MEMORY_KINDS.length).optional(),
  statuses: z.array(statusSchema).max(MEMORY_STATUSES.length).optional(),
  scopeTypes: z.array(scopeSchema).max(MEMORY_SCOPE_TYPES.length).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
const memoryContextSchema = searchSchema.extend({ budgetChars: z.number().int().min(800).max(9000).optional() });
const idRequestSchema = z.object({ ...contextShape, id: z.string().trim().min(1).max(120) }).strict();
const createSchema = z.object({
  ...contextShape,
  kind: kindSchema,
  title: z.string().min(1).max(240),
  content: z.string().max(6000).optional(),
  importance: z.number().int().min(0).max(3).optional(),
  confidence: z.number().min(0).max(1).optional(),
  scopeType: scopeSchema.optional(),
  scopeId: idSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  sourceRef: z.string().max(500).optional(),
  sourceTitle: z.string().max(500).optional(),
  sourceExcerpt: z.string().max(1200).optional(),
}).strict();
const updateSchema = z.object({
  ...contextShape,
  id: z.string().trim().min(1).max(120),
  kind: kindSchema.optional(),
  title: z.string().min(1).max(240).optional(),
  content: z.string().max(6000).optional(),
  status: statusSchema.optional(),
  importance: z.number().int().min(0).max(3).optional(),
  confidence: z.number().min(0).max(1).optional(),
  validFrom: z.number().int().nullable().optional(),
  validUntil: z.number().int().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  changeReason: z.string().max(500).optional(),
}).strict();
const promoteSchema = idRequestSchema.extend({
  targetScopeType: scopeSchema,
  targetScopeId: idSchema.optional(),
});

function defaultTokenPath(): string {
  return join(getMyBuddyDir(), MEMORY_GATEWAY_TOKEN_FILENAME);
}

export function loadOrCreateMemoryGatewayToken(path = defaultTokenPath()): string {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const current = readFileSync(path, "utf-8").trim();
    if (/^[A-Za-z0-9_-]{32,256}$/.test(current)) {
      protectMemoryGatewaySecretFile(path);
      return current;
    }
  }
  const token = randomBytes(32).toString("base64url");
  const tmp = `${path}.tmp-${process.pid}`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "w", 0o600);
    writeFileSync(fd, `${token}\n`, "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    protectMemoryGatewaySecretFile(tmp);
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
  protectMemoryGatewaySecretFile(path);
  return token;
}

function readBearer(req: IncomingMessage): string {
  const header = req.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function ownerTokenMatches(actual: string, expectedToken: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expectedToken);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function allowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const hostname = new URL(Array.isArray(origin) ? origin[0] : origin).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buf.length;
    if (bytes > MAX_BODY_BYTES) throw new MemoryGatewayError("invalid_request", "request body too large", 413);
    chunks.push(buf);
  }
  if (bytes === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw new MemoryGatewayError("invalid_request", "request body must be valid JSON", 400);
  }
}

function errorPayload(error: unknown): { status: number; payload: unknown } {
  if (error instanceof MemoryGatewayError) {
    return { status: error.httpStatus, payload: { ok: false, error: { code: error.code, message: error.message } } };
  }
  if (error instanceof z.ZodError) {
    return {
      status: 400,
      payload: { ok: false, error: { code: "invalid_request", message: "request validation failed", issues: error.issues } },
    };
  }
  console.warn("[MemoryGateway] request failed:", error instanceof Error ? error.message : String(error));
  return { status: 500, payload: { ok: false, error: { code: "internal_error", message: "internal Memory Gateway error" } } };
}

function toolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: { data },
  };
}

function toolError(error: unknown) {
  const normalized = errorPayload(error);
  const body = normalized.payload as { error?: { code?: string; message?: string } };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    isError: true as const,
  };
}

export function createMemoryGatewayMcpServer(gateway: MemoryGatewayService): McpServer {
  const server = new McpServer({ name: "mybuddy-memory", version: "1.0.0" });
  if (!gateway.memoryEnabled) return server;

  server.registerTool("memory_search", {
    description: "Search MyBuddy Memory Kernel within an authoritative Task/Project/Workspace context. Scope isolation is enforced server-side.",
    inputSchema: searchSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (input) => {
    try { return toolResult(await gateway.search(input)); } catch (error) { return toolError(error); }
  });

  server.registerTool("memory_get", {
    description: "Read one visible L1 MemoryRecord by id. Out-of-scope and missing ids are intentionally indistinguishable.",
    inputSchema: idRequestSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (input) => {
    try { return toolResult(gateway.get(input)); } catch (error) { return toolError(error); }
  });

  server.registerTool("memory_history", {
    description: "Read revision history for one visible MemoryRecord.",
    inputSchema: idRequestSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (input) => {
    try { return toolResult(gateway.history(input)); } catch (error) { return toolError(error); }
  });

  server.registerTool("memory_context", {
    description: "Resolve the same compact L3/L2 + precise L1 context projection used by MyBuddy without incrementing recall counters.",
    inputSchema: memoryContextSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (input) => {
    try { return toolResult(gateway.resolveMemoryContext(input)); } catch (error) { return toolError(error); }
  });

  if (gateway.isOwnerAccess) {
    server.registerTool("memory_stats", {
      description: "Read owner-level Memory Kernel statistics.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async () => {
      try { return toolResult(gateway.stats()); } catch (error) { return toolError(error); }
    });
  }

  if (gateway.writeEnabled) {
    server.registerTool("memory_create", {
      description: "Create a durable L1 MemoryRecord. Task context defaults to Project > Workspace > Task. Cross-scope writes require explicit promotion.",
      inputSchema: createSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async (input) => {
      try { return toolResult(gateway.create(input)); } catch (error) { return toolError(error); }
    });

    server.registerTool("memory_update", {
      description: "Revision-safe update of one visible MemoryRecord. Source attribution is fixed to memory-gateway/tool.",
      inputSchema: updateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async (input) => {
      try { return toolResult(gateway.update(input)); } catch (error) { return toolError(error); }
    });

    server.registerTool("memory_promote", {
      description: "Promote the same MemoryRecord to a scope allowed by an authoritative taskId. Does not duplicate the Memory body.",
      inputSchema: promoteSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input) => {
      try { return toolResult(gateway.promote(input)); } catch (error) { return toolError(error); }
    });

    server.registerTool("memory_forget", {
      description: "Hard-delete one visible MemoryRecord and invalidate its derived projections. Destructive.",
      inputSchema: idRequestSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async (input) => {
      try { return toolResult(gateway.forget(input)); } catch (error) { return toolError(error); }
    });
  }

  return server;
}

export class MemoryGatewayServer {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly tokenPath: string;
  private readonly token: string;
  private readonly accessControl: MemoryGatewayAccessControl;
  private httpServer: HttpServer | null = null;
  private actualPort: number | undefined;
  private readonly activeMcpServers = new Set<McpServer>();

  constructor(
    private readonly gateway: MemoryGatewayService,
    options: MemoryGatewayServerOptions = {},
  ) {
    this.host = options.host ?? MEMORY_GATEWAY_HOST;
    if (this.host !== MEMORY_GATEWAY_HOST) throw new Error("Memory Gateway only supports loopback host 127.0.0.1");
    this.requestedPort = options.port ?? MEMORY_GATEWAY_DEFAULT_PORT;
    if (!Number.isInteger(this.requestedPort) || this.requestedPort < 0 || this.requestedPort > 65535) {
      throw new Error(`Invalid Memory Gateway port: ${this.requestedPort}`);
    }
    this.tokenPath = options.tokenPath ?? defaultTokenPath();
    this.token = options.token?.trim() || loadOrCreateMemoryGatewayToken(this.tokenPath);
    if (this.token.length < 32) throw new Error("Memory Gateway token must be at least 32 characters");
    this.accessControl = options.accessControl ?? new MemoryGatewayAccessControl();
  }

  status(): MemoryGatewayServerStatus {
    const port = this.actualPort;
    return {
      running: this.httpServer !== null && port !== undefined,
      host: this.host,
      port,
      writeEnabled: this.gateway.writeEnabled,
      memoryEnabled: this.gateway.memoryEnabled,
      tokenPath: this.tokenPath,
      httpBaseUrl: port === undefined ? undefined : `http://${this.host}:${port}/v1/memory`,
      mcpUrl: port === undefined ? undefined : `http://${this.host}:${port}/mcp`,
    };
  }

  async start(): Promise<MemoryGatewayServerStatus> {
    if (this.httpServer) return this.status();
    const server = createServer((req, res) => { void this.handleRequest(req, res); });
    server.on("clientError", (_error, socket) => {
      try { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); } catch { /* ignore */ }
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        try { server.close(); } catch { /* not listening */ }
        reject(error);
      };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.requestedPort, this.host);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Memory Gateway failed to resolve listening address");
    }
    this.httpServer = server;
    this.actualPort = address.port;
    return this.status();
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = null;
    this.actualPort = undefined;
    await Promise.allSettled([...this.activeMcpServers].map((mcp) => mcp.close()));
    this.activeMcpServers.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://${this.host}`);
      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, {
          ok: true,
          service: "mybuddy-memory-gateway",
          version: MEMORY_GATEWAY_API_VERSION,
          writeEnabled: this.gateway.writeEnabled,
          memoryEnabled: this.gateway.memoryEnabled,
        });
        return;
      }
      if (!allowedOrigin(req)) {
        sendJson(res, 403, { ok: false, error: { code: "forbidden_origin", message: "cross-origin browser access is not allowed" } });
        return;
      }
      const principal = this.authenticate(req);
      if (!principal) {
        res.setHeader("www-authenticate", "Bearer realm=\"mybuddy-memory\"");
        sendJson(res, 401, { ok: false, error: { code: "unauthorized", message: "valid Bearer token required" } });
        return;
      }
      const requestGateway = this.gateway.withAccess(principal);
      if (url.pathname === "/mcp") {
        await this.handleMcp(req, res, requestGateway);
        return;
      }
      if (url.pathname.startsWith("/v1/memory")) {
        await this.handleHttpApi(req, res, url.pathname, requestGateway);
        return;
      }
      sendJson(res, 404, { ok: false, error: { code: "not_found", message: "route not found" } });
    } catch (error) {
      const normalized = errorPayload(error);
      sendJson(res, normalized.status, normalized.payload);
    }
  }

  private authenticate(req: IncomingMessage): MemoryGatewayAccessPrincipal | null {
    const token = readBearer(req);
    if (ownerTokenMatches(token, this.token)) {
      return { kind: "owner", id: "owner", name: "owner", mode: "read-write", scopeType: "all", accessSince: 0 };
    }
    return this.accessControl.authenticate(token);
  }

  private async handleMcp(req: IncomingMessage, res: ServerResponse, gateway: MemoryGatewayService): Promise<void> {
    const mcp = createMemoryGatewayMcpServer(gateway);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    this.activeMcpServers.add(mcp);
    const cleanup = () => {
      if (!this.activeMcpServers.delete(mcp)) return;
      void mcp.close().catch(() => undefined);
    };
    res.once("close", cleanup);
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  private async handleHttpApi(req: IncomingMessage, res: ServerResponse, path: string, gateway: MemoryGatewayService): Promise<void> {
    if (req.method === "GET" && path === "/v1/memory/stats") {
      sendJson(res, 200, { ok: true, data: gateway.stats() });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: { code: "method_not_allowed", message: "POST required" } });
      return;
    }
    const body = await readJsonBody(req);
    let data: unknown;
    switch (path) {
      case "/v1/memory/search": data = await gateway.search(searchSchema.parse(body)); break;
      case "/v1/memory/get": data = gateway.get(idRequestSchema.parse(body)); break;
      case "/v1/memory/history": data = gateway.history(idRequestSchema.parse(body)); break;
      case "/v1/memory/context": data = gateway.resolveMemoryContext(memoryContextSchema.parse(body)); break;
      case "/v1/memory/create": data = gateway.create(createSchema.parse(body)); break;
      case "/v1/memory/update": data = gateway.update(updateSchema.parse(body)); break;
      case "/v1/memory/forget": data = gateway.forget(idRequestSchema.parse(body)); break;
      case "/v1/memory/promote": data = gateway.promote(promoteSchema.parse(body)); break;
      default:
        sendJson(res, 404, { ok: false, error: { code: "not_found", message: "route not found" } });
        return;
    }
    sendJson(res, 200, { ok: true, data });
  }
}
