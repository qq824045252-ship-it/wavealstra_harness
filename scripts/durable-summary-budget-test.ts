import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { DurableContextManager, splitSpansByChars } from "../src/main/agent/durable/context/DurableContextManager";
import { blockSummaryBudget, nativeSummaryBudget, summaryModelLimits } from "../src/main/agent/durable/context/SummaryBudget";

// —— 契约本身：一个数字（字符），从内核配置派生 ——
const compress = { minCompressRange: 5000, maxSummaryLength: 20_000, minSummaryLength: 50 };
const block = blockSummaryBudget(compress);
assert.equal(block.charMax, 20_000);
assert.equal(block.maxRangeChars, 80_000, "one summary may represent at most 4x its own cap");
assert(block.fits("x".repeat(20_000)));
assert(block.fits(` ${"x".repeat(20_000)} `), "kernel validates the trimmed summary");
assert(!block.fits("x".repeat(20_001)));
assert.match(block.rule(), /20000 characters/, "the generation rule states the real number");
assert.match(block.overage("x".repeat(20_500)), /超过单块上限 20000 字符（超出 500）/);
// 同一字符上限对应完全不同的输出 token：英文 4 字符/token，中文 1 字符/token。
assert.equal(block.outputTokens("word ".repeat(4_000)), 3_750, "output aims below the hard limit instead of inviting an oversized response");
assert.equal(block.outputTokens("字".repeat(20_000)), 15_000, "CJK receives one output token per target character");
// 输入块上限：英文 80000 字符即 20000 token；窗口更小时跟随窗口；单次请求另有成本上限。
assert.equal(block.inputLimitTokens(4, 1_000_000), 20_000);
assert.equal(block.inputLimitTokens(4, 8_192), 8_192);
assert.equal(block.inputLimitTokens(1, 1_000_000), 24_000);
const disabled = blockSummaryBudget({ ...compress, maxSummaryLength: 0 });
assert.equal(disabled.charMax, Number.POSITIVE_INFINITY);
assert(disabled.fits("x".repeat(10_000_000)));
const native = nativeSummaryBudget();
assert.equal(native.charMax, Number.POSITIVE_INFINITY);
assert(native.fits("x".repeat(10_000_000)), "Pi native summaries have no kernel gate");

// —— 拆块：沿原子边界切片，每片都能由一条摘要代表 ——
const messages = Array.from({ length: 12 }, () => ({ text: "x".repeat(10_000) }));
const atomic = messages.map((_, index) => ({ start: index, end: index }));
assert.deepEqual(splitSpansByChars([{ start: 0, end: 11 }], atomic, { messages }, 50_000),
  [{ start: 0, end: 4 }, { start: 5, end: 9 }, { start: 10, end: 11 }], "each slice stays within one summary's source capacity");
assert.deepEqual(splitSpansByChars([{ start: 0, end: 1 }], [{ start: 0, end: 0 }, { start: 1, end: 1 }],
  { messages: [{ text: "x".repeat(120_000) }, { text: "y" }] }, 50_000), [{ start: 0, end: 0 }, { start: 1, end: 1 }],
  "an indivisible message larger than the cap keeps its own block instead of being cut");
assert.deepEqual(splitSpansByChars([{ start: 0, end: 0 }], atomic, { messages }, 50_000), [{ start: 0, end: 0 }]);

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
// —— 长度截断只放大输出预算，不重发被截断的回复 ——
assert.equal(summaryModelLimits({}, 128000).output, 4096);
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

// —— 超长摘要先在宿主侧 condense，绝不带着超限文本进入内核 ——
const oversized: string[] = [];
const condensing = new DurableContextManager({ conversation: { id: 1 } as never, models: {} as never,
  contextWindow: () => model.contextWindow, policy: () => ({ ratio: 0.8, absoluteTokens: 500000 }) });
const condenseModels = { completeSimple: async (_: unknown, request: { messages: Array<{ role: string; content: string }> }) => {
  const prompt = request.messages.at(-1)!.content;
  const mode = prompt.startsWith("Rewrite the summary below") ? "condense" : "summary";
  oversized.push(mode);
  return { stopReason: "stop", content: [{ type: "text", text: mode === "condense" ? "C".repeat(3_000) : "S".repeat(25_000) }] };
} };
const fitted = await (condensing as unknown as { callSummarizer: (...args: unknown[]) => Promise<string> })
  .callSummarizer("source ".repeat(4000), model, condenseModels, ctx);
assert.equal(fitted.length, 3_000);
assert.deepEqual(oversized, ["summary", "condense"]);
console.log("PASS summary budget: one char-derived contract (20000 chars / 80000 source chars), CJK-aware output tokens, host-side condense, untruncated length retry");
