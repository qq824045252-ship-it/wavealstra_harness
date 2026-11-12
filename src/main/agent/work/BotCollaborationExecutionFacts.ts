import type Database from "better-sqlite3";
import { z } from "zod";
import { BotCollaborationRepository } from "./BotCollaborationRepository";
import { createHash } from "node:crypto";

/** Record the first real executor/provider attempt, never a queue admission. */
export function recordCollaborationExecutionStarted(db: Database.Database, taskId: string, at = Date.now()): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_collaborations'").get()) return;
  const bindings = db.prepare(`SELECT b.binding_id,b.work_id,w.user_id FROM work_execution_bindings b JOIN works w ON w.work_id=b.work_id
    WHERE b.task_id=? AND b.intent_revision=w.intent_revision AND b.owner_epoch=w.owner_epoch
      AND b.input_snapshot_id=w.input_snapshot_id AND b.invalidated_at IS NULL AND b.settled_at IS NULL`)
    .all(taskId).map(row => z.object({ binding_id: z.string(), work_id: z.string(), user_id: z.string() }).parse(row));
  if (!bindings.length) return;
  const repo = new BotCollaborationRepository(db);
  for (const binding of bindings) {
    const relation = repo.byWork(binding.user_id, binding.work_id);
    if (relation) repo.event(binding.user_id, relation.collaborationId,
      { operationId: `execution-start:${binding.binding_id}`, workId: binding.work_id, exchangeId: binding.binding_id, kind: "started", createdAt: at });
  }
}

/** Called after the failed delivery transaction has rolled back. */
export function recordCollaborationReturnFailure(db: Database.Database, userId: string, workId: string,
  error: unknown, phase: "delivery" | "review_or_delivery" = "delivery"): void {
  const message = error instanceof Error ? error.message : String(error);
  const repo = new BotCollaborationRepository(db);
  const row = repo.byWork(userId, workId);
  if (!row) return;
  const work = z.object({ input_snapshot_id: z.string() }).optional().parse(
    db.prepare("SELECT input_snapshot_id FROM works WHERE work_id=? AND user_id=?").get(workId, userId));
  const identity = createHash("sha256").update(JSON.stringify([work?.input_snapshot_id, phase, message])).digest("hex");
  repo.event(userId, row.collaborationId, { operationId: `return-failure:${identity}`, workId, kind: "failed",
    detail: `${phase === "delivery" ? "成果回传失败" : "成果整理或回传失败"}，正在保留原结果并等待重试：${message.slice(0, 2000)}` });
}
