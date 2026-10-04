/** Design Mode 专业工具 Runtime IPC / DTO（不包含任何 MCP secret）。 */
export const PROFESSIONAL_TOOL_PROVIDER_IDS = [
  "penpot",
] as const;

export type ProfessionalToolProviderId = (typeof PROFESSIONAL_TOOL_PROVIDER_IDS)[number];

/**
 * 跨模式 managed provider 全集（design 专业工具 + 办公 Draw.io AI）。
 * createSession 的 providerMcpIds gate 与 ProfessionalToolRuntimeService 统一走此集合；
 * 新 provider 只需：注册 id → 加 Runtime 类 → 加 mcp.json 条目（modes 限模式）。
 */
export const MANAGED_TOOL_PROVIDER_IDS = [
  ...PROFESSIONAL_TOOL_PROVIDER_IDS,
  "drawio-ai",
] as const;

export type ManagedToolProviderId = (typeof MANAGED_TOOL_PROVIDER_IDS)[number];
export type ProfessionalToolState = "missing" | "stopped" | "ready" | "error" | "starting";

/** providerId 是否为受管工具（跨模式注册表；design 旧谓词 isProfessionalToolProvider 保持兼容） */
export function isManagedToolProvider(id: string): id is ManagedToolProviderId {
  return (MANAGED_TOOL_PROVIDER_IDS as readonly string[]).includes(id);
}

/**
 * 已下线桌面软件：不再出现在插件页受管启停 / 设置受管 MCP 列表。
 * 同名 MCP 若仍安装在 Hub（如 blender），场景模式「MCP 限制」仍应列出，
 * 只是不再当受管 runtime 自动拉起。
 */
export const RETIRED_MANAGED_PROVIDER_IDS = ["ardot-local", "blender", "freecad", "opendesign"] as const;

export function isRetiredManagedProvider(id: string): boolean {
  return (RETIRED_MANAGED_PROVIDER_IDS as readonly string[]).includes(id);
}

/** 随 Ardot / FreeCAD Tag 一起下线的技能，设置里不再列出。Blender 技能保留，配合 Hub 已装 blender MCP。 */
export const RETIRED_DESIGN_SKILL_IDS = [
  "ardot",
  "ardot-design-generator",
  "ardot-design-assistant",
  "freecad",
] as const;

export function isRetiredDesignSkill(id: string): boolean {
  return (RETIRED_DESIGN_SKILL_IDS as readonly string[]).includes(id);
}

/** Penpot 本机地址（扩展栏浏览器默认打开；Ready 探测同源）。 */
export const PENPOT_ORIGIN = "http://localhost:9001";

/**
 * Penpot 前端页身份标记（HTTP identity 探测用）。
 * 2.16+ 标题是 `<title>Penpot | Full-stack design</title>`，旧版是 `<title>Penpot</title>`。
 * 用 title 前缀，避免精确旧 title 把已可访问的 9001 误判成未 Ready。
 */
export const PENPOT_HTML_MARKER = "<title>Penpot";

/** 页面是否为 Penpot 前端（兼容旧 title 与 2.16+ 营销 title）。 */
export function isPenpotIdentityHtml(body: string): boolean {
  return /<title>\s*Penpot\b/i.test(body);
}

/** OpenDesign daemon 默认端口（官方 `od daemon start --port <n>`，OD_PORT 覆盖；见 open-design apps/daemon/src/daemon-startup.ts）。 */
export const OPENDESIGN_DEFAULT_PORT = 7456;

/** OpenDesign daemon HTTP base（MCP `--daemon-url` 与 status 探测共用）。 */
export const OPENDESIGN_DAEMON_ORIGIN = `http://127.0.0.1:${OPENDESIGN_DEFAULT_PORT}`;

/** daemon 健康探测端点（`od daemon status` 内部请求同源；200 = 就绪）。 */
export const OPENDESIGN_DAEMON_STATUS_PATH = "/api/daemon/status";

/** OpenDesign CLI 显式路径环境变量（可指向 cli.js / od.mjs / od.cmd / od.exe）。 */
export const OPENDESIGN_CLI_ENV = "MYBUDDY_OPENDESIGN_CLI";

