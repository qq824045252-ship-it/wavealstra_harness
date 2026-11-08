/**
 * One task/permission read per synchronous phase.
 *
 * The runtime filters the tool list and builds the Code Mode description in tight synchronous
 * loops, and it re-checks permission after approval/resource waits. Reading the task row (plus
 * its expert binding) once per tool name dominated that loop. This gate reuses a single read for
 * the current synchronous phase and drops it at the next microtask, so every check that happens
 * after an await — exactly the approval/resource re-checks — still reads fresh state.
 */
export class ToolGate<T> {
  private phase?: { value: T; allowed: Map<string, boolean>; fresh: boolean };

  constructor(
    private readonly read: () => T,
    private readonly evaluate: (value: T, name: string) => boolean,
  ) {}

  allowed(name: string): boolean {
    const phase = this.current();
    const cached = phase.allowed.get(name);
    if (cached !== undefined) return cached;
    const value = this.evaluate(phase.value, name);
    phase.allowed.set(name, value);
    return value;
  }

  /** Drop the current read so the next call re-reads, even inside the same phase. */
  reset(): void {
    this.phase = undefined;
  }

  private current(): { value: T; allowed: Map<string, boolean>; fresh: boolean } {
    if (this.phase?.fresh) return this.phase;
    const phase = { value: this.read(), allowed: new Map<string, boolean>(), fresh: true };
    this.phase = phase;
    queueMicrotask(() => { phase.fresh = false; });
    return phase;
  }
}
