/** Explicit permanent deletion from archive management; ordinary delete still uses trash. */
export const ArchivedContentDeletionIpc = { purge: "db:purgeArchivedContent" } as const;

/** Recoverable recycle-bin channels. Deleted tasks stay restorable until purgeAfter, then auto-purge. */
export const TrashIpc = {
  list: "db:listTrashedTasks",
  restore: "db:restoreTrashedTask",
} as const;

/**
 * Retention for the recoverable recycle bin. Deleted tasks keep their workspace directory for this
 * long, then become eligible for automatic purge (enforced by TaskExecutionWorkspaceLifecycle.purgeExpired).
 */
export const TRASH_RETENTION_DAYS = 7;
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** One recoverable entry in the recycle bin. */
export interface TrashedTaskDto {
  id: string;
  title: string;
  spaceId?: string;
  projectId?: string;
  /** When the task was moved into the recycle bin. */
  trashedAt?: number;
  /** Absolute deadline for automatic purge; absent for legacy entries. */
  purgeAfter?: number;
  /** True when the workspace directory is already gone (metadata-only entry). */
  directoryMissing: boolean;
}

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
