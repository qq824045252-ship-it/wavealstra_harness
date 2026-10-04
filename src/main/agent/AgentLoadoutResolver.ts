import { createHash } from "node:crypto";
import type { PermissionMode, WelcomeMode } from "../../shared/agent-ipc";
import type {
  AgentLoadoutCapabilityDto,
  AgentLoadoutCapabilityKind,
  AgentLoadoutEvidenceDto,
  AgentLoadoutEffectiveSelectionDto,
  AgentLoadoutRecommendationDto,
} from "../../shared/agent-loadout";
import type { ResolvedMemoryContext } from "../../shared/memory-kernel";

export interface LoadoutCandidate {
  kind: AgentLoadoutCapabilityKind;
  id: string;
  label: string;
  description?: string;
  tags?: string[];
  allowed: boolean;
  blockReason?: string;
  actual?: boolean;
  modeRecommended?: boolean;
  projectRecommended?: boolean;
  tagRecommended?: boolean;
  sourceMemoryIds?: string[];
  effectiveness?: {
    invocations: number;
    completionRate: number;
    helpfulFeedback: number;
    needsRevisionFeedback: number;
    incorrectFeedback: number;
  };
}

export interface ResolveAgentLoadoutInput {
  taskId: string;
  query: string;
  mode: WelcomeMode;
  projectId?: string;
  workspaceId?: string;
  tagId?: string;
  candidates: LoadoutCandidate[];
  modelSuggestion?: string | null;
  permissionSuggestion?: PermissionMode | null;
  memoryContext?: Pick<ResolvedMemoryContext, "items" | "scenarioIds" | "profileIds"> | null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function grams(value: string): Set<string> {
  const text = normalize(value).replace(/\s+/g, "");
  const out = new Set<string>();
  if (!text) return out;
  if (text.length === 1) {
    out.add(text);
    return out;
  }
  for (let index = 0; index < text.length - 1; index += 1) out.add(text.slice(index, index + 2));
  return out;
}

/** CJK/model-name friendly deterministic relevance; no model call. */
export function loadoutTextSimilarity(query: string, candidate: string): number {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.includes(q) || q.includes(c)) return 0.82;
  const qg = grams(q);
  const cg = grams(c);
  if (!qg.size || !cg.size) return 0;
  let hit = 0;
  for (const gram of qg) if (cg.has(gram)) hit += 1;
  return hit / Math.max(1, qg.size + cg.size - hit);
}

function threshold(kind: AgentLoadoutCapabilityKind): number {
  if (kind === "skill") return 0.2;
  if (kind === "expert") return 0.26;
  if (kind === "connector") return 0.28;
  return 0.3;
}

function maxRecommended(kind: AgentLoadoutCapabilityKind): number {
  if (kind === "skill") return 6;
  if (kind === "expert") return 2;
  if (kind === "connector") return 3;
  return 4;
}

