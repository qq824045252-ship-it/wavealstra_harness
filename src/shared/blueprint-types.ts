/** Blueprint shared schema. Definition JSON is validated independently from the database schema. */

import type { GadgetManifest, GadgetScope, GadgetSourceFile } from "./gadget-types";
import { normalizeJsonRecord } from "./gadget-types";
import type { TemplateCapabilityRegistries } from "./project-template/types";
import { assertBlueprintSecretFree, isBlueprintSensitivePath } from "./blueprint-secret-policy";

export const BLUEPRINT_DEFINITION_SCHEMA_VERSION = 1;
export const BLUEPRINT_MAX_WORKSPACE_DEPTH = 16;
export const BLUEPRINT_MAX_WORKSPACES = 128;
export const BLUEPRINT_MAX_TASKS = 512;
export const BLUEPRINT_MAX_GADGETS = 128;
export const BLUEPRINT_MAX_FILES = 512;
export const BLUEPRINT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const BLUEPRINT_MAX_TOTAL_FILE_BYTES = 20 * 1024 * 1024;
export const BLUEPRINT_MAX_DEFINITION_BYTES = 24 * 1024 * 1024;
export const BLUEPRINT_MAX_CONTEXT_CHARS = 6_000;

export type BlueprintKind = "workspace" | "gadget" | "composite";

export interface BlueprintCapabilityReferences {
  experts?: string[];
  skills?: string[];
  connectors?: string[];
  mcps?: string[];
}

export interface BlueprintLibraryBinding {
  librarySpaceId: string;
  optional?: boolean;
}

export interface BlueprintFile {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

export interface BlueprintTaskDefinition {
  key: string;
  title: string;
  status?: string;
  welcomeMode?: "working" | "coding" | "general";
}

export interface BlueprintGadgetDefinition {
  key: string;
  name: string;
  description?: string;
  manifest: GadgetManifest;
  sourceFiles: GadgetSourceFile[];
  metadata?: Record<string, unknown>;
  workspaceKey?: string;
  taskKey?: string;
  scopeType?: "global" | "workspace" | "task";
}

export interface WorkspaceBlueprintNode {
  key: string;
  name: string;
  children?: WorkspaceBlueprintNode[];
  defaultContext?: string;
  libraryBindings?: BlueprintLibraryBinding[];
  files?: BlueprintFile[];
  tasks?: BlueprintTaskDefinition[];
  gadgets?: BlueprintGadgetDefinition[];
}

interface BlueprintDefinitionBase {
  schemaVersion: number;
  kind: BlueprintKind;
  capabilities?: BlueprintCapabilityReferences;
}

export interface WorkspaceBlueprintDefinition extends BlueprintDefinitionBase {
  kind: "workspace";
  workspace: WorkspaceBlueprintNode;
}

export interface GadgetBlueprintDefinition extends BlueprintDefinitionBase {
  kind: "gadget";
  gadget: BlueprintGadgetDefinition;
}

export interface CompositeBlueprintDefinition extends BlueprintDefinitionBase {
  kind: "composite";
  workspace?: WorkspaceBlueprintNode;
  gadgets?: BlueprintGadgetDefinition[];
}

export type BlueprintDefinition =
  | WorkspaceBlueprintDefinition
  | GadgetBlueprintDefinition
  | CompositeBlueprintDefinition;

export interface BlueprintDescriptor {
  id: string;
  name: string;
  description?: string;
  kind: BlueprintKind;
  schemaVersion: number;
  definition: BlueprintDefinition;
  createdAt: number;
  updatedAt: number;
}

export interface BlueprintCreateRequest {
  name: string;
  description?: string;
  definition: BlueprintDefinition;
}

export interface BlueprintUpdateRequest {
  blueprintId: string;
  name?: string;
  description?: string | null;
  definition?: BlueprintDefinition;
}

export interface BlueprintResolvedCapabilities {
  experts: string[];
  skills: string[];
  connectors: string[];
  mcps: string[];
}

export interface ResolvedBlueprint {
  definition: BlueprintDefinition;
  resolved: BlueprintResolvedCapabilities;
  missing: BlueprintResolvedCapabilities;
  warnings: string[];
}

export interface BlueprintWorkspacePlanItem {
  key: string;
  name: string;
  parentKey?: string;
  defaultContext?: string;
}

export interface BlueprintTaskPlanItem extends BlueprintTaskDefinition {
  workspaceKey: string;
}

export interface BlueprintFilePlanItem extends BlueprintFile {
  workspaceKey: string;
}

export interface BlueprintLibraryBindingPlanItem extends BlueprintLibraryBinding {
  workspaceKey: string;
}

export interface BlueprintGadgetPlanItem extends BlueprintGadgetDefinition {
  targetScopeType: "global" | "workspace" | "task";
}

export interface BlueprintInstantiationPlan {
  kind: BlueprintKind;
  workspaces: BlueprintWorkspacePlanItem[];
  tasks: BlueprintTaskPlanItem[];
  files: BlueprintFilePlanItem[];
  libraryBindings: BlueprintLibraryBindingPlanItem[];
  gadgets: BlueprintGadgetPlanItem[];
  missing: BlueprintResolvedCapabilities;
  warnings: string[];
}

export interface BlueprintInstantiateRequest {
  blueprintId: string;
  rootName?: string;
  gadgetScope?: GadgetScope;
  registries?: TemplateCapabilityRegistries;
}

export interface BlueprintInstantiationResult {
  blueprintId: string;
  workspaceIdsByKey: Record<string, string>;
  taskIdsByKey: Record<string, string>;
  gadgetIdsByKey: Record<string, string>;
  warnings: string[];
  missing: BlueprintResolvedCapabilities;
}

export interface BlueprintCaptureOptions {
  name: string;
  description?: string;
  includeChildren?: boolean;
  includeTasks?: boolean;
  includeGadgets?: boolean;
  /** Shared context content is opt-in because it may contain business facts. */
  includeContext?: boolean;
  selectedFiles?: string[];
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

interface BlueprintValidationBudget {
  workspaces: number;
  tasks: number;
  gadgets: number;
  files: number;
  totalFileBytes: number;
}

function requireString(value: unknown, label: string, maxChars = 512): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 不能为空`);
  const result = value.trim();
  if (result.length > maxChars) throw new Error(`${label} 不能超过 ${maxChars} 字符`);
  return result;
}

function requireContent(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} 必须是字符串`);
  return value;
}

