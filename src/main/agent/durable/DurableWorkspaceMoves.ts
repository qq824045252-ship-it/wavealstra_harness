import type { AppDatabase } from "../../db/AppDatabase";

export interface DurableWorkspaceMove {
  fromCwd: string;
  toCwd: string;
}

export type RuntimeDurableWorkspaceMoveRequest = DurableWorkspaceMove & { taskId: string } & (
  | { kind: "stage" }
  | { kind: "cancel" }
  | { kind: "commit"; cwd: string; at: number }
);

export type RuntimeDurableWorkspaceMoveReply =
  | { status: "applied" | "needsHost" }
  | { status: "rejected"; message: string };

const CONFLICT = "任务工作目录搬迁记录已变化";
const PROTECTED = "任务已删除或在回收站中";

/** app.db intent and projection around the separate Pi workspace transaction. */
export class DurableWorkspaceMoves {
  constructor(private readonly db: AppDatabase) {}

  read(taskId: string): DurableWorkspaceMove | undefined {
    return this.db.connection.prepare<[string], DurableWorkspaceMove>(`
      SELECT from_cwd AS fromCwd, to_cwd AS toCwd FROM durable_bot_workspace_moves WHERE task_id = ?
    `).get(taskId);
  }

  async write(request: RuntimeDurableWorkspaceMoveRequest): Promise<void> {
    const worker = this.db.runtimeAuditReader;
    if (worker) {
      const reply = await worker.writeDurableWorkspaceMove(request);
      if (reply?.status === "applied") return;
      if (reply?.status === "rejected") throw new Error(reply.message);
      if (reply?.status !== "needsHost") throw new Error("任务工作目录搬迁的写入结果未确认，请重新打开任务");
    }
    this.db.connection.transaction(() => this.writeOnHost(request)).immediate();
  }

  private writeOnHost(request: RuntimeDurableWorkspaceMoveRequest): void {
    const { taskId, fromCwd, toCwd } = request;
    const db = this.db.connection;
    const state = db.prepare<[string], {
      taskCwd: string | null;
      bound: string | null;
      pendingFrom: string | null;
      pendingTo: string | null;
    }>(`
      SELECT t.cwd AS taskCwd, b.cwd AS bound, m.from_cwd AS pendingFrom, m.to_cwd AS pendingTo
      FROM tasks t
      LEFT JOIN durable_bot_bindings b ON b.task_id = t.id
      LEFT JOIN durable_bot_workspace_moves m ON m.task_id = t.id
      WHERE t.id = ? AND NOT EXISTS (
        SELECT 1 FROM task_execution_workspace_state w
        WHERE w.task_id = t.id AND w.state = 'trashed'
      )
    `).get(taskId);
    if (!state) throw new Error(PROTECTED);
    const { taskCwd, bound, pendingFrom, pendingTo } = state;
    const pending = pendingFrom !== null;
    if (pending && (pendingFrom !== fromCwd || pendingTo !== toCwd)) throw new Error(CONFLICT);

    if (request.kind === "stage" && bound === fromCwd) {
      if (!pending) db.prepare("INSERT INTO durable_bot_workspace_moves(task_id,from_cwd,to_cwd) VALUES (?,?,?)").run(taskId, fromCwd, toCwd);
      return;
    }
    if (request.kind === "commit") {
      if (!pending && bound === request.cwd && taskCwd === request.cwd) return;
      if (!pending || (bound !== fromCwd && bound !== request.cwd)) throw new Error(CONFLICT);
      db.prepare("UPDATE durable_bot_bindings SET cwd = ? WHERE task_id = ?").run(request.cwd, taskId);
      db.prepare("UPDATE tasks SET cwd = ?, updated_at = max(updated_at, ?) WHERE id = ?").run(request.cwd, request.at, taskId);
    } else if (request.kind !== "cancel" || bound !== fromCwd) {
      throw new Error(CONFLICT);
    }
    db.prepare("DELETE FROM durable_bot_workspace_moves WHERE task_id = ? AND from_cwd = ? AND to_cwd = ?")
      .run(taskId, fromCwd, toCwd);
  }
}
