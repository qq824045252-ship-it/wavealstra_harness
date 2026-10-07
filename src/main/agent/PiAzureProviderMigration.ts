import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { FileAuthStorageBackend } from "@earendil-works/pi-coding-agent";

const LEGACY = "azure-openai-responses";
const CURRENT = "azure";
const BACKUP_SUFFIX = ".pre-pi104-azure.bak";
type JsonRecord = Record<string, unknown>;
const object = (value: unknown): value is JsonRecord => !!value && typeof value === "object" && !Array.isArray(value);
const modelReference = (value: unknown): unknown => typeof value === "string" && value.startsWith(`${LEGACY}/`)
  ? `${CURRENT}${value.slice(LEGACY.length)}` : value;

function renameKeys(value: unknown, rename: (key: string) => string): unknown {
  if (!object(value)) return value;
  const next = { ...value };
  for (const [key, entry] of Object.entries(value)) {
    const renamed = rename(key);
    if (renamed === key) continue;
    if (Object.hasOwn(value, renamed) && !isDeepStrictEqual(value[renamed], entry)) {
      throw new Error(`Pi Azure 配置同时包含不同的 ${key} 与 ${renamed}；请先合并这两项`);
    }
    next[renamed] = entry;
    delete next[key];
  }
  return next;
}

/** Rename only persisted selection fields. The API ID and historical messages keep their meaning. */
export function migrateAzureSelections(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(migrateAzureSelections);
  if (!object(value)) return value;
  const next: JsonRecord = { ...value };
  for (const [key, entry] of Object.entries(value)) {
    if (["defaultProvider", "providerId"].includes(key)) next[key] = entry === LEGACY ? CURRENT : entry;
    else if (["defaultModelId", "defaultModel", "modelId", "suggestedModelId", "transportThinkingModelId"].includes(key)) next[key] = modelReference(entry);
    else if (key === "enabledModels" && Array.isArray(entry)) next[key] = entry.map(modelReference);
    else if (["modelThinkingLevels", "modelPreferences", "legacyModelPreferences"].includes(key)) next[key] = renameKeys(entry, key => modelReference(key) as string);
    else if (key === "pausedProviderModels") {
      const selections = object(entry) ? Object.fromEntries(Object.entries(entry).map(([provider, models]) => [provider,
        Array.isArray(models) ? models.map(modelReference) : models])) : entry;
      next[key] = renameKeys(selections, key => key === LEGACY ? CURRENT : key);
    } else if (object(entry) || Array.isArray(entry)) next[key] = migrateAzureSelections(entry);
  }
  return next;
}

export function migrateAzureProviderDocument(kind: "auth" | "models" | "settings", value: unknown): unknown {
  if (!object(value)) throw new Error("Pi Azure 迁移需要 JSON 对象");
  if (kind === "auth") return renameKeys(value, key => key === LEGACY ? CURRENT : key);
  if (kind === "models") return { ...value, providers: renameKeys(value.providers, key => key === LEGACY ? CURRENT : key) };
  return migrateAzureSelections(value);
}

function backup(path: string, original: string): void {
  // auth/models may contain secrets. Never print contents or replace the first backup.
  if (!existsSync(path + BACKUP_SUFFIX)) writeFileSync(path + BACKUP_SUFFIX, original, { flag: "wx", mode: 0o600 });
}

function writeAtomic(path: string, original: string, next: string): void {
  if (readFileSync(path, "utf8") !== original) throw new Error(`Pi Azure 迁移时配置已被修改：${path}`);
  backup(path, original);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, next, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Run before ModelRuntime reads auth/models/settings. Backups and the migration are idempotent. */
export function migratePiAzureProvider(agentDir: string, db: Database.Database): { files: number; selections: number } {
  const taskCwds = db.prepare("SELECT DISTINCT cwd FROM tasks WHERE cwd IS NOT NULL").all() as Array<{ cwd: string }>;
  const settingsPaths = new Set([join(agentDir, "settings.json"), join(agentDir, "subagent.json")]);
  for (const { cwd } of taskCwds) settingsPaths.add(join(resolve(cwd), ".pi", "settings.json"));
  const modes = join(agentDir, "modes");
  if (existsSync(modes)) for (const entry of readdirSync(modes, { withFileTypes: true })) {
    if (entry.isDirectory()) settingsPaths.add(join(modes, entry.name, "policy.json"));
  }
  const paths: Array<{ path: string; kind: "auth" | "models" | "settings" }> = [
    { path: join(agentDir, "auth.json"), kind: "auth" }, { path: join(agentDir, "models.json"), kind: "models" },
    ...[...settingsPaths].map(path => ({ path, kind: "settings" as const })),
  ];
  // Validate every document before modifying any file; conflicting new credentials are never overwritten.
  const planned: Array<{ path: string; kind: string; original: string; next: string }> = [];
  for (const { path, kind } of paths) {
    if (!existsSync(path)) continue;
    const original = readFileSync(path, "utf8");
    if (!original.includes(LEGACY)) continue;
    const before: unknown = JSON.parse(original);
    const after = migrateAzureProviderDocument(kind, before);
    if (!isDeepStrictEqual(before, after)) planned.push({ path, kind, original, next: JSON.stringify(after, null, 2) + "\n" });
  }
  for (const entry of planned) {
    if (entry.kind === "auth") {
      new FileAuthStorageBackend(entry.path).withLock(current => {
        if (current !== entry.original) throw new Error("Pi Azure 迁移时登录凭据已变化，请重新启动");
        backup(entry.path, current);
        return { result: undefined, next: entry.next };
      });
    } else writeAtomic(entry.path, entry.original, entry.next);
  }
  // Only future execution selections change; usage attribution and session transcripts are immutable.
  const selections = db.transaction(() => {
    let count = 0;
    for (const table of ["tasks", "cron_jobs"]) count += db.prepare(
      `UPDATE ${table} SET model_id = ? || substr(model_id, ?) WHERE substr(model_id, 1, ?) = ?`,
    ).run(CURRENT, LEGACY.length + 1, LEGACY.length + 1, LEGACY + "/").changes;
    return count;
  })();
  return { files: planned.length, selections };
}
