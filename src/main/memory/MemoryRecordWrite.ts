import { randomUUID } from "node:crypto";
import { LOCAL_USER_ID } from "../../shared/bot-work";
import type { MemoryCreateRequest, MemoryRecordDto, MemoryScopeType, MemorySourceType } from "../../shared/memory-kernel";
import type { WithdrawalTarget } from "./MemoryForgetWatermarks";
import type { WireMemoryRecord } from "./MemoryRecordsData";

type MutableFields = Pick<MemoryRecordDto,
  "id" | "kind" | "title" | "content" | "status" | "importance" | "confidence" | "explicit" |
  "validFrom" | "validUntil" | "contentHash" | "updatedAt"
> & { metadataJson: string };

interface Revision {
  revisionId: string;
  changedAt: number;
  changedBy: MemorySourceType;
  reason: string;
}

type RuntimeMemorySaveRequest =
  | { kind: "create"; record: MutableFields & Pick<MemoryRecordDto,
    "createdAt" | "sourceType" | "sourceId" | "sourceTaskId" | "evidence"
  >; scope: Pick<MemoryCreateRequest, "scopeType" | "scopeId"> & { id: string }; revision: Revision; userId: string }
  | { kind: "update"; record: MutableFields; expectedRevision: number; revision: Revision };

type Withdrawal = { signature: string; cutoffAt: number; targets: WithdrawalTarget[] };

export type RuntimeMemoryRecordWriteRequest = RuntimeMemorySaveRequest
  | { kind: "promoteScope"; id: string; scope: { id: string; scopeType: MemoryScopeType; scopeId?: string }; userId: string; now: number }
  | { kind: "detachScope"; id: string; scopeType: MemoryScopeType; scopeId?: string; withdrawal: Withdrawal }
  | { kind: "rejectCandidate"; id: string; at: number }
  | { kind: "forget"; id: string; withdrawal: Withdrawal };

export type RuntimeMemoryRecordWriteReply =
  | { status: "applied"; record: WireMemoryRecord }
  | { status: "forgotten"; refreshDots: boolean }
  | { status: "detached"; forgotten: boolean }
  | { status: "candidateRejected" }
  | { status: "needsHost" | "stale" }
  | { status: "rejected"; message: string };

function mutableFields(record: MemoryRecordDto): MutableFields {
  const {
    id, kind, title, content, status, importance, confidence, explicit,
    validFrom, validUntil, contentHash, updatedAt, metadata,
  } = record;
  return {
    id, kind, title, content, status, importance, confidence, explicit,
    validFrom, validUntil, contentHash, updatedAt, metadataJson: JSON.stringify(metadata ?? {}),
  };
}

export function createMemoryWrite(record: MemoryRecordDto): RuntimeMemorySaveRequest {
  const { sourceType, sourceId, sourceTaskId, createdAt, evidence } = record;
  const { scopeType, scopeId } = record.scopes[0];
  return {
    kind: "create",
    record: { ...mutableFields(record), sourceType, sourceId, sourceTaskId, createdAt, evidence },
    scope: { id: randomUUID(), scopeType, scopeId },
    revision: { revisionId: randomUUID(), changedAt: Date.now(), changedBy: sourceType, reason: "created" },
    userId: LOCAL_USER_ID,
  };
}

export function updateMemoryWrite(
  record: MemoryRecordDto, expectedRevision: number, changedBy: MemorySourceType, reason: string,
): RuntimeMemorySaveRequest {
  return {
    kind: "update", record: mutableFields(record), expectedRevision,
    revision: { revisionId: randomUUID(), changedAt: Date.now(), changedBy, reason },
  };
}

export function nativeMemoryWriteCompatible(request: RuntimeMemorySaveRequest): boolean {
  const { record, revision } = request;
  const strings = [record.title, record.content, revision.reason];
  if (request.kind === "create") {
    strings.push(request.scope.scopeId ?? "", request.record.sourceId ?? "", request.record.sourceTaskId ?? "");
    for (const evidence of request.record.evidence) {
      strings.push(evidence.refId, evidence.refTitle ?? "", evidence.excerpt ?? "");
    }
  }
  return strings.every(value => !/[\uD800-\uDFFF]/u.test(value))
    && [record.validFrom, record.validUntil].every(value => value === undefined || Number.isFinite(value));
}
