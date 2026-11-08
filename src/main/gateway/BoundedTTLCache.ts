/**
 * A fixed-lifetime, insertion-ordered cache. Reads never extend retention.
 *
 * Expiry is checked only for the requested key; writes evict at most one Map
 * head. Thus neither high message rates nor an idle period cause a full scan,
 * array allocation or sort. Expired, unread entries may remain resident, but
 * resident size (including such entries) can never exceed maxEntries.
 */
export class BoundedTTLCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();
  private readonly now: () => number;

  constructor(private readonly options: { maxEntries: number; ttlMs: number; now?: () => number }) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1) throw new RangeError('maxEntries must be a positive safe integer');
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) throw new RangeError('ttlMs must be positive and finite');
    this.now = options.now ?? (() => performance.now());
  }

  /** Number of resident entries; expired entries are reclaimed lazily. */
  get size(): number { return this.entries.size; }

  private lookup(key: K): { value: V; expiresAt: number } | undefined {
    const entry = this.entries.get(key);
    if (entry && this.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  has(key: K): boolean { return this.lookup(key) !== undefined; }
  get(key: K): V | undefined { return this.lookup(key)?.value; }

  set(key: K, value: V): this {
    const expiresAt = this.now() + this.options.ttlMs;
    // Updating an entry renews its TTL and makes it the newest insertion.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt });
    if (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    return this;
  }

  delete(key: K): boolean { return this.entries.delete(key); }
  clear(): void { this.entries.clear(); }
}
