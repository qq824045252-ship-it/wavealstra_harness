/**
 * Bounded startup resumption.
 *
 * Only the startup drain goes through this queue. Interactive reads (history, prompt, abort)
 * call `open()` directly, so they never wait behind background recovery. The service
 * deduplicates opens but retains the queued resume obligation: a history read alone
 * must not consume it. Explicit claim is only for a caller taking over resume too.
 *
 * "Delivered" means `open()` resolved and `runtime.resume()` was invoked. Pi's resume is
 * synchronous, so a delivered item may still be running tools, subtasks or receipt work; the
 * queue width is therefore not a bound on ongoing native work and must not be described as one.
 */

export interface ResumeAdmissionFailure {
  taskId: string;
  reason: string;
}

export interface ResumeAdmissionSkip {
  taskId: string;
  reason: string;
}

export interface ResumeAdmissionReport {
  concurrency: number;
  /** Bindings enumerated from durable_bot_bindings before any skip/claim. */
  enumerated: number;
  delivered: string[];
  failed: ResumeAdmissionFailure[];
  skipped: ResumeAdmissionSkip[];
  claimed: string[];
  pending: number;
  maxConcurrent: number;
}

export interface ResumeAdmissionOptions {
  concurrency: number;
  run: (taskId: string) => Promise<void>;
  /** Re-checked when the item leaves the queue: authority, Work lifecycle, binding and回收区 can change while queued. */
  shouldSkip: (taskId: string) => string | undefined;
}

/** Provisional width; the app-level baseline in Issue #17 A decides the final value. */
export const DEFAULT_DURABLE_RESUME_CONCURRENCY = 4;

export class ResumeAdmission {
  private readonly pending: string[] = [];
  private readonly pendingSet = new Set<string>();
  private readonly running = new Set<string>();
  private readonly delivered: string[] = [];
  private readonly failed: ResumeAdmissionFailure[] = [];
  private readonly skipped: ResumeAdmissionSkip[] = [];
  private readonly claimed: string[] = [];
  private readonly concurrency: number;
  private draining?: Promise<ResumeAdmissionReport>;
  private cursor = 0;
  private active = 0;
  private maxConcurrent = 0;
  private cancelled = false;
  private enqueued = 0;

  constructor(private readonly options: ResumeAdmissionOptions) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency));
  }

  enqueue(taskIds: Iterable<string>): void {
    for (const taskId of taskIds) {
      if (!taskId || this.pendingSet.has(taskId) || this.running.has(taskId)) continue;
      this.pending.push(taskId);
      this.pendingSet.add(taskId);
      this.enqueued += 1;
    }
  }

  /** Explicit transfer of the complete open+resume obligation, not a read-only history access. */
  claim(taskId: string): boolean {
    if (!this.pendingSet.delete(taskId)) return false;
    this.claimed.push(taskId);
    return true;
  }

  /** Shutdown must not keep scheduling sessions the service can no longer open. */
  cancel(): void {
    this.cancelled = true;
  }

  get queued(): number {
    return this.pendingSet.size;
  }

  drain(): Promise<ResumeAdmissionReport> {
    this.draining ??= this.runAll().finally(() => { this.draining = undefined; });
    return this.draining;
  }

  private next(): string | undefined {
    while (this.cursor < this.pending.length) {
      const taskId = this.pending[this.cursor++]!;
      // A foreground claim removed the id while it was still queued.
      if (!this.pendingSet.delete(taskId)) continue;
      return taskId;
    }
    this.pending.length = 0;
    this.cursor = 0;
    return undefined;
  }

  private async worker(): Promise<void> {
    for (let taskId = this.next(); taskId !== undefined; taskId = this.next()) {
      if (this.cancelled) {
        this.skipped.push({ taskId, reason: "cancelled" });
        continue;
      }
      const skip = this.options.shouldSkip(taskId);
      if (skip) {
        this.skipped.push({ taskId, reason: skip });
        continue;
      }
      this.running.add(taskId);
      this.active += 1;
      this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
      try {
        await this.options.run(taskId);
        this.delivered.push(taskId);
      } catch (error) {
        // One failed session must never hold a slot or stop the rest of the queue.
        this.failed.push({ taskId, reason: error instanceof Error ? error.message : String(error) });
      } finally {
        this.running.delete(taskId);
        this.active -= 1;
      }
    }
  }

  private async runAll(): Promise<ResumeAdmissionReport> {
    const width = Math.min(this.concurrency, Math.max(1, this.pendingSet.size));
    await Promise.all(Array.from({ length: width }, () => this.worker()));
    return {
      concurrency: this.concurrency,
      enumerated: this.enqueued,
      delivered: [...this.delivered],
      failed: [...this.failed],
      skipped: [...this.skipped],
      claimed: [...this.claimed],
      pending: this.pendingSet.size,
      maxConcurrent: this.maxConcurrent,
    };
  }
}
