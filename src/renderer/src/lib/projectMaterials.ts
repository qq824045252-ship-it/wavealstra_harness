import type { RuntimeContextSnapshotDto } from "@shared/agent-ipc";
import type { LibrarySnapshotDto } from "@shared/library-ipc";

export interface ProjectMaterialDocumentStatus {
  loaded: boolean;
  total: number;
  common: number;
}

export interface ProjectMaterialSupplementalStatus {
  checked: boolean;
  total: number;
  eligible: number;
  included: number;
  includedChars: number;
  budgetChars: number;
}

export interface ProjectMaterialExecutionStatus {
  selected: boolean;
  executionId?: string;
  status?: RuntimeContextSnapshotDto["status"];
  readCount: number;
  injectedCount: number;
  omitted: number;
}

/** Presentation projection only. Library Service remains the authorization authority. */
export function projectLibraryMaterials(snapshot: LibrarySnapshotDto, projectId: string, query = "") {
  const spaces = snapshot.spaces.filter((space) => space.kind === "team" && space.projectId === projectId);
  const spaceIds = new Set(spaces.map((space) => space.id));
  const needle = query.trim().toLocaleLowerCase();
  const items = snapshot.items.filter((item) => spaceIds.has(item.spaceId)
    && (!needle || `${item.title}\n${item.filename}`.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  return { spaces, items };
}

/**
 * Execution evidence only. Read/injected counts mean the runtime returned or assembled content;
 * they are never a claim that the model understood, relied on, or adopted that material.
 */
export function projectExecutionMaterialStatus(record?: RuntimeContextSnapshotDto | null): ProjectMaterialExecutionStatus {
  if (!record) return { selected: false, readCount: 0, injectedCount: 0, omitted: 0 };
  return {
    selected: true,
    executionId: record.executionId,
    status: record.status,
    readCount: record.materialUsage?.items.length ?? 0,
    injectedCount: record.resolvedInstructions.filter((item) => item.source === "project" && item.chars > 0).length,
    omitted: record.materialUsage?.omitted ?? 0,
  };
}