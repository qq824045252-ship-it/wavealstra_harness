/**
 * McpSideEffectPolicy — MCP 副作用声明与本地路径适配（P2 / Batch 11）
 *
 * 默认 unknown + requiresApproval。
 * 显式 McpLocalPathAdapter 优先；providerId="*" 为通用 adapter。
 * 无 adapter 时：工具名/参数像本地写 → 按 unknown 写处理（审批或拒绝），不静默放行。
 */
import { MANAGED_TOOL_PROVIDER_IDS, RETIRED_MANAGED_PROVIDER_IDS } from "../../shared/professional-tools";
import {
  isMyBuddyNativeExtensionToolName,
  NATIVE_CAPABILITY_TOOL_NAMES,
  PI_BUILTIN_TOOL_NAMES,
} from "../../shared/native-tools";

export type McpLocalFileAccess =
  | "none"
  | "read"
  | "task-write"
  | "unrestricted"
  | "unknown";

export type FileAccessOperation =
  | "read"
  | "create"
  | "write"
  | "edit"
  | "delete"
  | "rename"
  | "execute";

export interface McpSideEffectPolicy {
  providerId: string;
  localFileAccess: McpLocalFileAccess;
  externalMutation: boolean;
  supportsRoots: boolean;
  requiresApproval: boolean;
}

export interface McpLocalPathAdapter {
  /** providerId；"*" 匹配任意 provider */
  providerId: string;
  toolName: string;
  operation: FileAccessOperation;
  extractPaths(input: unknown): string[];
}

export interface McpToolGateDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  paths: string[];
  policy: McpSideEffectPolicy;
  /** 是否识别为本地写类工具 */
  isLocalWrite: boolean;
}

/** pi 内置工具（非 MCP）——权威清单见 src/shared/native-tools.ts */
export const BUILTIN_TOOL_NAMES = new Set<string>(PI_BUILTIN_TOOL_NAMES);

/** MyBuddy 自研原生能力工具（非 MCP）——权威清单见 src/shared/native-tools.ts */
const NATIVE_CAPABILITY_TOOL_SET = new Set<string>(NATIVE_CAPABILITY_TOOL_NAMES);

/**
 * 原生（native）CAD 工具前缀：MyBuddy 自研 cad_* 工具不是 MCP，
 * parseMcpToolIdentity 必须放行（否则会被误判为 unknown MCP provider 触发审批）。
 */
export const NATIVE_CAD_TOOL_PREFIX = "cad_";

const BUILTIN_KNOWN_MCP_PROVIDER_IDS = [...MANAGED_TOOL_PROVIDER_IDS, ...RETIRED_MANAGED_PROVIDER_IDS];

function splitKnownMcpProvider(
  rest: string,
  providerIds: readonly string[] = [],
): { providerId: string; shortToolName: string } | undefined {
  const seen = new Set<string>();
  const candidates = [...providerIds, ...BUILTIN_KNOWN_MCP_PROVIDER_IDS]
    .filter((providerId) => {
      if (!providerId || seen.has(providerId)) return false;
      seen.add(providerId);
      return true;
    })
    .map((providerId) => ({ providerId, normalized: providerId.replace(/-/g, "_") }))
    .sort((a, b) => b.normalized.length - a.normalized.length);
  for (const item of candidates) {
    const prefix = `${item.normalized}_`;
    if (!rest.startsWith(prefix)) continue;
    const shortToolName = rest.slice(prefix.length);
    if (!shortToolName) continue;
    return { providerId: item.providerId, shortToolName };
  }
  return undefined;
}

/** 内置保守默认：未知 provider = unknown + 审批 */
export function defaultMcpSideEffectPolicy(providerId: string): McpSideEffectPolicy {
  return {
    providerId,
    localFileAccess: "unknown",
    externalMutation: true,
    supportsRoots: false,
    requiresApproval: true,
  };
}

