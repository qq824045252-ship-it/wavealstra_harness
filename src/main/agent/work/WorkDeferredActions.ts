import { ensureWorkDeferredTables } from "../../db/bot-work-deferred-schema";
import { realpathSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";

const payloadSchema = z.object({
  taskRoot: z.string(), toolName: z.string(), arguments: z.record(z.string(), z.json()),
  originalCall: z.object({ name: z.string(), arguments: z.record(z.string(), z.json()) }),
  actionKind: z.string(), permissionMode: z.enum(["default", "auto", "readonly"]),
  canonicalCwd: z.string().optional(), canonicalTarget: z.string().optional(),
  sourceConversationId: z.string().optional(),
  nativeContext: z.record(z.string(), z.json()).optional(),
});
export type WorkDeferredPayload = z.infer<typeof payloadSchema>;
export type WorkDeferredState = "deferred" | "queued" | "running" | "consumed" | "unknown" | "invalidated";
const rowSchema = z.object({ approval_id: z.string(), payload_json: z.string(), payload_hash: z.string(),
  state: z.enum(["deferred", "queued", "running", "consumed", "unknown", "invalidated"]),
  delivery_generation: z.number().int(), attempt_operation_id: z.string().nullable(), reason: z.string().nullable() });
export const deferredPayloadHash = (payload: WorkDeferredPayload) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");
/** Resolve existing ancestors without treating a missing new file as unsafe. */
function canonicalPath(path: string): string {
  let cursor = resolve(path); const suffix: string[] = [];
  for (;;) {
    try { return join(realpathSync(cursor), ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(cursor) === cursor) throw error;
      suffix.push(basename(cursor)); cursor = dirname(cursor);
    }
  }
}
export function deferredTargetUnchanged(payload: WorkDeferredPayload): boolean {
  try {
    return (!payload.canonicalCwd || canonicalPath(payload.taskRoot) === payload.canonicalCwd)
      && (!payload.canonicalTarget || typeof payload.arguments.path === "string"
        && canonicalPath(resolve(payload.taskRoot, payload.arguments.path)) === payload.canonicalTarget);
  } catch { return false; }
}
/** Private durable execution payload. Never part of projections, logs, or approval DTOs. */
export class WorkDeferredActions {
  constructor(private readonly db: Database.Database) {
    ensureWorkDeferredTables(db);
  }
  register(approvalId: string, input: WorkDeferredPayload, now: number): void {
    const payload = payloadSchema.parse({ ...input, canonicalCwd: canonicalPath(input.taskRoot),
      canonicalTarget: ["write", "edit", "read"].includes(input.toolName) && typeof input.arguments.path === "string"
        ? canonicalPath(resolve(input.taskRoot, input.arguments.path)) : undefined });
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, "utf8") > 1_048_576) throw new Error("暂缓动作参数超过持久化上限，未登记执行意图");
    const hash = deferredPayloadHash(payload), existing = this.get(approvalId);
    if (existing && existing.payloadHash !== hash) throw new Error("暂缓动作参数不能变更");
    this.db.prepare(`INSERT OR IGNORE INTO work_deferred_actions
      (approval_id,payload_json,payload_hash,state,created_at,updated_at) VALUES (?,?,?,'deferred',?,?)`)
      .run(approvalId, json, hash, now, now);
  }
  get(approvalId: string) {
    const raw = this.db.prepare("SELECT * FROM work_deferred_actions WHERE approval_id=?").get(approvalId);
    if (!raw) return undefined;
    const row = rowSchema.parse(raw);
    let payload: WorkDeferredPayload;
    try {
      payload = payloadSchema.parse(JSON.parse(row.payload_json));
      if (deferredPayloadHash(payload) !== row.payload_hash) throw new Error("hash mismatch");
    } catch {
      const status = row.state === "consumed" ? "consumed" : ["running", "unknown"].includes(row.state) ? "unknown" : "invalidated";
      this.settle(approvalId, status, Date.now(), status === "invalidated"
        ? "原动作参数损坏或版本不兼容，未执行；请重新建立精确动作"
        : status === "consumed" ? "原动作已结算，但存储参数无法读取；未重新执行"
          : "原动作参数无法核对，可能已有执行效果；保留未知效果，禁止重放");
      return undefined;
    }
    return { approvalId: row.approval_id, deliveryId: `${row.approval_id}:${row.delivery_generation}`, payload, payloadHash: row.payload_hash, status: row.state,
      attemptOperationId: row.attempt_operation_id ?? undefined, reason: row.reason ?? undefined };
  }
  state(approvalId: string): { status: WorkDeferredState; reason?: string } | undefined {
    const raw = this.db.prepare("SELECT * FROM work_deferred_actions WHERE approval_id=?").get(approvalId);
    if (!raw) return undefined;
    const row = rowSchema.parse(raw); return { status: row.state, reason: row.reason ?? undefined };
  }
  forOperation(operationId: string) {
    const raw = this.db.prepare("SELECT approval_id FROM work_deferred_actions WHERE attempt_operation_id=?").get(operationId);
    return raw ? this.get(z.object({ approval_id: z.string() }).parse(raw).approval_id) : undefined;
  }
  listQueued() {
    return this.db.prepare("SELECT approval_id FROM work_deferred_actions WHERE state IN ('queued','running') ORDER BY created_at,rowid")
      .all().flatMap(raw => { const row = this.get(z.object({ approval_id: z.string() }).parse(raw).approval_id); return row ? [row] : []; });
  }
  enqueue(approvalId: string, now: number): boolean {
    return this.db.prepare("UPDATE work_deferred_actions SET state='queued',delivery_generation=delivery_generation+1,reason=NULL,updated_at=? WHERE approval_id=? AND state='deferred'")
      .run(now, approvalId).changes === 1;
  }
  claim(approvalId: string, operationId: string, now: number): boolean {
    return this.db.prepare("UPDATE work_deferred_actions SET state='running',attempt_operation_id=?,updated_at=? WHERE approval_id=? AND state='queued' AND attempt_operation_id IS NULL")
      .run(operationId, now, approvalId).changes === 1;
  }
  settle(approvalId: string, status: WorkDeferredState, now: number, reason?: string): void {
    this.db.prepare("UPDATE work_deferred_actions SET state=?,reason=?,updated_at=? WHERE approval_id=?")
      .run(status, reason ?? null, now, approvalId);
  }
}
