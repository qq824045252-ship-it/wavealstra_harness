import type { Database } from "better-sqlite3";
import { activityTimeOrUndefined } from "../../../../shared/src/activity-time";
import type { RuntimeAuditReader } from "../../platform/runtime-audit";

interface MessageWorkspace { messageId: string; cwd: string }

interface TaskProjection {
  activityAt?: number;
  workspaces: MessageWorkspace[];
}

export type RuntimeDurableTaskProjectionRequest = {
  taskId: string;
  workspaces: MessageWorkspace[];
} & ({ kind: "snapshot"; status: string; activityAt?: number } | { kind: "rememberWorkspaces" });

export type RuntimeDurableTaskProjectionReply =
  | ({ status: "applied" } & TaskProjection)
  | { status: "rejected"; message: string }
  | { status: "needsHost" };

/** Stores MyBuddy task metadata before the corresponding Durable revision is published. */
export class DurableTaskProjection {
  private applyOnHost?: ReturnType<typeof hostProjection>;

  constructor(private readonly db: Database, private readonly rust?: Pick<RuntimeAuditReader, "writeDurableTaskProjection">) {}

  /** Publish the stored activity time and the original workspace for each requested message. */
  async writeSnapshot(taskId: string, status: string, at: unknown, workspaces: MessageWorkspace[]): Promise<TaskProjection> {
    return this.write({ kind: "snapshot", taskId, status, activityAt: activityTimeOrUndefined(at), workspaces });
  }

  async rememberWorkspaces(taskId: string, workspaces: MessageWorkspace[]): Promise<void> {
    if (workspaces.length) await this.write({ kind: "rememberWorkspaces", taskId, workspaces });
  }

  private async write(request: RuntimeDurableTaskProjectionRequest): Promise<TaskProjection> {
    if (this.rust) {
      const result = await this.rust.writeDurableTaskProjection(request);
      if (result?.status === "applied") return { activityAt: activityTimeOrUndefined(result.activityAt), workspaces: result.workspaces };
      if (result?.status === "rejected") throw new Error(result.message);
      // Only an explicit "needsHost" may fall back. A missing reply means the native
      // write may or may not have committed, so a second host write would publish a
      // conflicting projection (for example a stale status or a lost workspace origin).
      if (result?.status !== "needsHost") {
        throw Object.assign(new Error("Durable 任务投影结果未知：原生写入未确认，不会回退到 Node 写入"), {
          code: "DURABLE_PROJECTION_UNKNOWN",
        });
      }
    }
    this.applyOnHost ??= hostProjection(this.db);
    return this.applyOnHost.immediate(request);
  }
}

function hostProjection(db: Database) {
  // A projection that arrives late with an older activity time must not move the status
  // backwards; disconnects and retries deliver snapshots out of order.
  const setStatus = db.prepare(
    "UPDATE tasks SET status = @status WHERE id = @taskId AND status IS NOT @status AND (@activityAt IS NULL OR @activityAt >= updated_at)",
  );
  const touchUpdatedAt = db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ? AND updated_at < ?");
  const readUpdatedAt = db.prepare("SELECT updated_at FROM tasks WHERE id = ?");
  const rememberMessage = db.prepare(`INSERT OR IGNORE INTO durable_bot_message_workspaces (task_id, message_id, cwd)
    SELECT @taskId, @messageId, @cwd WHERE EXISTS (SELECT 1 FROM tasks WHERE id = @taskId)`);
  const readWorkspace = db.prepare<{ taskId: string; messageId: string }, { cwd: string }>(
    "SELECT cwd FROM durable_bot_message_workspaces WHERE task_id = @taskId AND message_id = @messageId",
  );
  return db.transaction((request: RuntimeDurableTaskProjectionRequest): TaskProjection => {
    let activityAt: number | undefined;
    if (request.kind === "snapshot") {
      // Only a positive activity time orders the write; anything else carries no ordering.
      const ordering = typeof request.activityAt === "number" && Number.isFinite(request.activityAt) && request.activityAt > 0
        ? request.activityAt : null;
      setStatus.run({ status: request.status, taskId: request.taskId, activityAt: ordering });
      const candidate = request.activityAt;
      if (candidate !== undefined && touchUpdatedAt.run(candidate, request.taskId, candidate).changes > 0) activityAt = candidate;
      else {
        const row = readUpdatedAt.get(request.taskId) as { updated_at: unknown } | undefined;
        activityAt = activityTimeOrUndefined(row?.updated_at) ?? candidate;
      }
    }
    for (const { messageId, cwd } of request.workspaces) rememberMessage.run({ taskId: request.taskId, messageId, cwd });
    const workspaces: MessageWorkspace[] = [];
    if (request.kind === "snapshot") {
      for (const { messageId } of request.workspaces) {
        const row = readWorkspace.get({ taskId: request.taskId, messageId });
        if (row) workspaces.push({ messageId, cwd: row.cwd });
      }
    }
    return { activityAt, workspaces };
  });
}
