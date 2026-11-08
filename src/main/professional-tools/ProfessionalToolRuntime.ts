import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { npxFallbackPaths, npxProbeCommand } from "../platform/apps";
import {
  DRAWIO_DEFAULT_PORT,
  DRAWIO_HTTP_TITLE_MARKER,
  DRAWIO_MAX_PORT,
  DRAWIO_MCP_SERVER_ID,
  DRAWIO_NPM_PACKAGE,
  DRAWIO_READY_POLL_MS,
  DRAWIO_READY_TIMEOUT_MS,
  drawioOpenUrl,
  isManagedToolProvider,
  PENPOT_DEFAULT_OPEN_URL,
  isPenpotIdentityHtml,
  PENPOT_ORIGIN,
  type DrawioMcpPayload,
  type ManagedToolProviderId,
  type ProfessionalToolResultDto,
  type ProfessionalToolStatusDto,
} from "../../shared/professional-tools";
import { getMyBuddyDir, getToolsDir } from "../paths";
import {
  listListeningPids as platformListeningPids,
  listPidsByImageName as platformPidsByImageName,
  pidExecutablePath as platformPidExecutablePath,
  runProcess,
} from "../platform/processes";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_POLL_MS = 400;

type OwnedChild = Pick<ChildProcess, "pid" | "killed" | "kill"> & { unref?: () => void };

export interface ProfessionalToolRuntime {
  readonly providerId: ManagedToolProviderId;
  status(): Promise<ProfessionalToolStatusDto>;
  start(): Promise<ProfessionalToolStatusDto>;
  stop(): Promise<ProfessionalToolStatusDto>;
  connectMcp(): Promise<ProfessionalToolResultDto>;
  open(): Promise<ProfessionalToolResultDto>;
}

