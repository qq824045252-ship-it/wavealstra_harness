import type {
  ModeMcpPolicy,
  ModePolicyDto,
  ModePresetDto,
  ModeSkillPolicy,
} from "./mode-profile";
import type {
  ProjectPoliciesDto,
  ProjectSelectionPolicyDto,
} from "./project-domain";

export type CapabilityPolicySource = "global" | "mode" | "project" | "tag" | "task";
export type CapabilityKind = "expert" | "skill" | "connector" | "mcp";

export interface CapabilitySourceTrace {
  source: CapabilityPolicySource;
  sourceId?: string;
  decision: "allowed" | "denied" | "neutral";
}

export interface ResolvedCapabilityDto {
  id: string;
  kind: CapabilityKind;
  enabled: boolean;
  sources: CapabilitySourceTrace[];
  reason?: string;
}

export interface ResolvedRuntimePolicy {
  skillPolicy: ModeSkillPolicy;
  mcpPolicy: ModeMcpPolicy;
  expertPolicy: ProjectSelectionPolicyDto;
  connectorPolicy: ProjectSelectionPolicyDto;
}

interface SourcedSelectionPolicy {
  source: CapabilityPolicySource;
  sourceId?: string;
  policy?: ProjectSelectionPolicyDto | null;
}

export interface SourcedSkillPolicy {
  source: CapabilityPolicySource;
  sourceId?: string;
  policy?: ModeSkillPolicy | null;
}

export interface SourcedMcpPolicy {
  source: CapabilityPolicySource;
  sourceId?: string;
  policy?: ModeMcpPolicy | null;
}

export interface SkillCapabilityRef {
  id: string;
  name?: string;
  description?: string;
  /** UI 侧技能命令名（+ 菜单）；并入统一 matcher 的精确匹配维度 */
  command?: string;
  enabled?: boolean;
  modes?: string[] | null;
}

export interface ResolveSkillCapabilityOptions {
  welcomeMode?: string;
}

export interface McpCapabilityRef {
  id: string;
  disabled?: boolean;
  modes?: string[] | null;
}

export interface ResolveMcpCapabilityOptions {
  welcomeMode?: string;
  /** Final composed mode controls whether a rejection filters or only warns. */
  policyMode?: "hard" | "soft";
}

function unique(...lists: Array<string[] | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of lists.flatMap((list) => list ?? [])) {
    const value = raw.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function includesId(list: string[], id: string): boolean {
  const key = id.trim().toLowerCase();
  return list.some((item) => item.trim().toLowerCase() === key);
}

function matchesKeyword(list: string[], id: string): boolean {
  return matchesPolicyKeyword(id, list);
}

/**
 * 名单关键字匹配（MCP 名 / 技能名通用）：小写后精确或子串命中。
 * 与技能 matcher 分离：MCP 只有 name 维度，技能还有 id/description 维度。
 */
export function matchesPolicyKeyword(hay: string, needles: string[]): boolean {
  const key = hay.trim().toLowerCase();
  return needles.some((item) => {
    const needle = item.trim().toLowerCase();
    return needle.length > 0 && (key === needle || key.includes(needle));
  });
}

/** 显式关键词 needle 前缀：`keyword:bro` 表示子串匹配，而不是技能身份。 */
export const SKILL_KEYWORD_NEEDLE_PREFIX = "keyword:";

function splitSkillNeedle(raw: string): { keyword: boolean; value: string } {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith(SKILL_KEYWORD_NEEDLE_PREFIX)) {
    return { keyword: true, value: trimmed.slice(SKILL_KEYWORD_NEEDLE_PREFIX.length).trim() };
  }
  return { keyword: false, value: trimmed };
}

function skillKeywordBlob(skill: SkillCapabilityRef): string {
  return [skill.id, skill.name ?? "", skill.command ?? "", skill.description ?? ""]
    .filter((part) => part.length > 0)
    .join(" ")
    .toLowerCase();
}

function skillHasIdentity(skill: SkillCapabilityRef, value: string): boolean {
  const id = skill.id.toLowerCase();
  const name = (skill.name ?? "").toLowerCase();
  const cmd = (skill.command ?? "").toLowerCase();
  return id === value || name === value || (cmd.length > 0 && cmd === value);
}

/**
 * 硬名单匹配（hide / allow）：只接受稳定技能身份。
 * - 大小写不敏感；needle 先 trim；
 * - 裸 needle = id / name / command 精确命中；
 * - `keyword:<词>` = 显式声明的子串匹配（旧行为需显式标注，不再隐式扩散）。
 * 短名单词（如 `bro`）不得靠 description 子串命中别的技能。
 */
export function matchesSkillIdentityNeedles(
  skill: SkillCapabilityRef,
  needles: string[],
): boolean {
  if (needles.length === 0) return false;
  return needles.some((item) => {
    const { keyword, value } = splitSkillNeedle(item);
    const needle = value.toLowerCase();
    if (!needle) return false;
    if (skillHasIdentity(skill, needle)) return true;
    return keyword && skillKeywordBlob(skill).includes(needle);
  });
}

