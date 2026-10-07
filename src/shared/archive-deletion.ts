/** Explicit permanent deletion from archive management; ordinary delete still uses trash. */
export const ArchivedContentDeletionIpc = { purge: "db:purgeArchivedContent" } as const;

export interface ArchivedContentDeletionRequest {
  spaceIds: string[];
  taskIds: string[];
}

export interface ArchivedContentDeletionResult {
  deletedTaskIds: string[];
  deletedSpaceIds: string[];
  /** May accompany a deleted id when a post-delete cleanup failed. */
  failures: Array<{ kind: "task" | "space"; id: string; error: string }>;
}
