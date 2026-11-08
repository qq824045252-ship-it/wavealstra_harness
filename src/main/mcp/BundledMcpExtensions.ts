/**
 * 扫描仓库内 extensions/mcp/* 捆绑扩展（meta + mcp.json）。
 * 供 Hub 候选安装与 ensure 写入 ~/.mybuddy/plugins/mcp/mcp.json。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WelcomeMode } from "../../shared/mode-profile";
import type { McpServerEntry } from "./McpConfigService";

export interface BundledMcpExtension {
  id: string;
  name: string;
  description: string;
  version?: string;
  modes: WelcomeMode[];
  homepage?: string;
  installHints: string[];
  sourcePath: string;
  /** 写入 app 全局的服务器条目 */
  servers: Record<string, McpServerEntry>;
}

function projectRoot(): string {
  // electron-vite 开发时 cwd 一般为仓库根；打包后可回退 process.resourcesPath 旁
  const candidates = [
    process.cwd(),
    join(process.cwd(), ".."),
    join(__dirname, "..", "..", ".."),
    join(__dirname, "..", "..", "..", ".."),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "extensions", "mcp"))) return c;
  }
  return process.cwd();
}

export function getBundledMcpExtensionsDir(): string {
  return join(projectRoot(), "extensions", "mcp");
}

function parseModes(raw: unknown): WelcomeMode[] {
  if (!Array.isArray(raw)) return ["coding"];
  return raw
    .map(String).map(value => value.trim())
    .filter((s): s is WelcomeMode => s === "working" || s === "coding" || s === "general");
}

export function listBundledMcpExtensions(): BundledMcpExtension[] {
  const root = getBundledMcpExtensionsDir();
  if (!existsSync(root)) return [];
  const out: BundledMcpExtension[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const metaPath = join(dir, "extension-meta.json");
    const mcpPath = join(dir, "mcp.json");
    if (!existsSync(metaPath) || !existsSync(mcpPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
      const mcp = JSON.parse(readFileSync(mcpPath, "utf-8")) as {
        mcpServers?: Record<string, McpServerEntry>;
      };
      const servers = mcp.mcpServers ?? {};
      if (!Object.keys(servers).length) continue;
      const modes = parseModes(meta.modes);
      // 保证 servers 带 modes
      const withModes: Record<string, McpServerEntry> = {};
      for (const [k, v] of Object.entries(servers)) {
        withModes[k] = {
          ...v,
          modes: Array.isArray(v.modes) && v.modes.length ? v.modes : modes,
        };
      }
      out.push({
        id: String(meta.id ?? name),
        name: String(meta.name ?? name),
        description: String(meta.description ?? ""),
        version: meta.version ? String(meta.version) : undefined,
        modes,
        homepage: meta.homepage ? String(meta.homepage) : undefined,
        installHints: Array.isArray(meta.installHints)
          ? meta.installHints.map(String)
          : [],
        sourcePath: dir,
        servers: withModes,
      });
    } catch (err) {
      console.warn("[BundledMcpExtensions] skip", dir, err);
    }
  }
  return out;
}
