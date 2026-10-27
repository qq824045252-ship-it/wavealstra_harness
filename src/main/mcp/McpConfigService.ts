/**
 * MCP 配置服务：发现 / 合并 / 安装 / 移除（MyBuddy 应用全局）
 *
 * 对齐 pi-mcp-adapter 的配置语义（无新增依赖，自包含实现）：
 * - 配置来源（低 → 高优先级）：
 *   shared-global   ~/.config/mcp/mcp.json         （通用全局）
 *   agents-global   ~/.agents/mcp.json             （通用全局）
 *   agents-nested   ~/.agents/mcp/mcp.json         （通用全局）
 *   pi-global       ~/.mybuddy/plugins/mcp/mcp.json            （MyBuddy 应用全局，本服务的管理目标）
 * - 兼容来源（imports）：cursor / claude-code / claude-desktop / codex / opencode / windsurf / vscode
 * - “安装到 MyBuddy” = 把服务器定义写入 ~/.mybuddy/plugins/mcp/mcp.json（pi-global 层）
 * - 停用 = 在应用全局条目上写 disabled 字段（应用全局优先级高于任何兼容来源）
 * - 构造函数可注入 appGlobalPath / homeDir，便于测试隔离
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  McpConfigPreviewDto,
  McpDiscoveryDto,
  McpImportDto,
  McpInstallResultDto,
  McpServerDto,
  McpServerTransport,
  McpSourceDto,
  McpServerConfigDto,
  McpSaveServerRequest,
} from "../../shared/agent-ipc";
import { pluginStoragePaths } from "../plugins/PluginStorage";
import { roamingAppDataDir } from "../platform/apps";
import { toNativeMcpConfig } from "./NativeMcpConfig";
import { emptyMcpFilterResult } from "./McpModeFilter";
import { parseJsonc as parseConfigJsonc } from "../../shared/jsonc";
import {
  DRAWIO_MCP_SERVER_ID,
  type DrawioMcpPayload,
} from "../../shared/professional-tools";
import { listBundledMcpExtensions } from "./BundledMcpExtensions";

export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  socket?: string;
  auth?: string | { provider: string };
  bearerToken?: string;
  bearerTokenEnv?: string;
  oauth?: unknown;
  disabled?: boolean;
  lifecycle?: string;
  directTools?: true | string[] | false;
  [key: string]: unknown;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
  imports?: string[];
  settings?: Record<string, unknown>;
}

export type ImportKind =
  | "cursor"
  | "claude-code"
  | "claude-desktop"
  | "codex"
  | "opencode"
  | "windsurf"
  | "vscode";

const IMPORT_LABELS: Record<ImportKind, string> = {
  cursor: "Cursor",
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  opencode: "OpenCode",
  windsurf: "Windsurf",
  vscode: "VS Code",
};

type SourceKind = "shared" | "pi" | "import";

interface ConfigSource {
  id: string;
  label: string;
  path: string;
  kind: SourceKind;
  scope: "global" | "project";
  importKind?: ImportKind;
}

export interface McpConfigServiceOptions {
  /** 应用全局配置路径（默认 ~/.mybuddy/plugins/mcp/mcp.json；测试注入临时路径） */
  appGlobalPath?: string;
  /** 用户主目录（默认 os.homedir()；测试注入 fake home） */
  homeDir?: string;
}

interface LoadedImport {
  kind: ImportKind;
  path: string;
  servers: Record<string, McpServerEntry>;
}

/* ------------------------------ JSONC / TOML ------------------------------ */

/** 去除 // 与块注释、行尾逗号（字符串内外安全） */
function stripJsonc(src: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  // 行尾逗号（朴素处理：只处理 } ] 前的逗号）
  return out.replace(/,\s*([}\]])/g, "$1");
}

function parseJsonc(raw: string): unknown {
  return parseConfigJsonc(raw);
}

function readJsonc(path: string): unknown {
  return parseJsonc(readFileSync(path, "utf-8"));
}

