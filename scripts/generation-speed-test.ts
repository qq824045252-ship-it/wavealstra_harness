import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { GenerationSpeedTracker, estimateDeltaTokens } from "../src/main/usage/GenerationSpeedTracker";
import { generationSpeedView, generationSpeedInput, selectGenerationReply } from "../src/renderer/src/lib/generationSpeed";
import { applyPatchToMessage, useAppStore } from "../src/renderer/src/store/appStore";
import { useBtwStore } from "../src/renderer/src/store/btwStore";
import type { ChatMessage } from "../src/renderer/src/types";
import { mapPiEventToPatches } from "../src/shared/pi-event-mapper";

let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log(`PASS ${name}`); }
const event = (value: object) => value as AgentSessionEvent;
const turn = event({ type: "turn_start" });
const delta = (text: string, type = "text_delta") => event({ type: "message_update", assistantMessageEvent: { type, delta: text } });
const end = (output: number, stopReason = "stop") => event({ type: "message_end", message: { role: "assistant", stopReason, usage: { output } } });
const done = event({ type: "agent_end", willRetry: false });
const message = (id: string): ChatMessage => ({ id, role: "assistant", blocks: [], createdAt: 1000, streaming: true });

test("live speed is published before message_end, throttled to 500ms", () => {
  const t = new GenerationSpeedTracker();
  assert.equal(t.onEvent(turn, "a", 1000)?.phase, "waiting");
  assert.equal(t.onEvent(delta("hello"), "a", 1200)?.phase, "generating");
  assert.equal(t.onEvent(delta("world"), "a", 1300), null);
  const live = t.onEvent(delta("实时速度"), "a", 1700)!;
  assert.equal(live.estimated, true);
  assert.ok(live.tps! > 0);
  assert.equal(live.ttftMs, 200);
  assert.match(generationSpeedView({ stats: live, streaming: true, approval: false, createdAt: 1000 }, 1700)!.label, /^≈.+ tok\/s$/);
});
test("thinking and tool parameters also produce real-time estimates", () => {
  for (const kind of ["thinking_delta", "toolcall_delta"]) {
    const t = new GenerationSpeedTracker();
    t.onEvent(turn, "a", 1000);
    t.onEvent(delta("thinking tool", kind), "a", 1200);
    assert.ok(t.onEvent(delta("still generating", kind), "a", 1800)!.tps! > 0);
  }
  assert.equal(estimateDeltaTokens("abcd中😀"), 3);
});
test("final weighted average excludes model waits and tool execution", () => {
  const t = new GenerationSpeedTracker();
  t.onEvent(turn, "a", 1000);
  t.onEvent(delta("a"), "a", 2000);
  t.onEvent(end(100, "toolUse"), "a", 3000);
  assert.equal(t.onEvent(event({ type: "tool_execution_start", toolCallId: "x" }), "a", 3001)?.phase, "tools");
  t.onEvent(event({ type: "tool_execution_end", toolCallId: "x" }), "a", 53000);
  t.onEvent(turn, "a", 54000);
  t.onEvent(delta("b"), "a", 55000);
  t.onEvent(end(50), "a", 57000);
  const final = t.onEvent(done, "a", 58000)!;
  assert.equal(final.tps, 50); // 150 tokens / 3 decoding seconds, not 57 wall seconds
  assert.equal(final.outputTokens, 150);
  assert.equal(final.estimated, false);
  assert.match(generationSpeedView({ stats: final, streaming: false, approval: false, createdAt: 1000 }, 58000)!.label, /^平均 50.0/);
});
test("parallel tools stay in tool phase until all finish", () => {
  const t = new GenerationSpeedTracker();
  t.onEvent(event({ type: "tool_execution_start", toolCallId: "x" }), "a", 1);
  t.onEvent(event({ type: "tool_execution_start", toolCallId: "y" }), "a", 2);
  assert.equal(t.onEvent(event({ type: "tool_execution_end", toolCallId: "x" }), "a", 3)?.phase, "tools");
  assert.equal(t.onEvent(event({ type: "tool_execution_end", toolCallId: "y" }), "a", 4)?.phase, "waiting");
});
test("reply IDs reset estimates; separate sessions cannot contaminate each other", () => {
  const a = new GenerationSpeedTracker(), b = new GenerationSpeedTracker();
  a.onEvent(turn, "a", 1000); a.onEvent(delta("a"), "a", 1100); a.onEvent(end(100), "a", 2100);
  assert.equal(a.onEvent(turn, "next", 3000)?.outputTokens, null);
  assert.equal(b.onEvent(turn, "a", 3000)?.tps, null);
});
test("SDK turn_start before queued user message preserves the new request clock", () => {
  const t = new GenerationSpeedTracker();
  t.onEvent(turn, "old", 1000); t.onEvent(delta("old"), "old", 1200); t.onEvent(end(100), "old", 2200);
  t.onEvent(turn, "old", 3000); // Still routed to old reply until queued user message activates.
  assert.equal(t.finishReply(3010).tps, 100);
  t.onEvent(event({ type: "message_start", message: { role: "user" } }), "new", 3010);
  t.onEvent(delta("new"), "new", 3300);
  const live = t.onEvent(delta("reply"), "new", 3900)!;
  assert.ok(live.tps! > 0);
  assert.equal(live.ttftMs, 300);
  assert.equal(live.outputTokens, null);
  t.onEvent(end(60), "new", 4300);
  assert.equal(t.onEvent(done, "new", 4301)?.tps, 60);
});
test("missing usage and zero duration never invent a final average", () => {
  for (const [output, endedAt] of [[0, 2000], [100, 1100]]) {
    const t = new GenerationSpeedTracker();
    t.onEvent(turn, "a", 1000); t.onEvent(delta("hello"), "a", 1100); t.onEvent(end(output), "a", endedAt);
    assert.equal(t.onEvent(done, "a", 2100)?.tps, null);
  }
});
test("retry and compaction transitions publish immediately", () => {
  const t = new GenerationSpeedTracker();
  t.onEvent(turn, "a", 1000);
  assert.equal(t.onEvent(event({ type: "agent_end", willRetry: true }), "a", 1010)?.phase, "retrying");
  assert.equal(t.onEvent(event({ type: "compaction_start" }), "a", 1020)?.phase, "compacting");
  assert.equal(t.onEvent(turn, "a", 1030)?.phase, "waiting");
  assert.deepEqual(mapPiEventToPatches(event({ type: "agent_end", willRetry: true }), {
    taskId: "task", messageId: "a", startedAt: 1000,
  }), []);
  t.onEvent(done, "a", 1100);
  assert.equal(t.onEvent(event({ type: "compaction_start" }), "a", 1101), null);
});
test("waiting, stalled stream, approval and abort labels do not claim live TPS", () => {
  const t = new GenerationSpeedTracker();
  t.onEvent(turn, "a", 1000); t.onEvent(delta("a"), "a", 1100);
  const stats = t.onEvent(delta("abcdefgh"), "a", 2100)!;
  const input = { stats, streaming: true, createdAt: 1000, approval: false };
  assert.match(generationSpeedView({ ...input, stats: undefined }, 3000)!.label, /^等待 2.0s$/);
  assert.match(generationSpeedView(input, 6000)!.label, /^等待输出/);
  assert.equal(generationSpeedView({ ...input, approval: true }, 2100)!.label, "等待批准");
  assert.equal(generationSpeedView({ ...input, streaming: false }, 2100)!.label, "已停止");
  t.onEvent(end(0, "aborted"), "a", 2200);
  assert.equal(generationSpeedView({ ...input, streaming: false, stats: t.onEvent(done, "a", 2201)! }, 2201)!.label, "已停止");
});
test("message reducer retains telemetry at completion and does not change content", () => {
  const t = new GenerationSpeedTracker();
  const base = message("a");
  const stats = t.onEvent(turn, "a", 1000)!;
  const updated = applyPatchToMessage(base, { type: "generation_stats", taskId: "task", messageId: "a", stats });
  const completed = applyPatchToMessage(updated, { type: "assistant_end", taskId: "task", messageId: "a" });
  assert.equal(completed.generationStats, stats);
  assert.equal(completed.blocks, base.blocks);
  assert.equal(completed.streaming, false);
});
test("queued replies and new user messages do not show previous reply speed", () => {
  const current = message("current"), queued = message("queued");
  assert.equal(selectGenerationReply([current, queued]), current);
  assert.equal(selectGenerationReply([{ ...current, streaming: false }, { ...queued, role: "user" }]), undefined);
  assert.equal(generationSpeedView(generationSpeedInput(undefined), 1000), null);
});
test("actual stores isolate background tasks and BTW telemetry", () => {
  const stats = new GenerationSpeedTracker().onEvent(turn, "a", 1000)!;
  useAppStore.setState({ activeTaskId: "one", tasks: ["one", "two"].map(id => ({ id, title: id, updatedAt: 1, messages: [message("a")] })) });
  useAppStore.getState().applyAgentPatch({ type: "generation_stats", taskId: "two", messageId: "a", stats });
  assert.equal(useAppStore.getState().tasks[0].messages[0].generationStats, undefined);
  assert.equal(useAppStore.getState().tasks[1].messages[0].generationStats, stats);
  useBtwStore.setState({ active: true, btwId: "btw-test", parentTaskId: "one", messages: [message("a")] });
  useBtwStore.getState().applyBtwPatch({ type: "generation_stats", taskId: "btw-test", btwId: "stale-btw", messageId: "a", stats });
  assert.equal(useBtwStore.getState().messages[0].generationStats, undefined);
  useBtwStore.getState().applyBtwPatch({ type: "generation_stats", taskId: "btw-test", btwId: "btw-test", messageId: "a", stats });
  assert.equal(useBtwStore.getState().messages[0].generationStats, stats);
  assert.equal(useAppStore.getState().tasks[0].messages[0].generationStats, undefined);
});
console.log(`${passed} generation-speed scenarios passed`);