/**
 * 受管设计 runtime（freecad/blender 等）的 MCP side-effect 策略：
 * 结构化建模工具按任务内写放行（不每步无意义审批）；
 * 危险 escape-hatch 工具（execute_python 等任意代码）由
 * McpSideEffectExtension.dangerousTools 另行强制审批。
 */
export const MANAGED_RUNTIME_TOOL_POLICY: McpSideEffectPolicy = {
  providerId: "",
  localFileAccess: "task-write",
  externalMutation: true,
  supportsRoots: false,
  requiresApproval: false,
};

/**
 * 受管 runtime 的危险工具（providerId → 工具名）：强制审批（escape hatch 语义）。
 * - freecad（blwfish）：execute_python 任意代码执行；restart/stop/reload 影响运行时；
 * - blender（官方 Lab MCP）：execute_blender_code_for_cli 在后台 blender 进程中执行任意
 *   代码（可写任意路径）；execute_blender_code（交互实例主通道）保持 task-write 放行。
 */
export const MANAGED_RUNTIME_DANGEROUS_TOOLS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "freecad",
    new Set([
      "execute_python",
      "execute_python_async",
      "restart_freecad",
      "stop_freecad_instance",
      "reload_modules",
      "cancel_operation",
    ]),
  ],
  [
    "blender",
    new Set([
      "execute_blender_code_for_cli",
    ]),
  ],
]);

/**
 * 注册受管 runtime 的 side-effect 策略（进程级默认 registry 已含）。
 * 统一全部 managed provider（ardot-local/penpot/blender/freecad/opendesign/drawio-ai）：
 * 自动 prewarm/start 本身不是业务写操作；这些 provider 的工具按 task-write 放行，
 * 危险 escape-hatch 工具由 MANAGED_RUNTIME_DANGEROUS_TOOLS 强制审批。
 */
export function registerManagedRuntimePolicies(registry: McpSideEffectRegistry): void {
  for (const providerId of MANAGED_TOOL_PROVIDER_IDS) {
    registry.registerPolicy({ ...MANAGED_RUNTIME_TOOL_POLICY, providerId });
  }
}

/**
 * 从 pi 工具名解析 MCP provider / 短工具名。
 * 命名约定（pi-mcp-adapter）：
 *  - mcp 前缀：`mcp__{server}_{tool}`（server 内 `-`→`_`）
 *  - server 前缀：`{server}_{tool}`
 * 内置工具返回 null。
 * 原生工具（内置 + MyBuddy 原生能力 + cad_* native CAD）同样返回 null。
 */
export function parseMcpToolIdentity(
  toolName: string,
  providerIds: readonly string[] = [],
): { providerId: string; shortToolName: string } | null {
  if (!toolName) return null;
  // native：内置工具 + 自研原生能力工具 + MyBuddy 原生 CAD 工具
  // （均非 MCP，不经 MCP 副作用门禁，否则会被误判为 unknown MCP provider 触发审批）
  if (
    BUILTIN_TOOL_NAMES.has(toolName) ||
    NATIVE_CAPABILITY_TOOL_SET.has(toolName) ||
    isMyBuddyNativeExtensionToolName(toolName) ||
    toolName.startsWith(NATIVE_CAD_TOOL_PREFIX)
  ) {
    return null;
  }

  if (toolName.startsWith("mcp__")) {
    const rest = toolName.slice("mcp__".length);

    // Pi 0.99 native MCP uses mcp__<server>__<tool>. Prefer that unambiguous
    // separator before the legacy pi-mcp-adapter form (mcp__<server>_<tool>).
    const exactNativeProvider = [...providerIds, ...BUILTIN_KNOWN_MCP_PROVIDER_IDS]
      .sort((a, b) => b.length - a.length).find(id => rest.startsWith(id + '__'));
    if (exactNativeProvider) return {
      providerId: exactNativeProvider, shortToolName: rest.slice(exactNativeProvider.length + 2),
    };
    const nativeSeparator = rest.indexOf("__");
    if (nativeSeparator > 0) {
      const encodedProvider = rest.slice(0, nativeSeparator);
      const shortToolName = rest.slice(nativeSeparator + 2);
      const knownProvider = [...providerIds, ...BUILTIN_KNOWN_MCP_PROVIDER_IDS]
        .find((providerId) => providerId === encodedProvider || providerId.replace(/-/g, "_") === encodedProvider);
      return {
        providerId: knownProvider ?? encodedProvider,
        shortToolName: shortToolName || rest,
      };
    }

    const known = splitKnownMcpProvider(rest, providerIds);
    if (known) return known;
    const idx = rest.indexOf("_");
    if (idx <= 0) return { providerId: rest || "mcp", shortToolName: rest || toolName };
    return {
      providerId: rest.slice(0, idx),
      shortToolName: rest.slice(idx + 1) || rest,
    };
  }

  // 代理工具 "mcp" 本身（连接/OAuth）不按业务 MCP tool 门禁
  if (toolName === "mcp") return null;

  const known = splitKnownMcpProvider(toolName, providerIds);
  if (known) return known;
  const idx = toolName.indexOf("_");
  if (idx > 0) {
    return {
      providerId: toolName.slice(0, idx),
      shortToolName: toolName.slice(idx + 1),
    };
  }

  // 无法拆分时整名当作 provider，工具名同名
  return { providerId: toolName, shortToolName: toolName };
}

