/** One installation owner; callers own only their individual waits. */
export class SharedPreparation<T> {
  private controller = new AbortController();
  private waiters = 0;
  private settled = false;
  readonly promise: Promise<T>;

  constructor(run: (signal: AbortSignal) => Promise<T>) {
    this.promise = Promise.resolve().then(() => run(this.controller.signal));
    void this.promise.then(() => { this.settled = true; }, () => { this.settled = true; });
  }

  get stopping(): boolean { return this.controller.signal.aborted && !this.settled; }

  wait(signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error("Preparation cancelled"));
    this.waiters++;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (error: unknown, value?: T) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", abort);
        this.waiters--;
        if (!this.settled && this.waiters === 0) this.controller.abort();
        if (error) reject(error); else resolve(value as T);
      };
      const abort = () => finish(new Error("Preparation cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      this.promise.then(value => finish(null, value), error => finish(error));
    });
  }
}
