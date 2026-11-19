/** 摘要大小契约的端到端回归：真实 Durable/SQLite + 真实内核，假模型（无网络、无 GUI）。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { DurableBotRuntime, type DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";
import type { DurableContextManager } from "../src/main/agent/durable/context/DurableContextManager";
import { blockSummaryBudget } from "../src/main/agent/durable/context/SummaryBudget";
import { defaultConfig } from "../vendor/acp-kernel/src/index.js";

const WINDOW = 272_000;
const PER_MESSAGE = 8_000;
const budget = blockSummaryBudget(defaultConfig(WINDOW).compress);
const LIMIT = budget.charMax as number;
const MAX_RANGE = budget.maxRangeChars as number;

function body(index: number): string {
  return `${index % 2 ? "OBSERVED" : "REQUEST"} ${index}: /repo/file-${index}.ts:${index} ERROR_${index} v4.7.2\n`.padEnd(PER_MESSAGE, "x");
}
function answer(content: string, input = 0, timestamp = Date.now()): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text: content }], timestamp, api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop",
    usage: { input, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: input + 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function history(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => index % 2
    ? answer(body(index), index, index + 1)
    : { role: "user", content: body(index), timestamp: index + 1 } as Message);
}

/** 真实 provider 形状的夹具：completeSimple 伪造摘要把上限打爆，streamSimple 记录出站消息。 */
function fixture(summaryFor: (mode: string, prompt: string) => string) {
  const catalog: Model<"openai-completions">[] = [{ id: "fixture", provider: "fixture", api: "openai-completions", name: "fixture", baseUrl: "http://invalid.invalid",
    reasoning: false, input: ["text"], contextWindow: WINDOW, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }];
  const summaryCalls: string[] = [];
  const outbound: Message[][] = [];
  const models = {
    getModel: () => catalog[0],
    getAuth: async () => undefined,
    completeSimple: async (_model: unknown, request: { messages: readonly Message[] }) => {
      const prompt = String(request.messages.at(-1)!.content);
      const mode = prompt.startsWith("Rewrite the summary below") ? "condense" : prompt.startsWith("Merge these") ? "merge" : "summary";
      summaryCalls.push(mode);
      return answer(summaryFor(mode, prompt));
    },
    streamSimple: (_model: unknown, input: { messages: readonly Message[] }) => {
      outbound.push(structuredClone([...input.messages]));
      const tokens = input.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message: answer("Acknowledged.", tokens) }); stream.end(); });
      return stream;
    },
  } as unknown as DurableBotOptions["models"];
  return { models, summaryCalls, outbound };
}

function options(directory: string, source: ReturnType<typeof fixture>, messages: Message[]): DurableBotOptions {
  return { directory, cwd: directory, models: source.models, model: { provider: "fixture", modelId: "fixture" }, toolMode: "native",
    instructions: () => "", onSnapshot: () => {}, initialHistory: { messages, context: [] },
    contextManagement: { policy: () => ({ ratio: 0.1, absoluteTokens: null }), engine: () => "billion-context", toolEstimateTokens: () => 0 } };
}
const manager = (runtime: DurableBotRuntime) => (runtime as unknown as { contextManager: DurableContextManager }).contextManager;
async function turn(runtime: DurableBotRuntime, key: string) {
  const result = await (await runtime.submit("Continue the current archive task.", key)).wait(ctx);
  assert.equal(result.status, "done", JSON.stringify(result));
  await runtime.conversation.waitForIdle(ctx);
  await manager(runtime).flush(ctx);
}