const WRITE_NAME_RE =
  /(?:^|[_-])(?:write|create|edit|delete|unlink|remove|mkdir|rmdir|move|rename|save|patch|update(?:_?file)?|append|truncate)(?=$|[_-])/i;

const PATH_FIELDS = [
  "path",
  "file",
  "file_path",
  "filepath",
  "filePath",
  "target",
  "target_path",
  "filename",
  "fileName",
  "destination",
  "dest",
  "src",
  "source",
  "to",
  "from",
] as const;

/** 显式字段提取（非递归扫全部 key） */
export function extractCommonPathFields(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  const out: string[] = [];
  for (const f of PATH_FIELDS) {
    const v = o[f];
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  return out;
}

const MCP_READONLY_NAME_RE = /(?:^|_)(?:get|list|read|fetch|inspect|check|status|query|search|find|preview|screenshot|capture|measure|info|describe)(?:_|$)/i;
const MCP_MUTATION_NAME_RE = /(?:^|_)(?:write|create|edit|delete|remove|move|rename|save|update|apply|set|add|insert|append|patch|export|import|build|generate|run|execute|start|stop|restart|reload|cancel|upload)(?:_|$)/i;
const MCP_READONLY_ACTION_RE = /^(?:get|list|read|fetch|inspect|check|status|query|search|find|preview|screenshot|capture|measure|info|describe|select)(?:_|$)/i;
const MCP_MUTATION_ACTION_RE = /(?:^|_)(?:create|write|edit|delete|remove|move|rename|save|update|apply|set|add|insert|append|patch|export|import|build|generate|run|execute|start|stop|restart|reload|cancel|upload|clear|reset|connect|open)(?:_|$)/i;
const MCP_ACTION_FIELDS = ["action", "operation", "command", "mode", "op", "method"] as const;

function mcpAction(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  for (const field of MCP_ACTION_FIELDS) {
    const value = obj[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Positive readonly evidence for MCP tools. Used by Plan gate to keep inspection available. */
export function isMcpToolClearlyReadonly(toolName: string, input?: unknown): boolean {
  const action = mcpAction(input);
  if (action && MCP_MUTATION_ACTION_RE.test(action)) return false;
  if (action && MCP_READONLY_ACTION_RE.test(action)) return true;
  return MCP_READONLY_NAME_RE.test(toolName) && !MCP_MUTATION_NAME_RE.test(toolName);
}

/** Conservative mutation semantics for structured MCP tools, including operation-style CAD/design tools. */
export function isMcpToolLikelyMutating(toolName: string, input?: unknown): boolean {
  const action = mcpAction(input);
  if (action && MCP_MUTATION_ACTION_RE.test(action)) return true;
  if (MCP_MUTATION_NAME_RE.test(toolName)) return true;
  return /(?:^|_)(?:operations?|mutate|transform)(?:_|$)/i.test(toolName)
    && !isMcpToolClearlyReadonly(toolName, input);
}

export interface McpToolClassification {
  identity: { providerId: string; shortToolName: string };
  decision: McpToolGateDecision;
  dangerous: boolean;
  clearlyReadonly: boolean;
  sideEffect: boolean;
}

/** Single source of truth for MCP mutation semantics used by permission and execution evidence. */
export function classifyMcpToolCall(
  toolName: string,
  input: unknown,
  providerIds: readonly string[] = [],
  registry: McpSideEffectRegistry = getDefaultMcpSideEffectRegistry(),
  dangerousTools: ReadonlyMap<string, ReadonlySet<string>> = MANAGED_RUNTIME_DANGEROUS_TOOLS,
): McpToolClassification | null {
  const identity = parseMcpToolIdentity(toolName, providerIds);
  if (!identity) return null;
  const decision = registry.evaluateToolCall({ providerId: identity.providerId, toolName: identity.shortToolName, args: input });
  const dangerous = dangerousTools.get(identity.providerId)?.has(identity.shortToolName) === true;
  const clearlyReadonly = isMcpToolClearlyReadonly(identity.shortToolName, input);
  const sideEffect = decision.isLocalWrite || dangerous || isMcpToolLikelyMutating(identity.shortToolName, input)
    || (decision.requiresApproval && !clearlyReadonly);
  return { identity, decision, dangerous, clearlyReadonly, sideEffect };
}

export function looksLikeLocalWriteTool(toolName: string, input?: unknown): boolean {
  if (WRITE_NAME_RE.test(toolName)) return true;
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const f of PATH_FIELDS) {
      if (typeof o[f] === "string" && o[f].trim()) {
        // 名称不含写语义但带 path 的工具：仅当还有 content/text 等写入体时当写
        if (
          typeof o.content === "string" ||
          typeof o.text === "string" ||
          typeof o.data === "string" ||
          o.overwrite !== undefined ||
          o.create !== undefined
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * 注册表：provider 策略 + 显式 path adapter。
 * providerId="*" 的 adapter 匹配任意 provider。
 */
export class McpSideEffectRegistry {
  private readonly policies = new Map<string, McpSideEffectPolicy>();
  private readonly adapters: McpLocalPathAdapter[] = [];

  registerPolicy(policy: McpSideEffectPolicy): void {
    this.policies.set(policy.providerId, { ...policy });
  }

  registerAdapter(adapter: McpLocalPathAdapter): void {
    this.adapters.push(adapter);
  }

  getPolicy(providerId: string): McpSideEffectPolicy {
    return this.policies.get(providerId) ?? defaultMcpSideEffectPolicy(providerId);
  }

  findAdapters(providerId: string, toolName: string): McpLocalPathAdapter[] {
    return this.adapters.filter(
      (a) =>
        (a.providerId === providerId || a.providerId === "*") &&
        a.toolName === toolName,
    );
  }

  /**
   * 评估 MCP 工具调用是否应放行/审批。
   * - localFileAccess=none 且像本地写/有路径 → 硬拒绝
   * - unknown 本地写 → requiresApproval（不静默放行）
   * - unrestricted 写 → 允许但强制审批
   * - 无本地写迹象：按 requiresApproval 策略
   */
  evaluateToolCall(input: {
    providerId: string;
    toolName: string;
    args?: unknown;
  }): McpToolGateDecision {
    const policy = this.getPolicy(input.providerId);
    const adapters = this.findAdapters(input.providerId, input.toolName);
    let paths = adapters.flatMap((a) => {
      try {
        return a.extractPaths(input.args);
      } catch {
        return [];
      }
    });

    let isWrite = adapters.some((a) =>
      ["create", "write", "edit", "delete", "rename"].includes(a.operation),
    );

    // 无显式 adapter：启发式本地写 + 常见 path 字段
    if (!isWrite && looksLikeLocalWriteTool(input.toolName, input.args)) {
      isWrite = true;
      if (paths.length === 0) paths = extractCommonPathFields(input.args);
    }

    // 有 adapter 但没抽出 path 时，仍可补常见字段
    if (isWrite && paths.length === 0) {
      paths = extractCommonPathFields(input.args);
    }

    if (isWrite && policy.localFileAccess === "none") {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `provider ${input.providerId} 声明 localFileAccess=none，拒绝本地写工具 ${input.toolName}`,
        paths,
        policy,
        isLocalWrite: true,
      };
    }

    if (isWrite && policy.localFileAccess === "unknown") {
      return {
        allowed: false,
        requiresApproval: true,
        reason: `未知本地写能力（unknown），MCP 工具 ${input.providerId}/${input.toolName} 需审批`,
        paths,
        policy,
        isLocalWrite: true,
      };
    }

    if (isWrite && policy.localFileAccess === "unrestricted") {
      return {
        allowed: true,
        requiresApproval: true,
        reason: `unrestricted 本地写，强制审批：${input.providerId}/${input.toolName}`,
        paths,
        policy,
        isLocalWrite: true,
      };
    }

    if (isWrite && policy.localFileAccess === "read") {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `provider ${input.providerId} 仅允许 read，拒绝写工具 ${input.toolName}`,
        paths,
        policy,
        isLocalWrite: true,
      };
    }

    // task-write：允许写，但仍可要求审批（若 policy.requiresApproval）
    if (isWrite && policy.localFileAccess === "task-write") {
      return {
        allowed: true,
        requiresApproval: policy.requiresApproval,
        reason: policy.requiresApproval
          ? `task-write 工具需审批：${input.toolName}`
          : `task-write 允许：${input.toolName}`,
        paths,
        policy,
        isLocalWrite: true,
      };
    }

    if (policy.requiresApproval) {
      return {
        allowed: true,
        requiresApproval: true,
        reason: `provider 默认需要审批：${input.providerId}`,
        paths,
        policy,
        isLocalWrite: isWrite,
      };
    }

    return {
      allowed: true,
      requiresApproval: false,
      reason: "策略允许",
      paths,
      policy,
      isLocalWrite: isWrite,
    };
  }
}

/** 从常见 { path: string } 参数提取路径 */
export function extractPathField(input: unknown, field = "path"): string[] {
  if (!input || typeof input !== "object") return [];
  const v = (input as Record<string, unknown>)[field];
  return typeof v === "string" && v.trim() ? [v.trim()] : [];
}

/** 通用写工具 adapter（provider=*） */
const GENERIC_WRITE_TOOLS: Array<{ name: string; op: FileAccessOperation }> = [
  { name: "write_file", op: "write" },
  { name: "write_text_file", op: "write" },
  { name: "create_file", op: "create" },
  { name: "edit_file", op: "edit" },
  { name: "delete_file", op: "delete" },
  { name: "remove_file", op: "delete" },
  { name: "move_file", op: "rename" },
  { name: "rename_file", op: "rename" },
];

let defaultRegistry: McpSideEffectRegistry | null = null;

/** 进程级默认 registry（含通用写 adapter）；可 registerPolicy 覆盖 */
export function getDefaultMcpSideEffectRegistry(): McpSideEffectRegistry {
  if (defaultRegistry) return defaultRegistry;
  const reg = new McpSideEffectRegistry();
  for (const t of GENERIC_WRITE_TOOLS) {
    reg.registerAdapter({
      providerId: "*",
      toolName: t.name,
      operation: t.op,
      extractPaths: (input) => {
        const paths = extractCommonPathFields(input);
        return paths.length ? paths : extractPathField(input, "path");
      },
    });
  }
  registerManagedRuntimePolicies(reg);
  defaultRegistry = reg;
  return reg;
}
