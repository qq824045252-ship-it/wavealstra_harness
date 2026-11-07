import type Database from "better-sqlite3";
import { z } from "zod";
import { WorkResourceGate, type ResourceLease } from "./WorkResourceGate";

export interface ResourceExecutionQuiet {
  executionStopped: boolean;
  ownedChildrenStopped: boolean;
  receipt: string;
}
export interface WorkResourceRecoveryPort {
  inspectExecution(lease: ResourceLease): Promise<ResourceExecutionQuiet>;
  drainInput(lease: ResourceLease, execution: ResourceExecutionQuiet): Promise<{ queueDrained: boolean; inputReleased: boolean; receipt: string }>;
  verifyEffect(lease: ResourceLease): Promise<{ known: boolean; receipt: string }>;
  onRecovered?(lease: ResourceLease, receipt: string): void;
  transaction?<T>(fn: () => T): T;
}
const recoverySchema = z.object({ attempts: z.number(), next_at: z.number(), exhausted_at: z.number().nullable() });

/** Reconciles the original action. It never submits or retries business execution. */
export class WorkResourceRecovery {
  private pending?: Promise<void>;
  constructor(private readonly db: Database.Database, private readonly gate: WorkResourceGate,
    private readonly port: WorkResourceRecoveryPort, private readonly now: () => number = () => Date.now()) {}

  recover(): Promise<void> {
    this.pending ??= this.consume().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  retryWork(workId: string): void {
    this.gate.assertAuthority();
    this.db.prepare(`UPDATE work_resource_recovery SET attempts=0,next_at=0,exhausted_at=NULL WHERE token IN (
      SELECT token FROM work_resource_leases WHERE json_extract(owner_json,'$.workId')=?)`).run(workId);
  }

  private async consume(): Promise<void> {
    const due = this.gate.fenceLost().filter(lease => {
      const state = recoverySchema.optional().parse(this.db.prepare("SELECT attempts,next_at,exhausted_at FROM work_resource_recovery WHERE token=?").get(lease.token));
      return !state || state.exhausted_at === null && state.next_at <= this.now();
    }).slice(0, 4);
    for (const lease of due) {
      try {
        const execution = await bounded(this.port.inspectExecution(lease));
        if (!execution.executionStopped || !execution.ownedChildrenStopped || !execution.receipt) throw new Error("旧执行或 owned child 仍活动，资源保持隔离");
        const cleanup = await bounded(this.port.drainInput(lease, execution));
        if (!cleanup.queueDrained || !cleanup.inputReleased || !cleanup.receipt) throw new Error("后端队列或本驱动输入释放尚未确认");
        const effect = lease.resources.every(resource => resource.mode === "read")
          ? { known: true, receipt: "read-only-action-no-mutation" } : await bounded(this.port.verifyEffect(lease));
        if (!effect.known || !effect.receipt) throw new Error("原动作外部效果仍未知，没有重复执行");
        const evidence = { executionStopped: true, queueDrained: true, inputReleased: true, effectKnown: true,
          receipt: JSON.stringify({ execution: execution.receipt, cleanup: cleanup.receipt, effect: effect.receipt }) };
        this.commit(() => {
          this.gate.assertAuthority();
          if (!this.gate.reconcileQuarantine(lease.token, evidence)) throw new Error("原资源代次已变化，保持原始事实待核对");
          this.port.onRecovered?.(lease, evidence.receipt);
          this.db.prepare(`INSERT INTO work_resource_recovery(token,attempts,next_at,receipt_json) VALUES (?,1,?,?)
            ON CONFLICT(token) DO UPDATE SET receipt_json=excluded.receipt_json,reason=NULL`)
            .run(lease.token, this.now(), JSON.stringify(evidence));
        });
      } catch (error) {
        const now = this.now();
        this.db.transaction(() => {
          this.gate.assertAuthority();
          this.db.prepare(`INSERT INTO work_resource_recovery(token,attempts,next_at,reason) VALUES (?,1,?,?)
            ON CONFLICT(token) DO UPDATE SET attempts=attempts+1,next_at=excluded.next_at+(attempts*1000),reason=excluded.reason,
            exhausted_at=CASE WHEN attempts>=4 THEN ? ELSE exhausted_at END`)
            .run(lease.token, now + 1000, error instanceof Error ? error.message : String(error), now);
        }).immediate();
      }
    }
  }
  private commit<T>(fn: () => T): T { return this.port.transaction ? this.port.transaction(fn) : this.db.transaction(fn).immediate(); }
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("资源核对超时，保留隔离")), 4000); })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Matches persisted verifier evidence to this exact native tool task, not root terminal status. */
export function readResourceEffectEvidence(db: Database.Database, lease: ResourceLease): { known: boolean; receipt: string } {
  if (!lease.actionId.startsWith("resource:")) return { known: false, receipt: "direct-managed-effect-needs-backend-readback" };
  const parts = lease.actionId.split(":");
  const nativeTaskId = parts[2], toolCallId = parts.slice(3).join(":");
  if (!nativeTaskId || !toolCallId) return { known: false, receipt: "missing-native-action-identity" };
  const executionId = `durable:${lease.owner.taskId}:${lease.owner.childId ?? lease.owner.conversationId}:${nativeTaskId}`;
  const row = z.object({ record_json: z.string() }).optional().parse(db.prepare(`SELECT record_json FROM execution_attempts
    WHERE task_id=? AND execution_id=? AND tool_call_id=? AND status='passed' ORDER BY finished_at DESC LIMIT 1`)
    .get(lease.owner.taskId, executionId, toolCallId));
  if (!row) return { known: false, receipt: "original-effect-verifier-not-settled" };
  const record = z.object({ id: z.string(), taskId: z.string(), executionId: z.string(), toolCallId: z.string(), target: z.string(),
    verifierId: z.enum(["durable-file-content", "durable-business-receipt"]), startedAt: z.number(),
    verification: z.object({ status: z.literal("passed"), attemptId: z.string(), taskId: z.string(), executionId: z.string(),
      target: z.string(), verifierId: z.string(), checkedAt: z.number() }).passthrough() }).safeParse(JSON.parse(row.record_json));
  if (!record.success) return { known: false, receipt: "no-verified-file-or-business-effect" };
  const value = record.data, proof = value.verification;
  const known = value.taskId === lease.owner.taskId && value.executionId === executionId && value.toolCallId === toolCallId
    && proof.attemptId === value.id && proof.taskId === value.taskId && proof.executionId === value.executionId
    && proof.target === value.target && proof.verifierId === value.verifierId && proof.checkedAt >= value.startedAt;
  return { known, receipt: known ? JSON.stringify({ attemptId: value.id, verifierId: value.verifierId, checkedAt: proof.checkedAt,
    durableStoreKey: lease.owner.durableStoreKey, conversationId: lease.owner.conversationId, childId: lease.owner.childId }) : "verifier-namespace-mismatch" };
}
