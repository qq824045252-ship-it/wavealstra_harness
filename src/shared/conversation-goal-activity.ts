import type { ReportedTokenUsage } from "./task-diagnostics";

export interface GoalActivityOwner {
  goalId: string;
  intentRevision: number;
}

export interface GoalActivityIdentity {
  conversationId: string;
  generationTaskId: number;
}

export interface GoalActivityAdmission extends GoalActivityIdentity {
  inputs?: Array<{ owner: GoalActivityOwner; assistantMessageId: string }>;
  parent?: GoalActivityIdentity;
  child?: { id: string; displayName: string; role: string; model: string };
}

export interface GoalActivityRun extends GoalActivityIdentity {
  taskId: string;
  intentRevision: number;
  parent?: GoalActivityIdentity;
  child?: GoalActivityAdmission["child"];
  returned?: { status: string; outcome?: string; toolCallId: string };
  status?: "completed" | "failed" | "aborted";
  requestCount: number;
  retryCount: number;
}

export interface GoalActivitySkill {
  skillId: string;
  description?: string;
  candidateId?: string;
  sourceMemoryIds: string[];
  installedVersion?: string;
  installedFingerprint?: string;
  invokedAt?: number;
  invocationKind?: string;
  assistantMessageId?: string;
  creationToolCallId?: string;
  createdAt?: number;
  scopeType?: string;
  scopeId?: string;
  laterInvokedAt?: number;
}

export type GoalNativeEvidence =
  | { kind: "check"; command: string; passed: boolean; exitCode: number | null; fingerprint: string }
  | { kind: "unit"; unitId: string; state: "running" | "returned" | "verified" | "failed";
      boardRun?: number; branch?: string; reason?: string;
      command?: string; fingerprint?: string; sha?: string; pr?: number }
  | { kind: "delivery"; path?: string; url?: string; digest?: string; sha?: string; branch?: string;
      saved?: { snapshotPath: string; manifestPath?: string; registeredAt: number } };

export interface GoalActivityCost {
  knownCostUsd: number | null;
  observedRequests: number;
  requestsWithCost: number;
  providerReportedRequests: number;
  estimatedRequests: number;
  missingGenerationObservations: number;
}

export interface GoalActivityDto {
  runs: GoalActivityRun[];
  skills: GoalActivitySkill[];
  knownTokens: ReportedTokenUsage;
  knownCostUsd: number | null;
  observedRequests: number;
  requestsWithUsage: number;
  tokenFieldCoverage: Record<keyof ReportedTokenUsage, number>;
  requestsWithCompleteUsage: number;
  requestsWithCost: number;
  costBySource: Record<"main" | "child" | "auxiliary", GoalActivityCost>;
  unattributedAuxiliaryRequests: number;
  missingGenerationObservations: number;
  retryCount: number;
  nativeEvidence?: Array<GoalNativeEvidence & GoalActivityIdentity & { taskId: string; intentRevision: number; toolTaskId: number }>;
}
