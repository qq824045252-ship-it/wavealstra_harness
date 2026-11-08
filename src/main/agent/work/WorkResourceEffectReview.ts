import type Database from "better-sqlite3";
import { z } from "zod";
import type { ResourceLease } from "./WorkResourceGate";

/** Human inspection is a distinct audited fact, never a fabricated native verifier. */
export function readUserResourceEffectReview(db: Database.Database, lease: ResourceLease): {
  known: boolean; receipt: string; conclusion?: "not_occurred" | "occurred";
} {
  const preparation = readResourceEffectPreparation(db, lease);
  if (!preparation?.readyAt) return { known: false, receipt: "effect-review-not-prepared" };
  const row = z.object({ action_id: z.string(), owner_json: z.string(), resources_json: z.string(),
    user_id: z.string(), reviewed_at: z.number(), conclusion: z.enum(["not_occurred", "occurred"]), receipt_json: z.string() }).optional()
    .parse(db.prepare("SELECT * FROM work_resource_effect_reviews WHERE token=?").get(lease.token));
  if (!row || row.reviewed_at < preparation.readyAt || row.action_id !== lease.actionId || row.owner_json !== JSON.stringify(lease.owner)
    || row.resources_json !== JSON.stringify(lease.resources)) return { known: false, receipt: "no-exact-user-effect-review" };
  const work = z.object({ user_id: z.string() }).optional().parse(db.prepare("SELECT user_id FROM works WHERE work_id=?").get(lease.owner.workId));
  if (!work || work.user_id !== row.user_id) return { known: false, receipt: "effect-review-owner-mismatch" };
  return { known: true, receipt: row.receipt_json, conclusion: row.conclusion };
}

export function readResourceEffectPreparation(db: Database.Database, lease: ResourceLease): {
  preparedAt: number; readyAt?: number; userId: string;
} | undefined {
  const row = z.object({ action_id: z.string(), owner_json: z.string(), resources_json: z.string(), user_id: z.string(),
    prepared_at: z.number(), ready_at: z.number().nullable() }).optional()
    .parse(db.prepare("SELECT * FROM work_resource_effect_preparations WHERE token=?").get(lease.token));
  if (!row || row.action_id !== lease.actionId || row.owner_json !== JSON.stringify(lease.owner)
    || row.resources_json !== JSON.stringify(lease.resources)) return;
  const binding = db.prepare("SELECT invalidated_at FROM work_execution_bindings WHERE binding_id=? AND task_id=?")
    .get(lease.owner.bindingId, lease.owner.taskId) as { invalidated_at: number | null } | undefined;
  if (!binding?.invalidated_at) return;
  return { preparedAt: row.prepared_at, readyAt: row.ready_at ?? undefined, userId: row.user_id };
}

/** Invoked only after the native stop, owned-child and input probes succeeded. */
export function markResourceEffectReady(db: Database.Database, lease: ResourceLease, receipt: string, now: number): void {
  if (!db.inTransaction || !receipt || !readResourceEffectPreparation(db, lease)) throw new Error("核对准备缺少原执行身份或事务");
  db.prepare("UPDATE work_resource_effect_preparations SET ready_at=?,quiet_receipt=? WHERE token=? AND ready_at IS NULL")
    .run(now, receipt, lease.token);
}


/** A failed final quiet/input probe invalidates the inspection window, not its audit history. */
export function invalidateResourceEffectReview(db: Database.Database, lease: ResourceLease): boolean {
  if (!db.inTransaction) throw new Error("核对失效必须与恢复状态同事务提交");
  if (!readResourceEffectPreparation(db, lease)?.readyAt) return false;
  // Immutable user-control outbox events retain the original inspection and evidence.
  // Remove active attestations so neither automatic retry nor a stale form can reuse them.
  db.prepare("DELETE FROM work_resource_effect_reviews WHERE token=?").run(lease.token);
  db.prepare("DELETE FROM work_resource_effect_preparations WHERE token=?").run(lease.token);
  return true;
}
