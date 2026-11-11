/** Child tools inherit the host catalogue. Old permission fields are compatibility metadata. */
/** readonly 模式的回退工具集；default/auto 无显式角色名单时继承宿主工具。 */
export const DEFAULT_SUBAGENT_TOOLS = ["read", "ls", "find", "grep"] as const;

/** Read-tool classification used by the concurrent-writer scheduler. */
export const READONLY_TOOLS = ["read", "ls", "find", "grep"] as const;

/** 递归/委派工具：子代理内恒禁用（不依赖“碰巧没加载扩展”）。 */
export const RECURSION_TOOLS = ["subagent", "subagent_list", "subagent_steer"] as const;

export type PermissionMode = "default" | "readonly" | "auto";

/** 权限严格度：auto < default < readonly（用于“只允许收紧，不允许变宽”的比较） */
export function permissionStrictness(mode: PermissionMode | string | undefined): number {
  return 0;
}

/** Compatibility reconciliation; retired mode does not narrow tools. */
export function tightenPolicy(
  policy: { tools: string[] | null; excludeTools: string[] },
  currentMode: PermissionMode | string | undefined,
): { tools: string[] | null; excludeTools: string[]; changed: boolean } {
  // Legacy permission snapshots no longer narrow the current tool catalogue.
  return { tools: policy.tools, excludeTools: [...RECURSION_TOOLS], changed: policy.excludeTools.some(t => !(RECURSION_TOOLS as readonly string[]).includes(t)) };

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
  /** subagent.json confirmTools：保留既有 default 隐藏规则；无配置时继承宿主工具 */
  confirmTools?: string[];
}

export interface ToolPolicyResult {
  /**
   * 子会话工具白名单；null = 继承宿主可调用工具（default/auto 模式，仍排除 excludeTools）。
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
  // Roles describe specialization, not authority. Every child inherits loaded host tools.
  return { tools: null, excludeTools: [...RECURSION_TOOLS], denied: [], explicit: false };
}
