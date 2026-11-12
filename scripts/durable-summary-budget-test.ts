import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { DurableContextManager } from "../src/main/agent/durable/context/DurableContextManager";
import { summaryOutputBudget, summaryModelLimits } from "../src/main/agent/durable/context/DurableSummaryBudget";

const model = { id: "flash", provider: "fixture", contextWindow: 1_048_000, maxTokens: 65536, reasoning: true };
function fixture(replies: string[], registered = model) {
  const calls: { maxTokens: number; input: number; messages: unknown }[] = [];
  const statuses: unknown[] = [];
  const manager = new DurableContextManager({ conversation: { id: 1 } as never, models: {} as never,
    contextWindow: () => registered.contextWindow, policy: () => ({ ratio: 0.8, absoluteTokens: 500000 }),
    onStatus: status => statuses.push(status) });
  const models = { completeSimple: async (_: unknown, request: { messages: never[] }, options: { maxTokens: number }) => {
    calls.push({ maxTokens: options.maxTokens, input: request.messages.reduce((n, m) => n + estimateMessageTokens(m), 0), messages: request.messages });
    const stopReason = replies.shift() ?? "length";
    return { stopReason, content: [{ type: "text", text: stopReason === "stop" ? "Exact path /tmp/a, decision retained." : "INCOMPLETE" }] };
  } };
  const run = () => (manager as unknown as { callSummarizer: (...args: unknown[]) => Promise<string> }).callSummarizer("history ".repeat(6000), registered, models, ctx);
  return { run, calls, statuses, manager };
}
for (const window of [8192, 128000, 272000, 1048000]) {
  for (const output of [256, 1500, 4096, 32768, 65536]) {
    const m = { contextWindow: window, maxTokens: output, reasoning: true };
    const b = summaryOutputBudget(m, window, Math.floor(window / 2));
    assert(b.initial > 0 && b.initial <= b.ceiling && b.ceiling <= output);
    assert(window / 2 + b.ceiling + b.safety <= window);
  }
}
assert(summaryOutputBudget(model, model.contextWindow, 24000).initial > 1500);
assert(summaryOutputBudget(model, model.contextWindow, 24000).initial > summaryOutputBudget(model, model.contextWindow, 2000).initial);
assert.equal(summaryModelLimits({}, 128000).output, 4096);
assert.throws(() => summaryOutputBudget(model, 1024, 1000), /窗口不足/);
const recovered = fixture(["length", "stop"]);
assert.match(await recovered.run(), /Exact path/);
assert.equal(recovered.calls.length, 2);
assert(recovered.calls[1]!.maxTokens > recovered.calls[0]!.maxTokens);
assert.deepEqual(recovered.calls[0]!.messages, recovered.calls[1]!.messages, "discard truncated reply; retry original only");
assert(recovered.statuses.length > 0);
for (const call of recovered.calls) assert(call.input + call.maxTokens + 1024 <= model.contextWindow);
const exhausted = fixture(["length", "length", "length"]);
await assert.rejects(exhausted.run(), /length.*尝试 3 次.*原文/);
assert.equal(exhausted.calls.length, 3);
assert(exhausted.calls.at(-1)!.maxTokens <= model.maxTokens);
const tiny = fixture(["length"], { ...model, maxTokens: 1000 });
await assert.rejects(tiny.run(), /length.*尝试 1 次/);
assert.equal(tiny.calls.length, 1);
const error = fixture(["error"]);
await assert.rejects(error.run(), /error/);
assert.equal(error.calls.length, 1, "only length is budget-retriable");
console.log("PASS summary budgets: 20 model/window cases, growth, missing metadata, actual manager length recovery, bounded failure, original preservation");
