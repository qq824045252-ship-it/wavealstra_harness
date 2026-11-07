import type Database from "better-sqlite3";
import { resolve } from "node:path";
import { z } from "zod";
import type { ResourceRecoveryAttempt } from "../../../shared/resource-recovery";
import { WorkResourceGate, type ResourceLease } from "./WorkResourceGate";

export type { ResourceRecoveryAttempt } from "../../../shared/resource-recovery";
export interface ResourceExecutionQuiet {
  executionStopped: boolean;
  ownedChildrenStopped: boolean;
  receipt: string;
}
export interface WorkResourceRecoveryPort {
  inspectExecution(lease: ResourceLease, recovery: ResourceRecoveryAttempt): Promise<ResourceExecutionQuiet>;
  drainInput(lease: ResourceLease, execution: ResourceExecutionQuiet, recovery: ResourceRecoveryAttempt): Promise<{ queueDrained: boolean; inputReleased: boolean; receipt: string }>;
  verifyEffect(lease: ResourceLease, recovery: ResourceRecoveryAttempt): Promise<{ known: boolean; receipt: string }>;
  onRecovered?(lease: ResourceLease, receipt: string): void;
  transaction?<T>(fn: () => T): T;
}
const MAX_ATTEMPTS = 4;
const recoverySchema = z.object({ attempts: z.number().int().nonnegative(), next_at: z.number(), exhausted_at: z.number().nullable() });
interface RecoveryFlight {
  context: ResourceRecoveryAttempt;
  controller: AbortController;
  outstanding: number;
  finished: boolean;
  onRetired(): void;
}
// A timeout ends the waiter, not necessarily the native operation. Retain this
// barrier until the ORIGINAL promise settles, including across service/DB reopen.
const memoryFlights = new WeakMap<Database.Database, Map<number, RecoveryFlight>>();
const fileFlights = new Map<string, Map<number, RecoveryFlight>>();
function currentFlights(db: Database.Database): Map<number, RecoveryFlight> | undefined {
  return db.memory ? memoryFlights.get(db) : fileFlights.get(resolve(db.name));
}
export function hasPendingResourceRecoveryProbe(db: Database.Database, token: number): boolean {
  return currentFlights(db)?.has(token) ?? false;
}
function flightsFor(db: Database.Database): Map<number, RecoveryFlight> {
  const key = resolve(db.name);
  const previous = currentFlights(db);
  if (previous) return previous;
  const flights = new Map<number, RecoveryFlight>();
  if (db.memory) memoryFlights.set(db, flights); else fileFlights.set(key, flights);
  return flights;
}
function retireFlight(db: Database.Database, flight: RecoveryFlight): void {
  if (!flight.finished || flight.outstanding) return;
  const flights = currentFlights(db);
  if (flights?.get(flight.context.token) !== flight) return;
  flights.delete(flight.context.token);
  if (!flights.size && !db.memory) fileFlights.delete(resolve(db.name));
  flight.onRetired();
}

/** Monotonic attempt counter; an explicit retry opens another budget of four probes. */
export function retryWorkResourceRecovery(db: Database.Database, gate: WorkResourceGate, input: {
  workId: string; token: number; expectedAttempts: number; expectedExhaustedAt: number;
}): boolean {
  gate.assertAuthority();
  if (hasPendingResourceRecoveryProbe(db, input.token)) return false;
  // Older releases exhausted on the fifth failure. Advance such rows to the
  // next budget boundary; never reuse a previously issued (token, attempt).
  const result = db.prepare(`UPDATE work_resource_recovery
    SET attempts=attempts+((4-(attempts%4))%4),next_at=0,exhausted_at=NULL,reason=NULL,receipt_json=NULL
    WHERE token=? AND attempts=? AND exhausted_at=? AND token IN (
      SELECT token FROM work_resource_leases WHERE state='quarantined' AND json_extract(owner_json,'$.workId')=?)`)
    .run(input.token, input.expectedAttempts, input.expectedExhaustedAt, input.workId);
  return result.changes === 1;
}

/** Reconciles the original action. It never submits or retries business execution. */
export class WorkResourceRecovery {
  private pending?: Promise<void>;
  private readonly probeTimeoutMs: number;
  constructor(private readonly db: Database.Database, private readonly gate: WorkResourceGate,
    private readonly port: WorkResourceRecoveryPort, private readonly now: () => number = () => Date.now(),
    options: { probeTimeoutMs?: number } = {}) {
    this.probeTimeoutMs = Math.max(1, options.probeTimeoutMs ?? 4_000);
  }

