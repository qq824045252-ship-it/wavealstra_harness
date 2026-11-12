/** One absolute budget for a tool invocation, including renderer waits. */
export class AutomationScope {
  readonly deadline: number;
  private finished = false;
  private readonly guards = new Set<() => void>();
  dispatched = false;
  confirmed = false;
  pageUrl?: string;

  constructor(readonly signal?: AbortSignal, timeoutMs = 10_000, private readonly validate = () => {}) {
    this.deadline = Date.now() + Math.max(100, Math.min(30_000, timeoutMs));
  }

  check(): void {
    if (this.signal?.aborted) throw new DOMException("浏览器操作已取消", "AbortError");
    if (this.finished || Date.now() >= this.deadline) throw new AutomationTimeoutError();
    this.validate();
    for (const guard of this.guards) guard();
  }

  dispatch(): void { this.check(); this.dispatched = true; }
  guard(check: () => void): () => void { this.guards.add(check); return () => { this.guards.delete(check); }; }
  close(): void { this.finished = true; }
  get remaining(): number { return Math.max(1, this.deadline - Date.now()); }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => reject(new AutomationTimeoutError()), this.remaining);
        abort = () => reject(new DOMException("浏览器操作已取消", "AbortError"));
        this.signal?.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => { this.check(); return operation(); }).then(value => {
          try { this.check(); resolve(value); } catch (error) { reject(error); }
        }, reject);
      });
    } finally {
      clearTimeout(timer);
      if (abort) this.signal?.removeEventListener("abort", abort);
    }
  }
}

export class AutomationTimeoutError extends Error {
  constructor() { super("浏览器调用超过总时间预算"); this.name = "AutomationTimeoutError"; }
}
