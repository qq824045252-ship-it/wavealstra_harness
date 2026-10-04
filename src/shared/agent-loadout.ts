import type { PermissionMode, WelcomeMode } from "./agent-ipc";

export type AgentLoadoutCapabilityKind = "expert" | "skill" | "connector" | "mcp";

export interface AgentLoadoutEvidenceDto {
  source: "query" | "mode" | "project" | "tag" | "memory" | "effectiveness" | "current" | "policy";
  label: string;
  sourceId?: string;
  weight?: number;
}

export interface AgentLoadoutCapabilityDto {
  kind: AgentLoadoutCapabilityKind;
  id: string;
  label: string;
  score: number;
  recommended: boolean;
  actual: boolean;
  /** Selected into the effective query-aware loadout. Selection never bypasses policy or explicit user scope. */
  selected?: boolean;
  blocked: boolean;
  blockReason?: string;
  evidence: AgentLoadoutEvidenceDto[];
}

export interface AgentLoadoutEffectiveSelectionDto {
  expertId?: string;
  connectorIds: string[];
  skillIds: string[];
  mcpIds: string[];
  /** True when at least one allowed/current capability was intentionally narrowed for this query. */
  narrowed: boolean;
  /** Stable identity used to decide whether an idle session needs rebuilding. */
  fingerprint: string;
}

export interface AgentLoadoutContextDto {
  memoryIds: string[];
  scenarioIds: string[];
  profileIds: string[];
}

export interface AgentLoadoutRecommendationDto {
  taskId: string;
  generatedAt: number;
  basis: "recommendation_only" | "effective_selection";
  query: string;
  mode: WelcomeMode;
  projectId?: string;
  workspaceId?: string;
  tagId?: string;
  capabilities: AgentLoadoutCapabilityDto[];
  modelSuggestion?: string;
  permissionSuggestion?: PermissionMode;
  context: AgentLoadoutContextDto;
  effectiveSelection?: AgentLoadoutEffectiveSelectionDto;
  summary: {
    recommended: number;
    matchedActual: number;
    notSelected: number;
    blocked: number;
  };
}

export type AgentLoadoutObservationOutcome = "pending" | "completed" | "failed" | "aborted";

export interface AgentLoadoutObservationContextDto extends AgentLoadoutContextDto {
  mode: WelcomeMode;
  projectId?: string;
  workspaceId?: string;
  tagId?: string;
}

export interface AgentLoadoutObservationDto {
  id: string;
  taskId: string;
  userMessageId: string;
  assistantMessageId: string;
  queryHash: string;
  context: AgentLoadoutObservationContextDto;
  recommended: Array<{
    kind: AgentLoadoutCapabilityKind;
    id: string;
    score: number;
    evidence: AgentLoadoutEvidenceDto[];
  }>;
  actual: Array<{ kind: AgentLoadoutCapabilityKind; id: string }>;
  matchedActual: Array<{ kind: AgentLoadoutCapabilityKind; id: string }>;
  notSelected: Array<{ kind: AgentLoadoutCapabilityKind; id: string; reason: string }>;
  blocked: Array<{ kind: AgentLoadoutCapabilityKind; id: string; reason: string }>;
  usedSkillIds: string[];
  outcome: AgentLoadoutObservationOutcome;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface RuntimeAuditClearResultDto {
  runtimeSnapshots: number;
  loadoutObservations: number;
  total: number;
}
