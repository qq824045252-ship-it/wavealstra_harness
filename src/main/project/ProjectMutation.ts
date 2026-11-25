import type { ProjectDto, ProjectEventPromotedBy, ProjectResourceDto, ProjectReviewDto, ProjectTodoDto } from "../../shared/project-domain";
import type { MemoryEvidenceDto, MemoryRecordDto } from "../../shared/memory-kernel";
import type { MemoryWithdrawalSource, WithdrawalTarget } from "../memory/MemoryForgetWatermarks";

export type ProjectWriteDomain = "project" | "todo" | "eventTodoPromotion" | "eventLibraryPromotion" | "deletion" | "memory" | "memoryEdits" | "review";
export type ProjectLibraryPromotion = {
  projectId: string;
  eventId: string;
  promotedBy: ProjectEventPromotedBy;
  actorTaskId?: string;
  createdAt: number;
  spaceName: string;
  title: string;
  content: string;
};
export type RuntimeProjectLibraryPromotion = ProjectLibraryPromotion & {
  root: string;
  operationId: string;
  promotionId: string;
  spaceId: string;
  itemId: string;
  owner: string;
  savedAt: number;
  chunkSize: number;
  overlap: number;
};
export type ProjectLibraryPromotionReply =
  | { status: "changed" | "existingPromotion" | "needsHost" }
  | { status: "rejected"; message: string };
export type ProjectWithdrawalSnapshot = { signature: string; records: MemoryWithdrawalSource[] };
export type ProjectWithdrawal = { signature: string; cutoffAt: number; targets: WithdrawalTarget[] };
export type ProjectDeletion = { status: "deleted"; itemIds: string[]; jobIds: string[] };
export type ProjectDeletionResult = ProjectDeletion | { status: "memoryChanged" | "libraryScopeChanged" };
type ProjectTodoWrite = Omit<ProjectTodoDto, "tags"> & { tagsJson: string };
export type ProjectMemoryWrite = Pick<MemoryRecordDto,
  "id" | "kind" | "title" | "content" | "status" | "importance" | "confidence" | "explicit" | "sourceType"
  | "sourceTaskId" | "contentHash" | "createdAt" | "evidence"> & {
  metadataJson: string;
  scopeRowId: string;
  revisionId: string;
};
export type ProjectMemoryEdit = Pick<MemoryRecordDto,
  "id" | "kind" | "title" | "content" | "status" | "importance" | "contentHash" | "updatedAt"> & {
  metadataJson: string;
  expectedRevision: number;
  revisionId: string;
};
export type ProjectMemoryProjection = Pick<MemoryRecordDto,
  "id" | "kind" | "title" | "content" | "status" | "importance" | "metadata" | "sourceType" | "createdAt" | "updatedAt"> & {
  sourceTaskId?: string | null;
  evidence: Array<Pick<MemoryEvidenceDto, "id" | "evidenceKind" | "refId" | "createdAt"> & { refTitle?: string | null }>;
};

export type ProjectMutation =
  | { kind: "create"; project: ProjectDto; policiesJson: string; resources: ProjectResourceDto[]; source?: { id: string; updatedAt: number } }
  | { kind: "edit"; project: ProjectDto; expectedUpdatedAt: number; defaultSpacePath?: string; policiesJson?: string }
  | { kind: "archive"; id: string; archived: boolean; updatedAt: number }
  | { kind: "saveResource"; resource: ProjectResourceDto; expectedUpdatedAt: number; create: boolean }
  | { kind: "deleteResource"; id: string; projectId: string; expectedUpdatedAt: number; updatedAt: number }
  | { kind: "saveTodo"; todo: ProjectTodoWrite; expectedUpdatedAt?: number; sourceTaskId?: string }
  | { kind: "deleteTodo"; id: string; projectId: string; updatedAt: number }
  | { kind: "recordReview"; review: ProjectReviewDto; actorTaskId?: string }
  | { kind: "promoteEventToTodo"; todo: ProjectTodoWrite; eventId: string; promotionId: string;
    promotedBy: "user" | "agent"; createdAt: number; sourceTaskId?: string }
  | { kind: "createMemory"; projectId: string; memory: ProjectMemoryWrite;
    actorTaskId?: string; promotion?: { eventId: string; id: string; promotedBy: "user" | "agent"; createdAt: number } }
  | { kind: "editMemory"; projectId: string; edit: ProjectMemoryEdit; actorTaskId?: string }
  | { kind: "detachMemory"; projectId: string; id: string; withdrawal: ProjectWithdrawal };

export type ProjectWriteStatus = "changed" | "missing" | "stale" | "archived" | "nameTaken" | "invalidSpace" | "invalidParent"
  | "scopeChanged" | "missingEvent" | "existingPromotion" | "invalidEvidence" | "missingMemory" | "sharedMemory" | "unchanged";
