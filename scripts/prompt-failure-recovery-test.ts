import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { classifyPromptFailure, recordPromptFailureRecovery, resolvePromptFailureRecovery } from "../src/main/agent/PromptFailureRecovery";

const db = new Database(":memory:");
db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES ('task');");
const failures = new ExecutionFailureRepository(db);
try {
  assert.equal(classifyPromptFailure(Object.assign(new Error("socket failed"), { code: "ECONNRESET" }))?.causeCode, "provider-network");
  assert.equal(classifyPromptFailure(Object.assign(new Error("Too many requests"), { status: 429 }))?.causeCode, "provider-rate-limit");
  assert.equal(classifyPromptFailure(Object.assign(new Error("Unauthorized"), { status: 401 }))?.recovery, "requires-user-action");
  assert.equal(classifyPromptFailure(new Error("request timed out after 30s"))?.causeCode, "provider-timeout");
  assert.equal(classifyPromptFailure(Object.assign(new Error("model foo not found"), { status: 404 }))?.causeCode, "provider-model-unavailable");
  assert.equal(classifyPromptFailure(Object.assign(new Error("upstream unavailable"), { status: 503 }))?.causeCode, "provider-server-error");
  assert.equal(classifyPromptFailure(new DOMException("This operation was aborted", "AbortError")), null);
  assert.equal(classifyPromptFailure(new Error("content policy refused the request")), null, "unknown model/content errors are not guessed into recovery classes");
  const tierLimitBody = '400: {"code":"tier_limit_exceeded","message":"Open Design: [code=tier_limit_exceeded] membership concurrency limit exceeded: 11/10 resets 2026-11-06T01:00:00Z","param":null,"type":"invalid_request_error"}';
  assert.equal(classifyPromptFailure(new Error(tierLimitBody))?.causeCode, "provider-rate-limit", "the provider membership concurrency 400 string is a rate limit even without a status field");
  assert.equal(classifyPromptFailure(Object.assign(new Error(tierLimitBody), { status: 400, code: "tier_limit_exceeded" }))?.recovery, "recoverable", "a 400 carrying the tier-limit code classifies as a recoverable rate limit");
  assert.equal(classifyPromptFailure(Object.assign(new Error("invalid request body"), { status: 400, code: "tier_limit_exceeded" }))?.causeCode, "provider-rate-limit", "the code field alone is enough to separate a provider quota 400 from a parameter 400");
  assert.equal(classifyPromptFailure(Object.assign(new Error("invalid_request_error: temperature must be between 0 and 2"), { status: 400 })), null, "an ordinary 400 is not guessed into rate limit");
  assert.equal(classifyPromptFailure(Object.assign(new Error("membership concurrency limit exceeded: 11/10"), { status: 429 }))?.causeCode, "provider-rate-limit", "the same body with 429 stays a rate limit");

  const first = recordPromptFailureRecovery({ failures, taskId: "task", executionId: "e1", assistantMessageId: "a1", modelKey: "openai/gpt-x",
    error: Object.assign(new Error("Too many requests"), { status: 429 }) });
  assert.equal(first?.causeCode, "provider-rate-limit");
  recordPromptFailureRecovery({ failures, taskId: "task", executionId: "e1", assistantMessageId: "a1", modelKey: "openai/gpt-x",
    error: Object.assign(new Error("Too many requests again"), { status: 429 }) });
  assert.equal(failures.list("task").filter((item) => !item.resolvedAt && item.causeCode === "provider-rate-limit").length, 1, "duplicate SDK error paths share one unresolved recovery record");
  const row = failures.list("task").find((item) => item.causeCode === "provider-rate-limit")!;
  assert.equal(row.sideEffects, "unknown");
  assert.equal(row.target, "model:openai/gpt-x");
  assert.equal(row.recovery, "recoverable");
  assert.equal(resolvePromptFailureRecovery(failures, "task", "openai/gpt-x"), 1);
  assert(failures.list("task").find((item) => item.id === row.id)?.resolvedAt);

  console.log("prompt failure recovery: PASS (conservative classifier, tier-limit 400 vs ordinary 400, cancel exclusion, dedupe, stable model identity, successful-turn resolution)");
} finally { db.close(); }