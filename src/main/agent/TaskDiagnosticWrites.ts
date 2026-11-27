import { randomUUID } from "node:crypto";
import { RuntimeAuditUnknownOperationError, type RuntimeAuditReader, type RuntimeDiagnosticWrite } from "../platform/runtime-audit";
import type { DiagnosticUsageReceipt } from "./TaskDiagnosticsRepository";

const batchSize = 64;
const maxQueued = 512;

interface Batch {
  sequence: number;
  items: PendingWrite[];
}

interface PendingWrite {
  write: RuntimeDiagnosticWrite;
  receipt?: DiagnosticUsageReceipt;
}

/** Serializes native writes and exposes pending usage receipts to synchronous accounting. */
export class TaskDiagnosticWrites {
  private readonly writerId = randomUUID();
  private sequence = 0;
  private active?: Batch;
  private queued: PendingWrite[] = [];
  private draining?: Promise<void>;
  private warnedAt = 0;
  private submitted = 0;
  private settled = 0;
  private waiters: Array<{ through: number; resolve: () => void }> = [];

  constructor(private readonly reader: RuntimeAuditReader) {}

  add(write: RuntimeDiagnosticWrite, receipt?: DiagnosticUsageReceipt): void {
    if (this.queued.length >= maxQueued) {
      if (Date.now() - this.warnedAt >= 5000) {
        this.warnedAt = Date.now();
        console.warn("[RuntimeAudit] Diagnostic queue is full");
      }
      return;
    }
    this.submitted++;
    this.queued.push({ write, receipt });
    this.schedule();
  }

  private schedule(): void {
    if (!this.draining) {
      this.draining = new Promise<void>(resolve => setImmediate(resolve))
        .then(() => this.drain())
        .finally(() => {
          this.draining = undefined;
          if (this.queued.length) this.schedule();
        });
    }
  }

  flush(): Promise<void> {
    const through = this.submitted;
    if (this.settled >= through) return Promise.resolve();
    return new Promise(resolve => this.waiters.push({ through, resolve }));
  }

  requestReceipts(): Map<string, DiagnosticUsageReceipt> {
    const receipts = new Map<string, DiagnosticUsageReceipt>();
    for (const items of [this.active?.items ?? [], this.queued]) {
      for (const { receipt } of items) if (receipt) receipts.set(receipt.id, receipt);
    }
    return receipts;
  }

  private async drain(): Promise<void> {
    while (this.queued.length) {
      const items = this.queued.splice(0, batchSize);
      const through = this.settled + items.length;
      const traces = new Map<string, Extract<RuntimeDiagnosticWrite, { kind: "trace" }>["request"]>();
      const writes: RuntimeDiagnosticWrite[] = [];
      for (const { write } of items) {
        if (write.kind === "tool") { writes.push(write); continue; }
        const combined = traces.get(write.request.id);
        if (combined) { combined.events.push(...write.request.events); continue; }
        const request = { ...write.request, events: [...write.request.events] };
        traces.set(request.id, request);
        writes.push({ kind: "trace", request });
      }
      const batch = this.active = { sequence: ++this.sequence, items };
      try {
        const send = () => this.reader.writeDiagnostics(this.writerId, batch.sequence, writes);
        const committed = await send().catch(error => {
          if (error instanceof RuntimeAuditUnknownOperationError) return send();
          throw error;
        });
        if (!committed) console.warn("[RuntimeAudit] Diagnostic batch could not be confirmed");
      } catch (error) { console.warn("[RuntimeAudit] Diagnostic batch could not be saved", error); }
      finally {
        this.active = undefined;
        this.settle(through);
      }
    }
  }

  private settle(through: number): void {
    this.settled = through;
    const waiting: typeof this.waiters = [];
    for (const waiter of this.waiters) {
      if (waiter.through <= through) waiter.resolve();
      else waiting.push(waiter);
    }
    this.waiters = waiting;
  }

}