const root = await mkdtemp(join(tmpdir(), "durable-summary-limit-"));
try {
  const regressions = [
    ["growth below threshold preserves provider prefix", async () => {
      const directory = join(root, "cache-growth"); await mkdir(directory);
      const source = fixture(() => "Archived paths /repo/file-0.ts ERROR_0 v4.7.2 remain retrievable.");
      const base = options(directory, source, history(24));
      const config = { ...base, contextManagement: { ...base.contextManagement!, policy: () => ({ ratio: 0.9, absoluteTokens: null }) } };
      const runtime = await DurableBotRuntime.open(config);
      try {
        await turn(runtime, "growth-first");
        await runtime.conversation.commit(async tx => {
          for (const message of history(12)) await tx.appendEntry(runtime.conversation.id, { kind: message.role === "assistant" ? "pi.assistant" : "pi.user", model: [message] });
        }, ctx);
        await turn(runtime, "growth-second");
        assert.equal(source.summaryCalls.length, 0, "growth alone below the configured threshold must not rewrite history");
        assert.deepEqual(source.outbound[1]!.slice(0, source.outbound[0]!.length), source.outbound[0], "new turns append to the previous provider prefix");
      } finally { await runtime.close(); }
    }],
    ["committed summaries survive warm turns and restart without refolding", async () => {
      const directory = join(root, "cache-reopen"); await mkdir(directory);
      const source = fixture(() => "Archived paths /repo/file-0.ts ERROR_0 v4.7.2 remain retrievable.");
      const base = options(directory, source, history(96));
      const config = { ...base, contextManagement: { ...base.contextManagement!, policy: () => ({ ratio: 0.9, absoluteTokens: null }) } };
      let runtime = await DurableBotRuntime.open(config);
      try {
        assert.equal((await manager(runtime).compressNow(ctx)).applied, true);
        const calls = source.summaryCalls.length;
        const prior = await manager(runtime).readState(ctx);
        assert(prior!.blocks.some(block => block.active), "the test must start with committed coverage");
        await turn(runtime, "warm-first");
        await turn(runtime, "warm-second");
        assert.equal(source.summaryCalls.length, calls, "already-compressed originals must not trigger another summary");
        assert.deepEqual(source.outbound[1]!.slice(0, source.outbound[0]!.length), source.outbound[0]);
        await runtime.close();
        runtime = await DurableBotRuntime.open({ ...config, initialHistory: undefined });
        await turn(runtime, "warm-reopened");
        assert.equal(source.summaryCalls.length, calls, "restart must reuse committed summaries");
        assert.deepEqual(source.outbound[2]!.slice(0, source.outbound[1]!.length), source.outbound[1]);
        assert.equal((await manager(runtime).retrieveOriginal({ entryId: 7, limit: 12000 }, {
          entry: id => runtime.conversation.commit(tx => tx.entry(id as never), ctx),
        }, ctx)).text.includes("REQUEST 0:"), true, "folding preserves original evidence");
      } finally { await runtime.close(); }
    }],
    ["raw threshold retires committed projection without another model summary", async () => {
      const directory = join(root, "cache-native-retirement"); await mkdir(directory);
      const source = fixture(() => "Archived paths /repo/file-0.ts ERROR_0 v4.7.2 remain retrievable.");
      const base = options(directory, source, history(96));
      const config = { ...base, contextManagement: { ...base.contextManagement!, policy: () => ({ ratio: 0.9, absoluteTokens: null }) } };
      const runtime = await DurableBotRuntime.open(config);
      try {
        assert.equal((await manager(runtime).compressNow(ctx)).applied, true);
        const calls = source.summaryCalls.length;
        await runtime.conversation.commit(async tx => {
          for (const message of history(16)) await tx.appendEntry(runtime.conversation.id, { kind: message.role === "assistant" ? "pi.assistant" : "pi.user", model: [message] });
        }, ctx);
        await turn(runtime, "native-retirement");
        const view = await runtime.conversation.context(ctx);
        assert.equal(view.head?.kind, "pi.compaction", "the real SDK must retire the oversized original prefix");
        assert.equal(source.summaryCalls.length, calls, "native retirement must reuse the fitting projection instead of summarizing it again");
        assert.equal(JSON.stringify(source.outbound.at(-1)).includes("Archived paths /repo/file-0.ts ERROR_0 v4.7.2"), true);
      } finally { await runtime.close(); }
    }],
    ["overlong summary splits source into independently committed blocks", async () => {
      const directory = join(root, "split-overlong"); await mkdir(directory);
      const source = fixture((mode, prompt) => mode === "condense" || prompt.length > MAX_RANGE / 4
        ? "S".repeat(LIMIT + 5_000)
        : "Exact paths /repo/file-0.ts ERROR_0 v4.7.2; originals remain retrievable. ".repeat(30));
      const runtime = await DurableBotRuntime.open(options(directory, source, history(30)));
      try {
        const outcome = await manager(runtime).compressNow(ctx);
        assert.equal(outcome.applied, true, JSON.stringify(outcome));
        const blocks = (await manager(runtime).readState(ctx))!.blocks.filter(block => block.active);
        assert(blocks.length >= 2, "smaller legal summaries must commit as separate blocks");
        assert.equal(blocks.every(block => budget.fits(block.summary)), true);
        assert.equal(blocks.every(block => block.summary.includes("/repo/file-0.ts ERROR_0 v4.7.2")), true);
        assert.equal(new Set(blocks.flatMap(block => block.effectiveMessageIds)).size,
          blocks.reduce((count, block) => count + block.effectiveMessageIds.length, 0), "split blocks must not overlap");
        assert.equal((await manager(runtime).retrieveOriginal({ entryId: 7, limit: 12000 }, {
          entry: id => runtime.conversation.commit(tx => tx.entry(id as never), ctx),
        }, ctx)).text.includes("REQUEST 0:"), true);
      } finally { await runtime.close(); }
    }],
    ["an indivisible overlong tool exchange stays intact without repeated maintenance", async () => {
      const directory = join(root, "atomic-overlong"); await mkdir(directory);
      const source = fixture((mode, prompt) => mode === "condense" || prompt.includes("ATOMIC_STAMP")
        ? "S".repeat(LIMIT + 5_000)
        : "Earlier unrelated records retain exact paths and decisions; original entries remain retrievable. ".repeat(20));
      const seed = history(30);
      const parallel = answer("ATOMIC_STAMP " + "inspection ".repeat(800), 0, 5);
      parallel.stopReason = "toolUse";
      parallel.content.push({ type: "thinking", thinking: "Inspect both original records.", thinkingSignature: "immutable-signature" },
        { type: "toolCall", id: "atomic-a", name: "read", arguments: { path: "/repo/a.ts" } },
        { type: "toolCall", id: "atomic-b", name: "read", arguments: { path: "/repo/b.ts" } });
      seed[4] = parallel;
      for (const [index, id] of [[5, "atomic-a"], [6, "atomic-b"]] as const) seed[index] = {
        role: "toolResult", toolCallId: id, toolName: "read", isError: false, timestamp: index + 1,
        content: [{ type: "text", text: `ATOMIC_STAMP ${id} ` + "original result ".repeat(800) }],
      };
      const original = JSON.stringify(seed.slice(4, 7));
      const base = options(directory, source, seed);
      const runtime = await DurableBotRuntime.open({ ...base,
        contextManagement: { ...base.contextManagement!, policy: () => ({ ratio: 0.9, absoluteTokens: null }) } });
      try {
        assert.equal((await manager(runtime).compressNow(ctx)).applied, true, "other ranges must still make progress");
        assert.match(runtime.contextManagementStatus()!.message!, /部分范围未整理/);
        const calls = source.summaryCalls.length;
        const view = await runtime.conversation.context(ctx);
        const projected = await manager(runtime).beforeRequest(view.messages, { models: source.models } as never, ctx);
        assert(projected, "legal committed blocks must be used alongside the intact failed exchange");
        const exchange = projected.messages.filter(message => message.role === "toolResult" && message.toolCallId.startsWith("atomic-")
          || message.role === "assistant" && message.content.some(part => part.type === "toolCall" && part.id.startsWith("atomic-")));
        assert.equal(JSON.stringify(exchange), original, "both calls, signature and results must remain byte-identical");
        await manager(runtime).beforeRequest(view.messages, { models: source.models } as never, ctx);
        assert.equal(source.summaryCalls.length, calls, "a fitting partial projection must not repeatedly retry the failed range");
      } finally { await runtime.close(); }
    }],
  ] as const;
  const failures: Error[] = [];
  for (const [name, run] of regressions) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures.push(error as Error); console.error(`FAIL ${name}: ${String(error)}`); }
  }
  if (failures.length) throw new AggregateError(failures, "context cache/summary regressions");
  // 1. 模型写出超长摘要 → 宿主 condense 到上限内，折叠照常提交。
  {
    const directory = join(root, "condense"); await mkdir(directory);
    const source = fixture(mode => mode === "condense" ? "C".repeat(3_000) : "S".repeat(LIMIT + 5_000));
    const runtime = await DurableBotRuntime.open(options(directory, source, history(30)));
    try {
      await turn(runtime, "condense");
      const state = await manager(runtime).readState(ctx);
      const blocks = (state?.blocks ?? []).filter(block => block.active);
      assert(blocks.length >= 1, "oversized summary must be condensed into a legal block, not dropped");
      for (const block of blocks) assert(block.summary.length <= LIMIT, `${block.blockId} summary ${block.summary.length} > ${LIMIT}`);
      assert(source.summaryCalls.includes("condense"), "the over-limit summary must be rewritten, not retried blind");
      const status = runtime.contextManagementStatus()!;
      assert.notEqual(status.phase, "failed");
      assert(!/Batch rejected|Summary too long/.test(status.lastError ?? ""));
      assert(!source.outbound.at(-1)!.some(message => message.role === "user" && String(message.content).includes("REQUEST 0:")),
        "folded originals must leave the outbound view");
      console.log(`PASS oversized summary condensed: ${blocks.length} block(s), max ${Math.max(...blocks.map(block => block.summary.length))} chars`);
    } finally { await runtime.close(); }
  }
  // 2. 模型持续无视上限 → 宿主自己拒绝并说清超了多少；内核整批拒绝必须不可达。
  {
    const directory = join(root, "over-limit"); await mkdir(directory);
    const source = fixture(() => "S".repeat(LIMIT + 5_000));
    const runtime = await DurableBotRuntime.open(options(directory, source, history(30)));
    try {
      await turn(runtime, "over-limit");
      const state = await manager(runtime).readState(ctx);
      assert.equal((state?.blocks ?? []).filter(block => block.active).length, 0, "nothing may be committed from an over-limit summary");
      const status = runtime.contextManagementStatus()!;
      assert.equal(status.phase, "failed");
      assert(!/Batch rejected|Summary too long/.test(status.lastError ?? ""), `kernel gate must be unreachable: ${status.lastError}`);
      assert.match(status.lastError ?? "", new RegExp(`超过单块上限 ${LIMIT}`));
      console.log(`PASS over-limit refusal is host-side: ${status.lastError}`);
    } finally { await runtime.close(); }
  }
  // 3. 连续多轮超大摘要：每轮都只提交契约内的摘要，折叠持续推进而不是卡死。
  {
    const directory = join(root, "repeated"); await mkdir(directory);
    const source = fixture(mode => mode === "condense" ? "C".repeat(2_000) : "S".repeat(LIMIT + 5_000));
    const runtime = await DurableBotRuntime.open(options(directory, source, history(24)));
    try {
      for (const key of ["repeat-1", "repeat-2", "repeat-3"]) await turn(runtime, key);
      const state = await manager(runtime).readState(ctx);
      const blocks = (state?.blocks ?? []).filter(block => block.active);
      assert(blocks.length >= 2, `repeated folds must accumulate blocks, got ${blocks.length}`);
      for (const block of blocks) {
        assert(block.summary.length <= LIMIT, `${block.blockId} summary ${block.summary.length} > ${LIMIT}`);
        assert(block.effectiveMessageIds.length * PER_MESSAGE <= MAX_RANGE + PER_MESSAGE,
          `${block.blockId} represents ${block.effectiveMessageIds.length * PER_MESSAGE} source chars > ${MAX_RANGE}`);
      }
      assert.notEqual(runtime.contextManagementStatus()!.phase, "failed");
      console.log(`PASS repeated oversized turns: ${blocks.length} blocks, every summary ≤ ${LIMIT} chars, every block ≤ ${MAX_RANGE} source chars`);
    } finally { await runtime.close(); }
  }
} finally { await rm(root, { recursive: true, force: true }); }
