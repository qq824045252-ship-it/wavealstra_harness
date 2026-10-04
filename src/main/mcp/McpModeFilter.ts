/**
 * 按 welcomeMode + ModePolicy.mcpPolicy 过滤 MCP 配置（会话级硬隔离）。
 * McpFilterResult.capabilities 是执行判定本身；trace 只能消费它，不能二次推导。
 */
import type { ModeMcpPolicy, WelcomeMode } from "../../shared/mode-profile";
import {
  resolveMcpCapability,
  type ResolvedCapabilityDto,
  type SourcedMcpPolicy,
} from "../../shared/runtime-policy";
import type { McpConfig, McpServerEntry } from "./McpConfigService";

export interface McpFilterResult {
  config: McpConfig;
  enabled: string[];
  hidden: string[];
  reasons: Record<string, string>;
  capabilities: ResolvedCapabilityDto[];
}

function entryModes(entry: McpServerEntry): WelcomeMode[] | null {
  const raw = entry.modes;
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const modes = raw
      .map(String)
      .map((value) => value.trim())
      .filter((value): value is WelcomeMode =>
        value === "working" || value === "coding" || value === "design",
      );
    return modes.length ? modes : null;
  }
  if (typeof raw === "string") {
    const modes = raw
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter((value): value is WelcomeMode =>
        value === "working" || value === "coding" || value === "design",
      );
    return modes.length ? modes : null;
  }
  return null;
}

export function emptyMcpFilterResult(base?: McpConfig): McpFilterResult {
  const config: McpConfig = base ?? { mcpServers: {} };
  const enabled = Object.keys(config.mcpServers ?? {});
  return {
    config,
    enabled,
    hidden: [],
    reasons: {},
    capabilities: enabled.map((id) => ({ id, kind: "mcp", enabled: true, sources: [] })),
  };
}

function formatReason(
  decision: ResolvedCapabilityDto,
  modes: WelcomeMode[] | null,
  welcomeMode: WelcomeMode,
): string | null {
  const code = decision.reason?.replace(/_soft$/, "");
  if (!code) return null;
  if (code === "global_disabled") return "全局已停用";
  if (code === "mode_not_supported") {
    return `仅限模式 [${modes?.join(", ")}], 当前 ${welcomeMode}`;
  }
  if (code.endsWith("_policy_denied")) {
    return `mcpPolicy.deny 命中（场景 ${welcomeMode}）`;
  }
  return `mcpPolicy.allow 白名单未包含（场景 ${welcomeMode}）`;
}

/**
 * policySources 可携带 Mode → Project → Tag 的原始来源，用于在同一次真实判定中生成 trace。
 * 缺省时把已合成 policy 记作 mode 来源，兼容既有调用方。
 */
export function filterMcpConfigForMode(
  full: McpConfig,
  welcomeMode: WelcomeMode,
  policy?: ModeMcpPolicy | null,
  policySources?: SourcedMcpPolicy[],
): McpFilterResult {
  const policyMode = policy?.mode === "soft" ? "soft" : "hard";
  const servers = full.mcpServers ?? {};
  const next: Record<string, McpServerEntry> = {};
  const enabled: string[] = [];
  const hidden: string[] = [];
  const reasons: Record<string, string> = {};
  const capabilities: ResolvedCapabilityDto[] = [];

  for (const [name, entry] of Object.entries(servers)) {
    if (!entry || typeof entry !== "object") continue;
    const modes = entryModes(entry);
    const decision = resolveMcpCapability(
      { id: name, disabled: entry.disabled === true || entry.enabled === false, modes },
      policySources ?? [{ source: "mode", sourceId: welcomeMode, policy }],
      { welcomeMode, policyMode },
    );
    capabilities.push(decision);

    const detail = formatReason(decision, modes, welcomeMode);
    if (detail) {
      hidden.push(name);
      reasons[name] = detail;
    }
    if (!decision.enabled) continue;

    next[name] = entry;
    enabled.push(name);
  }

  return {
    config: { ...full, mcpServers: next },
    enabled,
    hidden,
    reasons,
    capabilities,
  };
}

/** 默认 coding-only 扩展名（与 extensions/mcp 出厂一致） */
export const DEFAULT_CODING_ONLY_MCP = ["serena", "codegraph"] as const;


/**
 * Query-aware Loadout overlay. This can only narrow providers that already passed
 * Runtime Policy; it never re-enables a policy-hidden or globally disabled MCP.
 */
export function applyMcpLoadoutSelection(
  base: McpFilterResult,
  selectedIds?: readonly string[] | null,
): McpFilterResult {
  if (!selectedIds) return base;
  const selected = new Set(selectedIds.map((id) => id.trim().toLowerCase()).filter(Boolean));
  const policyEnabled = new Set(base.enabled.map((id) => id.toLowerCase()));
  const enabled = base.enabled.filter((id) => selected.has(id.toLowerCase()));
  const deselected = base.enabled.filter((id) => !selected.has(id.toLowerCase()));
  const hidden = [...new Set([...base.hidden, ...deselected])];
  const reasons = { ...base.reasons };
  for (const id of deselected) reasons[id] = "loadout_not_selected";
  const mcpServers = Object.fromEntries(
    Object.entries(base.config.mcpServers ?? {}).filter(([id]) => selected.has(id.toLowerCase())),
  );
  const capabilities = base.capabilities.map((item) => {
    if (!item.enabled || !policyEnabled.has(item.id.toLowerCase())) return item;
    if (selected.has(item.id.toLowerCase())) return item;
    return { ...item, enabled: false, reason: "loadout_not_selected" };
  });
  return {
    config: { ...base.config, mcpServers },
    enabled,
    hidden,
    reasons,
    capabilities,
  };
}
