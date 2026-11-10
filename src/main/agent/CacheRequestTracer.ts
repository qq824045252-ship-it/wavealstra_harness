import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { reportedCostTotal, reportedTokenUsage, unknownTokenUsage } from './ReportedTokenUsage';
import { nativeCostEvidence } from './NativeCostEvidence';
import type { DiagnosticSource } from '../../shared/task-diagnostics';

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
/** The operation a request belongs to; every chain is keyed by it so two operations never share a baseline. */
export const CACHE_TRACE_OPERATIONS = ['prompt', 'stream', 'compact', 'navigate', 'capability'] as const;
export type CacheTraceOperation = (typeof CACHE_TRACE_OPERATIONS)[number];
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const AFFINITY_HEADERS = ['session_id', 'conversation_id', 'x-session-id', 'x-client-session-id', 'user-agent', 'openai-beta',
  'authorization', 'api-key', 'x-api-key', 'openai-organization', 'openai-project', 'chatgpt-account-id'];
const RESPONSE_TERMINALS = new Set(['response.completed', 'response.incomplete', 'response.failed']);
const RESPONSE_STATUSES = new Set(['completed', 'incomplete', 'failed', 'cancelled', 'in_progress', 'queued']);
const object = (value: unknown): Json | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const finiteNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const plainHash = (value: string) => createHash('sha256').update(value).digest('hex');
type Json = Record<string, unknown>;
export type CacheTraceRecord = Json;
type Item = { hash: string; bytes: number; kind: string; role?: string; fields: Record<string, string> };
type Snapshot = { request: string; attempt: number; hash: string; inputHash: string; items: Item[];
  inputCount: number; complete: boolean; fields: Record<string, string>; bytes: number };
export type CacheTraceSink = (record: Json) => void;
export type CacheTraceBoundary = { sessionId?: string; leafId?: string | null; userId?: string;
  compactionId?: string; ledgerId?: string; resetId?: string; operation?: string };
export type ModelExecutionIdentity = { taskId?: string; conversationId: string; generationTaskId: number; sourceKind: DiagnosticSource; executionScope?: string };

/**
 * Classify the body a transport hands to fetch *without reading it*. A stream is never teed or consumed:
 * only its runtime type is named, so the record says why the wire body is unobservable instead of looking unchanged.
 */
function requestBodyKind(input: RequestInfo | URL, init?: RequestInit): string {
  const body: unknown = init?.body;
  if (typeof body === 'string') return 'string';
  if (body === undefined || body === null) return input instanceof Request && input.body !== null ? 'request-body' : 'none';
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return 'stream';
  if (typeof Blob !== 'undefined' && body instanceof Blob) return 'blob';
  if (typeof FormData !== 'undefined' && body instanceof FormData) return 'form-data';
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return 'url-search-params';
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return 'binary';
  return 'other';
}

