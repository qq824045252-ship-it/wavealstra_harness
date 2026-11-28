import type {
  MemoryEvidenceDto,
  MemoryCandidateDto,
  MemoryKernelStats,
  MemoryListRequest,
  MemoryRecordDto,
  MemoryRevisionDto,
  MemoryScopeDto,
  MemorySkillCandidateDto,
} from "../../shared/memory-kernel";
import type { MemoryWithdrawalSource, WithdrawalFingerprint } from "./MemoryForgetWatermarks";

type MemoryListQuery = {
  kind: "list";
  recordKind?: MemoryListRequest["kind"];
  status?: MemoryListRequest["status"];
  scopeType?: MemoryListRequest["scopeType"];
  scopeId?: string;
  pattern?: string;
  limit: number;
  offset: number;
};

export type RuntimeMemoryRecordsQuery =
  | MemoryListQuery
  | { kind: "dotsRevisionSource"; id: string; revision?: number; now: number }
  | { kind: "detail"; id: string }
  | { kind: "forTurn"; turnId: string }
  | { kind: "history"; id: string }
  | { kind: "forgetSource"; id: string }
  | { kind: "scopeMutationSupport" }
  | { kind: "candidateList"; status?: MemoryCandidateDto["status"]; limit: number }
  | { kind: "candidateReviewSupported" }
  | { kind: "installedSkillGrounding"; installedSkillId: string; candidateId: string; sourceMemoryIds: string[] }
  | { kind: "stats" }
  | { kind: "distinctProjectionScopes" }
  | { kind: "projects"; includeArchived: boolean }
  | { kind: "candidateById"; id: string }
  | { kind: "captureReceipt"; sourceKey: string }
  | { kind: "revisions"; memoryId: string }
  | { kind: "userWorks"; userId: string }
  | { kind: "workCaptureFacts"; workId: string; userId: string }
  | { kind: "assistantScopeContext"; taskId?: string; workId?: string; conversationId?: string; userId: string }
  | { kind: "dotsDueProjection"; now: number }
  | ({ kind: "skillEffectivenessQuery" } & (
    | { action: "byId"; id: string }
    | { action: "byTurnSkill"; taskId: string; assistantMessageId: string; skillId: string }
    | { action: "invokedForTurn"; taskId: string; assistantMessageId: string }
    | { action: "latestInvocationAfter"; skillId: string; candidateId: string; after: number }
    | { action: "recent"; limit: number; invokedOnly: boolean }
    | { action: "summaries"; limit: number }
    | { action: "revisionById"; id: string }
    | { action: "revisionList"; status?: string; limit: number }
    | { action: "revisionRefreshFacts"; skillId: string; candidateId?: string }
    | { action: "revisionStaleCount"; skillId: string; candidateId?: string; keepId: string }
  ));

type WireScope = Omit<MemoryScopeDto, "scopeId"> & { scopeId: string | null };
type WireEvidence = Omit<MemoryEvidenceDto, "refTitle" | "excerpt"> & {
  refTitle: string | null;
  excerpt: string | null;
};
type WireRevision = Omit<MemoryRevisionDto, "validFrom" | "validUntil" | "changeReason"> & {
  validFrom: number | null;
  validUntil: number | null;
  changeReason: string | null;
};
export type WireMemoryRecord = Omit<MemoryRecordDto,
  "sourceId" | "sourceTaskId" | "validFrom" | "validUntil" | "lastRecalledAt" | "metadata" | "scopes" | "evidence"> & {
    sourceId: string | null;
    sourceTaskId: string | null;
    validFrom: number | null;
    validUntil: number | null;
    lastRecalledAt: number | null;
    metadataJson: string;
    scopes: WireScope[];
    evidence: WireEvidence[];
  };