/**
 * 排序/推荐匹配（prefer / demote）：保留历史的「精确优先 + 子串回退」语义。
 * 这是唯一允许 description 子串命中的维度；硬名单请用 matchesSkillIdentityNeedles。
 */
export function matchesSkillPolicyNeedles(
  skill: SkillCapabilityRef,
  needles: string[],
): boolean {
  if (needles.length === 0) return false;
  const blob = skillKeywordBlob(skill);
  return needles.some((item) => {
    const { value } = splitSkillNeedle(item);
    const needle = value.toLowerCase();
    if (!needle) return false;
    if (skillHasIdentity(skill, needle)) return true;
    return blob.includes(needle);
  });
}

function intersectAllow(base: string[], next: string[]): { allow: string[]; empty: boolean } {
  if (next.length === 0) return { allow: [...base], empty: false };
  if (base.length === 0) return { allow: [...next], empty: false };
  const intersection = base.filter((id) => includesId(next, id));
  return { allow: intersection.length ? intersection : [...base], empty: intersection.length === 0 };
}

/** Restrictive composition shared by Mode, Project and Tag. */
export function composeMcpPolicies(
  base: ModeMcpPolicy,
  next?: ModeMcpPolicy | null,
): ModeMcpPolicy {
  if (!next) return { mode: base.mode, allow: [...base.allow], deny: [...base.deny] };
  const intersection = intersectAllow(base.allow, next.allow);
  return {
    mode: base.mode === "hard" || next.mode === "hard" ? "hard" : "soft",
    allow: intersection.allow,
    deny: unique(base.deny, next.deny, intersection.empty ? base.allow : []),
  };
}

/** Restrictive Skill composition; hide is the hard deny dimension. */
export function composeSkillPolicies(
  base: ModeSkillPolicy,
  next?: ModeSkillPolicy | null,
): ModeSkillPolicy {
  if (!next) {
    return {
      prefer: [...base.prefer],
      demote: [...base.demote],
      hide: [...base.hide],
      allow: [...base.allow],
    };
  }
  const intersection = intersectAllow(base.allow, next.allow);
  return {
    prefer: unique(base.prefer, next.prefer),
    demote: unique(base.demote, next.demote),
    hide: unique(base.hide, next.hide, intersection.empty ? base.allow : []),
    allow: intersection.allow,
  };
}

export function composeSelectionPolicies(
  base: ProjectSelectionPolicyDto,
  next?: ProjectSelectionPolicyDto | null,
): ProjectSelectionPolicyDto {
  if (!next) {
    return { allow: [...base.allow], deny: [...base.deny], recommended: [...base.recommended] };
  }
  const intersection = intersectAllow(base.allow, next.allow);
  return {
    allow: intersection.allow,
    deny: unique(base.deny, next.deny, intersection.empty ? base.allow : []),
    recommended: unique(base.recommended, next.recommended),
  };
}

const EMPTY_SELECTION: ProjectSelectionPolicyDto = { allow: [], deny: [], recommended: [] };

/**
 * One policy composition path. Project is deliberately between Mode and Tag;
 * Tag can narrow Project but Project can never widen Mode or bypass Tag.
 */
export function resolveRuntimePolicy(input: {
  mode: ModePolicyDto;
  project?: ProjectPoliciesDto | null;
  tag?: ModePresetDto | null;
}): ResolvedRuntimePolicy {
  const modeExpert = input.mode.expertPolicy ?? EMPTY_SELECTION;
  const modeConnector = input.mode.connectorPolicy ?? EMPTY_SELECTION;
  return {
    skillPolicy: composeSkillPolicies(
      composeSkillPolicies(input.mode.skillPolicy, input.project?.skill),
      input.tag?.skillPolicy,
    ),
    mcpPolicy: composeMcpPolicies(
      composeMcpPolicies(input.mode.mcpPolicy, input.project?.mcp),
      input.tag?.mcpPolicy,
    ),
    expertPolicy: composeSelectionPolicies(
      composeSelectionPolicies(modeExpert, input.project?.expert),
      input.tag?.expertPolicy,
    ),
    connectorPolicy: composeSelectionPolicies(
      composeSelectionPolicies(modeConnector, input.project?.connector),
      input.tag?.connectorPolicy,
    ),
  };
}

