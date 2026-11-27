import type { MemoryCandidateDto, MemoryKind } from "../../shared/memory-kernel";

export type CoreMemoryExtractionScope = {
  scopeType: "global" | "workspace" | "project" | "task";
  scopeId: string | null;
};

export type CoreMemoryExtractionRecord = CoreMemoryExtractionScope & {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  status: string;
  contentHash: string;
  revision: number;
  mutationAllowed: boolean;
};

export type CoreMemoryExtractionReadyBasis = {
  kind: "extractionBasis";
  status: "ready";
  basisStamp: string;
  turns: Array<{ id: string; taskId: string; userText: string; capturedAt: number }>;
  withheldSourceCount: number;
  scopes: CoreMemoryExtractionScope[];
  records: CoreMemoryExtractionRecord[];
};

export type RuntimeMemoryExtractionBasisRequest = { kind: "extractionBasis" };
export type RuntimeMemoryExtractionBasis = CoreMemoryExtractionReadyBasis
  | { kind: "extractionBasis"; status: "stale" | "blocked"; reason?: string };

export type CoreMemoryExtractionCandidate = CoreMemoryExtractionScope & Pick<MemoryCandidateDto,
  "kind" | "title" | "content" | "confidence" | "importance" | "explicit" | "operationHint" | "replaces"
> & {
  evidence?: { turnId: string; quote: string };
  action: { kind: "review" | "create" }
    | { kind: "update" | "resolve" | "duplicate"; targetId: string; expectedRevision: number };
};

export type CoreMemoryExtractionPlan = { basisStamp: string; candidates: CoreMemoryExtractionCandidate[] };
export type RuntimeMemoryExtractionPublish = { kind: "publish" } & CoreMemoryExtractionPlan;
export type RuntimeMemoryExtractionPublishReply = {
  status: "published";
  extractedCount: number;
  committedCount: number;
  reviewCount: number;
  changedScopes: Array<CoreMemoryExtractionScope["scopeType"]>;
  skippedSourceCount: number;
} | { status: "filtered"; skippedSourceCount: number }
  | { status: "stale"; reason?: string }
  | { status: "blocked"; reason?: string }
  | { status: "conflict"; reason?: string };
