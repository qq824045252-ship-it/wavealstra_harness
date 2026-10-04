import { projectLegacyExecutionControlHistory } from "../src/main/agent/LegacyExecutionControlHistory";
import { nativeRunPhaseLabel } from "../src/shared/generation-stats";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createConversationRuntimeExtension } from "../src/main/agent/conversation-runtime-extension";
import { mapPiEventToPatches, type MapperContext } from "../src/shared/pi-event-mapper";
import { PromptSubmissionCoordinator } from "../src/main/agent/PromptSubmissionCoordinator";

const results: Array<{ name: string; passed: boolean; error?: string }> = [];
function test(name: string, fn: () => void) {
  try { fn(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); console.error(`FAIL ${name}: ${error}`); }
}
const source = (p: string) => readFileSync(p, "utf8");
const extensionSource = source("src/main/agent/conversation-runtime-extension.ts");
const handlers = new Map<string, Function>();
const tools = new Map<string, any>();
createConversationRuntimeExtension({ resolveContext: () => undefined } as any)({
  on: (name: string, fn: Function) => handlers.set(name, fn),
  registerTool: (tool: any) => tools.set(tool.name, tool),
} as any);
const context = (): MapperContext => ({ taskId: "test-task", messageId: "test-message", startedAt: Date.now() });
const assistant = (stopReason = "stop", errorMessage?: string) => ({ role: "assistant", content: [], stopReason, errorMessage });
const event = (type: string, rest: object = {}): any => ({ type, ...rest });