export function resolveSelectionCapability(
  id: string,
  kind: "expert" | "connector",
  sources: SourcedSelectionPolicy[],
  options: { globallyEnabled?: boolean } = {},
): ResolvedCapabilityDto {
  const traces: CapabilitySourceTrace[] = [];
  for (const source of sources) {
    const policy = source.policy;
    if (!policy) continue;
    if (includesId(policy.deny, id)) {
      traces.push({ source: source.source, sourceId: source.sourceId, decision: "denied" });
      return {
        id,
        kind,
        enabled: false,
        sources: traces,
        reason: `${source.source}_policy_denied`,
      };
    }
    if (policy.allow.length > 0) {
      const allowed = includesId(policy.allow, id);
      traces.push({
        source: source.source,
        sourceId: source.sourceId,
        decision: allowed ? "allowed" : "denied",
      });
      if (!allowed) {
        return {
          id,
          kind,
          enabled: false,
          sources: traces,
          reason: `${source.source}_policy_not_allowed`,
        };
      }
    } else {
      traces.push({ source: source.source, sourceId: source.sourceId, decision: "neutral" });
    }
  }
  if (options.globallyEnabled === false) {
    traces.push({ source: "global", decision: "denied" });
    return { id, kind, enabled: false, sources: traces, reason: "global_disabled" };
  }
  return { id, kind, enabled: true, sources: traces };
}

export function resolveSkillCapability(
  skill: string | SkillCapabilityRef,
  sources: SourcedSkillPolicy[],
  options: ResolveSkillCapabilityOptions = {},
): ResolvedCapabilityDto {
  const ref = typeof skill === "string" ? { id: skill, name: skill } : skill;
  const id = ref.id;
  const traces: CapabilitySourceTrace[] = [];
  if (ref.enabled === false) {
    traces.push({ source: "global", decision: "denied" });
    return { id, kind: "skill", enabled: false, sources: traces, reason: "global_disabled" };
  }
  for (const source of sources) {
    const policy = source.policy;
    if (!policy) continue;
    if (matchesSkillIdentityNeedles(ref, policy.hide)) {
      traces.push({ source: source.source, sourceId: source.sourceId, decision: "denied" });
      return { id, kind: "skill", enabled: false, sources: traces, reason: `${source.source}_policy_denied` };
    }
    if (policy.allow.length > 0) {
      const allowed = matchesSkillIdentityNeedles(ref, policy.allow);
      traces.push({ source: source.source, sourceId: source.sourceId, decision: allowed ? "allowed" : "denied" });
      if (!allowed) {
        return { id, kind: "skill", enabled: false, sources: traces, reason: `${source.source}_policy_not_allowed` };
      }
    } else {
      traces.push({ source: source.source, sourceId: source.sourceId, decision: "neutral" });
    }
  }
  if (
    options.welcomeMode &&
    ref.modes?.length &&
    !ref.modes.includes(options.welcomeMode)
  ) {
    traces.push({ source: "mode", sourceId: options.welcomeMode, decision: "denied" });
    return { id, kind: "skill", enabled: false, sources: traces, reason: "mode_not_supported" };
  }
  return { id, kind: "skill", enabled: true, sources: traces };
}

export function resolveMcpCapability(
  capability: string | McpCapabilityRef,
  sources: SourcedMcpPolicy[],
  options: ResolveMcpCapabilityOptions = {},
): ResolvedCapabilityDto {
  const ref = typeof capability === "string" ? { id: capability } : capability;
  const id = ref.id;
  const traces: CapabilitySourceTrace[] = [];
  const hard = options.policyMode !== "soft";
  if (ref.disabled) {
    traces.push({ source: "global", decision: "denied" });
    return {
      id,
      kind: "mcp",
      enabled: !hard,
      sources: traces,
      reason: hard ? "global_disabled" : "global_disabled_soft",
    };
  }
  if (
    options.welcomeMode &&
    ref.modes?.length &&
    !ref.modes.includes(options.welcomeMode)
  ) {
    traces.push({ source: "mode", sourceId: options.welcomeMode, decision: "denied" });
    return {
      id,
      kind: "mcp",
      enabled: !hard,
      sources: traces,
      reason: hard ? "mode_not_supported" : "mode_not_supported_soft",
    };
  }
  for (const source of sources) {
    const policy = source.policy;
    if (!policy) continue;
    if (matchesKeyword(policy.deny, id)) {
      traces.push({ source: source.source, sourceId: source.sourceId, decision: "denied" });
      return {
        id,
        kind: "mcp",
        enabled: !hard,
        sources: traces,
        reason: `${source.source}_policy_denied${hard ? "" : "_soft"}`,
      };
    }
    if (policy.allow.length > 0) {
      const allowed = matchesKeyword(policy.allow, id);
      traces.push({ source: source.source, sourceId: source.sourceId, decision: allowed ? "allowed" : "denied" });
      if (!allowed) {
        return {
          id,
          kind: "mcp",
          enabled: !hard,
          sources: traces,
          reason: `${source.source}_policy_not_allowed${hard ? "" : "_soft"}`,
        };
      }
    } else {
      traces.push({ source: source.source, sourceId: source.sourceId, decision: "neutral" });
    }
  }
  return { id, kind: "mcp", enabled: true, sources: traces };
}
