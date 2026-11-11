/** Gadget shared domain contract. This module is runtime-neutral. */

export const GADGET_MANIFEST_SCHEMA_VERSION = 1;

export type GadgetScope =
  | { type: "global" }
  | { type: "workspace"; workspaceId: string }
  | { type: "task"; taskId: string };

export type GadgetType = "web";
export type GadgetRuntimeStatus = "stopped" | "starting" | "running" | "error";

export interface GadgetManifest {
  schemaVersion: number;
  name: string;
  type: GadgetType;
  entry: string;
  defaultConfig?: Record<string, unknown>;
}

export interface GadgetDescriptor {
  id: string;
  name: string;
  description?: string;
  scope: GadgetScope;
  type: GadgetType;
  manifestPath: string;
  sourcePath: string;
  createdByTaskId?: string;
  blueprintId?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface GadgetRuntimeDiagnostics {
  reason: "explicit_stop" | "restart" | "unexpected_exit" | "startup_failure" | "health_failure";
  occurredAt: number;
  exitedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  stderr?: string;
  pid?: number;
  /** Historical identity only; never a current running URL. */
  url?: string;
  error?: string;
}

export interface GadgetRuntimeState {
  gadgetId: string;
  status: GadgetRuntimeStatus;
  url?: string;
  port?: number;
  pid?: number;
  startedAt?: number;
  error?: string;
  diagnostics?: GadgetRuntimeDiagnostics;
}

export interface GadgetSourceFile {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

export interface GadgetCreateRequest {
  name: string;
  description?: string;
  scope: GadgetScope;
  type?: GadgetType;
  entry?: string;
  files?: GadgetSourceFile[];
  defaultConfig?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdByTaskId?: string;
  blueprintId?: string;
}

export interface GadgetUpdateRequest {
  gadgetId: string;
  name?: string;
  description?: string | null;
  defaultConfig?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

export interface GadgetSourceSnapshot {
  manifest: GadgetManifest;
  files: GadgetSourceFile[];
  revision: string;
}

/** Patch the named source files; all other files and runtime data are retained. */
export interface GadgetSourceUpdateRequest {
  gadgetId: string;
  expectedRevision: string;
  files: GadgetSourceFile[];
}

export interface GadgetListItem extends GadgetDescriptor {
  runtime: GadgetRuntimeState;
  inherited?: boolean;
  inheritedFromWorkspaceId?: string;
}

/** Normalize a record to JSON-safe data so durable manifests/descriptors never diverge from SQLite/JSON truth. */
export function normalizeJsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  const visiting = new Set<object>();
  const visit = (current: unknown, path: string): unknown => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error(`${path} 必须是有限数字`);
      return current;
    }
    if (!current || typeof current !== "object") throw new Error(`${path} 必须是 JSON 值`);
    if (visiting.has(current)) throw new Error(`${path} 不得包含循环引用`);
    visiting.add(current);
    try {
      if (Array.isArray(current)) return current.map((item, index) => visit(item, `${path}[${index}]`));
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} 必须是普通对象`);
      return Object.fromEntries(Object.entries(current).map(([key, child]) => [key, visit(child, `${path}.${key}`)]));
    } finally {
      visiting.delete(current);
    }
  };
  return visit(value, label) as Record<string, unknown>;
}

export function assertGadgetScope(value: unknown): asserts value is GadgetScope {
  if (!value || typeof value !== "object") throw new Error("Gadget scope 无效");
  const scope = value as Record<string, unknown>;
  if (scope.type === "global") {
    if ("workspaceId" in scope || "taskId" in scope) throw new Error("global Gadget 不得携带 scope id");
    return;
  }
  if (scope.type === "workspace") {
    if (typeof scope.workspaceId !== "string" || !scope.workspaceId.trim() || "taskId" in scope) {
      throw new Error("workspace Gadget 必须且只能携带 workspaceId");
    }
    return;
  }
  if (scope.type === "task") {
    if (typeof scope.taskId !== "string" || !scope.taskId.trim() || "workspaceId" in scope) {
      throw new Error("task Gadget 必须且只能携带 taskId");
    }
    return;
  }
  throw new Error("Gadget scope type 必须是 global、workspace 或 task");
}

export function normalizeGadgetManifest(value: unknown): GadgetManifest {
  if (!value || typeof value !== "object") throw new Error("gadget.json 必须是对象");
  const manifest = value as Record<string, unknown>;
  const schemaVersion = Number(manifest.schemaVersion);
  const name = typeof manifest.name === "string" ? manifest.name.trim() : "";
  const entry = typeof manifest.entry === "string" ? manifest.entry.replaceAll("\\", "/").trim() : "";
  if (schemaVersion !== GADGET_MANIFEST_SCHEMA_VERSION) throw new Error(`不支持的 Gadget manifest 版本：${schemaVersion}`);
  if (!name) throw new Error("Gadget manifest name 不能为空");
  if (manifest.type !== "web") throw new Error("当前仅支持 web Gadget");
  if (
    !entry || entry.startsWith("/") || /^[a-zA-Z]:/.test(entry) || entry.includes("\0") ||
    entry.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error("Gadget manifest entry 必须是安全相对路径");
  const defaultConfig = manifest.defaultConfig;
  const normalizedConfig = defaultConfig === undefined ? undefined : normalizeJsonRecord(defaultConfig, "Gadget defaultConfig");
  return {
    schemaVersion,
    name,
    type: "web",
    entry,
    ...(normalizedConfig ? { defaultConfig: normalizedConfig } : {}),
  };
}