export interface ProfessionalToolPlatformOps {
  exists(path: string): boolean;
  listDirectories(path: string): string[];
  ensureDir(path: string): void;
  writeText(path: string, content: string): void;
  /** 读取文本文件（不存在/不可读 => null）。 */
  readTextFile(path: string): string | null;
  spawn(command: string, args: string[], env?: Record<string, string>): OwnedChild;
  run(
    command: string,
    args: string[],
    options?: { env?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ code: number; output: string }>;
  tcpReady(host: string, port: number): Promise<boolean>;
  /** 端口归属：返回监听该端口的 pid 列表（netstat；不可用/失败 => []）。 */
  listListeningPids(port: number): Promise<number[]>;
  /** 按镜像名返回进程 pid 列表（tasklist；不可用/失败 => []）。 */
  runningPidsByImageName(imageName: string): Promise<number[]>;
  /** 进程可执行文件路径（不可用/失败 => null）。 */
  pidExecutablePath(pid: number): Promise<string | null>;
  httpReady(url: string): Promise<boolean>;
  /** HTTP 状态码（0 = 不可达）。 */
  httpStatus(url: string): Promise<number>;
  /** GET 并返回响应体（截断；不可达/错误 => null）。供身份标记探测（如 Draw.io HTML title）。 */
  httpGet(url: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  /** 应用内打开（扩展栏浏览器/现有 Web surface）；未配置时回落 openExternal。 */
  openInApp(url: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface ProfessionalToolRuntimeOptions {
  toolsRoot?: string;
  runtimeDir?: string;
  providerEnabled?: (providerId: ManagedToolProviderId) => boolean | Promise<boolean>;
  ops?: Partial<ProfessionalToolPlatformOps>;
  readyTimeoutMs?: number;
  readyPollMs?: number;
}

function redactSensitiveText(input: string): string {
  return input
    .replace(/([?&]userToken=)[^\s&#]+/gi, "$1<redacted>")
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1<redacted>");
}

function defaultTcpReady(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    const finish = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(800);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function defaultHttpReady(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet(url, { timeout: 1_500 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.once("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.once("error", () => resolve(false));
  });
}

function defaultHttpStatus(url: string): Promise<number> {
  return new Promise((resolve) => {
    const req = httpGet(url, { timeout: 1_500 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.once("timeout", () => {
      req.destroy();
      resolve(0);
    });
    req.once("error", () => resolve(0));
  });
}

const DEFAULT_HTTP_GET_LIMIT = 16 * 1024;

function defaultHttpGet(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const req = httpGet(url, { timeout: 2_000 }, (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        res.resume();
        resolve(null);
        return;
      }
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += String(chunk);
        if (body.length > DEFAULT_HTTP_GET_LIMIT) {
          req.destroy();
          resolve(body.slice(0, DEFAULT_HTTP_GET_LIMIT));
        }
      });
      res.on("end", () => resolve(body));
      res.on("error", () => resolve(null));
    });
    req.once("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.once("error", () => resolve(null));
  });
}

function defaultOps(): ProfessionalToolPlatformOps {
  return {
    exists: existsSync,
    listDirectories: (path) => {
      if (!existsSync(path)) return [];
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    },
    ensureDir: (path) => mkdirSync(path, { recursive: true }),
    writeText: (path, content) => writeFileSync(path, content, "utf-8"),
    readTextFile: (path) => {
      try {
        return readFileSync(path, "utf-8");
      } catch {
        return null;
      }
    },
    spawn: (command, args, env) =>
      spawn(command, args, {
        windowsHide: false,
        stdio: "ignore",
        detached: true,
        env: env ? { ...process.env, ...env } : undefined,
      }),
    run: runProcess,
    tcpReady: defaultTcpReady,
    // 平台实现见 platform/processes.ts（Windows netstat/tasklist/PowerShell CIM；Linux ss//proc）。
    listListeningPids: platformListeningPids,
    runningPidsByImageName: platformPidsByImageName,
    pidExecutablePath: platformPidExecutablePath,
    httpReady: defaultHttpReady,
    httpStatus: defaultHttpStatus,
    httpGet: defaultHttpGet,
    openExternal: async () => {
      throw new Error("openExternal dependency is not configured");
    },
    openInApp: async (url) => {
      // 未显式配置应用内打开 → 回落系统浏览器（与 openExternal 同语义）
      return defaultOps().openExternal(url);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * 受管工具根解析：显式注入 > MYBUDDY_TOOLS_DIR > ~/.mybuddy/tools。
 *
 * 产品不内置第三方软件：这里只承载用户/产品提供的配置（如 penpot compose），
 * 不再从 exe 旁或 cwd 下的便携目录发现随包软件。
 */
function resolveToolsRoot(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.MYBUDDY_TOOLS_DIR) return process.env.MYBUDDY_TOOLS_DIR;
  return getToolsDir();
}

abstract class BaseRuntime implements ProfessionalToolRuntime {
  abstract readonly providerId: ManagedToolProviderId;
  protected ownedChild: OwnedChild | null = null;

  constructor(
    protected readonly toolsRoot: string,
    protected readonly runtimeDir: string,
    protected readonly ops: ProfessionalToolPlatformOps,
    protected readonly providerEnabled: (providerId: ManagedToolProviderId) => boolean | Promise<boolean>,
    protected readonly readyTimeoutMs: number,
    protected readonly readyPollMs: number,
  ) {}

  abstract status(): Promise<ProfessionalToolStatusDto>;
  abstract start(): Promise<ProfessionalToolStatusDto>;
  abstract stop(): Promise<ProfessionalToolStatusDto>;
  abstract open(): Promise<ProfessionalToolResultDto>;

  /**
   * prepare 自定义钩子：返回非 null 时 service.prepareForProvider 直接采用，跳过通用
   * status→start→ready 流程。自托管进程的 provider（drawio：进程由会话内 MCP adapter
   * 托管）用它做「预检 = npx 可解析 + MCP 条目已配置启用」，避免死锁（HTTP 就绪只出现在
   * 会话内首条工具调用之后）。
   */
  async customPrepare(): Promise<ProfessionalToolResultDto | null> {
    return null;
  }

  async connectMcp(): Promise<ProfessionalToolResultDto> {
    const status = await this.status();
    if (!status.ready) return this.fail(status, `${this.providerId} 工具尚未 Ready`);
    if (!(await this.providerEnabled(this.providerId))) {
      return this.fail(status, `${this.providerId} MCP 未配置或已停用`);
    }
    return { ok: true, providerId: this.providerId, status };
  }

  protected fail(status: ProfessionalToolStatusDto, error: string): ProfessionalToolResultDto {
    return { ok: false, providerId: this.providerId, status, error: redactSensitiveText(error) };
  }

  protected async waitReady(): Promise<ProfessionalToolStatusDto> {
    const deadline = Date.now() + this.readyTimeoutMs;
    let status = await this.status();
    while (!status.ready && status.state !== "missing" && Date.now() < deadline) {
      await this.ops.sleep(this.readyPollMs);
      status = await this.status();
    }
    return status;
  }

  /** App quit 专用：只杀本 Runtime 自己 spawn 的 native GUI；不碰外部实例。 */
  stopOwned(): void {
    const child = this.ownedChild;
    this.ownedChild = null;
    if (!child || child.killed) return;
    try {
      child.kill();
    } catch {
      /* best effort */
    }
  }
}

class PenpotRuntime extends BaseRuntime {
  readonly providerId = "penpot" as const;
  /** 避免 start/open 并发或短时间内重复弹出多个系统浏览器标签。 */
  private lastBrowserOpenAt = 0;

  private composePath(): string | null {
    for (const name of ["docker-compose.yaml", "docker-compose.yml", "compose.yaml", "compose.yml"]) {
      const path = join(this.toolsRoot, "penpot", name);
      if (this.ops.exists(path)) return path;
    }
    return null;
  }

  async status(): Promise<ProfessionalToolStatusDto> {
    const compose = this.composePath();
    if (!compose) return { providerId: this.providerId, state: "missing", installed: false, ready: false, detail: "Penpot compose 未找到" };
    const ready = await this.isHttpReady();
    return {
      providerId: this.providerId,
      state: ready ? "ready" : "stopped",
      installed: true,
      ready,
      detail: ready ? `Penpot ${PENPOT_ORIGIN} Ready` : "Penpot Docker 未 Ready（或端口被无关服务占用）",
    };
  }

  /**
   * Penpot HTTP identity：端口可达 + 页面 title 以 Penpot 开头双确认，
   * 避免 9001 上任意 HTTP 200 被误判为 Penpot Ready。
   * 2.16+ 标题是 "Penpot | Full-stack design"，不能再要求精确 `<title>Penpot</title>`。
   */
  private async isHttpReady(): Promise<boolean> {
    if (!(await this.ops.httpReady(PENPOT_ORIGIN))) return false;
    const body = await this.ops.httpGet(PENPOT_ORIGIN);
    return body != null && isPenpotIdentityHtml(body);
  }

  private async openSystemBrowser(): Promise<void> {
    const now = Date.now();
    if (now - this.lastBrowserOpenAt < 3_000) return;
    this.lastBrowserOpenAt = now;
    try {
      await this.ops.openExternal(PENPOT_DEFAULT_OPEN_URL);
    } catch {
      // 打开浏览器失败不影响 Ready；用户仍可点「打开」重试
    }
  }

  async start(): Promise<ProfessionalToolStatusDto> {
    const before = await this.status();
    if (before.state === "missing") return before;
    let status = before;
    if (!before.ready) {
      const compose = this.composePath();
      if (!compose) return before;
      const result = await this.ops.run("docker", ["compose", "-f", compose, "up", "-d"]);
      if (result.code !== 0) {
        return { ...before, state: "error", detail: redactSensitiveText(`docker compose 启动失败: ${result.output.trim()}`) };
      }
      // 审计：Penpot backend 由固定 compose 文件启动（仅 up -d 固定服务，绝无任意 docker run）
      console.info(
        `[runtime:audit] penpot docker compose up -d（${compose}）@ ${new Date().toISOString()}`,
      );
      status = await this.waitReady();
      if (!status.ready) return { ...status, state: "error", detail: "Penpot 启动后等待 Ready 超时" };
    }
    await this.openSystemBrowser();
    return status;
  }

  async stop(): Promise<ProfessionalToolStatusDto> {
    const compose = this.composePath();
    if (!compose) return this.status();
    await this.ops.run("docker", ["compose", "-f", compose, "stop"]);
    return this.status();
  }

  async open(): Promise<ProfessionalToolResultDto> {
    const status = await this.start();
    if (!status.ready) return this.fail(status, status.detail ?? "Penpot 未 Ready");
    return { ok: true, providerId: this.providerId, status };
  }

  /**
   * 建会话 gate：只校验 compose 存在 + MCP 已配置，不 docker up、不弹浏览器。
   * 旧逻辑 prepare 会 up -d，且 createSession 每次 open 弹窗；服务未 Ready 时反复 up/open 烦人。
   * 需要服务时走 start()/open()（Ready 后系统浏览器打开 9001）。
   */
  override async customPrepare(): Promise<ProfessionalToolResultDto | null> {
    const status = await this.status();
    if (status.state === "missing") {
      return {
        ok: false,
        providerId: this.providerId,
        status,
        error: status.detail ?? "Penpot compose 未找到",
      };
    }
    if (!(await this.providerEnabled(this.providerId))) {
      return this.fail(status, `${this.providerId} MCP 未配置或已停用`);
    }
    if (status.ready) {
      return { ok: true, providerId: this.providerId, status };
    }
    return {
      ok: true,
      providerId: this.providerId,
      status: {
        ...status,
        detail:
          "Penpot 已配置但 Docker 未 Ready。会话不自动 docker up / 不弹浏览器；" +
          "需要时 start/open Penpot，或手动 docker compose up。",
      },
    };
  }
}

/**
 * next-ai-draw-io MCP server（@next-ai-drawio/mcp-server）Runtime。
 *
 * 官方事实（0.2.3 源码实证，packages/mcp-server）：
 * - 自包含 stdio MCP server + 内嵌 HTTP server（127.0.0.1，PORT 默认 6002，被占自动回退至 6020）；
 * - GET / 返回 draw.io embed 画布页，HTML <title> 恒为 "Next AI Draw.io"（身份标记），
 *   无 ?mcp= 参数时自动 302 到最近会话；/api/state 提供会话状态轮询；
 * - 工具：start_session（开浏览器）/ create_new_diagram / load_diagram（磁盘 .drawio，含压缩格式）/\
 *   edit_diagram / get_diagram / export_diagram（.drawio/.png/.svg 落盘）/ list_pages / add_page /\
 *   rename_page / delete_page。
 *
 * 生命周期模型：进程由 MyBuddy 会话内的 MCP adapter 托管（会话创建时 spawn、会话销毁时 kill），
 * 本 Runtime 不重复拉起进程；只负责：npx 解析（MCP 条目 payload）、就绪探测/身份识别、
 * 端口冲突预检、画布打开（应用内扩展栏浏览器优先）。
 */
class DrawioRuntime extends BaseRuntime {
  readonly providerId = "drawio-ai" as const;

  /** 探测到的活动端口（外部实例或本会话实例；open/status 用）。 */
  private activePort: number | null = null;
  /** npx 解析结果缓存（只做一次进程探测）。 */
  private npxResolvePromise: Promise<string | null> | null = null;

  /**
   * 端口扫描 + 身份识别：6002-6020 逐个 GET /，HTML 含 <title>Next AI Draw.io</title> 即命中。
   * 返回 { found, port, occupiedByOther }（occupiedByOther = 至少一个端口被非本服务占用）。
   */
  private async probeHttp(): Promise<{
    found: boolean;
    port: number | null;
    occupiedByOther: boolean;
  }> {
    let occupiedByOther = false;
    for (let port = DRAWIO_DEFAULT_PORT; port <= DRAWIO_MAX_PORT; port += 1) {
      const url = drawioOpenUrl(port);
      const status = await this.ops.httpStatus(url);
      if (status === 0) continue;
      const body = await this.ops.httpGet(url);
      if (body != null && body.includes(DRAWIO_HTTP_TITLE_MARKER)) {
        this.activePort = port;
        return { found: true, port, occupiedByOther };
      }
      occupiedByOther = true;
    }
    return { found: false, port: null, occupiedByOther };
  }

  /** npx 解析：where/which 优先取绝对路径（Electron PATH 不可靠），找不到回落 "npx"。 */
  private resolveNpx(): Promise<string | null> {
    if (this.npxResolvePromise) return this.npxResolvePromise;
    this.npxResolvePromise = (async () => {
      const probe = await this.ops.run(npxProbeCommand(), ["npx"], { timeoutMs: 10_000 });
      if (probe.code !== 0) {
        // 直接探测常见路径，避免 PATH 探测失败误判
        const candidates = npxFallbackPaths();
        const hit = candidates.find((c) => this.ops.exists(c));
        return hit ?? null;
      }
      const first = probe.output
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .find((c) => !/\.ps1$/i.test(c));
      return first ?? null;
    })();
    return this.npxResolvePromise;
  }

  async status(): Promise<ProfessionalToolStatusDto> {
    const probe = await this.probeHttp();
    if (probe.found) {
      return {
        providerId: this.providerId,
        state: "ready",
        installed: true,
        ready: true,
        detail: `Next AI Draw.io 已就绪（127.0.0.1:${probe.port}）`,
      };
    }
    const npx = await this.resolveNpx();
    if (!npx) {
      return {
        providerId: this.providerId,
        state: "missing",
        installed: false,
        ready: false,
        detail:
          "未找到 npx/Node：请安装 Node.js（含 npx）。Draw.io MCP 由会话内自动拉起，无需单独安装服务。",
      };
    }
    return {
      providerId: this.providerId,
      state: "stopped",
      installed: true,
      ready: false,
      detail: probe.occupiedByOther
        ? `端口 6002-${DRAWIO_MAX_PORT} 有非 Draw.io 服务占用；MCP server 启动时会自动回退端口（官方 PORT 语义）`
        : "Draw.io MCP 未运行：在 drawio-ai 标签下发消息后由会话自动拉起（首条工具调用即就绪）",
    };
  }

  async start(): Promise<ProfessionalToolStatusDto> {
    const before = await this.status();
    if (before.ready || before.state === "missing") return before;
    // 进程由会话内 MCP adapter 托管：这里只做预检（npx 已解析即视为可启动），
    // 不重复 spawn，避免与 adapter 实例抢端口/双实例。
    return before;
  }

  async stop(): Promise<ProfessionalToolStatusDto> {
    this.stopOwned(); // 从不自启，恒为 no-op（防御）
    return this.status();
  }

  /** 应用内扩展栏浏览器打开画布（无会话时根路径自动 302 最近会话）；未配置 openInApp 回落系统浏览器。 */
  async open(): Promise<ProfessionalToolResultDto> {
    const status = await this.status();
    if (!status.installed) {
      return this.fail(status, status.detail ?? "npx/Node 未找到");
    }
    const probe = await this.probeHttp();
    if (!probe.found) {
      return this.fail(
        status,
        "Draw.io 画布尚未启动：在「流程图」标签下发消息，Agent 调用 start_session 后画布会自动打开；也可直接开始对话生成图。",
      );
    }
    const url = drawioOpenUrl(probe.port!);
    try {
      await this.ops.openInApp(url);
      return { ok: true, providerId: this.providerId, status };
    } catch (error) {
      return this.fail(status, error instanceof Error ? error.message : String(error));
    }
  }

  /** 本地 stdio MCP 条目 payload（npx 未解析到 => null，不写配置）。 */
  async getMcpPayload(): Promise<DrawioMcpPayload | null> {
    const npx = await this.resolveNpx();
    if (!npx) return null;
    return {
      command: npx,
      args: [DRAWIO_NPM_PACKAGE],
      env: { PORT: String(DRAWIO_DEFAULT_PORT) },
      port: DRAWIO_DEFAULT_PORT,
    };
  }

  /** 预检 = npx 可解析 + MCP 条目已配置启用；不要求 HTTP ready（进程由会话内 adapter 拉起）。 */
  async customPrepare(): Promise<ProfessionalToolResultDto | null> {
    const status = await this.status();
    if (status.state === "missing") {
      return { ok: false, providerId: this.providerId, status, error: status.detail ?? "npx/Node 未找到" };
    }
    if (status.ready) {
      if (!(await this.providerEnabled(this.providerId))) {
        return this.fail(status, `${this.providerId} MCP 未配置或已停用`);
      }
      return { ok: true, providerId: this.providerId, status };
    }
    if (!(await this.providerEnabled(this.providerId))) {
      return this.fail(
        status,
        "drawio-ai MCP 未配置或已停用：请先在 MCP 设置中启用（首条 drawio 工具调用会自动拉起服务）",
      );
    }
    return { ok: true, providerId: this.providerId, status };
  }
}

export class ProfessionalToolRuntimeService {
  private readonly runtimes: Record<ManagedToolProviderId, BaseRuntime>;

  constructor(options: ProfessionalToolRuntimeOptions = {}) {
    const defaults = defaultOps();
    const ops: ProfessionalToolPlatformOps = { ...defaults, ...options.ops };
    const toolsRoot = resolveToolsRoot(options.toolsRoot);
    const runtimeDir = options.runtimeDir ?? join(getMyBuddyDir(), "runtime");
    const providerEnabled = options.providerEnabled ?? (() => false);
    const timeout = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const poll = options.readyPollMs ?? DEFAULT_READY_POLL_MS;
    this.runtimes = {
      penpot: new PenpotRuntime(toolsRoot, runtimeDir, ops, providerEnabled, timeout, poll),
      "drawio-ai": new DrawioRuntime(toolsRoot, runtimeDir, ops, providerEnabled, timeout, poll),
    };
  }

  async status(providerId: ManagedToolProviderId): Promise<ProfessionalToolStatusDto> {
    return this.runtimes[providerId].status();
  }

  /** 直接启动 runtime（spawn 桌面软件 + 等 bridge ready；无业务 MCP tool 调用）。 */
  async start(providerId: ManagedToolProviderId): Promise<ProfessionalToolStatusDto> {
    return this.runtimes[providerId].start();
  }

  async prepareForProvider(providerId: ManagedToolProviderId): Promise<ProfessionalToolResultDto> {
    const runtime = this.runtimes[providerId];
    // 自托管进程的 provider（drawio）：采用其预检钩子，不要求 HTTP ready（会话内拉起）
    const custom = await runtime.customPrepare();
    if (custom) return custom;
    let status = await runtime.status();
    if (status.state === "missing") {
      return { ok: false, providerId, status, error: status.detail ?? `${providerId} 未安装` };
    }
    if (!status.ready) status = await runtime.start();
    if (!status.ready) {
      return { ok: false, providerId, status, error: redactSensitiveText(status.detail ?? `${providerId} 未 Ready`) };
    }
    return runtime.connectMcp();
  }

  async open(providerId: ManagedToolProviderId): Promise<ProfessionalToolResultDto> {
    return this.runtimes[providerId].open();
  }

  async stop(providerId: ManagedToolProviderId): Promise<ProfessionalToolStatusDto> {
    return this.runtimes[providerId].stop();
  }

  stopOwned(): void {
    // Penpot Docker 是独立服务，MyBuddy 退出时不自动 stop。
  }

  /** Draw.io 本地 stdio MCP 条目 payload（npx 未找到时 null）。 */
  drawioMcpPayload(): Promise<DrawioMcpPayload | null> {
    return (this.runtimes["drawio-ai"] as unknown as DrawioRuntime).getMcpPayload();
  }

  /** 给 Agent/UI 防御性调用：非受管 provider 不进入 Runtime（设计类工具旧 5 个 + 办公 drawio-ai）。 */
  static manages(providerId: string): providerId is ManagedToolProviderId {
    return isManagedToolProvider(providerId);
  }
}