export type RuntimeMemoryRecordsData =
  | { kind: "list" | "forTurn"; records: WireMemoryRecord[] }
  | { kind: "history"; revisions: WireRevision[] }
  | { kind: "dotsRevisionSource"; source: null | { revision: number; reason: string; excerpt: string | null; userText: string | null; targets: WithdrawalFingerprint[] } }
  | { kind: "detail"; record: WireMemoryRecord | null; revision?: number }
  | { kind: "forgetSource"; record: MemoryWithdrawalSource | null; signature: string }
  | { kind: "scopeMutationSupport" }
  | { kind: "candidateList"; candidates: Record<string, unknown>[] }
  | { kind: "candidateReviewSupported" }
  | { kind: "installedSkillGrounding"; grounded: {
    candidateId: string; scopeType: MemorySkillCandidateDto["scopeType"]; scopeId: string | null; sourceSignature: string;
  } | null }
  | { kind: "stats"; stats: MemoryKernelStats }
  | { kind: "distinctProjectionScopes"; scopes: Array<{ scopeType: string; scopeId: string | null }> }
  | { kind: "projects"; projects: Array<{ id: string; name: string; archived: number }> }
  | { kind: "candidateById"; candidate: Record<string, unknown> | null }
  | { kind: "captureReceipt"; receipt: Record<string, unknown> | null }
  | { kind: "revisions"; revisions: Array<Record<string, unknown>> }
  | { kind: "userWorks"; workIds: string[] }
  | { kind: "workCaptureFacts"; work: Record<string, unknown> | null; deliverables?: Array<Record<string, unknown>>; deliverableTotal?: number; blockers?: Array<{ reason: string }>; blockerTotal?: number }
  | { kind: "assistantScopeContext"; workScope: Record<string, unknown> | null; botSource: Record<string, unknown> | null; directWork: Record<string, unknown> | null; hasGatewayDotsMemory: boolean }
  | { kind: "dotsDueProjection"; nextDue: number | null; records: Array<{ id: string; revision: number | null }> }
  | { kind: "skillEffectiveness"; row: Record<string, unknown> | null }
  | { kind: "skillEffectivenessList"; rows: Array<Record<string, unknown>> }
  | { kind: "skillEffectivenessLatest"; latest: number | null }
  | { kind: "skillEffectivenessSummaries"; rows: Array<Record<string, unknown>> }
  | { kind: "skillRevisionCandidate"; row: Record<string, unknown> | null }
  | { kind: "skillRevisionCandidateList"; rows: Array<Record<string, unknown>> }
  | { kind: "skillRevisionRefreshFacts"; negativeRows: Array<Record<string, unknown>>; failedCount: number }
  | { kind: "skillRevisionStaleCount"; count: number };

export function memoryListQuery(input: MemoryListRequest): MemoryListQuery {
  const query = input.query?.trim();
  return {
    kind: "list",
    recordKind: input.kind || undefined,
    status: input.status || undefined,
    scopeType: input.scopeType || undefined,
    scopeId: input.scopeId,
    pattern: query ? `%${query.replace(/[\\%_]/g, "\\$&")}%` : undefined,
    limit: Math.max(1, Math.min(5000, input.limit ?? 500)),
    offset: Math.max(0, input.offset ?? 0),
  };
}

export function memoryRecordFromWire({ metadataJson, ...record }: WireMemoryRecord): MemoryRecordDto {
  return {
    ...record,
    sourceId: record.sourceId ?? undefined,
    sourceTaskId: record.sourceTaskId ?? undefined,
    validFrom: record.validFrom ?? undefined,
    validUntil: record.validUntil ?? undefined,
    lastRecalledAt: record.lastRecalledAt ?? undefined,
    metadata: memoryMetadata(metadataJson),
    scopes: record.scopes.map((scope) => ({ ...scope, scopeId: scope.scopeId ?? undefined })),
    evidence: record.evidence.map((item) => ({
      ...item, refTitle: item.refTitle ?? undefined, excerpt: item.excerpt ?? undefined,
    })),
  };
}

export function memoryMetadata(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