/** 极简 TOML 解析：注释、[table]/[table."name"]、key = value（字符串/数字/布尔/数组/基础 inline table） */
function parseMinimalToml(raw: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let table: Record<string, unknown> = root;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const noComment = line.replace(/#.*$/, "").trim();
    if (!noComment) continue;
    const tableMatch = /^\[(.+)\]$/.exec(noComment);
    if (tableMatch) {
      const path = tableMatch[1]!.replace(/"/g, "").split(".");
      let cursor = root;
      for (const segment of path) {
        const existing = cursor[segment];
        if (existing && typeof existing === "object" && !Array.isArray(existing)) {
          cursor = existing as Record<string, unknown>;
        } else {
          const next: Record<string, unknown> = {};
          cursor[segment] = next;
          cursor = next;
        }
      }
      table = cursor;
      continue;
    }
    const eq = noComment.indexOf("=");
    if (eq <= 0) continue;
    const key = noComment.slice(0, eq).trim().replace(/"/g, "");
    const valueText = noComment.slice(eq + 1).trim();
    table[key] = parseTomlValue(valueText);
  }
  return root;
}

function parseTomlValue(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    return parseTomlArray(trimmed);
  }
  if (trimmed.startsWith("{")) {
    const inner = trimmed.slice(1, -1);
    const out: Record<string, unknown> = {};
    for (const part of splitTopLevel(inner, ",")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      out[part.slice(0, eq).trim().replace(/"/g, "")] = parseTomlValue(part.slice(eq + 1));
    }
    return out;
  }
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    const end = trimmed.lastIndexOf(quote);
    return trimmed.slice(1, end === 0 ? undefined : end);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const num = Number(trimmed);
  return Number.isNaN(num) ? trimmed : num;
}

function parseTomlArray(text: string): unknown[] {
  const inner = text.slice(1, -1);
  if (!inner.trim()) return [];
  const out: unknown[] = [];
  for (const part of splitTopLevel(inner, ",")) {
    out.push(parseTomlValue(part.trim()));
  }
  return out;
}

/** 忽略引号内分隔符地按分隔符拆分 */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      current += ch;
      if (ch === "\\") {
        current += text[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    if (ch === "]" || ch === "}") depth -= 1;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/* ------------------------------ 服务主体 ------------------------------ */
export class McpConfigService {
  private readonly appGlobalPath: string;
  private readonly importPaths: Record<ImportKind, string[]>;
  private readonly genericGlobalPath: string;
  private readonly agentsGlobalPaths: readonly string[];

  constructor(options: McpConfigServiceOptions = {}) {
    const home = options.homeDir ?? homedir();
    this.appGlobalPath = options.appGlobalPath ?? pluginStoragePaths(join(home, ".mybuddy")).mcpConfig;
    this.genericGlobalPath = join(home, ".config", "mcp", "mcp.json");
    this.agentsGlobalPaths = [
      join(home, ".agents", "mcp.json"),
      join(home, ".agents", "mcp", "mcp.json"),
    ] as const;
    const apdata = roamingAppDataDir(home);
    this.importPaths = {
      cursor: [join(home, ".cursor", "mcp.json")],
      "claude-code": [
        join(home, ".claude", "mcp.json"),
        join(home, ".claude.json"),
        join(home, ".claude", "claude_desktop_config.json"),
      ],
      "claude-desktop": [
        join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        ...(apdata ? [join(apdata, "Claude", "claude_desktop_config.json")] : []),
      ],
      codex: [join(home, ".codex", "config.toml"), join(home, ".codex", "config.json")],
      opencode: [
        join(home, ".config", "opencode", "opencode.json"),
        join(home, ".config", "opencode", "opencode.jsonc"),
      ],
      windsurf: [join(home, ".windsurf", "mcp.json")],
      vscode: [],
    };
  }

  getAppGlobalConfigPath(): string {
    return this.appGlobalPath;
  }

  readServerConfig(name: string): McpServerConfigDto {
    const raw = readRawConfigObject(this.appGlobalPath, true);
    const entry = getServersObject(raw, true)[name];
    if (!entry) throw new Error(`「${name}」尚未安装到 MyBuddy`);
    return { name, entryText: JSON.stringify(entry, null, 2), path: this.appGlobalPath };
  }

  /** Update one entry with native Pi validation and an optimistic concurrency check. */
  saveServerConfig(request: McpSaveServerRequest): McpInstallResultDto {
    try {
      const { name, entryText, expectedEntryText } = request;
      if (!/^[A-Za-z0-9_-]+$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) throw new Error("服务器名称只能包含字母、数字、下划线和连字符");
      const entry = parseJsonc(entryText);
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("服务器配置必须是 JSON 对象");
      const raw = readRawConfigObject(this.appGlobalPath, true);
      const servers = getServersObject(raw, true);
      const existing = Object.hasOwn(servers, name) ? servers[name] : undefined;
      if (expectedEntryText === null && existing) throw new Error(`「${name}」已存在，请使用编辑配置`);
      if (typeof expectedEntryText === "string" && (!existing || JSON.stringify(existing) !== JSON.stringify(parseJsonc(expectedEntryText)))) throw new Error("配置已被其他操作修改，请关闭后重新打开编辑");
      const normalizedName = name.replace(/-/g, "_");
      if (Object.keys(this.loadMcpConfig().mcpServers).some(other => other !== name && other.replace(/-/g, "_") === normalizedName)) throw new Error("服务器名称与已有服务器在 Pi 中重名");
      const validated = toNativeMcpConfig(emptyMcpFilterResult({ mcpServers: { [name]: entry as McpServerEntry } }));
      if (validated.errors.length) throw new Error(validated.errors.join("\n"));
      servers[name] = entry as McpServerEntry;
      setServersObject(raw, servers);
      const preview = writeRawConfigObject(this.appGlobalPath, raw);
      return { ok: true, path: this.appGlobalPath, names: [name], added: existing ? [] : [name], preview };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 发现：所有全局配置来源 + 兼容来源 */
  discover(): McpDiscoveryDto {
    const sources = this.getConfigSources().map((source) => {
      const loaded = readValidatedConfig(source.path);
      return {
        id: source.id,
        label: source.label,
        path: source.path,
        exists: existsSync(source.path),
        kind: source.kind,
        scope: source.scope,
        importKind: source.importKind,
        serverCount: loaded ? Object.keys(loaded.mcpServers).length : 0,
      } satisfies McpSourceDto;
    });

    const imports: McpImportDto[] = [];
    for (const kind of Object.keys(this.importPaths) as ImportKind[]) {
      const loaded = this.loadImportedConfig(kind);
      if (!loaded) continue;
      imports.push({
        kind,
        label: IMPORT_LABELS[kind],
        path: loaded.path,
        serverCount: Object.keys(loaded.servers).length,
      });
    }

    return {
      sources,
      imports,
      totalServerCount: sources.reduce((sum, s) => sum + s.serverCount, 0),
      appGlobalConfigPath: this.appGlobalPath,
    };
  }

  /**
   * 服务器列表（全部来源合并去重 + 兼容来源候选），带来源溯源。
   * 停用的服务器仍返回（disabled: true），由 UI 决定展示方式。
   * 未启用的兼容来源（cursor / claude-code …）服务器也作为候选返回
   * （sourceId = import:<kind>），供用户选择安装到 MyBuddy。
   */
  listServers(): McpServerDto[] {
    const merged = this.loadMcpConfig();
    const appGlobalRaw = readValidatedConfig(this.appGlobalPath);
    const installedNames = new Set(Object.keys(appGlobalRaw?.mcpServers ?? {}));

    // 来源溯源：从高优先级往下找定义位置
    const provenance = new Map<string, ConfigSource>();
    for (const source of [...this.getConfigSources()].reverse()) {
      const loaded = readValidatedConfig(source.path);
      if (!loaded) continue;
      for (const name of Object.keys(loaded.mcpServers)) {
        if (!provenance.has(name)) provenance.set(name, source);
      }
      if (loaded.imports?.length) {
        for (const kind of loaded.imports) {
          const imported = this.loadImportedConfig(kind as ImportKind);
          if (!imported) continue;
          for (const name of Object.keys(imported.servers)) {
            if (!provenance.has(name)) {
              provenance.set(name, {
                id: `import:${kind}`,
                label: `兼容来源 · ${IMPORT_LABELS[kind as ImportKind]}`,
                path: imported.path,
                kind: "import",
                scope: "global",
                importKind: kind as ImportKind,
              });
            }
          }
        }
      }
    }

    // 未启用导入的兼容来源：其服务器作为候选补充（已在生效配置中的不重复）
    const candidateNames = new Set<string>();
    const candidates: McpServerDto[] = [];
    for (const kind of Object.keys(this.importPaths) as ImportKind[]) {
      const imported = this.loadImportedConfig(kind);
      if (!imported) continue;
      for (const [name, entry] of Object.entries(imported.servers)) {
        if (merged.mcpServers[name] || candidateNames.has(name)) continue;
        candidateNames.add(name);
        const { transport, endpoint } = describeTransport(entry);
        candidates.push({
          name,
          sourceId: `import:${kind}`,
          sourcePath: imported.path,
          transport,
          endpoint,
          args: Array.isArray(entry.args) ? entry.args.map(String) : [],
          env: entry.env ? Object.keys(entry.env) : [],
          disabled: isServerDisabled(entry),
          installed: false,
          fields: Object.keys(entry),
        } satisfies McpServerDto);
      }
    }

    const effective: McpServerDto[] = Object.entries(merged.mcpServers).map(([name, entry]) => {
      const prov = provenance.get(name);
      const { transport, endpoint } = describeTransport(entry);
      return {
        name,
        sourceId: prov?.id ?? "unknown",
        sourcePath: prov?.path ?? "",
        transport,
        endpoint,
        args: Array.isArray(entry.args) ? entry.args.map(String) : [],
        env: entry.env ? Object.keys(entry.env) : [],
        disabled: isServerDisabled(entry),
        installed: installedNames.has(name),
        fields: Object.keys(entry),
        exposure: typeof entry.exposure === "string" ? entry.exposure : entry.directTools === true ? "direct" : "codemode",
        description: typeof entry.description === "string" ? entry.description : undefined,
      } satisfies McpServerDto;
    });

    // 捆绑扩展：未安装时作为候选（sourceId = bundled:<id>）
    for (const ext of listBundledMcpExtensions()) {
      for (const [name, entry] of Object.entries(ext.servers)) {
        if (merged.mcpServers[name] || candidateNames.has(name)) continue;
        candidateNames.add(name);
        const { transport, endpoint } = describeTransport(entry);
        candidates.push({
          name,
          sourceId: `bundled:${ext.id}`,
          sourcePath: ext.sourcePath,
          transport,
          endpoint,
          args: Array.isArray(entry.args) ? entry.args.map(String) : [],
          env: entry.env ? Object.keys(entry.env) : [],
          disabled: isServerDisabled(entry),
          installed: false,
          fields: Object.keys(entry),
        } satisfies McpServerDto);
      }
    }

    return [...effective, ...candidates];
  }

  /** 应用全局 ~/.mybuddy/plugins/mcp/mcp.json 的原始内容（供展示/编辑） */
  readAppConfig(): { path: string; text: string } {
    if (!existsSync(this.appGlobalPath)) return { path: this.appGlobalPath, text: "" };
    return { path: this.appGlobalPath, text: readFileSync(this.appGlobalPath, "utf-8") };
  }

  /** 整体覆写应用全局配置（文本） */
  writeAppConfig(text: string): McpInstallResultDto {
    try {
      const parsed = parseJsonc(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "配置必须是 JSON 对象" };
      }
      writeJsonFile(this.appGlobalPath, text.endsWith("\n") ? text : `${text}\n`);
      return { ok: true, path: this.appGlobalPath };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 安装：把服务器定义写入应用全局 ~/.mybuddy/plugins/mcp/mcp.json。
   * 定义查找顺序：生效合并配置 → 各兼容来源（cursor / codex …）。
   * 已在应用全局中的服务器会被更新定义。
   */
  installServers(names: string[]): McpInstallResultDto {
    try {
      const merged = this.loadMcpConfig();
      const raw = readRawConfigObject(this.appGlobalPath);
      const servers = getServersObject(raw);
      const added: string[] = [];
      const updated: string[] = [];
      const missing: string[] = [];
      for (const name of names) {
        const entry =
          merged.mcpServers[name] ?? this.findInImports(name) ?? this.findInBundled(name);
        if (!entry) {
          missing.push(name);
          continue;
        }
        if (servers[name]) updated.push(name);
        else added.push(name);
        servers[name] = { ...entry };
      }
      if (added.length === 0 && updated.length === 0) {
        return {
          ok: false,
          error: missing.length ? `未找到服务器: ${missing.join(", ")}` : "没有需要安装的服务器",
        };
      }
      setServersObject(raw, servers);
      const preview = writeRawConfigObject(this.appGlobalPath, raw);
      return { ok: true, path: this.appGlobalPath, names, added, removed: updated, preview };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 从应用全局配置移除服务器定义 */
  removeServers(names: string[]): McpInstallResultDto {
    try {
      const raw = readRawConfigObject(this.appGlobalPath);
      const servers = getServersObject(raw);
      const removed: string[] = [];
      for (const name of names) {
        if (servers[name]) {
          delete servers[name];
          removed.push(name);
        }
      }
      if (removed.length === 0) return { ok: true, path: this.appGlobalPath, removed: [] };
      setServersObject(raw, servers);
      const preview = writeRawConfigObject(this.appGlobalPath, raw);
      return { ok: true, path: this.appGlobalPath, names, removed, preview };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 启用/停用：直接在应用全局条目上写 disabled 字段。
   * 应用全局优先级高于任何兼容来源，删除 disabled 即恢复启用。
   */
  setServerEnabled(name: string, enabled: boolean): McpInstallResultDto {
    try {
      const raw = readRawConfigObject(this.appGlobalPath);
      const servers = getServersObject(raw);
      const existing = servers[name];
      if (!existing) {
        return { ok: false, error: `「${name}」尚未安装到 MyBuddy` };
      }
      const next = { ...existing } as McpServerEntry;
      if (enabled) { delete next.disabled; delete next.enabled; }
      else { next.disabled = true; next.enabled = false; }
      if (JSON.stringify(existing) === JSON.stringify(next)) {
        return { ok: true, path: this.appGlobalPath, names: [name] };
      }
      servers[name] = next;
      setServersObject(raw, servers);
      const preview = writeRawConfigObject(this.appGlobalPath, raw);
      return {
        ok: true,
        path: this.appGlobalPath,
        names: [name],
        added: enabled ? [name] : [],
        removed: enabled ? [] : [name],
        preview,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Draw.io 本地 stdio MCP 条目自愈/同步（启动时调用，幂等）：
   * - payload 为 null（npx 未解析到）→ 不动现有配置（用户可能手动配置了命令），ok:false 说明原因；
   * - 条目缺失 → 写入 {command, args, env, modes:["working"], disabled:false}；
   * - 条目存在且内容过期（command/args/env 变化）→ 重写，保留 modes；
   * - 条目存在且用户显式停用（disabled:true）→ 尊重用户，不碰。
   * modes:["working"] 保证 drawio-ai 不泄漏到 coding/design 会话。
   */
  ensureDrawioServer(payload: DrawioMcpPayload | null): McpInstallResultDto {
    if (!payload) {
      return { ok: false, error: "npx 未解析到，跳过 Draw.io MCP 条目写入" };
    }
    try {
      const raw = readRawConfigObject(this.appGlobalPath);
      const servers = getServersObject(raw);
      const existing = servers[DRAWIO_MCP_SERVER_ID];
      if (existing?.disabled === true) {
        return { ok: true, path: this.appGlobalPath, names: [DRAWIO_MCP_SERVER_ID] };
      }
      const next: McpServerEntry = {
        command: payload.command,
        args: payload.args,
        env: { ...payload.env },
        modes: ["working"],
        disabled: false,
      };
      const transportOf = (entry: McpServerEntry | undefined): unknown =>
        entry ? { command: entry.command, args: entry.args, env: entry.env } : null;
      if (existing && JSON.stringify(transportOf(existing)) === JSON.stringify(transportOf(next))) {
        return { ok: true, path: this.appGlobalPath, names: [DRAWIO_MCP_SERVER_ID] };
      }
      servers[DRAWIO_MCP_SERVER_ID] = next;
      setServersObject(raw, servers);
      const preview = writeRawConfigObject(this.appGlobalPath, raw);
      return {
        ok: true,
        path: this.appGlobalPath,
        names: [DRAWIO_MCP_SERVER_ID],
        added: existing ? [] : [DRAWIO_MCP_SERVER_ID],
        removed: existing ? [DRAWIO_MCP_SERVER_ID] : [],
        preview,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /* ------------------------------ 内部：来源与合并 ------------------------------ */

  /** 全局配置来源（低 → 高优先级），不含项目层 */
  private getConfigSources(): ConfigSource[] {
    const sources: ConfigSource[] = [];
    if (this.genericGlobalPath !== this.appGlobalPath) {
      sources.push({
        id: "shared-global",
        label: "通用全局 MCP",
        path: this.genericGlobalPath,
        kind: "shared",
        scope: "global",
      });
    }
    for (const [index, agentsPath] of this.agentsGlobalPaths.entries()) {
      if (agentsPath === this.appGlobalPath || agentsPath === this.genericGlobalPath) continue;
      sources.push({
        id: index === 0 ? "agents-global" : "agents-nested-global",
        label: index === 0 ? ".agents 全局 MCP" : ".agents/mcp 全局 MCP",
        path: agentsPath,
        kind: "shared",
        scope: "global",
      });
    }
    sources.push({
      id: "pi-global",
      label: "MyBuddy 全局 MCP",
      path: this.appGlobalPath,
      kind: "pi",
      scope: "global",
    });
    return sources;
  }

  /**
   * Runtime only mounts MCP servers explicitly installed into MyBuddy's app-global file.
   * Shared/import sources remain discovery/install candidates and must not connect implicitly.
   * This keeps Hub's "已安装到 MyBuddy" list consistent with what the Pi runtime actually starts.
   */
  loadRuntimeConfig(): McpConfig {
    return readValidatedConfig(this.appGlobalPath) ?? { mcpServers: {} };
  }

  /** 加载完整生效配置（全局来源 + imports 展开） */
  private loadMcpConfig(): McpConfig {
    let config: McpConfig = { mcpServers: {} };
    for (const source of this.getConfigSources()) {
      const loaded = readValidatedConfig(source.path);
      if (!loaded) continue;
      config = mergeConfigs(config, this.expandImports(loaded));
    }
    return config;
  }

  /** 在全部兼容来源中查找第一个含该名字的定义 */
  private findInImports(name: string): McpServerEntry | undefined {
    for (const kind of Object.keys(this.importPaths) as ImportKind[]) {
      const imported = this.loadImportedConfig(kind);
      if (!imported) continue;
      const entry = imported.servers[name];
      if (entry) return entry;
    }
    return undefined;
  }

  /** 仓库内 extensions/mcp 捆绑扩展 */
  private findInBundled(name: string): McpServerEntry | undefined {
    const key = name.toLowerCase();
    for (const ext of listBundledMcpExtensions()) {
      for (const [serverName, entry] of Object.entries(ext.servers)) {
        if (serverName.toLowerCase() === key || ext.id.toLowerCase() === key) {
          return { ...entry };
        }
      }
    }
    return undefined;
  }

  /**
   * 一键安装全部捆绑 coding MCP（serena / codegraph），写入 modes:["coding"]。
   */
  installBundledCodingMcp(): McpInstallResultDto {
    const names: string[] = [];
    for (const ext of listBundledMcpExtensions()) {
      names.push(...Object.keys(ext.servers));
    }
    if (!names.length) {
      return { ok: false, error: "未找到 extensions/mcp 捆绑扩展" };
    }
    return this.installServers(names);
  }

  private expandImports(config: McpConfig): McpConfig {
    if (!config.imports?.length) return config;
    const imported: Record<string, McpServerEntry> = {};
    for (const kind of config.imports) {
      const loaded = this.loadImportedConfig(kind as ImportKind);
      if (!loaded) continue;
      for (const [name, definition] of Object.entries(loaded.servers)) {
        if (!imported[name]) imported[name] = definition;
      }
    }
    return {
      imports: config.imports,
      settings: config.settings,
      mcpServers: mergeServerMaps(imported, config.mcpServers),
    };
  }

  private loadImportedConfig(importKind: ImportKind): LoadedImport | null {
    for (const path of this.importPaths[importKind] ?? []) {
      if (!existsSync(path)) continue;
      let raw: string;
      try {
        raw = readFileSync(path, "utf-8");
      } catch {
        continue;
      }
      // empty / 纯空白 / 注释-only 占位：视为无配置（静默，不 warn）
      if (!raw.trim() || !stripJsonc(raw).trim()) continue;
      try {
        return {
          kind: importKind,
          path,
          servers: extractServers(
            path.endsWith(".toml") ? parseMinimalToml(raw) : parseJsonc(raw),
            importKind,
          ),
        };
      } catch (error) {
        // 简洁 warning（仅 message，不输出整段 stack）：该兼容来源失败不影响其它来源
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[McpConfig] 兼容来源 ${importKind} 读取失败，已跳过: ${path} — ${message}`);
      }
    }
    return null;
  }
}

/* ------------------------------ 解析与合并工具 ------------------------------ */

function readValidatedConfig(path: string): McpConfig | null {
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  // empty / 纯空白 / 注释-only 占位：视为无配置（静默，不 warn）——兼容来源常见占位文件
  if (!text.trim()) return null;
  if (!stripJsonc(text).trim()) return null;
  try {
    const obj = parseJsonc(text);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { mcpServers: {} };
    const raw = obj as Record<string, unknown>;
    const servers = raw.mcpServers ?? raw["mcp-servers"] ?? {};
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      return { mcpServers: {} };
    }
    return {
      mcpServers: servers as Record<string, McpServerEntry>,
      imports: Array.isArray(raw.imports) ? (raw.imports as string[]) : undefined,
      settings:
        raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings)
          ? (raw.settings as Record<string, unknown>)
          : undefined,
    };
  } catch (error) {
    // truncated / invalid：只让该来源失败（调用方 continue 跳过，绝不污染其它来源
    // 或清空本地 MCP）；打印简洁 warning（仅 message，不输出整段 stack）
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[McpConfig] 配置解析失败，该来源将被跳过: ${path} — ${message}`);
    return null;
  }
}

function extractServers(config: unknown, kind: ImportKind): Record<string, McpServerEntry> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  const obj = config as Record<string, unknown>;

  let servers: unknown;
  switch (kind) {
    case "claude-desktop":
    case "claude-code":
      servers = obj.mcpServers;
      break;
    case "codex":
      servers = obj.mcp_servers ?? obj.mcpServers;
      break;
    case "cursor":
    case "windsurf":
    case "vscode":
      servers = obj.mcpServers ?? obj["mcp-servers"];
      break;
    case "opencode":
      servers = obj.mcp;
      break;
    default:
      return {};
  }
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};

  const mapped: Record<string, McpServerEntry> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (kind === "opencode") {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const raw = entry as Record<string, unknown>;
      if (raw.enabled === false) continue;
      if (raw.type === "local" && Array.isArray(raw.command)) {
        const command = raw.command.filter(
          (value): value is string => typeof value === "string",
        );
        if (command.length === 0) continue;
        const env = toStringRecord(raw.environment);
        mapped[name] = {
          command: command[0]!,
          args: command.slice(1),
          ...(env ? { env } : {}),
          ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
        };
        continue;
      }
      if (raw.type === "remote" && typeof raw.url === "string") {
        const headers = toStringRecord(raw.headers);
        mapped[name] = {
          url: raw.url,
          ...(headers ? { headers } : {}),
          ...(raw.oauth === false
            ? { oauth: false }
            : raw.oauth && typeof raw.oauth === "object" && !Array.isArray(raw.oauth)
              ? { auth: "oauth", oauth: raw.oauth }
              : {}),
        };
        continue;
      }
      continue;
    }

    if (kind !== "codex" || !entry || typeof entry !== "object" || Array.isArray(entry)) {
      mapped[name] = (entry as McpServerEntry) ?? {};
      continue;
    }

    const codex = entry as Record<string, unknown>;
    const mappedEntry: Record<string, unknown> = { ...codex };
    const bearerTokenEnv = codex.bearer_token_env_var;
    const httpHeaders = codex.http_headers;
    const envHttpHeaders = codex.env_http_headers;
    if (typeof bearerTokenEnv === "string") {
      mappedEntry.bearerTokenEnv = bearerTokenEnv;
      if (mappedEntry.auth === undefined) mappedEntry.auth = "bearer";
    }
    if (httpHeaders && typeof httpHeaders === "object" && !Array.isArray(httpHeaders)) {
      mappedEntry.headers = {
        ...(mappedEntry.headers as Record<string, string> | undefined),
        ...(httpHeaders as Record<string, string>),
      };
    }
    if (envHttpHeaders && typeof envHttpHeaders === "object" && !Array.isArray(envHttpHeaders)) {
      const headers = { ...(mappedEntry.headers as Record<string, string> | undefined) };
      for (const [header, envVar] of Object.entries(envHttpHeaders)) {
        if (typeof envVar === "string" && headers[header] === undefined) {
          headers[header] = `$env:${envVar}`;
        }
      }
      mappedEntry.headers = headers;
    }
    delete mappedEntry.bearer_token_env_var;
    delete mappedEntry.http_headers;
    delete mappedEntry.env_http_headers;
    mapped[name] = mappedEntry as McpServerEntry;
  }
  return mapped;
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const URL_BOUND_AUTH_FIELDS = ["headers", "bearerToken", "bearerTokenEnv"] as const;

/** 逐字段合并：url 变化时丢弃低优先级来源的认证材料（防凭证外泄），对齐 pi */
function mergeServerMaps(
  base: Record<string, McpServerEntry>,
  next: Record<string, McpServerEntry>,
): Record<string, McpServerEntry> {
  const merged = { ...base };
  for (const [name, definition] of Object.entries(next)) {
    const existing = merged[name];
    let baseEntry: McpServerEntry | undefined = existing;
    if (existing && typeof definition.socket === "string") {
      baseEntry = { ...existing };
      for (const field of [
        "command", "args", "env", "cwd", "url", "headers", "auth",
        "bearerToken", "bearerTokenEnv", "oauth",
      ]) {
        delete baseEntry[field];
      }
    } else if (existing?.socket && (typeof definition.command === "string" || typeof definition.url === "string")) {
      baseEntry = { ...existing };
      delete baseEntry.socket;
    }
    if (existing && typeof definition.url === "string" && definition.url !== existing.url) {
      if (baseEntry === existing) baseEntry = { ...existing };
      for (const field of URL_BOUND_AUTH_FIELDS) delete baseEntry[field];
      if (baseEntry.oauth !== false) delete baseEntry.oauth;
    }
    merged[name] = { ...(baseEntry ?? {}), ...definition };
  }
  return merged;
}

function mergeConfigs(base: McpConfig, next: McpConfig): McpConfig {
  return {
    mcpServers: mergeServerMaps(base.mcpServers, next.mcpServers),
    imports: [...new Set([...(base.imports ?? []), ...(next.imports ?? [])])],
    settings: next.settings ? { ...base.settings, ...next.settings } : base.settings,
  };
}

function isServerDisabled(entry: McpServerEntry | undefined): boolean {
  return entry?.disabled === true || entry?.enabled === false;
}

function describeTransport(entry: McpServerEntry): {
  transport: McpServerTransport;
  endpoint: string;
} {
  if (typeof entry.url === "string" && entry.url) {
    return { transport: "url", endpoint: entry.url };
  }
  if (typeof entry.command === "string" && entry.command) {
    const args = Array.isArray(entry.args) ? entry.args.join(" ") : "";
    return { transport: "command", endpoint: args ? `${entry.command} ${args}` : entry.command };
  }
  if (typeof entry.socket === "string" && entry.socket) {
    return { transport: "socket", endpoint: entry.socket };
  }
  return { transport: "unknown", endpoint: "" };
}

/* ------------------------------ 读写工具 ------------------------------ */

function readRawConfigObject(filePath: string, strict = false): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const text = readFileSync(filePath, "utf8");
    if (!stripJsonc(text).trim()) return {};
    const raw = parseJsonc(text);
    if (strict && (!raw || typeof raw !== "object" || Array.isArray(raw))) throw new Error("MCP 配置必须是 JSON 对象");
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch (error) {
    if (strict) throw error;
    return {};
  }
}

function getServersObject(raw: Record<string, unknown>, strict = false): Record<string, McpServerEntry> {
  const existing = raw.mcpServers ?? raw["mcp-servers"] ?? {};
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    if (strict) throw new Error("mcpServers 必须是 JSON 对象");
    return {};
  }
  return existing as Record<string, McpServerEntry>;
}

function setServersObject(raw: Record<string, unknown>, servers: Record<string, McpServerEntry>): void {
  delete raw["mcp-servers"];
  raw.mcpServers = servers;
}

function buildUnifiedDiff(beforeText: string, afterText: string): string {
  if (beforeText === afterText) return "(无变化)";
  const before = beforeText.split("\n");
  const after = afterText.split("\n");
  const rows = before.length;
  const cols = after.length;
  const lcs = Array.from({ length: rows + 1 }, () => Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: string[] = ["--- 修改前", "+++ 修改后"];
  let i = 0;
  let j = 0;
  while (i < rows || j < cols) {
    if (i < rows && j < cols && before[i] === after[j]) {
      lines.push(`  ${before[i]}`);
      i += 1;
      j += 1;
      continue;
    }
    if (j < cols && (i === rows || lcs[i][j + 1] >= lcs[i + 1][j])) {
      lines.push(`+ ${after[j]}`);
      j += 1;
      continue;
    }
    if (i < rows) {
      lines.push(`- ${before[i]}`);
      i += 1;
    }
  }
  return lines.join("\n");
}

function writeRawConfigObject(
  filePath: string,
  raw: Record<string, unknown>,
): McpConfigPreviewDto {
  const existed = existsSync(filePath);
  const beforeText = existed ? `${JSON.stringify(readRawConfigObject(filePath), null, 2)}\n` : "";
  const afterText = `${JSON.stringify(raw, null, 2)}\n`;
  const changed = beforeText !== afterText;
  if (changed) {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, afterText, "utf-8");
    renameSync(tmpPath, filePath);
  }
  return {
    path: filePath,
    existed,
    changed,
    beforeText,
    afterText,
    diffText: buildUnifiedDiff(beforeText, afterText),
  };
}

function writeJsonFile(filePath: string, text: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, text, "utf-8");
  renameSync(tmpPath, filePath);
}
