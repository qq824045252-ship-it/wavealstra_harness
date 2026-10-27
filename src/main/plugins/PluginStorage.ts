import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PluginStoragePathsDto } from "../../shared/plugin-storage";
import { parseJsonc } from "../../shared/jsonc";
import { directorySymlinkType, parentTraversalPrefix, resolvedPathKey } from "../platform/paths";

const DIRECTORY_NAMES = ["skills", "experts", "connectors", "agents", "prompts", "extensions", "expert-market", "connector-market"] as const;
const MCP_FILES = ["mcp.json", "mcp-cache.json", "mcp-native-auth.encrypted.json", "mcp-native-refresh-locks", "mcp-native.log", "mcp-native.log.1"];
const MARKET_FILES = ["market-hidden-skills.json", "market-hidden-experts.json", "market-hidden-connectors.json"];
const cache = new Map<string, PluginStoragePathsDto>();

export function pluginStoragePaths(myBuddyDir: string): PluginStoragePathsDto {
  const root = join(resolve(myBuddyDir), "plugins");
  return {
    root, skills: join(root, "skills"), experts: join(root, "experts"), connectors: join(root, "connectors"),
    agents: join(root, "agents"), prompts: join(root, "prompts"), extensions: join(root, "extensions"),
    expertMarket: join(root, "expert-market"), connectorMarket: join(root, "connector-market"),
    mcp: join(root, "mcp"), mcpConfig: join(root, "mcp", "mcp.json"),
  };
}

/** Rebase only known installed-resource path segments, including escaped Windows paths in JSON. */
export function rebasePluginReferences(text: string): string {
  return text.replace(/\.mybuddy([/\\]+)(skills|experts|connectors|agents|prompts|extensions|expert-market|connector-market)(?=[/\\])/g,
    (_match, separator: string, category: string) => `.mybuddy${separator}plugins${separator}${category}`);
}

/** Same-volume moves; existing destination content wins and every conflict is retained under the plugin root. */
export function migratePluginStorage(myBuddyDir: string): PluginStoragePathsDto {
  const paths = pluginStoragePaths(myBuddyDir);
  mkdirSync(paths.root, { recursive: true });
  const lock = join(paths.root, ".storage-migration.lock");
  const token = randomUUID();
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token }), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = JSON.parse(readFileSync(lock, "utf8")) as { pid: number };
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("插件目录迁移锁无效，请检查 " + lock);
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (cause) { alive = (cause as NodeJS.ErrnoException).code !== "ESRCH"; }
    if (alive) throw new Error("另一个进程正在迁移插件目录，请稍后重试");
    unlinkSync(lock);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token }), { flag: "wx" });
  }
  try { return migratePluginStorageUnlocked(myBuddyDir); }
  finally {
    if (JSON.parse(readFileSync(lock, "utf8")).token === token) unlinkSync(lock);
  }
}