  recover(): Promise<void> {
    this.pending ??= this.consume().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private read(token: number) {
    return recoverySchema.optional().parse(this.db.prepare("SELECT attempts,next_at,exhausted_at FROM work_resource_recovery WHERE token=?").get(token));
  }

  private claim(lease: ResourceLease): RecoveryFlight | undefined {
    const flights = flightsFor(this.db);
    if (flights.has(lease.token)) return;
    return this.commit(() => {
      this.gate.assertAuthority();
      const state = this.read(lease.token), now = this.now();
      if (this.gate.leaseState(lease) !== "quarantined" || state && (state.exhausted_at !== null || state.next_at > now)) return;
      const attempt = (state?.attempts ?? 0) + 1;
      const controller = new AbortController();
      const context: ResourceRecoveryAttempt = {
        token: lease.token, attempt, signal: controller.signal,
        assertCurrent: () => {
          controller.signal.throwIfAborted();
          try {
            this.gate.assertAuthority();
            if (flights.get(lease.token)?.context !== context || this.read(lease.token)?.attempts !== attempt
              || this.gate.leaseState(lease) !== "quarantined") throw new Error("资源恢复代次已变化，拒绝迟到探针和回执");
          } catch (error) { controller.abort(error); throw error; }
        },
      };
      // Charge before invoking a probe: restart cannot reuse an attempt, and a
      // crash in the fourth probe cannot silently grant a fifth automatic try.
      this.db.prepare(`INSERT INTO work_resource_recovery(token,attempts,next_at,exhausted_at,reason) VALUES (?,?,?,?,?)
        ON CONFLICT(token) DO UPDATE SET attempts=excluded.attempts,next_at=excluded.next_at,
          exhausted_at=excluded.exhausted_at,reason=excluded.reason,receipt_json=NULL`)
        .run(lease.token, attempt, now + this.probeTimeoutMs * 3 + 1_000, attempt % MAX_ATTEMPTS === 0 ? now : null, "正在核对原执行、输入清理和外部效果");
      const flight: RecoveryFlight = { context, controller, outstanding: 0, finished: false, onRetired: () => {
        if (!this.db.open) return;
        try {
          this.commit(() => {
            this.gate.assertAuthority();
            // The UI must see a cancelled native probe actually exit before it
            // offers manual rearming. The journal observes this same-row touch.
            this.db.prepare(`UPDATE work_resource_recovery SET reason=reason WHERE token=? AND attempts=?
              AND token IN (SELECT token FROM work_resource_leases WHERE state='quarantined')`).run(lease.token, attempt);
          });
        } catch { /* A lost authority/closed database leaves the lease quarantined. */ }
      } };
      flights.set(lease.token, flight);
      return flight;
    });
  }

  private async consume(): Promise<void> {
    const due = this.gate.fenceLost().filter(lease => {
      const state = this.read(lease.token);
      return !hasPendingResourceRecoveryProbe(this.db, lease.token) && (!state || state.exhausted_at === null && state.next_at <= this.now());
    }).slice(0, 4);
    for (const lease of due) {
      const flight = this.claim(lease);
      if (!flight) continue;
      const recovery = flight.context;
      try {
        const execution = await this.bounded(flight, () => this.port.inspectExecution(lease, recovery));
        if (!execution.executionStopped || !execution.ownedChildrenStopped || !execution.receipt) throw new Error("旧执行或 owned child 仍活动，资源保持隔离");
        const cleanup = await this.bounded(flight, () => this.port.drainInput(lease, execution, recovery));
        if (!cleanup.queueDrained || !cleanup.inputReleased || !cleanup.receipt) throw new Error("后端队列或本驱动输入释放尚未确认");
        const effect = lease.resources.every(resource => resource.mode === "read")
          ? { known: true, receipt: "read-only-action-no-mutation" } : await this.bounded(flight, () => this.port.verifyEffect(lease, recovery));
        if (!effect.known || !effect.receipt) throw new Error("原动作外部效果仍未知，没有重复执行");
        const evidence = { executionStopped: true, queueDrained: true, inputReleased: true, effectKnown: true,
          receipt: JSON.stringify({ token: recovery.token, attempt: recovery.attempt, execution: execution.receipt, cleanup: cleanup.receipt, effect: effect.receipt }) };
        this.commit(() => {
          recovery.assertCurrent();
          if (!this.gate.reconcileQuarantine(lease.token, evidence)) throw new Error("原资源代次已变化，保持原始事实待核对");
          this.port.onRecovered?.(lease, evidence.receipt);
          this.db.prepare(`UPDATE work_resource_recovery SET receipt_json=?,reason=NULL,exhausted_at=NULL,next_at=? WHERE token=? AND attempts=?`)
            .run(JSON.stringify(evidence), this.now(), lease.token, recovery.attempt);
        });
      } catch (error) {
        flight.controller.abort(error);
        this.commit(() => {
          this.gate.assertAuthority();
          const now = this.now();
          this.db.prepare(`UPDATE work_resource_recovery SET next_at=?,reason=?,
            exhausted_at=CASE WHEN attempts%4=0 THEN ? ELSE exhausted_at END
            WHERE token=? AND attempts=? AND token IN (SELECT token FROM work_resource_leases WHERE state='quarantined')`)
            .run(now + (((recovery.attempt - 1) % MAX_ATTEMPTS) + 1) * 1_000,
              error instanceof Error ? error.message : String(error), now, lease.token, recovery.attempt);
        });
      } finally {
        flight.finished = true;
        flight.controller.abort(new Error("资源恢复核对轮次已结束"));
        retireFlight(this.db, flight);
      }
    }
  }

  private async bounded<T>(flight: RecoveryFlight, operation: () => Promise<T>): Promise<T> {
    flight.context.assertCurrent();
    const original = operation();
    flight.outstanding++;
    const settled = () => { flight.outstanding--; retireFlight(this.db, flight); };
    void original.then(settled, settled);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([original, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error("资源核对超时，已取消本轮探针；原探针退出前继续隔离");
          flight.controller.abort(error);
          reject(error);
        }, this.probeTimeoutMs);
      })]);
      flight.context.assertCurrent();
      return result;
    } finally { if (timer) clearTimeout(timer); }
  }

  private commit<T>(fn: () => T): T { return this.port.transaction ? this.port.transaction(fn) : this.db.transaction(fn).immediate(); }
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
