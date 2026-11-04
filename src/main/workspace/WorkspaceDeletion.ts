import type { AppDatabase } from "../db/AppDatabase";

export type WorkspaceDeletionResult =
  | { ok: true; warning?: string }
  | { ok: false; reason: string; error: string };

/** Commit the empty-workspace check and deletion before any asynchronous, irreversible cleanup. */
export async function deleteEmptyWorkspace(
  db: AppDatabase,
  workspaceId: string,
  cleanup: ReadonlyArray<{ name: string; run: () => void | Promise<void> }>,
): Promise<WorkspaceDeletionResult> {
  try {
    // This is synchronous and rechecks owned documents inside the database transaction.
    // No renderer request can insert documents between its check and its commit.
    db.deleteSpace(workspaceId);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: error.includes("尚有") || error.includes("自有资料") ? "workspace_not_empty" : "unknown", error };
  }
  const warnings: string[] = [];
  for (const step of cleanup) {
    try { await step.run(); }
    catch (cause) { warnings.push(`${step.name}：${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  // Cleanup failures must not make the renderer retain a workspace that is already deleted.
  return warnings.length ? { ok: true, warning: `工作空间已删除，部分附属内容清理失败：${warnings.join("；")}` } : { ok: true };
}
