export type WorkResultPhase = "opening" | "submission" | "reply" | "idle" | "closing";

/** Native review identity remains valid. Recovery must observe the same request. */
export class WorkResultLifecycleError extends Error {
  constructor(readonly phase: WorkResultPhase, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkResultLifecycleError";
  }
}

/** One deadline covers opening, admission, reply and native idle convergence. */
export class WorkResultDeadline {
  private readonly cancellation = new AbortController();
  readonly signal = this.cancellation.signal;
  private phase: WorkResultPhase = "opening";
  private stopped = false;
  private readonly failure: Promise<never>;
  private readonly timeout: ReturnType<typeof setTimeout>;
  private readonly authority: ReturnType<typeof setInterval>;
  constructor(private readonly available: () => boolean) {
    let fail!: (error: WorkResultLifecycleError) => void;
    this.failure = new Promise<never>((_resolve, reject) => { fail = reject; });
    const reject = (message: string) => {
      if (this.stopped) return;
      this.stopped = true;
      const error = new WorkResultLifecycleError(this.phase, message);
      fail(error);
      this.cancellation.abort(error);
    };
    this.timeout = setTimeout(() => reject(`结果整理 ${this.phase} 阶段超时，原执行结果已保留，恢复时查回原生请求`), 60000);
    this.authority = setInterval(() => {
      if (!available()) reject(`结果整理 ${this.phase} 阶段已停止，等待原生请求恢复`);
    }, 250);
    this.failure.catch(() => {});
  }
  current(): boolean { return !this.stopped && this.available(); }
  async wait<T>(phase: WorkResultPhase, operation: () => Promise<T>): Promise<T> {
    this.phase = phase;
    if (!this.current()) throw new WorkResultLifecycleError(phase, "结果整理已停止，等待原生请求恢复");
    const value = await Promise.race([operation(), this.failure]);
    if (!this.current()) throw new WorkResultLifecycleError(phase, "结果整理已停止，忽略迟到结果");
    return value;
  }
  dispose(): void {
    this.stopped = true; clearTimeout(this.timeout); clearInterval(this.authority);
    this.cancellation.abort(new WorkResultLifecycleError(this.phase, "结果整理等待已结束"));
  }
}