export function sessionTraceBoundary(session: AgentSession, operation: string): CacheTraceBoundary {
  try {
    const branch = session.sessionManager.getBranch();
    const latest = (type: string, customType?: string) => [...branch].reverse().find(entry =>
      entry.type === type && (!customType || (entry.type === 'custom' && entry.customType === customType)))?.id;
    return { sessionId: session.sessionId, operation, leafId: session.sessionManager.getLeafId(),
      userId: [...branch].reverse().find(entry => entry.type === 'message' && entry.message.role === 'user')?.id,
      compactionId: latest('compaction'), ledgerId: latest('custom', 'mybuddy.context-ledger'), resetId: latest('custom', 'mybuddy.context-reset') };
  } catch { return { operation }; }
}

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
  private emit(record: Json): Json {
    const event = { version: 1, epoch: this.epoch, at: Date.now(), sequence: ++this.sequence, ...record };
    try { this.sink(event); } catch { /* observation cannot fail a request */ }
    return event;
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

  start(model: { provider: string; id: string; api: string }, sessionId?: string, boundary?: CacheTraceBoundary, observer?: CacheTraceSink) {
    const emit = (value: Json, privateDiagnostic?: Json) => { const record = this.emit(value); try { observer?.({ ...record, ...privateDiagnostic }); } catch { /* observation cannot fail a request */ } };
    const startedAt = Date.now();
    const startedClock = performance.now();
    let firstResponseAt: number | null = null;
    let reported = unknownTokenUsage();
    let usageSource: string | null = null;
    let providerCost: number | undefined;
    const request = randomUUID();
    const session = sessionId || boundary?.sessionId;
    // No global chain for unbound calls: unrelated requests must never share a baseline.
    const sessionHash = session ? plainHash(session) : undefined;
    const modelHash = this.digest([model.provider, model.id, model.api]);
    // One normalized operation drives both the record and every chain key, so the audit can never read a
    // label that differs from the chain the tracer actually compared against.
    const operation = boundary
      ? (CACHE_TRACE_OPERATIONS as readonly string[]).includes(boundary.operation ?? '') ? boundary.operation : 'other'
      : undefined;
    const chainKey = (stage: 'provider' | 'http') => sessionHash ? `${sessionHash}/${stage}/${operation ?? 'unbound'}` : undefined;
    const base = { request, sessionHash, modelHash,
      boundary: boundary ? { operation,
        leaf: boundary.leafId ? this.digest(boundary.leafId) : null,
        user: boundary.userId ? this.digest(boundary.userId) : null,
        compaction: boundary.compactionId ? this.digest(boundary.compactionId) : null,
        ledger: boundary.ledgerId ? this.digest(boundary.ledgerId) : null,
        reset: boundary.resetId ? this.digest(boundary.resetId) : null } : undefined };
    let attempts = 0;
    let payloadSnapshot: Snapshot | undefined;
    emit({ ...base, event: 'started', startedAt });
    const capture = (payload: unknown, stage: 'provider' | 'http', attempt: number, extras: Json = {}) => {
      try {
        const now = this.snapshot(payload, request, attempt);
        if (!now) {
          emit({ ...base, event: 'request', stage, attempt, coverage: 'unsupported-or-over-limit', ...extras });
          // Skipped observations cannot silently bridge a gap in the chain.
          const skipped = chainKey(stage); if (skipped) this.previous.delete(skipped);
          return undefined;
        }
        const chain = chainKey(stage);
        const before = chain ? this.previous.get(chain) : undefined;
        let shared = 0;
        while (before && shared < before.items.length && shared < now.items.length && before.items[shared]!.hash === now.items[shared]!.hash) shared++;
        const changes = before ? [...new Set([...Object.keys(before.fields), ...Object.keys(now.fields)])]
          .filter(key => before.fields[key] !== now.fields[key]) : [];
        const oldItem = before?.items[shared], newItem = now.items[shared];
        const prefix = before?.complete && now.complete ? shared === before.inputCount : null;
        const changedItemFields = oldItem && newItem ? [...new Set([...Object.keys(oldItem.fields), ...Object.keys(newItem.fields)])]
          .filter(key => oldItem.fields[key] !== newItem.fields[key]) : [];
        emit({ ...base, event: 'request', stage, attempt, coverage: now.complete ? 'complete' : 'partial',
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
        const failed = chainKey(stage); if (failed) this.previous.delete(failed);
        emit({ ...base, event: 'request', stage, attempt, coverage: 'observation-failed' });
        return undefined;
      }
    };
    return {
      identify: (identity: ModelExecutionIdentity) => { emit({ ...base, event: 'execution', ...identity }); },
      firstResponse: () => { if (firstResponseAt === null) { firstResponseAt = Date.now(); emit({ ...base, event: 'first-response' }); } },
      payload: (payload: unknown) => { payloadSnapshot = capture(payload, 'provider', 0); },
      providerEvent: (data: unknown) => {
        try {
          const observed = reportedTokenUsage(data);
          if (observed) { reported = { ...reported, ...observed.values }; usageSource = observed.source; }
          const event = object(data);
          providerCost = reportedCostTotal(event?.response ?? event?.message ?? data) ?? providerCost;
          // Chat Completions reports usage in its final chunk, not a Responses terminal.
          // Keep raw counters (including invalid values) instead of reconstructing them
          // from SDK-normalized input/cache counts, which may have been clamped.
          const chatUsage = object(event?.usage);
          if (model.api === 'openai-completions' && chatUsage) {
            const details = object(chatUsage.prompt_tokens_details);
            emit({ ...base, event: 'provider-usage', terminal: 'chat-completions.usage',
              responseStatus: 'unknown', usagePresent: true,
              cachedTokensPresent: details !== undefined && Object.hasOwn(details, 'cached_tokens'),
              usage: { inputTokens: finiteNumber(chatUsage.prompt_tokens), outputTokens: finiteNumber(chatUsage.completion_tokens),
                totalTokens: finiteNumber(chatUsage.total_tokens), cachedTokens: finiteNumber(details?.cached_tokens) } });
          }
          if (typeof event?.type !== 'string' || !RESPONSE_TERMINALS.has(event.type)) return;
          const response = object(event.response);
          const usage = object(response?.usage);
          const details = object(usage?.input_tokens_details);
          emit({ ...base, event: 'provider-usage', terminal: event.type,
            responseStatus: typeof response?.status === 'string' && RESPONSE_STATUSES.has(response.status) ? response.status : 'unknown',
            usagePresent: usage !== undefined, cachedTokensPresent: details !== undefined && Object.hasOwn(details, 'cached_tokens'),
            usage: { inputTokens: finiteNumber(usage?.input_tokens), outputTokens: finiteNumber(usage?.output_tokens),
              totalTokens: finiteNumber(usage?.total_tokens), cachedTokens: finiteNumber(details?.cached_tokens) } });
        } catch { emit({ ...base, event: 'provider-usage', coverage: 'observation-failed' }); }
      },
      sent: (input: RequestInfo | URL, init?: RequestInit) => {
        const attempt = ++attempts;
        try {
          const suppliedHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
          const headers = suppliedHeaders === undefined ? undefined : new Headers(suppliedHeaders);
          const entries = headers ? [...headers.entries()].sort(([a], [b]) => a.localeCompare(b)) : undefined;
          const headerEvidence = { headersScope: 'sdk-fetch-arguments',
            headersHash: entries ? this.digest(entries) : null, headersCount: entries?.length ?? null,
            affinityHash: headers ? this.digest(AFFINITY_HEADERS.map(key => [key, headers.get(key)])) : null };
          // Native HTTP SDKs pass JSON strings. Any other body (a stream, a Request's own body, binary) is
          // named but never consumed or teed; the record says `body-unobservable` instead of implying
          // "no items observed = nothing changed".
          const body = init?.body;
          const bodyKind = requestBodyKind(input, init);
          const wireBytes = typeof body === 'string' ? Buffer.byteLength(body) : null;
          if (typeof body !== 'string' || wireBytes === null || wireBytes > MAX_BYTES) {
            capture(undefined, 'http', attempt, { ...headerEvidence, coverage: 'body-unobservable',
              bodyKind: wireBytes !== null && wireBytes > MAX_BYTES ? 'string-over-limit' : bodyKind,
              ...(wireBytes === null ? {} : { wireBytes }) });
            return attempt;
          }
          const payload: unknown = JSON.parse(body);
          capture(payload, 'http', attempt, { ...headerEvidence,
            wireBytes, wireHash: this.digest(body),
            adapterMatch: payloadSnapshot ? payloadSnapshot.hash === this.digest(payload) : null,
            endpointHash: this.digest(input instanceof Request ? input.url : String(input)) });
        } catch { capture(undefined, 'http', attempt); }
        return attempt;
      },
      received: (attempt: number, status: number | null) => { emit({ ...base, event: 'http-result', attempt, status }); },
      result: (message: { responseId?: string; responseModel?: string; stopReason: string; errorMessage?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total?: number } } }) => {
        try {
          const u = message.usage;
          const cost = nativeCostEvidence(u, reported, providerCost);
          emit({ ...base, event: 'result', attempts, startedAt, firstResponseAt, modelMs: Math.max(0, performance.now() - startedClock),
            reportedUsage: reported, usageSource,
            nativeCostTotal: cost.total, nativeCostSource: cost.source, nativeCostComplete: cost.complete,
            responseHash: message.responseId ? plainHash(message.responseId) : null,
            responseModelHash: message.responseModel ? this.digest(message.responseModel) : null,
            outcome: ['stop', 'length', 'toolUse', 'error', 'aborted'].includes(message.stopReason) ? message.stopReason : 'other',
            usage: u ? { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite } : null,
            hitRate: u && u.input + u.cacheRead + u.cacheWrite > 0 ? u.cacheRead / (u.input + u.cacheRead + u.cacheWrite) : null },
          message.errorMessage ? { error: message.errorMessage.slice(0, 2000) } : undefined);
        } catch { emit({ ...base, event: 'result', attempts, outcome: 'observation-failed' }); }
      },
    };
  }
}
