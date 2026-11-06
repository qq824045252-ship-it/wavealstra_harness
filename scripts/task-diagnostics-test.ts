import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { CacheRequestTracer } from "../src/main/agent/CacheRequestTracer";
import { TaskDiagnosticsRepository } from "../src/main/agent/TaskDiagnosticsRepository";
import { reportedTokenUsage } from "../src/main/agent/ReportedTokenUsage";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { UsageStatsService } from "../src/main/usage/UsageStatsService";
import { isCallRow } from "../src/shared/usage-stats";

const root = mkdtempSync(join(tmpdir(), "mybuddy-task-diagnostics-"));
const db = new AppDatabase(join(root, "app.db"));
db.upsertTask({ id: "task", title: "diagnostic fixture", updatedAt: 1 });
const model = { provider: "fixture", id: "model", api: "fixture", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } };
let diagnostics = new TaskDiagnosticsRepository(db.connection);
const tracer = new CacheRequestTracer(() => {});
try {
  assert.deepEqual(reportedTokenUsage({ type: "response.completed", response: { usage: { input_tokens: 120, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } } })?.values,
    { input: 120, output: 5, cacheRead: 0, cacheWrite: null });
  assert.deepEqual(reportedTokenUsage({ usage: { prompt_tokens: 120, completion_tokens: 5 } })?.values,
    { input: null, output: 5, cacheRead: null, cacheWrite: null });
  assert.equal(reportedTokenUsage({ unrelated: true }), undefined);
  const request = tracer.start(model, "fixture-session", undefined, event => diagnostics.observeTrace(event, model));
  request.identify({ taskId: "task", executionScope: "task", conversationId: "7", generationTaskId: 11, sourceKind: "main" });
  const body = JSON.stringify({ model: "model", input: [{ role: "user", content: "fixture" }] });
  request.payload(JSON.parse(body));
  request.received(request.sent("https://fixture.invalid", { body }), 503);
  request.received(request.sent("https://fixture.invalid", { body }), 200);
  request.providerEvent({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 } } });
  request.providerEvent({ type: "message_delta", usage: { output_tokens: 3 } });
  request.firstResponse();
  const result = { stopReason: "stop", usage: { input: 10, output: 3, cacheRead: 20, cacheWrite: 0, cacheWrite1h: 7,
    cost: { input: 0.2, output: 0.3, cacheRead: 0.1, cacheWrite: 0.4, total: 1 } } };
  request.result(result); request.result(result);
  let value = diagnostics.list("task");
  assert.equal(value.requests.length, 1, "completed result observation is idempotent");
  assert.equal(value.requests[0]?.attempts.length, 2);
  assert.deepEqual(value.requests[0]?.usage, { input: 10, output: 3, cacheRead: 20, cacheWrite: 0 });
  assert.equal(value.requests[0]?.costComplete, true);
  assert.equal(value.requests[0]?.knownCostUsd, 1, "native tier/cache pricing is not replaced with base rates");
  const unknown = tracer.start(model, "fixture-session", undefined, event => diagnostics.observeTrace(event, model));
  unknown.identify({ taskId: "task", conversationId: "8", generationTaskId: 12, sourceKind: "subagent" });
  unknown.result({ stopReason: "aborted", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } });
  assert.deepEqual(diagnostics.list("task").requests.find(row => row.generationTaskId === 12)?.usage,
    { input: null, output: null, cacheRead: null, cacheWrite: null }, "SDK zero does not establish reported usage");
  assert.equal(diagnostics.usageForConversation("task", "8").cacheHitRate, null);
  assert.equal(diagnostics.usageForGeneration("task", "8", 12).costTotal, null, "missing native cost remains unknown");
  assert.equal(diagnostics.list("task").requests.find(row => row.generationTaskId === 12)?.costSource, "sdk-default");
  assert.equal(diagnostics.list("task").requests.find(row => row.generationTaskId === 12)?.costComplete, false);
  const now = Date.now();
  new ConversationInteractionRepository(db.connection).insert({ id: "wait", taskId: "task", executionId: "durable:task:7:30",
    assistantMessageId: "assistant", kind: "confirm", title: "Approve", options: [], allowCustom: false, status: "resolved", answer: true,
    version: 1, createdAt: now + 100, resolvedAt: now + 500 });
  const tool = { taskId: "task", conversationId: "7", toolTaskId: 30, callId: "call", name: "request_user_input", sourceKind: "main" as const };
  diagnostics.observeTool({ ...tool, phase: "start", at: now });
  diagnostics.observeTool({ ...tool, phase: "finish", at: now + 1000 });
  value = diagnostics.list("task");
  assert.equal(value.tools[0]?.observedMs, 1000);
  assert.equal(value.tools[0]?.activeMs, 600);
  assert.equal(value.tools[0]?.waitingMs, 400);
  diagnostics.observeTool({ ...tool, toolTaskId: 31, phase: "start", at: now });
  diagnostics = new TaskDiagnosticsRepository(db.connection);
  value = diagnostics.list("task");
  assert.equal(value.requests.length, 2, "reopen does not fabricate requests or usage");
  const interrupted = value.tools.find(row => row.id.endsWith(":31"));
  assert.equal(interrupted?.status, "interrupted"); assert.equal(interrupted?.complete, false);
  assert.equal(interrupted?.activeMs, 0, "unobserved downtime is not charged as tool time");
  const statistics = new UsageStatsService(db.connection);
  statistics.recordLive({ taskId: "task", sessionFile: "durable:task:8", sourceKind: "subagent", sourceDetail: "pi-durable",
    persistedEntryId: "diagnostic-usage", message: { ...result, provider: model.provider, model: model.id, timestamp: now },
    reportedUsage: diagnostics.usageForGeneration("task", "8", 12),
    sample: { turnIndex: 12, requestStartedAt: null, firstResponseAt: null, completedAt: now, ttftMs: null, decodeMs: null,
      generationTps: null, modelWallMs: null, outputTokens: null, reasoningTokens: null } });
  assert.equal(statistics.queryRows({})[0]?.known?.cacheRead, false);
  const usageRow = statistics.queryRows({})[0];
  assert(usageRow);
  assert.equal(usageRow.costTotal, 1, "unknown raw usage does not erase native pricing");
  assert.equal(usageRow.known?.cost, true);
  assert.deepEqual(db.connection.prepare("SELECT cost_input, cost_output, cost_cache_read, cost_cache_write, cache_write_1h FROM usage_events WHERE entry_id='diagnostic-usage'").get(),
    { cost_input: 0.2, cost_output: 0.3, cost_cache_read: 0.1, cost_cache_write: 0.4, cache_write_1h: 7 });
  assert.equal(isCallRow({ ...usageRow, sourceKind: "auxiliary" }), true);
  assert.equal(statistics.dashboard(1).cacheHitRate, null);
  assert.equal(diagnostics.list("task", 1, 1).requests.length, 1);
  const zero = tracer.start(model, "zero", undefined, event => diagnostics.observeTrace(event, model));
  zero.identify({ taskId: "task", conversationId: "zero", generationTaskId: 13, sourceKind: "main" });
  zero.providerEvent({ usage: { cost: 0 } });
  zero.result({ stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } });
  const zeroRow = diagnostics.list("task").requests.find(row => row.generationTaskId === 13)!;
  assert.equal(zeroRow.costSource, "provider-reported"); assert.equal(zeroRow.costComplete, true); assert.equal(zeroRow.knownCostUsd, 0);
  const partial = tracer.start(model, "partial", undefined, event => diagnostics.observeTrace(event, model));
  partial.identify({ taskId: "task", conversationId: "partial", generationTaskId: 14, sourceKind: "main" });
  partial.result(result);
  const partialRow = diagnostics.list("task").requests.find(row => row.generationTaskId === 14)!;
  assert.equal(partialRow.knownCostUsd, 1); assert.equal(partialRow.costSource, "pi-native");
  assert.deepEqual(partialRow.usage, { input: null, output: null, cacheRead: null, cacheWrite: null });
  statistics.recordLive({ taskId: "task", sessionFile: "durable:task:8", sourceKind: "main", persistedEntryId: "unknown-zero",
    message: { ...result, timestamp: now, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
    reportedUsage: diagnostics.usageForGeneration("task", "8", 12),
    sample: { turnIndex: 13, requestStartedAt: null, firstResponseAt: null, completedAt: now, ttftMs: null, decodeMs: null, generationTps: null, modelWallMs: null, outputTokens: null, reasoningTokens: null } });
  assert.equal(statistics.queryRows({}).find(row => row.entryId === "unknown-zero")?.known?.cost, false);
  console.log("PASS request retries, raw usage presence, idempotent recovery, wait subtraction and account coverage");
} finally { db.close(); }
assert.doesNotThrow(() => diagnostics.observeTool({ phase: "finish", taskId: "task", conversationId: "7", toolTaskId: 99, callId: "closed", name: "read", sourceKind: "main", at: Date.now() }));
assert.equal(diagnostics.usageForGeneration("task", "7", 11).costTotal, null);
assert(diagnostics.list("task").unavailable);