function evaluateCandidate(
  candidate: LoadoutCandidate,
  query: string,
  memoryIds: Set<string>,
): { score: number; evidence: AgentLoadoutEvidenceDto[]; explicitRecommendation: boolean } {
  let score = 0;
  const evidence: AgentLoadoutEvidenceDto[] = [];
  const relevance = loadoutTextSimilarity(
    query,
    [candidate.id, candidate.label, candidate.description ?? "", ...(candidate.tags ?? [])].join(" "),
  );
  if (relevance > 0.02) {
    const weight = relevance * 0.55;
    score += weight;
    evidence.push({ source: "query", label: `任务相关度 ${(relevance * 100).toFixed(0)}%`, weight });
  }
  if (candidate.modeRecommended) {
    score += 0.22;
    evidence.push({ source: "mode", label: "Mode 推荐", weight: 0.22 });
  }
  if (candidate.projectRecommended) {
    score += 0.3;
    evidence.push({ source: "project", label: "Project 推荐", weight: 0.3 });
  }
  if (candidate.tagRecommended) {
    score += 0.32;
    evidence.push({ source: "tag", label: "Tag / Preset 推荐", weight: 0.32 });
  }
  const groundedMemoryIds = (candidate.sourceMemoryIds ?? []).filter((id) => memoryIds.has(id));
  if (groundedMemoryIds.length > 0) {
    const weight = Math.min(0.18, 0.1 + groundedMemoryIds.length * 0.02);
    score += weight;
    evidence.push({ source: "memory", label: `当前 Memory 命中 ${groundedMemoryIds.length} 条`, sourceId: groundedMemoryIds[0], weight });
  }
  if (candidate.effectiveness && candidate.effectiveness.invocations > 0) {
    const e = candidate.effectiveness;
    const volume = Math.min(1, e.invocations / 8);
    const successWeight = e.completionRate * 0.14 * volume;
    const feedbackTotal = e.helpfulFeedback + e.needsRevisionFeedback + e.incorrectFeedback;
    const helpfulRatio = feedbackTotal > 0 ? e.helpfulFeedback / feedbackTotal : 0;
    const correctionRatio = feedbackTotal > 0 ? (e.needsRevisionFeedback + e.incorrectFeedback) / feedbackTotal : 0;
    const feedbackWeight = helpfulRatio * 0.12 * volume - correctionRatio * 0.18 * volume;
    score += successWeight + feedbackWeight;
    evidence.push({
      source: "effectiveness",
      label: `历史调用 ${e.invocations} · 完成率 ${(e.completionRate * 100).toFixed(0)}% · 纠正 ${e.needsRevisionFeedback + e.incorrectFeedback}`,
      weight: successWeight + feedbackWeight,
    });
  }
  if (candidate.actual) {
    score += 0.04;
    evidence.push({ source: "current", label: "当前已装配", weight: 0.04 });
  }
  if (!candidate.allowed) {
    evidence.push({ source: "policy", label: `策略阻断：${candidate.blockReason ?? "denied"}` });
  }
  return {
    score: clamp01(score),
    evidence,
    explicitRecommendation: Boolean(candidate.modeRecommended || candidate.projectRecommended || candidate.tagRecommended),
  };
}

export function resolveAgentLoadout(input: ResolveAgentLoadoutInput): AgentLoadoutRecommendationDto {
  const query = input.query.trim().slice(0, 2000);
  const memoryIds = new Set(input.memoryContext?.items.map((item) => item.id) ?? []);
  const evaluated = input.candidates.map((candidate) => {
    const result = evaluateCandidate(candidate, query, memoryIds);
    return { candidate, ...result };
  });

  const selected = new Set<string>();
  const output: AgentLoadoutCapabilityDto[] = [];
  for (const kind of ["expert", "skill", "connector", "mcp"] as const) {
    const group = evaluated
      .filter((item) => item.candidate.kind === kind)
      .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
    let inferredRecommendedCount = 0;
    for (const item of group) {
      const inferredRecommendation = !item.explicitRecommendation && item.score >= threshold(kind);
      const recommended = item.explicitRecommendation || (
        inferredRecommendation && inferredRecommendedCount < maxRecommended(kind)
      );
      if (recommended && !item.explicitRecommendation) inferredRecommendedCount += 1;
      if (!recommended && !item.candidate.actual) continue;
      const key = `${kind}:${item.candidate.id}`;
      if (selected.has(key)) continue;
      selected.add(key);
      output.push({
        kind,
        id: item.candidate.id,
        label: item.candidate.label,
        score: item.score,
        recommended,
        actual: Boolean(item.candidate.actual),
        blocked: recommended && !item.candidate.allowed,
        blockReason: recommended && !item.candidate.allowed ? item.candidate.blockReason ?? "policy_denied" : undefined,
        evidence: item.evidence,
      });
    }
  }

  const recommended = output.filter((item) => item.recommended);
  const matchedActual = recommended.filter((item) => item.actual && !item.blocked);
  const blocked = recommended.filter((item) => item.blocked);
  const notSelected = recommended.filter((item) => !item.actual && !item.blocked);
  return {
    taskId: input.taskId,
    generatedAt: Date.now(),
    basis: "recommendation_only",
    query,
    mode: input.mode,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    tagId: input.tagId,
    capabilities: output,
    modelSuggestion: input.modelSuggestion?.trim() || undefined,
    permissionSuggestion: input.permissionSuggestion ?? undefined,
    context: {
      memoryIds: [...memoryIds],
      scenarioIds: input.memoryContext?.scenarioIds ?? [],
      profileIds: input.memoryContext?.profileIds ?? [],
    },
    summary: {
      recommended: recommended.length,
      matchedActual: matchedActual.length,
      notSelected: notSelected.length,
      blocked: blocked.length,
    },
  };
}


