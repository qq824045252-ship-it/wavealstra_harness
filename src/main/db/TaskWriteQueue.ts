export class TaskWriteQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private exclusiveTail: Promise<void> = Promise.resolve();

  run<T>(taskIds: readonly string[], write: () => T | Promise<T>): Promise<T> {
    const keys = [...new Set(taskIds)];
    const result = Promise.all([this.exclusiveTail, ...keys.map(id => this.tails.get(id))]).then(write);
    const tail = result.then(() => undefined, () => undefined);
    for (const id of keys) this.tails.set(id, tail);
    void tail.then(() => {
      for (const id of keys) {
        if (this.tails.get(id) === tail) this.tails.delete(id);
      }
    });
    return result;
  }

  runExclusive<T>(write: () => T | Promise<T>): Promise<T> {
    const result = this.flush().then(write);
    this.exclusiveTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async flush(taskId?: string): Promise<void> {
    if (taskId !== undefined) {
      await Promise.all([this.exclusiveTail, this.tails.get(taskId)]);
      return;
    }
    await Promise.all([this.exclusiveTail, ...this.tails.values()]);
  }
}
