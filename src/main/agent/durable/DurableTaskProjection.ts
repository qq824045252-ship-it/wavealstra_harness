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
    }
    this.applyOnHost ??= hostProjection(this.db);
    return this.applyOnHost.immediate(request);
  }
}

function hostProjection(db: Database) {
  const setStatus = db.prepare("UPDATE tasks SET status = ? WHERE id = ? AND status IS NOT ?");
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
      setStatus.run(request.status, request.taskId, request.status);
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