export interface ResolveEffectiveLoadoutSelectionOptions {
  /** Explicit slash-skill invocation is never narrowed away when it is already allowed/current. */
  explicitSkillId?: string | null;
  /** Tag/preset-required MCP providers are never narrowed away when already policy-enabled. */
  requiredMcpIds?: readonly string[];
  /** Allows callers such as Inspector to keep recommendation-only behavior. */
  enableNarrowing?: boolean;
}

function stableIds(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function loadoutQueryHasSignal(query: string): boolean {
  const value = normalize(query);
  if (!value) return false;
  if (/^(continue|go|next|keep going|\u7ee7\u7eed|\u63a5\u7740|\u7ee7\u7eed\u6267\u884c|\u7ee7\u7eed\u5e72|\u5f00\u5e72)[.!\u3002\uff01 ]*$/.test(value)) return false;
  return value.replace(/[\s\p{P}\p{S}]+/gu, "").length >= 4;
}

function selectionFingerprint(selection: Omit<AgentLoadoutEffectiveSelectionDto, "fingerprint">): string {
  return createHash("sha256").update(JSON.stringify({
    expertId: selection.expertId ?? null,
    connectorIds: stableIds(selection.connectorIds),
    skillIds: stableIds(selection.skillIds),
    mcpIds: stableIds(selection.mcpIds),
    narrowed: selection.narrowed,
  })).digest("hex");
}

/**
 * Converts recommendation telemetry into an effective selection without expanding authority:
 * only capabilities that are already `actual` and not blocked may be selected. Query-aware
 * narrowing is therefore a subset operation over the current Runtime Policy + explicit scope.
 */
export function resolveEffectiveLoadoutSelection(
  recommendation: AgentLoadoutRecommendationDto,
  options: ResolveEffectiveLoadoutSelectionOptions = {},
): AgentLoadoutRecommendationDto {
  const active = recommendation.capabilities.filter((item) => item.actual && !item.blocked);
  const querySignal = options.enableNarrowing !== false && loadoutQueryHasSignal(recommendation.query);
  const explicitSkillId = options.explicitSkillId?.trim().toLowerCase() || undefined;
  const requiredMcpIds = new Set((options.requiredMcpIds ?? []).map((id) => id.trim().toLowerCase()).filter(Boolean));

  const pickKind = (kind: AgentLoadoutCapabilityKind, forcedIds: Set<string> = new Set()): string[] => {
    const group = active.filter((item) => item.kind === kind);
    if (!group.length) return [];
    const recommended = group.filter((item) => item.recommended || forcedIds.has(item.id.toLowerCase()));
    if (!querySignal && forcedIds.size === 0) return stableIds(group.map((item) => item.id));
    if (!recommended.length) return stableIds(group.map((item) => item.id));
    return stableIds(recommended.map((item) => item.id));
  };

  const forcedSkills = new Set<string>();
  if (explicitSkillId) forcedSkills.add(explicitSkillId);
  const expertIds = pickKind("expert");
  const connectorIds = pickKind("connector");
  const skillIds = pickKind("skill", forcedSkills);
  const mcpIds = pickKind("mcp", requiredMcpIds);
  const selectedKeys = new Set<string>([
    ...expertIds.map((id) => `expert:${id.toLowerCase()}`),
    ...connectorIds.map((id) => `connector:${id.toLowerCase()}`),
    ...skillIds.map((id) => `skill:${id.toLowerCase()}`),
    ...mcpIds.map((id) => `mcp:${id.toLowerCase()}`),
  ]);
  const activeKeys = new Set(active.map((item) => `${item.kind}:${item.id.toLowerCase()}`));
  const narrowed = selectedKeys.size < activeKeys.size;
  const baseSelection = {
    expertId: expertIds[0],
    connectorIds,
    skillIds,
    mcpIds,
    narrowed,
  };
  const effectiveSelection: AgentLoadoutEffectiveSelectionDto = {
    ...baseSelection,
    fingerprint: selectionFingerprint(baseSelection),
  };
  return {
    ...recommendation,
    basis: "effective_selection",
    capabilities: recommendation.capabilities.map((item) => ({
      ...item,
      selected: selectedKeys.has(`${item.kind}:${item.id.toLowerCase()}`),
    })),
    effectiveSelection,
  };
}
