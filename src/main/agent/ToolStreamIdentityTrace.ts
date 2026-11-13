/** Bounded, content-free observation at the Completions parser input boundary.
 * No arguments, names, raw IDs, prompts, headers, or response bodies are retained. */
export class ToolStreamIdentityTrace {
  private readonly ids = new Map<number, string>();
  private readonly reused = new Set<number>();
  private ordinal = 0;
  private emitted = 0;
  constructor(private readonly hash: (value: string) => string,
    private readonly emit: (record: Record<string, unknown>) => void) {}
  observe(data: unknown): void {
    this.ordinal++;
    if (this.emitted >= 16 || !data || typeof data !== 'object') return;
    const choices = (data as { choices?: unknown }).choices;
    // The current Pi Completions parser consumes choices[0], not every choice.
    const first = Array.isArray(choices) ? choices[0] : undefined;
    const calls = first?.delta?.tool_calls;
    if (!Array.isArray(calls)) return;
    for (const call of calls) {
      if (this.emitted >= 16 || !call || !Number.isSafeInteger(call.index) || call.index < 0) continue;
      const index = call.index as number;
      const id = typeof call.id === 'string' && call.id ? this.hash(call.id) : undefined;
      const prior = this.ids.get(index);
      if (id) {
        if (prior && prior !== id) {
          this.reused.add(index);
          this.emit({ event: 'tool-stream-identity', phase: 'index_reused', chunkOrdinal: this.ordinal, index,
            priorCallHash: prior, currentCallHash: id });
          this.emitted++;
        }
        if (prior || this.ids.size < 128) this.ids.set(index, id);
      } else if (this.reused.has(index)) {
        this.emit({ event: 'tool-stream-identity', phase: 'missing_id_after_reuse', chunkOrdinal: this.ordinal, index });
        this.emitted++;
      }
    }
  }
}
