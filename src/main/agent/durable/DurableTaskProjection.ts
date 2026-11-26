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
  workspaces?: MessageWorkspace[];
} & (
  | { kind: "snapshot"; status: string; activityAt?: number; workspaces: MessageWorkspace[] }
  | { kind: "rememberWorkspaces"; workspaces: MessageWorkspace[] }
  | { kind: "bindBot"; directory: string; cwd: string; updateCwdIfExists?: boolean }
  | { kind: "commitBranch"; directory: string; cwd: string; inheritedLastEntryId: number }
  | { kind: "rebindGatewayDirectory"; previousDirectory: string; nextDirectory: string }
  | { kind: "queueWorkspaceMove"; fromCwd: string; toCwd: string }
);

export type RuntimeDurableTaskProjectionReply =
  | ({ status: "applied" } & TaskProjection)
  | { status: "rejected"; message: string }
  | { status: "needsHost" };

/** Stores MyBuddy task metadata before the corresponding Durable revision is published. */
export class DurableTaskProjection {
  private applyOnHost?: ReturnType<typeof hostProjection>;

  constructor(
    private readonly db: Database,
    private readonly rust?: Pick<RuntimeAuditReader, "writeDurableTaskProjection" | "supervised">,
  ) {}

  /** Publish the stored activity time and the original workspace for each requested message. */
  async writeSnapshot(taskId: string, status: string, at: unknown, workspaces: MessageWorkspace[]): Promise<TaskProjection> {
    return this.write({ kind: "snapshot", taskId, status, activityAt: activityTimeOrUndefined(at), workspaces });
  }

  async rememberWorkspaces(taskId: string, workspaces: MessageWorkspace[]): Promise<void> {
    if (workspaces.length) await this.write({ kind: "rememberWorkspaces", taskId, workspaces });
  }

  async bindBot(taskId: string, directory: string, cwd: string, updateCwdIfExists = false): Promise<void> {
    if (!this.db.readonly) {
      this.db.prepare("INSERT OR IGNORE INTO durable_bot_bindings(task_id, backend, directory, cwd) VALUES (?, 'pi-durable', ?, ?)").run(taskId, directory, cwd);
      if (updateCwdIfExists) this.db.prepare("UPDATE durable_bot_bindings SET cwd = ? WHERE task_id = ?").run(cwd, taskId);
      return;
    }
    await this.write({ kind: "bindBot", taskId, directory, cwd, updateCwdIfExists });
  }

  async commitBranch(taskId: string, directory: string, cwd: string, inheritedLastEntryId: number): Promise<void> {
    if (!this.db.readonly) {
      this.db.prepare("INSERT INTO durable_bot_bindings(task_id, backend, directory, cwd) VALUES (?, 'pi-durable', ?, ?)").run(taskId, directory, cwd);
      this.db.prepare("INSERT INTO durable_bot_memory_projection(task_id, entry_id) VALUES (?, ?)").run(taskId, inheritedLastEntryId);
      return;
    }
    await this.write({ kind: "commitBranch", taskId, directory, cwd, inheritedLastEntryId });
  }

  async rebindGatewayDirectory(taskId: string, previousDirectory: string, nextDirectory: string): Promise<void> {
    if (!this.db.readonly) {
      this.db.prepare("UPDATE durable_bot_bindings SET directory = ? WHERE task_id = ? AND directory = ?").run(nextDirectory, taskId, previousDirectory);
      return;
    }
    await this.write({ kind: "rebindGatewayDirectory", taskId, previousDirectory, nextDirectory });
  }

  async queueWorkspaceMove(taskId: string, fromCwd: string, toCwd: string): Promise<void> {
    if (!this.db.readonly) {
      this.db.prepare("INSERT OR REPLACE INTO durable_bot_workspace_moves VALUES (?, ?, ?)").run(taskId, fromCwd, toCwd);
      return;
    }
    await this.write({ kind: "queueWorkspaceMove", taskId, fromCwd, toCwd });
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
      if (this.rust.supervised) {
        throw new Error("Durable 任务投影需要 Rust 核心确认，不会回退到 Node 写入");
      }
    }
    if (this.rust?.supervised || this.db.readonly) {
      throw new Error("只读模式下 Durable 任务投影需要 Rust 核心确认");
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
    for (const { messageId, cwd } of request.workspaces ?? []) rememberMessage.run({ taskId: request.taskId, messageId, cwd });
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
