/**
 * policy.ts — 子代理工具权限策略（C）。
 *
 * 设计原则：
 * - 工具名单在创建 Durable 子会话时固化；宿主工具 hook 继续执行当前权限与路径检查。
 * - 角色 frontmatter 显式 tools = 显式授权（与已有角色配置兼容）。
 * - 无 tools frontmatter 时不再默认「全部工具」：默认是**只读分析集**（最小权限）；
 *   bash/write/edit 均需显式授权。
 * - 递归工具恒排除；Durable 分派器还验证调用方不是子代理。
 * - tightenPolicy：策略永不自动变宽；宿主 permissionMode 变更（auto→default/readonly）
 *   时按更严模式收敛（详见 P1-2）。
 */

/** 无 tools frontmatter 时的最小权限默认集（只读分析，无执行/写入）。bash 需显式授权。 */
export const DEFAULT_SUBAGENT_TOOLS = ["read", "ls", "find", "grep"] as const;

/** 宿主 readonly 模式下的只读核心（与 MyBuddy permission-extension readonly 一致：禁 write/edit/bash）。 */
export const READONLY_TOOLS = ["read", "ls", "find", "grep"] as const;

/** 递归/委派工具：子代理内恒禁用（不依赖“碰巧没加载扩展”）。 */
export const RECURSION_TOOLS = ["subagent", "subagent_list", "subagent_steer"] as const;

export type PermissionMode = "default" | "readonly" | "auto";

/** 权限严格度：auto < default < readonly（用于“只允许收紧，不允许变宽”的比较） */
export function permissionStrictness(mode: PermissionMode | string | undefined): number {
  switch (mode) {
    case "readonly":
      return 2;
    case "default":
      return 1;
    case "auto":
      return 0;
    default:
      return 1; // 未知按 default 处理（保守）
  }
}

/**
 * 收紧策略（P1-2）：策略永不自动变宽；按当前 hostPermissionMode 收敛。
 * - current=auto：不改（auto 不收紧；也不允许把更严策略放宽）→ 返回原策略。
 * - current=readonly：白名单收敛到只读集（null → READONLY_TOOLS）。
 * - current=default：null（原 auto 无白名单）→ DEFAULT_SUBAGENT_TOOLS；已有白名单不变。
 */
export function tightenPolicy(
  policy: { tools: string[] | null; excludeTools: string[] },
  currentMode: PermissionMode | string | undefined,
): { tools: string[] | null; excludeTools: string[]; changed: boolean } {
  const mode: PermissionMode = currentMode === "readonly" || currentMode === "auto" ? currentMode : "default";
  const excludeTools = unique([...policy.excludeTools, ...RECURSION_TOOLS]);
  if (mode === "auto") {
    return { tools: policy.tools, excludeTools, changed: false };
  }
  if (mode === "readonly") {
    const tools = policy.tools
      ? unique(policy.tools.filter((t) => (READONLY_TOOLS as readonly string[]).includes(t)))
      : [...READONLY_TOOLS];
    return { tools, excludeTools, changed: true };
  }
  // default
  if (policy.tools === null) {
    return { tools: [...DEFAULT_SUBAGENT_TOOLS], excludeTools, changed: true };
  }
  return { tools: policy.tools, excludeTools, changed: false };
}

export interface ToolPolicyInput {
  /** 角色 frontmatter tools（已解析） */
  roleTools?: string[];
  /** 宿主 settings.json permissionMode（缺省 default） */
  permissionMode?: PermissionMode | null;
  /** subagent.json allowTools：追加授权 */
  allowTools?: string[];
  /** subagent.json denyTools：硬排除（优先级最高） */
  denyTools?: string[];
  /** subagent.json confirmTools：默认集内需要宿主确认的工具（默认集不含时自动剔除） */
  confirmTools?: string[];
}

export interface ToolPolicyResult {
  /**
   * 子会话工具白名单；null = 继承宿主可调用工具（仅 auto 模式，仍排除 excludeTools）。
   */
  tools: string[] | null;
  /** 恒含 recursion 工具 + denyTools。 */
  excludeTools: string[];
  /** 被策略剔除的工具（诊断展示用） */
  denied: string[];
  /** 该策略是否由显式 frontmatter 驱动（可解释性） */
  explicit: boolean;
}

const unique = (xs: string[]): string[] => [...new Set(xs.filter((x) => typeof x === "string" && x.length > 0))];

export function computeChildTools(input: ToolPolicyInput): ToolPolicyResult {
  const deny = new Set(unique([...(input.denyTools ?? []), ...RECURSION_TOOLS]));
  const mode: PermissionMode = input.permissionMode ?? "default";
  const roleTools = unique(input.roleTools ?? []);
  const allow = unique(input.allowTools ?? []);
  const confirm = new Set(unique(input.confirmTools ?? []));
  const explicit = roleTools.length > 0;

  let base: string[];
  if (explicit) {
    // 显式 frontmatter = 显式授权（含 write/edit，即使宿主 default 模式需确认）
    base = roleTools;
  } else if (mode === "auto") {
    // auto = 用户已完全授权 → 不设白名单
    return {
      tools: null,
      excludeTools: unique([...RECURSION_TOOLS, ...(input.denyTools ?? [])]),
      denied: [...deny],
      explicit: false,
    };
  } else {
    base = [...DEFAULT_SUBAGENT_TOOLS, ...allow];
    if (mode === "default") {
      base = base.filter((t) => !confirm.has(t));
    }
  }

  if (mode === "readonly") {
    base = base.filter((t) => (READONLY_TOOLS as readonly string[]).includes(t));
  }

  const final = unique(base.filter((t) => !deny.has(t)));
  const denied = unique(base.filter((t) => deny.has(t)));
  return {
    tools: final,
    excludeTools: unique([...RECURSION_TOOLS, ...(input.denyTools ?? [])]),
    denied,
    explicit,
  };
}