function migratePluginStorageUnlocked(myBuddyDir: string): PluginStoragePathsDto {
  const base = resolve(myBuddyDir);
  const paths = pluginStoragePaths(base);
  mkdirSync(paths.root, { recursive: true });
  const marker = join(paths.root, ".storage-v1.json");
  const moves = [
    ...DIRECTORY_NAMES.map(name => [join(base, name), join(paths.root, name)] as const),
    ...MCP_FILES.map(name => [join(base, name), join(paths.mcp, name)] as const),
    ...MARKET_FILES.map(name => [join(base, name), join(paths.root, name)] as const),
  ];
  const exists = (path: string): boolean => { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
  if (existsSync(marker) && !moves.some(([source]) => exists(source))) {
    const saved = JSON.parse(readFileSync(marker, "utf8")) as { backupPath?: string };
    return { ...paths, ...(saved.backupPath ? { backupPath: saved.backupPath } : {}) };
  }
  const backupPath = join(paths.root, ".migration-backup", `${Date.now()}-${randomUUID().slice(0, 8)}`);
  let backedUp = false;
  const assertOwned = (path: string): void => {
    const rel = relative(base, resolve(path));
    if (!rel || rel === ".." || rel.startsWith(parentTraversalPrefix()) || isAbsolute(rel)) throw new Error(`插件迁移路径超出数据目录: ${path}`);
  };
  const move = (source: string, target: string): void => {
    assertOwned(source); assertOwned(target);
    if (!exists(source)) return;
    mkdirSync(dirname(target), { recursive: true });
    if (!exists(target)) { renameSync(source, target); return; }
    if (source === join(base, "mcp.json")) {
      const readConfig = (path: string): Record<string, unknown> => {
        const config = parseJsonc(readFileSync(path, "utf8"));
        if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`MCP 迁移需要有效的 JSON 对象: ${path}`);
        return config as Record<string, unknown>;
      };
      const oldConfig = readConfig(source), newConfig = readConfig(target);
      const servers = (config: Record<string, unknown>): Record<string, unknown> => {
        const entries = config.mcpServers ?? config["mcp-servers"] ?? {};
        if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("MCP 迁移的 mcpServers 必须是对象");
        return entries as Record<string, unknown>;
      };
      const merged: Record<string, unknown> = { ...oldConfig, ...newConfig, mcpServers: { ...servers(oldConfig), ...servers(newConfig) } };
      delete merged["mcp-servers"];
      if (Array.isArray(oldConfig.imports) || Array.isArray(newConfig.imports)) merged.imports = [...new Set([...(Array.isArray(oldConfig.imports) ? oldConfig.imports : []), ...(Array.isArray(newConfig.imports) ? newConfig.imports : [])])];
      if (oldConfig.settings || newConfig.settings) merged.settings = { ...(oldConfig.settings as object ?? {}), ...(newConfig.settings as object ?? {}) };
      const backup = join(backupPath, "destination", "mcp.json");
      mkdirSync(dirname(backup), { recursive: true }); copyFileSync(target, backup); backedUp = true;
      const temp = `${target}.plugin-migration-${process.pid}`;
      writeFileSync(temp, JSON.stringify(merged, null, 2) + "\n", "utf8"); renameSync(temp, target);
    }
    const srcStat = lstatSync(source), dstStat = lstatSync(target);
    if (srcStat.isDirectory() && !srcStat.isSymbolicLink() && dstStat.isDirectory() && !dstStat.isSymbolicLink()) {
      for (const name of readdirSync(source)) move(join(source, name), join(target, name));
      rmdirSync(source); // Only empty directories; no recursive deletion.
    } else {
      const backup = join(backupPath, "conflicts", relative(base, source));
      mkdirSync(dirname(backup), { recursive: true });
      renameSync(source, backup);
      backedUp = true;
    }
  };
  for (const [source, target] of moves) move(source, target);

  // Retarget existing CLI projections of MyBuddy Skills. CLI-owned folders/links are preserved.
  const linkBackups: { path: string; before: string; after: string }[] = [];
  const normalize = (path: string): string => resolvedPathKey(path);
  const legacySkills = join(base, "skills");
  for (const cli of [".agents", ".codex", ".claude", ".hermes"]) {
    const cliRoot = join(dirname(base), cli, "skills");
    if (!exists(cliRoot) || lstatSync(cliRoot).isSymbolicLink() || !lstatSync(cliRoot).isDirectory()) continue;
    for (const name of readdirSync(cliRoot)) {
      const link = join(cliRoot, name);
      if (!lstatSync(link).isSymbolicLink()) continue;
      const before = readlinkSync(link);
      if (normalize(resolve(cliRoot, before)) !== normalize(join(legacySkills, name))) continue;
      const after = join(paths.skills, name);
      if (!exists(after)) continue;
      linkBackups.push({ path: link, before, after });
      mkdirSync(backupPath, { recursive: true });
      writeFileSync(join(backupPath, "cli-links.json"), JSON.stringify(linkBackups, null, 2), "utf8");
      backedUp = true;
      unlinkSync(link);
      try { symlinkSync(after, link, directorySymlinkType()); }
      catch (error) { symlinkSync(before, link, directorySymlinkType()); throw error; }
    }
  }

  // Installed Skill instructions/scripts and MCP commands may contain the old absolute path.
  // Preserve originals before changing only those references. Never follow user directory links.
  const ignored = new Set([".git", ".venv", "venv", "node_modules", "__pycache__", "vendor", ".migration-backup"]);
  const rewriteReferences = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { rewriteReferences(path); continue; }
      if (!/\.(?:md|json|js|mjs|cjs|ts|py|ps1|cmd|bat|sh)$/i.test(entry.name) || lstatSync(path).size > 1024 * 1024) continue;
      const before = readFileSync(path, "utf8");
      const after = rebasePluginReferences(before);
      if (before === after) continue;
      const backup = join(backupPath, "references", relative(paths.root, path));
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(path, backup);
      backedUp = true;
      const temp = `${path}.plugin-migration-${process.pid}`;
      writeFileSync(temp, after, { encoding: "utf8", mode: lstatSync(path).mode });
      renameSync(temp, path);
    }
  };
  rewriteReferences(paths.root);
  const result = { ...paths, ...(backedUp ? { backupPath } : {}) };
  const temporary = `${marker}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, migratedAt: new Date().toISOString(), backupPath: result.backupPath }, null, 2), "utf8");
  renameSync(temporary, marker);
  return result;
}

export function getPluginStorage(myBuddyDir = join(homedir(), ".mybuddy")): PluginStoragePathsDto {
  const key = resolve(myBuddyDir);
  let paths = cache.get(key);
  if (!paths) { paths = migratePluginStorage(key); cache.set(key, paths); }
  return paths;
}

export function getPluginDirectory(name: typeof DIRECTORY_NAMES[number] | "mcp", myBuddyDir?: string): string {
  const dir = join(getPluginStorage(myBuddyDir).root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
