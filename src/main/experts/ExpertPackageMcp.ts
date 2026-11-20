import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type JSZip from "jszip";
import { parseJsonc } from "../../shared/jsonc";
import type { McpServerEntry } from "../mcp/McpConfigService";

function dependencyPath(manifest: string | undefined): { path: string; required: boolean } {
  let plugin: { dependencies?: { mcpServers?: unknown } } | null = null;
  if (manifest) {
    try { plugin = JSON.parse(manifest); } catch { /* Expert metadata is optional. */ }
  }
  const declared = plugin?.dependencies?.mcpServers;
  if (declared === undefined) return { path: ".mcp.json", required: false };
  if (typeof declared !== "string") throw new Error("专家包的 dependencies.mcpServers 必须是相对文件路径");
  const parts = declared.trim().replace(/\\/g, "/").split("/").filter(part => part !== ".");
  if (!parts.length || parts.some(part => !part || /[<>:"|?*\u0000-\u001f]|[. ]$/.test(part))) {
    throw new Error("专家包的 MCP 配置路径必须位于包内");
  }
  return { path: parts.join("/"), required: true };
}

function parseServers(text: string, path: string): Record<string, McpServerEntry> {
  let parsed: unknown;
  try { parsed = parseJsonc(text); } catch { throw new Error(`专家包的 MCP 配置不是有效 JSON：${path}`); }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(`专家包的 MCP 配置必须包含 mcpServers 对象：${path}`);
  }
  return Object.fromEntries(Object.entries(servers).map(([name, entry]) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`专家包的 MCP 配置项必须是对象：${name}`);
    const { "x-workbuddy": workbuddy, ...config } = entry as McpServerEntry;
    if (config.type === "streamableHttp") config.type = "http";
    const workbuddyAuth = workbuddy as { auth?: { type?: unknown } } | undefined;
    if (workbuddyAuth?.auth?.type === "oauth" && config.auth === undefined && config.oauth === undefined) {
      config.auth = "oauth";
    }
    return [name, config];
  }));
}

export async function readExpertZipMcp(zip: JSZip, prefix: string, manifest?: string): Promise<Record<string, McpServerEntry>> {
  const { path, required } = dependencyPath(manifest);
  const key = prefix + path;
  const file = zip.file(key);
  if (!file) {
    if (required) throw new Error(`专家包缺少声明的 MCP 配置：${path}`);
    return {};
  }
  if (file.unsafeOriginalName && file.unsafeOriginalName !== key) throw new Error("专家包的 MCP 配置路径必须位于包内");
  return parseServers(await file.async("string"), path);
}

export function readExpertFolderMcp(folder: string, manifest?: string): Record<string, McpServerEntry> {
  const { path, required } = dependencyPath(manifest);
  const candidate = join(folder, path);
  if (!existsSync(candidate)) {
    if (required) throw new Error(`专家包缺少声明的 MCP 配置：${path}`);
    return {};
  }
  const file = realpathSync(candidate);
  const localPath = relative(realpathSync(folder), file);
  if (!localPath || isAbsolute(localPath) || localPath === ".." || localPath.startsWith(`..${sep}`) || !statSync(file).isFile()) {
    throw new Error("专家包的 MCP 配置必须是包内文件");
  }
  return parseServers(readFileSync(file, "utf-8"), path);
}
