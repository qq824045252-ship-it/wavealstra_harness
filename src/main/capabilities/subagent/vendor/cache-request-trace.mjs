// src/main/agent/CacheRequestTracer.ts
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
var MAX_ITEMS = 4096;
var MAX_BYTES = 16 * 1024 * 1024;
var MAX_CHAINS = 32;
var FIELDS = /* @__PURE__ */ new Set([
  "model",
  "instructions",
  "system",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "thinking",
  "max_output_tokens",
  "max_tokens",
  "temperature",
  "top_p",
  "stream",
  "store",
  "include",
  "text",
  "response_format",
  "prompt_cache_key",
  "prompt_cache_retention",
  "prompt_cache",
  "previous_response_id",
  "service_tier",
  "metadata",
  "user",
  "truncation",
  "context_management"
]);
var ITEM_FIELDS = /* @__PURE__ */ new Set([
  "type",
  "role",
  "id",
  "call_id",
  "name",
  "arguments",
  "content",
  "output",
  "summary",
  "encrypted_content",
  "phase",
  "status",
  "tools"
]);
var KINDS = /* @__PURE__ */ new Set([
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "tool_search_call",
  "tool_search_output",
  "additional_tools",
  "configuration_update"
]);
var ROLES = /* @__PURE__ */ new Set(["system", "developer", "user", "assistant", "tool"]);
var AFFINITY_HEADERS = ["session_id", "conversation_id", "x-session-id", "x-client-session-id", "user-agent", "openai-beta"];
var plainHash = (value) => createHash("sha256").update(value).digest("hex");
function sessionTraceBoundary(session, operation) {
  try {
    const branch = session.sessionManager.getBranch();
    const latest = (type, customType) => [...branch].reverse().find((entry) => entry.type === type && (!customType || entry.type === "custom" && entry.customType === customType))?.id;
    return {
      sessionId: session.sessionId,
      operation,
      leafId: session.sessionManager.getLeafId(),
      userId: [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "user")?.id,
      compactionId: latest("compaction"),
      ledgerId: latest("custom", "mybuddy.context-ledger"),
      resetId: latest("custom", "mybuddy.context-reset")
    };
  } catch {
    return { operation };
  }
}
var CacheRequestTracer = class {
  constructor(sink) {
    this.sink = sink;
  }
  sink;
  epoch = randomUUID();
  key = randomBytes(32);
  previous = /* @__PURE__ */ new Map();
  sequence = 0;
  digest(value) {
    return createHmac("sha256", this.key).update(JSON.stringify(value) ?? "undefined").digest("hex");
  }
  emit(record) {
    try {
      this.sink({ version: 1, epoch: this.epoch, at: Date.now(), sequence: ++this.sequence, ...record });
    } catch {
    }
  }
  fields(value, allowed, omit = /* @__PURE__ */ new Set()) {
    const result = {};
    const other = {};
    for (const [key, data] of Object.entries(value)) {
      if (omit.has(key)) continue;
      if (allowed.has(key)) result[key] = this.digest(data);
      else other[key] = data;
    }
    if (Object.keys(other).length) result.other = this.digest(other);
    return result;
  }
  snapshot(payload, request, attempt) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const body = payload;
    const encoded = JSON.stringify(body);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_BYTES) return;
    const field = Array.isArray(body.input) ? "input" : Array.isArray(body.messages) ? "messages" : void 0;
    if (!field) return;
    const input = body[field];
    const items = input.slice(0, MAX_ITEMS).map((value) => {
      const item = value && typeof value === "object" && !Array.isArray(value) ? value : {};
      const type = typeof item.type === "string" && KINDS.has(item.type) ? item.type : "other";
      const role = typeof item.role === "string" && ROLES.has(item.role) ? item.role : void 0;
      return {
        hash: this.digest(value),
        bytes: Buffer.byteLength(JSON.stringify(value) ?? "undefined"),
        kind: type,
        role,
        fields: this.fields(item, ITEM_FIELDS)
      };
    });
    return {
      request,
      attempt,
      hash: this.digest(body),
      inputHash: this.digest(input),
      items,
      inputCount: input.length,
      complete: input.length <= MAX_ITEMS,
      fields: this.fields(body, FIELDS, /* @__PURE__ */ new Set([field])),
      bytes
    };
  }
  start(model, sessionId, boundary) {
    const request = randomUUID();
    const session = sessionId || boundary?.sessionId;
    const sessionHash = session ? plainHash(session) : void 0;
    const modelHash = this.digest([model.provider, model.id, model.api]);
    const base = {
      request,
      sessionHash,
      modelHash,
      boundary: boundary ? {
        operation: ["prompt", "stream", "compact", "navigate", "capability"].includes(boundary.operation ?? "") ? boundary.operation : "other",
        leaf: boundary.leafId ? this.digest(boundary.leafId) : null,
        user: boundary.userId ? this.digest(boundary.userId) : null,
        compaction: boundary.compactionId ? this.digest(boundary.compactionId) : null,
        ledger: boundary.ledgerId ? this.digest(boundary.ledgerId) : null,
        reset: boundary.resetId ? this.digest(boundary.resetId) : null
      } : void 0
    };
    let attempts = 0;
    let payloadSnapshot;
    const capture = (payload, stage, attempt, extras = {}) => {
      try {
        const now = this.snapshot(payload, request, attempt);
        if (!now) {
          this.emit({ ...base, event: "request", stage, attempt, coverage: "unsupported-or-over-limit", ...extras });
          if (sessionHash) this.previous.delete(`${sessionHash}/${stage}/${boundary?.operation ?? "unbound"}`);
          return void 0;
        }
        const chain = sessionHash ? `${sessionHash}/${stage}/${boundary?.operation ?? "unbound"}` : void 0;
        const before = chain ? this.previous.get(chain) : void 0;
        let shared = 0;
        while (before && shared < before.items.length && shared < now.items.length && before.items[shared].hash === now.items[shared].hash) shared++;
        const changes = before ? [.../* @__PURE__ */ new Set([...Object.keys(before.fields), ...Object.keys(now.fields)])].filter((key) => before.fields[key] !== now.fields[key]) : [];
        const oldItem = before?.items[shared], newItem = now.items[shared];
        const prefix = before?.complete && now.complete ? shared === before.inputCount : null;
        const changedItemFields = oldItem && newItem ? [.../* @__PURE__ */ new Set([...Object.keys(oldItem.fields), ...Object.keys(newItem.fields)])].filter((key) => oldItem.fields[key] !== newItem.fields[key]) : [];
        this.emit({
          ...base,
          event: "request",
          stage,
          attempt,
          coverage: now.complete ? "complete" : "partial",
          bytes: now.bytes,
          bodyHash: now.hash,
          inputHash: now.inputHash,
          inputCount: now.inputCount,
          // Full bounded vectors allow independent offline checking; field hashes only for the first difference.
          items: now.items.map(({ fields: _fields, ...item }) => item),
          fields: now.fields,
          previous: before ? {
            request: before.request,
            attempt: before.attempt,
            inputCount: before.inputCount,
            sharedItems: shared,
            prefix,
            changedFields: changes,
            firstDifference: prefix === false ? { index: shared, old: oldItem, current: newItem, changedItemFields } : void 0
          } : null,
          ...extras
        });
        if (chain) {
          this.previous.delete(chain);
          this.previous.set(chain, now);
          while (this.previous.size > MAX_CHAINS) this.previous.delete(this.previous.keys().next().value);
        }
        return now;
      } catch {
        if (sessionHash) this.previous.delete(`${sessionHash}/${stage}/${boundary?.operation ?? "unbound"}`);
        this.emit({ ...base, event: "request", stage, attempt, coverage: "observation-failed" });
        return void 0;
      }
    };
    return {
      payload: (payload) => {
        payloadSnapshot = capture(payload, "provider", 0);
      },
      sent: (input, init) => {
        const attempt = ++attempts;
        try {
          if (typeof init?.body !== "string" || Buffer.byteLength(init.body) > MAX_BYTES) {
            capture(void 0, "http", attempt);
            return attempt;
          }
          const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : void 0));
          const affinity = AFFINITY_HEADERS.map((key) => [key, headers.get(key)]);
          const payload = JSON.parse(init.body);
          capture(payload, "http", attempt, {
            wireBytes: Buffer.byteLength(init.body),
            wireHash: this.digest(init.body),
            adapterMatch: payloadSnapshot ? payloadSnapshot.hash === this.digest(payload) : null,
            endpointHash: this.digest(input instanceof Request ? input.url : String(input)),
            affinityHash: this.digest(affinity)
          });
        } catch {
          capture(void 0, "http", attempt);
        }
        return attempt;
      },
      received: (attempt, status) => {
        this.emit({ ...base, event: "http-result", attempt, status });
      },
      result: (message) => {
        try {
          const u = message.usage;
          this.emit({
            ...base,
            event: "result",
            attempts,
            responseHash: message.responseId ? plainHash(message.responseId) : null,
            responseModelHash: message.responseModel ? this.digest(message.responseModel) : null,
            outcome: ["stop", "length", "toolUse", "error", "aborted"].includes(message.stopReason) ? message.stopReason : "other",
            usage: u ? { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite } : null,
            hitRate: u && u.input + u.cacheRead + u.cacheWrite > 0 ? u.cacheRead / (u.input + u.cacheRead + u.cacheWrite) : null
          });
        } catch {
          this.emit({ ...base, event: "result", attempts, outcome: "observation-failed" });
        }
      }
    };
  }
};
export {
  CacheRequestTracer,
  sessionTraceBoundary
};
