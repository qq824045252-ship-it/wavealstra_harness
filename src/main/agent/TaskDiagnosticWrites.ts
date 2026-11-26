import type Database from "better-sqlite3";
import type { RuntimeAuditReader, RuntimeDiagnosticWrite } from "../platform/runtime-audit";
import type { DiagnosticUsageReceipt } from "./TaskDiagnosticsRepository";

const batchSize = 64;
const maxQueued = 512;
const retryNativeAfterMs = 30_000;

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
  private readonly epoch?: number;
  private readonly epochPromise?: Promise<number | undefined>;
  private readonly rustRequired: boolean;
  private sequence = 0;
  private active?: Batch;
  private queued: PendingWrite[] = [];
  private draining?: Promise<void>;
  private fallbackUntil = 0;
  private submitted = 0;
  private settled = 0;
  private waiters: Array<{ through: number; resolve: () => void }> = [];

  constructor(
    private readonly db: Database.Database,
    private readonly reader: RuntimeAuditReader,
    private readonly applyOnHost: (write: RuntimeDiagnosticWrite) => void,
  ) {
    this.rustRequired = db.readonly || reader.supervised;
    if (this.rustRequired) {
      this.epochPromise = reader.batch1Write<{ epoch: number }>({ kind: "claimDiagnosticEpoch" })
        .then(res => res?.epoch)
        .catch(() => undefined);
    } else {
      db.exec(`CREATE TABLE IF NOT EXISTS runtime_diagnostic_writer (
        id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL, sequence INTEGER NOT NULL
      ); INSERT OR IGNORE INTO runtime_diagnostic_writer VALUES (1, 0, 0);`);
      this.epoch = db.prepare("UPDATE runtime_diagnostic_writer SET epoch=epoch+1, sequence=0 RETURNING epoch").pluck().get() as number;
    }
  }

  private get native(): boolean { return this.rustRequired || Date.now() >= this.fallbackUntil; }

  add(write: RuntimeDiagnosticWrite, receipt?: DiagnosticUsageReceipt): void {
    if (!this.native) { this.applyOnHost(write); return; }
    this.submitted++;
    this.queued.push({ write, receipt });
    if (this.queued.length >= maxQueued && !this.rustRequired) {
      this.fallback();
      return;
    }
    this.schedule();
  }

  private schedule(): void {
    if (!this.draining) {
      this.draining = new Promise<void>(resolve => setImmediate(resolve))
        .then(() => this.drain())
        .finally(() => {
          this.draining = undefined;
          if (this.native && this.queued.length) this.schedule();
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
    while (this.native && this.queued.length) {
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
        const epoch = this.epoch ?? await this.epochPromise;
        const committed = epoch !== undefined
          ? await this.reader.writeDiagnostics(epoch, batch.sequence, writes).catch(() => false)
          : false;
        if (this.active === batch) {
          if (committed) this.settle(through);
          else if (this.rustRequired) {
            console.warn("[RuntimeAudit] Supervised diagnostic batch could not be saved");
            this.settle(through);
          } else {
            this.fallback();
          }
        }
      } finally { this.active = undefined; }
    }
  }

  private fallback(): void {
    if (this.rustRequired) {
      this.active = undefined;
      this.queued.length = 0;
      this.settle(this.submitted);
      return;
    }
    this.fallbackUntil = Date.now() + retryNativeAfterMs;
    const active = this.active;
    this.active = undefined;
    const pending = { sequence: ++this.sequence, items: this.queued.splice(0) };
    try {
      // Both writers advance the same receipt, so an in-flight batch cannot
      // replay earlier rows after the host has committed its fallback.
      this.db.transaction(() => {
        if (active) this.commitOnHost(active);
        this.commitOnHost(pending);
      }).immediate();
    } catch { console.warn("[RuntimeAudit] Diagnostic batch could not be saved"); }
    this.settle(this.submitted);
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

  private commitOnHost(batch: Batch): void {
    if (!batch.items.length || this.epoch === undefined) return;
    const receipt = this.db.prepare("UPDATE runtime_diagnostic_writer SET sequence=? WHERE id=1 AND epoch=? AND sequence<?")
      .run(batch.sequence, this.epoch, batch.sequence);
    if (receipt.changes) for (const { write } of batch.items) this.applyOnHost(write);
  }
}
