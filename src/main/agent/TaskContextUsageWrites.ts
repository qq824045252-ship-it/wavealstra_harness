export interface TaskContextUsageSnapshot {
  taskId: string;
  usedTokens: number | null;
  contextWindow: number;
  cacheHitRate: number | null;
}

const BATCH_SIZE = 128;

export class TaskContextUsageWrites {
  private readonly pending = new Map<string, TaskContextUsageSnapshot>();
  private writing?: Promise<void>;
  private closed = false;

  constructor(private readonly persist: (snapshots: readonly TaskContextUsageSnapshot[]) => Promise<void>) {}

  enqueue(snapshot: TaskContextUsageSnapshot): void {
    if (this.closed) return;
    this.pending.set(snapshot.taskId, snapshot);
    this.writing ??= Promise.resolve().then(() => this.writePending());
  }

  latest(taskId: string): TaskContextUsageSnapshot | undefined {
    return this.pending.get(taskId);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writing;
  }

  private async writePending(): Promise<void> {
    try {
      while (this.pending.size > 0) {
        const batch: TaskContextUsageSnapshot[] = [];
        for (const snapshot of this.pending.values()) {
          batch.push(snapshot);
          if (batch.length === BATCH_SIZE) break;
        }
        try {
          await this.persist(batch);
        } catch (error) {
          console.warn("[TaskContextUsage] 保存上下文用量失败", error);
        }
        for (const snapshot of batch) {
          if (this.pending.get(snapshot.taskId) === snapshot) this.pending.delete(snapshot.taskId);
        }
      }
    } finally {
      this.writing = undefined;
    }
  }
}