test("no model-end handler can inject or suspend another turn", () => {
  assert(!handlers.has("agent_end"));
  assert(!handlers.has("agent_before_settle"));
});
test("no hidden follow-up, completion gate, or text-to-tool recovery", () => {
  assert(!/mybuddy_completion_gate|deliverAs|extractRequestUserInputFallback|pi\.sendMessage/.test(extensionSource));
});
test("no automatic task classifier or forced planning", () => {
  assert(!/routeExecution|Execution Router|尚未进入 executing/.test(extensionSource));
});
test("runtime exposes only user input and goal tools, with no retired conversation controls", () => {
  assert.deepEqual([...tools.keys()].sort(), ["request_user_input", "conversation_goal_get", "conversation_goal_create",
    "conversation_goal_update", "conversation_goal_propose_complete"].sort());
  assert.deepEqual([...handlers.keys()], ["context"], "removed tools cannot keep an execution or compaction hook");
});
test("agent_end is not a UI terminal, including non-retry endings", () => {
  const ctx = context();
  mapPiEventToPatches(event("agent_start"), ctx);
  assert.equal(mapPiEventToPatches(event("agent_end", { messages: [assistant()], willRetry: false }), ctx).length, 0);
});
test("native settled emits exactly one terminal UI event", () => {
  const ctx = context();
  mapPiEventToPatches(event("agent_start"), ctx);
  mapPiEventToPatches(event("agent_end", { messages: [assistant()] }), ctx);
  const all = [...mapPiEventToPatches(event("agent_settled"), ctx), ...mapPiEventToPatches(event("agent_settled"), ctx)];
  assert.equal(all.filter(p => p.type === "assistant_end").length, 1);
});
test("native retry can recover without a premature failure or stale error", () => {
  const ctx = context();
  mapPiEventToPatches(event("agent_start"), ctx);
  assert.deepEqual(mapPiEventToPatches(event("agent_end", { messages: [assistant("error", "503 temporary")], willRetry: true }), ctx), []);
  mapPiEventToPatches(event("agent_start"), ctx);
  mapPiEventToPatches(event("agent_end", { messages: [assistant()] }), ctx);
  const end = mapPiEventToPatches(event("agent_settled"), ctx).find(p => p.type === "assistant_end");
  assert(end && !end.error);
});
test("terminal provider error remains visible only at settled", () => {
  const ctx = context();
  mapPiEventToPatches(event("agent_start"), ctx);
  mapPiEventToPatches(event("agent_end", { messages: [assistant("error", "provider unavailable")] }), ctx);
  const end = mapPiEventToPatches(event("agent_settled"), ctx).find(p => p.type === "assistant_end");
  assert(end && end.error === "provider unavailable");
});
test("tool error remains a tool error, not an invented run failure", () => {
  const ctx = context();
  const patches = mapPiEventToPatches(event("tool_execution_end", { toolName: "bash", toolCallId: "call-1", isError: true, result: { content: [{ type: "text", text: "exit 7" }] } }), ctx);
  assert(patches.some(p => p.type === "tool_update" && p.status === "error"));
  assert(!patches.some(p => p.type === "assistant_end"));
});
test("successive steer requests neither cancel a run nor replace Pi queues", () => {
  let cancels = 0;
  const entry: any = { session: { isStreaming: true, isCompacting: false, clearQueue: () => { throw Error("must not clear native queue"); } },
    executionId: "old-exec", assistantMessageId: "old", pendingAssistantTurns: [],
    promptQueueEpoch: 0, promptSubmissionTail: Promise.resolve() };
  const c = new PromptSubmissionCoordinator();
  const a = c.begin(entry, { streamingBehavior: "steer", assistantMessageId: "a", executionId: "ea", startedAt: 1 });
  const b = c.begin(entry, { streamingBehavior: "steer", assistantMessageId: "b", executionId: "eb", startedAt: 2 });
  assert(a.ok && b.ok);
  assert.equal(c.enqueue(entry, a.context), "ready");
  assert.equal(c.enqueue(entry, b.context), "ready");
  assert.equal(cancels, 0);
  assert.deepEqual(entry.pendingAssistantTurns.map((x: any) => x.messageId), ["a", "b"]);
});
test("runtime observer does not turn business evidence into a model error", () => {
  const s = source("src/main/agent/SessionEventCoordinator.ts");
  assert(!/executionGateReasons|verificationError|previousVerificationError/.test(s));
  assert(s.includes('event.type === "agent_settled"'));
});
test("legacy hidden directives are removed without erasing real user answers/history", () => {
  const user: any = { role: "user", content: "Explain mybuddy_completion_gate", timestamp: 1 };
  const gate: any = { role: "custom", customType: "mybuddy_completion_gate", content: "Continue forever", timestamp: 2 };
  const answer: any = { role: "custom", customType: "mybuddy_request_user_input_recovery", content: "Continue now", details: { answer: "chosen option" }, timestamp: 3 };
  const history = [user, gate, answer];
  const projected = projectLegacyExecutionControlHistory(history);
  assert.equal(history.length, 3);
  assert.strictEqual(projected[0], user);
  assert.equal(projected.length, 2);
  assert(JSON.stringify(projected[1]).includes("chosen option"));
  assert(!JSON.stringify(projected).includes("Continue now"));
  assert.strictEqual(projectLegacyExecutionControlHistory([user])[0], user);
});
test("legacy Todo and Plan tool records remain readable history without reviving their tools", () => {
  const history: any[] = [
    { role: "user", content: "保留以前的对话内容", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "old-todo", name: "conversation_todo_write", arguments: { title: "旧任务清单" } }] },
    { role: "toolResult", toolCallId: "old-todo", toolName: "conversation_todo_write", content: [{ type: "text", text: "以前记录的清单" }], isError: false },
    { role: "assistant", content: [{ type: "toolCall", id: "old-plan", name: "conversation_plan_write", arguments: { title: "旧计划" } }] },
    { role: "toolResult", toolCallId: "old-plan", toolName: "conversation_plan_write", content: [{ type: "text", text: "以前记录的计划" }], isError: false },
  ];
  assert.strictEqual(projectLegacyExecutionControlHistory(history), history);
  assert.equal(handlers.get("context")!({ messages: history }), undefined);
  assert(!tools.has("conversation_todo_write") && !tools.has("conversation_plan_write"));
});

test("tool wait, native retry and user input are not mislabeled as thinking", () => {
  assert.match(nativeRunPhaseLabel("tools", ["bash"]), /bash/);
  assert.match(nativeRunPhaseLabel("tools", ["request_user_input"]), /用户/);
  assert.match(nativeRunPhaseLabel("retrying", []), /重试/);
  assert.match(nativeRunPhaseLabel("compacting", []), /压缩/);
  assert.match(nativeRunPhaseLabel("waiting", []), /等待模型/);
});
mkdirSync("artifacts/pi-native-control", { recursive: true });
writeFileSync("artifacts/pi-native-control/contract-results.json", JSON.stringify({ at: new Date().toISOString(), results, passed: results.every(r => r.passed) }, null, 2));
process.exitCode = results.every(r => r.passed) ? 0 : 1;
