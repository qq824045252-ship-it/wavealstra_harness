import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { RuntimeLogger, resolveRuntimeLogsDir } from '../runtime-logging';

// This observer never rewrites requests, retries them, or saves request content.
// Content digests are keyed per process. Different epochs are not comparable.
const MAX_ITEMS = 4096;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_CHAINS = 32;
const FIELDS = new Set(['model', 'instructions', 'system', 'tools', 'tool_choice', 'parallel_tool_calls',
  'reasoning', 'thinking', 'max_output_tokens', 'max_tokens', 'temperature', 'top_p', 'stream', 'store',
  'include', 'text', 'response_format', 'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache',
  'previous_response_id', 'service_tier', 'metadata', 'user', 'truncation', 'context_management']);
const ITEM_FIELDS = new Set(['type', 'role', 'id', 'call_id', 'name', 'arguments', 'content', 'output',
  'summary', 'encrypted_content', 'phase', 'status', 'tools']);
const KINDS = new Set(['message', 'reasoning', 'function_call', 'function_call_output', 'custom_tool_call',
  'custom_tool_call_output', 'tool_search_call', 'tool_search_output', 'additional_tools', 'configuration_update']);
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const AFFINITY_HEADERS = ['session_id', 'conversation_id', 'x-session-id', 'x-client-session-id', 'user-agent', 'openai-beta'];
const plainHash = (value: string) => createHash('sha256').update(value).digest('hex');
type Json = Record<string, unknown>;
type Item = { hash: string; bytes: number; kind: string; role?: string; fields: Record<string, string> };
type Snapshot = { request: string; attempt: number; hash: string; inputHash: string; items: Item[];
  inputCount: number; complete: boolean; fields: Record<string, string>; bytes: number };
export type CacheTraceSink = (record: Json) => void;
export type CacheTraceBoundary = { sessionId?: string; leafId?: string | null; userId?: string;
  compactionId?: string; ledgerId?: string; resetId?: string; operation?: string };

/** Exported for deterministic tests; the sink sees only hashes, counters and fixed labels. */
export class CacheRequestTracer {
  readonly epoch = randomUUID();
  private readonly key = randomBytes(32);
  private readonly previous = new Map<string, Snapshot>();
  private sequence = 0;
  constructor(private readonly sink: CacheTraceSink) {}