/** daemon 启动端口冲突回退窗口：7456 起最多再试 N 个端口（7457-7466）。 */
export const OPENDESIGN_PORT_RETRY_COUNT = 10;

/**
 * OpenDesign 本地 stdio MCP 条目 payload（写入 ~/.mybuddy/plugins/mcp/mcp.json 的 opendesign server）。
 * 形状对齐官方 buildMcpInstallPayload（open-design apps/daemon/src/mcp-install-info.ts）：
 * command = 当前 Node 兼容 runtime（Electron 场景带 ELECTRON_RUN_AS_NODE=1），
 * args = [cliScript, "mcp", "--daemon-url", daemonUrl]。
 */
export interface OpenDesignMcpPayload {
  command: string;
  args: string[];
  env: Record<string, string>;
  daemonUrl: string;
}

/** 扩展栏浏览器默认打开 URL（与 PENPOT_ORIGIN 一致，不擅自加路径/team-id）。 */
export const PENPOT_DEFAULT_OPEN_URL = PENPOT_ORIGIN;

export interface ProfessionalToolStatusDto {
  providerId: ManagedToolProviderId;
  state: ProfessionalToolState;
  installed: boolean;
  ready: boolean;
  /** 可安全展示的路径/端口摘要；禁止包含 token/query。 */
  detail?: string;
}

export interface ProfessionalToolResultDto {
  ok: boolean;
  providerId: ManagedToolProviderId;
  status: ProfessionalToolStatusDto;
  error?: string;
}

export const ProfessionalToolIpc = {
  status: "professional-tools:status",
  prepare: "professional-tools:prepare",
  open: "professional-tools:open",
  stop: "professional-tools:stop",
} as const;

export function isProfessionalToolProvider(id: string): id is ProfessionalToolProviderId {
  return (PROFESSIONAL_TOOL_PROVIDER_IDS as readonly string[]).includes(id);
}

/** OpenDesign MCP server 名（集中式；与 DESIGN_PROVIDER_MCP_IDS 的 opendesign 一致）。 */
export const OPENDESIGN_MCP_SERVER_ID = "opendesign";

/* ------------------------- Draw.io AI（办公 provider） ------------------------- */

/** Draw.io MCP server 名（集中式；与 OFFICE_PROVIDER_MCP_IDS 的 drawio-ai 一致）。 */
export const DRAWIO_MCP_SERVER_ID = "drawio-ai";

/** npm 包（官方 README 推荐 npx 直启：`npx @next-ai-drawio/mcp-server@latest`）。 */
export const DRAWIO_NPM_PACKAGE = "@next-ai-drawio/mcp-server@latest";

/** 内嵌 HTTP server 默认端口（官方 PORT env；6002 起被占时自动回退至 6020）。 */
export const DRAWIO_DEFAULT_PORT = 6002;

/** 官方自动回退上限（http-server.ts MAX_PORT=6020）。 */
export const DRAWIO_MAX_PORT = 6020;

/** 身份标记：内嵌页 HTML `<title>Next AI Draw.io</title>`（http-server.ts getHtmlPage）。 */
export const DRAWIO_HTTP_TITLE_MARKER = "Next AI Draw.io";

/** 端口探测轮询参数（与其它 provider 对齐）。 */
export const DRAWIO_READY_TIMEOUT_MS = 30_000;
export const DRAWIO_READY_POLL_MS = 400;

/** 扩展栏浏览器默认打开 URL（根路径；有会话时服务端自动 302 到最近会话）。 */
export function drawioOpenUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Draw.io 本地 stdio MCP 条目 payload（写入 ~/.mybuddy/plugins/mcp/mcp.json 的 drawio-ai server）。
 * command = 解析到的 npx（或 "npx"），args = [npm 包]，env.PORT 固定默认端口。
 * 进程生命周期由会话内 MCP adapter 托管（spawn/kill），本 Runtime 不重复拉起。
 */
export interface DrawioMcpPayload {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** 期望端口（PORT env；探测按 6002-6020 扫描）。 */
  port: number;
}
