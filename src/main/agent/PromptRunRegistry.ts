export interface PromptRunState {
  done: Promise<void>;
  ready: Promise<void>;
  cancelled: boolean;
  waitingFollowUp: boolean;
  markReady: () => void;
  finish: () => void;
}

export class PromptRunRegistry {
  private readonly runs = new Map<string, Set<PromptRunState>>();

  isBusy(taskId: string): boolean {
    return Boolean(this.runs.get(taskId)?.size);
  }

  begin(taskId: string, waitingFollowUp: boolean): { run: PromptRunState; predecessors: PromptRunState[] } {
    const taskRuns = this.runs.get(taskId) ?? new Set<PromptRunState>();
    const predecessors = [...taskRuns];
    let resolveDone!: () => void;
    let resolveReady!: () => void;
    const run: PromptRunState = {
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
      ready: new Promise<void>((resolve) => { resolveReady = resolve; }),
      cancelled: false,
      waitingFollowUp,
      markReady: () => resolveReady(),
      finish: () => resolveDone(),
    };
    taskRuns.add(run);
    this.runs.set(taskId, taskRuns);
    return { run, predecessors };
  }

  release(taskId: string, run: PromptRunState): void {
    const taskRuns = this.runs.get(taskId);
    if (!taskRuns) return;
    taskRuns.delete(run);
    if (taskRuns.size === 0) this.runs.delete(taskId);
  }

  cancel(taskId: string, preservedRun?: PromptRunState): void {
    for (const run of this.runs.get(taskId) ?? []) {
      if (run !== preservedRun) run.cancelled = true;
    }
  }
}

export class PromptRetryRegistry<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly maxEntries = 200) {}

  remember(id: string, value: T): void {
    this.entries.set(id, structuredClone(value));
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  get(id: string): T | undefined {
    return this.entries.get(id);
  }

  delete(id: string): void {
    this.entries.delete(id);
  }
}