  private digest(value: unknown): string {
    return createHmac('sha256', this.key).update(JSON.stringify(value) ?? 'undefined').digest('hex');
  }
  private emit(record: Json): void {
    try { this.sink({ version: 1, epoch: this.epoch, at: Date.now(), sequence: ++this.sequence, ...record }); } catch { /* observation cannot fail a request */ }
  }
  private fields(value: Json, allowed: Set<string>, omit: Set<string> = new Set()): Record<string, string> {
    const result: Record<string, string> = {};
    const other: Json = {};
    for (const [key, data] of Object.entries(value)) {
      if (omit.has(key)) continue;
      if (allowed.has(key)) result[key] = this.digest(data);
      else other[key] = data;
    }
    if (Object.keys(other).length) result.other = this.digest(other);
    return result;
  }
  private snapshot(payload: unknown, request: string, attempt: number): Snapshot | undefined {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const body = payload as Json;
    const encoded = JSON.stringify(body);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_BYTES) return;
    const field = Array.isArray(body.input) ? 'input' : Array.isArray(body.messages) ? 'messages' : undefined;
    if (!field) return;
    const input = body[field] as unknown[];
    const items = input.slice(0, MAX_ITEMS).map(value => {
      const item = value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
      const type = typeof item.type === 'string' && KINDS.has(item.type) ? item.type : 'other';
      const role = typeof item.role === 'string' && ROLES.has(item.role) ? item.role : undefined;
      return { hash: this.digest(value), bytes: Buffer.byteLength(JSON.stringify(value) ?? 'undefined'),
        kind: type, role, fields: this.fields(item, ITEM_FIELDS) };
    });
    return { request, attempt, hash: this.digest(body), inputHash: this.digest(input), items,
      inputCount: input.length, complete: input.length <= MAX_ITEMS,
      fields: this.fields(body, FIELDS, new Set([field])), bytes };
  }

  start(model: { provider: string; id: string; api: string }, sessionId?: string, boundary?: CacheTraceBoundary) {
    const request = randomUUID();
    const session = sessionId || boundary?.sessionId;
    // No global chain for unbound calls: unrelated requests must never share a baseline.
    const sessionHash = session ? plainHash(session) : undefined;
    const modelHash = this.digest([model.provider, model.id, model.api]);
    const base = { request, sessionHash, modelHash,
      boundary: boundary ? { operation: ['prompt', 'stream', 'compact', 'navigate', 'capability'].includes(boundary.operation ?? '') ? boundary.operation : 'other',
        leaf: boundary.leafId ? this.digest(boundary.leafId) : null,
        user: boundary.userId ? this.digest(boundary.userId) : null,
        compaction: boundary.compactionId ? this.digest(boundary.compactionId) : null,
        ledger: boundary.ledgerId ? this.digest(boundary.ledgerId) : null,
        reset: boundary.resetId ? this.digest(boundary.resetId) : null } : undefined };
    let attempts = 0;
    let payloadSnapshot: Snapshot | undefined;
    const capture = (payload: unknown, stage: 'provider' | 'http', attempt: number, extras: Json = {}) => {
      try {
        const now = this.snapshot(payload, request, attempt);
        if (!now) {
          this.emit({ ...base, event: 'request', stage, attempt, coverage: 'unsupported-or-over-limit', ...extras });
          // Skipped observations cannot silently bridge a gap in the chain.
          if (sessionHash) this.previous.delete(`${sessionHash}/${stage}/${boundary?.operation ?? 'unbound'}`);
          return undefined;
        }
        const chain = sessionHash ? `${sessionHash}/${stage}/${boundary?.operation ?? 'unbound'}` : undefined;
        const before = chain ? this.previous.get(chain) : undefined;
        let shared = 0;
        while (before && shared < before.items.length && shared < now.items.length && before.items[shared]!.hash === now.items[shared]!.hash) shared++;
        const changes = before ? [...new Set([...Object.keys(before.fields), ...Object.keys(now.fields)])]
          .filter(key => before.fields[key] !== now.fields[key]) : [];
        const oldItem = before?.items[shared], newItem = now.items[shared];
        const prefix = before?.complete && now.complete ? shared === before.inputCount : null;
        const changedItemFields = oldItem && newItem ? [...new Set([...Object.keys(oldItem.fields), ...Object.keys(newItem.fields)])]
          .filter(key => oldItem.fields[key] !== newItem.fields[key]) : [];
        this.emit({ ...base, event: 'request', stage, attempt, coverage: now.complete ? 'complete' : 'partial',
          bytes: now.bytes, bodyHash: now.hash, inputHash: now.inputHash, inputCount: now.inputCount,
          // Full bounded vectors allow independent offline checking; field hashes only for the first difference.
          items: now.items.map(({ fields: _fields, ...item }) => item), fields: now.fields,
          previous: before ? { request: before.request, attempt: before.attempt, inputCount: before.inputCount,
            sharedItems: shared, prefix, changedFields: changes,
            firstDifference: prefix === false ? { index: shared, old: oldItem, current: newItem, changedItemFields } : undefined } : null,
          ...extras });
        if (chain) {
          this.previous.delete(chain); this.previous.set(chain, now);
          while (this.previous.size > MAX_CHAINS) this.previous.delete(this.previous.keys().next().value!);
        }
        return now;
      } catch {
        if (sessionHash) this.previous.delete(`${sessionHash}/${stage}/${boundary?.operation ?? 'unbound'}`);
        this.emit({ ...base, event: 'request', stage, attempt, coverage: 'observation-failed' });
        return undefined;
      }
    };
    return {
      payload: (payload: unknown) => { payloadSnapshot = capture(payload, 'provider', 0); },
      sent: (input: RequestInfo | URL, init?: RequestInit) => {
        const attempt = ++attempts;
        try {
          // Native HTTP SDKs pass JSON strings. Never consume or tee an arbitrary request stream.
          if (typeof init?.body !== 'string' || Buffer.byteLength(init.body) > MAX_BYTES) {
            capture(undefined, 'http', attempt); return attempt;
          }
          const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
          const affinity = AFFINITY_HEADERS.map(key => [key, headers.get(key)]);
          const payload: unknown = JSON.parse(init.body);
          capture(payload, 'http', attempt, { wireBytes: Buffer.byteLength(init.body), wireHash: this.digest(init.body),
            adapterMatch: payloadSnapshot ? payloadSnapshot.hash === this.digest(payload) : null,
            endpointHash: this.digest(input instanceof Request ? input.url : String(input)), affinityHash: this.digest(affinity) });
        } catch { capture(undefined, 'http', attempt); }
        return attempt;
      },
      received: (attempt: number, status: number | null) => { this.emit({ ...base, event: 'http-result', attempt, status }); },
      result: (message: { responseId?: string; responseModel?: string; stopReason: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } }) => {
        try {
          const u = message.usage;
          this.emit({ ...base, event: 'result', attempts,
            responseHash: message.responseId ? plainHash(message.responseId) : null,
            responseModelHash: message.responseModel ? this.digest(message.responseModel) : null,
            outcome: ['stop', 'length', 'toolUse', 'error', 'aborted'].includes(message.stopReason) ? message.stopReason : 'other',
            usage: u ? { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite } : null,
            hitRate: u && u.input + u.cacheRead + u.cacheWrite > 0 ? u.cacheRead / (u.input + u.cacheRead + u.cacheWrite) : null });
        } catch { this.emit({ ...base, event: 'result', attempts, outcome: 'observation-failed' }); }
      },
    };
  }
}

let tracer: CacheRequestTracer | undefined;
export function startCacheRequestTrace(model: { provider: string; id: string; api: string }, sessionId?: string, boundary?: CacheTraceBoundary) {
  if (process.env.MYBUDDY_CACHE_TRACE === '0') return;
  try {
    if (!tracer) {
      const logger = new RuntimeLogger({ dir: resolveRuntimeLogsDir(), prefix: 'cache-requests',
        onWriteError: () => { /* Never log a request or filesystem exception as a fallback. */ } });
      tracer = new CacheRequestTracer(record => logger.info('cache-trace', JSON.stringify(record)));
    }
    return tracer.start(model, sessionId, boundary);
  } catch { return; }
}