function base64ByteLength(value: string, label: string): number {
  if (!value) return 0;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} 必须是规范 base64`);
  }
  return (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
}

function decodedBase64Text(value: string): string | null {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function consumeFileBudget(content: string, encoding: "utf8" | "base64", label: string, budget: BlueprintValidationBudget): void {
  const bytes = encoding === "base64" ? base64ByteLength(content, label) : new TextEncoder().encode(content).byteLength;
  if (bytes > BLUEPRINT_MAX_FILE_BYTES) throw new Error(`${label} 超过单文件大小限制`);
  budget.files += 1;
  budget.totalFileBytes += bytes;
  if (budget.files > BLUEPRINT_MAX_FILES) throw new Error(`Blueprint 文件数量不能超过 ${BLUEPRINT_MAX_FILES}`);
  if (budget.totalFileBytes > BLUEPRINT_MAX_TOTAL_FILE_BYTES) throw new Error("Blueprint 文件总大小超过限制");
  if (encoding === "base64") {
    const decoded = decodedBase64Text(content);
    if (decoded !== null) assertBlueprintSecretFree(decoded);
  }
}

function optionalArray(owner: Record<string, unknown>, key: string, label: string): unknown[] | undefined {
  const value = owner[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  return value;
}

function validateEncoding(value: unknown, label: string): "utf8" | "base64" {
  if (value === undefined || value === "utf8") return "utf8";
  if (value === "base64") return "base64";
  throw new Error(`${label} 只能是 utf8 或 base64`);
}

function validateRelativePath(value: unknown, label: string): string {
  const path = requireString(value, label).replaceAll("\\", "/");
  if (
    path.startsWith("/") || /^[a-zA-Z]:/.test(path) || path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..") || isBlueprintSensitivePath(path)
  ) throw new Error(`${label} 必须是符合 Blueprint 白名单的安全相对路径`);
  return path;
}

function validateWorkspaceNode(
  value: unknown,
  seen: Set<string>,
  budget: BlueprintValidationBudget,
  depth = 1,
): WorkspaceBlueprintNode {
  if (depth > BLUEPRINT_MAX_WORKSPACE_DEPTH) throw new Error(`Blueprint Workspace 深度不能超过 ${BLUEPRINT_MAX_WORKSPACE_DEPTH}`);
  budget.workspaces += 1;
  if (budget.workspaces > BLUEPRINT_MAX_WORKSPACES) throw new Error(`Blueprint Workspace 数量不能超过 ${BLUEPRINT_MAX_WORKSPACES}`);
  const node = requireObject(value, "Workspace Blueprint node");
  const key = requireString(node.key, "Workspace node key");
  if (seen.has(key)) throw new Error(`Blueprint key 重复：${key}`);
  seen.add(key);
  const name = requireString(node.name, "Workspace node name", 240);
  const childrenRaw = optionalArray(node, "children", "Workspace children");
  const children = childrenRaw?.map((child) => validateWorkspaceNode(child, seen, budget, depth + 1));
  const filesRaw = optionalArray(node, "files", "Workspace files");
  const filePaths = new Set<string>();
  const files = filesRaw
    ? filesRaw.map((raw) => {
        const file = requireObject(raw, "Blueprint file");
        const path = validateRelativePath(file.path, "Blueprint file path");
        const pathKey = path.toLocaleLowerCase();
        if (filePaths.has(pathKey)) throw new Error(`Blueprint file path 重复：${path}`);
        filePaths.add(pathKey);
        const content = requireContent(file.content, "Blueprint file content");
        const encoding = validateEncoding(file.encoding, "Blueprint file encoding");
        consumeFileBudget(content, encoding, `Blueprint file ${path}`, budget);
        return { path, content, encoding };
      })
    : undefined;
  const tasksRaw = optionalArray(node, "tasks", "Workspace tasks");
  const tasks: BlueprintTaskDefinition[] | undefined = tasksRaw
    ? tasksRaw.map((raw) => {
        const task = requireObject(raw, "Blueprint task");
        budget.tasks += 1;
        if (budget.tasks > BLUEPRINT_MAX_TASKS) throw new Error(`Blueprint Task 数量不能超过 ${BLUEPRINT_MAX_TASKS}`);
        const taskKey = requireString(task.key, "Blueprint task key");
        if (seen.has(taskKey)) throw new Error(`Blueprint key 重复：${taskKey}`);
        seen.add(taskKey);
        if (task.status !== undefined && typeof task.status !== "string") throw new Error("Blueprint task status 必须是字符串");
        // Legacy Blueprint files may still use the retired "bot" id.
        const welcomeMode = task.welcomeMode === "bot" ? "general" : task.welcomeMode;
        if (welcomeMode !== undefined && welcomeMode !== "working" && welcomeMode !== "coding" && welcomeMode !== "general") {
          throw new Error("Blueprint task welcomeMode 无效");
        }
        return {
          key: taskKey,
          title: requireString(task.title, "Blueprint task title", 240),
          ...(typeof task.status === "string" ? { status: task.status } : {}),
          ...(welcomeMode === "working" || welcomeMode === "coding" || welcomeMode === "general"
            ? { welcomeMode: welcomeMode as BlueprintTaskDefinition["welcomeMode"] }
            : {}),
        };
      })
    : undefined;
  const bindingsRaw = optionalArray(node, "libraryBindings", "Workspace libraryBindings");
  const libraryBindings = bindingsRaw
    ? bindingsRaw.map((raw) => {
        const binding = requireObject(raw, "Blueprint library binding");
        if (binding.optional !== undefined && typeof binding.optional !== "boolean") throw new Error("Blueprint library binding optional 必须是布尔值");
        return { librarySpaceId: requireString(binding.librarySpaceId, "librarySpaceId"), optional: binding.optional !== false };
      })
    : undefined;
  const gadgetsRaw = optionalArray(node, "gadgets", "Workspace gadgets");
  const gadgets = gadgetsRaw?.map((raw) => validateGadgetDefinition(raw, seen, budget));
  if (node.defaultContext !== undefined && typeof node.defaultContext !== "string") throw new Error("Workspace defaultContext 必须是字符串");
  if (typeof node.defaultContext === "string" && node.defaultContext.length > BLUEPRINT_MAX_CONTEXT_CHARS) {
    throw new Error(`Workspace defaultContext 不能超过 ${BLUEPRINT_MAX_CONTEXT_CHARS} 字符`);
  }
  return {
    key,
    name,
    ...(children?.length ? { children } : {}),
    ...(typeof node.defaultContext === "string" && node.defaultContext.trim() ? { defaultContext: node.defaultContext } : {}),
    ...(libraryBindings?.length ? { libraryBindings } : {}),
    ...(files?.length ? { files } : {}),
    ...(tasks?.length ? { tasks } : {}),
    ...(gadgets?.length ? { gadgets } : {}),
  };
}

function validateGadgetDefinition(value: unknown, seen: Set<string>, budget: BlueprintValidationBudget): BlueprintGadgetDefinition {
  budget.gadgets += 1;
  if (budget.gadgets > BLUEPRINT_MAX_GADGETS) throw new Error(`Blueprint Gadget 数量不能超过 ${BLUEPRINT_MAX_GADGETS}`);
  const gadget = requireObject(value, "Blueprint gadget");
  const key = requireString(gadget.key, "Blueprint gadget key");
  if (seen.has(key)) throw new Error(`Blueprint key 重复：${key}`);
  seen.add(key);
  const manifestRaw = requireObject(gadget.manifest, "Blueprint gadget manifest");
  const defaultConfig = manifestRaw.defaultConfig === undefined
    ? undefined
    : normalizeJsonRecord(manifestRaw.defaultConfig, "Gadget defaultConfig");
  const manifest: GadgetManifest = {
    schemaVersion: Number(manifestRaw.schemaVersion),
    name: requireString(manifestRaw.name, "Gadget manifest name"),
    type: manifestRaw.type === "web" ? "web" : (() => { throw new Error("当前仅支持 web Gadget"); })(),
    entry: validateRelativePath(manifestRaw.entry, "Gadget manifest entry"),
    ...(defaultConfig ? { defaultConfig } : {}),
  };
  if (manifest.schemaVersion !== 1) throw new Error(`不支持的 Gadget manifest 版本：${manifest.schemaVersion}`);
  const sourceFilesRaw = optionalArray(gadget, "sourceFiles", "Gadget sourceFiles");
  if (!sourceFilesRaw) throw new Error("Gadget sourceFiles 必须存在");
  const sourcePaths = new Set<string>();
  const sourceFiles = sourceFilesRaw.map((raw) => {
    const file = requireObject(raw, "Gadget source file");
    const path = validateRelativePath(file.path, "Gadget source path");
    const pathKey = path.toLocaleLowerCase();
    if (sourcePaths.has(pathKey)) throw new Error(`Gadget source path 重复：${path}`);
    sourcePaths.add(pathKey);
    const content = requireContent(file.content, "Gadget source content");
    const encoding = validateEncoding(file.encoding, "Gadget source encoding");
    consumeFileBudget(content, encoding, `Gadget source ${path}`, budget);
    return { path, content, encoding };
  });
  if (!sourceFiles.some((file) => file.path === manifest.entry)) throw new Error(`Gadget Blueprint 缺少入口文件：${manifest.entry}`);
  if (gadget.description !== undefined && typeof gadget.description !== "string") throw new Error("Blueprint gadget description 必须是字符串");
  const metadata = gadget.metadata === undefined ? undefined : normalizeJsonRecord(gadget.metadata, "Blueprint gadget metadata");
  if (gadget.workspaceKey !== undefined && typeof gadget.workspaceKey !== "string") throw new Error("Blueprint gadget workspaceKey 必须是字符串");
  if (gadget.taskKey !== undefined && typeof gadget.taskKey !== "string") throw new Error("Blueprint gadget taskKey 必须是字符串");
  if (gadget.scopeType !== undefined && gadget.scopeType !== "global" && gadget.scopeType !== "workspace" && gadget.scopeType !== "task") {
    throw new Error("Blueprint gadget scopeType 无效");
  }
  return {
    key,
    name: requireString(gadget.name, "Blueprint gadget name"),
    manifest,
    sourceFiles,
    ...(typeof gadget.description === "string" ? { description: gadget.description } : {}),
    ...(metadata ? { metadata } : {}),
    ...(typeof gadget.workspaceKey === "string" ? { workspaceKey: requireString(gadget.workspaceKey, "workspaceKey") } : {}),
    ...(typeof gadget.taskKey === "string" ? { taskKey: requireString(gadget.taskKey, "taskKey") } : {}),
    ...(gadget.scopeType === "global" || gadget.scopeType === "workspace" || gadget.scopeType === "task"
      ? { scopeType: gadget.scopeType }
      : {}),
  };
}

export function normalizeBlueprintDefinition(value: unknown): BlueprintDefinition {
  const raw = requireObject(value, "Blueprint definition");
  if (Number(raw.schemaVersion) !== BLUEPRINT_DEFINITION_SCHEMA_VERSION) {
    throw new Error(`不支持的 Blueprint schemaVersion：${String(raw.schemaVersion)}`);
  }
  if (raw.kind !== "workspace" && raw.kind !== "gadget" && raw.kind !== "composite") {
    throw new Error("Blueprint kind 必须是 workspace、gadget 或 composite");
  }
  const seen = new Set<string>();
  const budget: BlueprintValidationBudget = { workspaces: 0, tasks: 0, gadgets: 0, files: 0, totalFileBytes: 0 };
  const capabilities = validateCapabilities(raw.capabilities);
  const base = { schemaVersion: BLUEPRINT_DEFINITION_SCHEMA_VERSION, capabilities };
  if (raw.kind === "workspace") {
    return ensureDefinitionSafe({ ...base, kind: "workspace", workspace: validateWorkspaceNode(raw.workspace, seen, budget) });
  }
  if (raw.kind === "gadget") {
    return ensureDefinitionSafe({ ...base, kind: "gadget", gadget: validateGadgetDefinition(raw.gadget, seen, budget) });
  }
  const workspace = raw.workspace === undefined ? undefined : validateWorkspaceNode(raw.workspace, seen, budget);
  const gadgetsRaw = optionalArray(raw, "gadgets", "Composite gadgets");
  const gadgets = gadgetsRaw?.map((gadget) => validateGadgetDefinition(gadget, seen, budget));
  if (!workspace && !gadgets?.length) throw new Error("Composite Blueprint 至少需要 workspace 或 gadget");
  return ensureDefinitionSafe({ ...base, kind: "composite", ...(workspace ? { workspace } : {}), ...(gadgets?.length ? { gadgets } : {}) });
}

function validateCapabilities(value: unknown): BlueprintCapabilityReferences | undefined {
  if (value === undefined) return undefined;
  const raw = requireObject(value, "Blueprint capabilities");
  const normalize = (key: keyof BlueprintCapabilityReferences): string[] | undefined => {
    const items = optionalArray(raw, key, `Blueprint capabilities.${key}`);
    if (!items) return undefined;
    if (items.length > 256) throw new Error(`Blueprint capabilities.${key} 数量不能超过 256`);
    const normalized = items.map((item) => requireString(item, `Blueprint capabilities.${key}`, 256));
    return [...new Map(normalized.map((item) => [item.toLowerCase(), item])).values()];
  };
  const experts = normalize("experts");
  const skills = normalize("skills");
  const connectors = normalize("connectors");
  const mcps = normalize("mcps");
  return {
    ...(experts?.length ? { experts } : {}),
    ...(skills?.length ? { skills } : {}),
    ...(connectors?.length ? { connectors } : {}),
    ...(mcps?.length ? { mcps } : {}),
  };
}

function ensureSecretFree<T extends BlueprintDefinition>(definition: T): T {
  assertBlueprintSecretFree(definition);
  return definition;
}

function ensureDefinitionSafe<T extends BlueprintDefinition>(definition: T): T {
  const safe = ensureSecretFree(definition);
  if (new TextEncoder().encode(JSON.stringify(safe)).byteLength > BLUEPRINT_MAX_DEFINITION_BYTES) {
    throw new Error("Blueprint definition 总大小超过限制");
  }
  return safe;
}
