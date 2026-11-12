/**
 * Issue #26 D.1/D.4 的长历史性能证据（headless，无网络）。
 *
 * 验证的是“请求准备成本只随当前模型可见的活动视图增长，不随归档历史增长”：
 * - 归档规模 1K / 10K / 100K 条 refs 只影响打开时加载的文档，不进入每轮投影；
 * - 每轮 beforeRequest 不得扫描 conversation.entries（全量历史）；
 * - 持久 refs 有上界，state 文档大小不会随归档线性膨胀；
 * - 活动视图 200/800/2000 条消息的请求准备耗时被记录（供后续 incremental 优化对比）。
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { DurableContextManager } from "../src/main/agent/durable/context/DurableContextManager";
import { createInitialState } from "../vendor/acp-kernel/src/index.ts";
import type { DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";

const MODEL_CONTEXT_WINDOW = 128_000;
const ROUNDS = 6;
const WARMUP = 2;
const SHORT_TEXT = "small context line about wind observations and archive references. ";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function assistantMessage(text: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], stopReason: "stop", api: "openai-completions",
    provider: "fixture", model: "fixture", timestamp,
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function activeHistory(size: number, baseEntryId: number): { entries: EntryRecord[]; messages: Message[] } {
  const entries: EntryRecord[] = [];
  const messages: Message[] = [];
  for (let index = 0; index < size; index++) {
    const text = `${index % 2 === 0 ? "user" : "assistant"} line ${index}: ${SHORT_TEXT}`;
    const message: Message = index % 2 === 0
      ? { role: "user", content: text, timestamp: baseEntryId + index }
      : assistantMessage(text, baseEntryId + index);
    entries.push({ id: baseEntryId + index, conversationId: 1 as never, kind: index % 2 === 0 ? "pi.user" : "pi.assistant",
      model: [message] } as unknown as EntryRecord);
    messages.push(message);
  }
  return { entries, messages };
}

function refsForArchive(count: number, baseEntryId: number): Record<string, { entryId: number; slot: number; role: string }> {
  const refs: Record<string, { entryId: number; slot: number; role: string }> = {};
  for (let index = 1; index <= count; index++) {
    refs[`m${String(index).padStart(5, "0")}`] = { entryId: baseEntryId - count + index, slot: 0, role: index % 2 ? "user" : "assistant" };
  }
  return refs;
}

interface Fixture {
  manager: DurableContextManager;
  archiveCount: number;
  scanCount: number;
  docBytes: number;
  refsAfterFlush: number;
  beforeRequest(messages: readonly Message[]): Promise<void>;
  flush(): Promise<void>;
}

function createFixture(activeSize: number, archiveCount: number): Fixture {
  const baseEntryId = archiveCount + 10;
  const { entries, messages } = activeHistory(activeSize, baseEntryId);
  const doc = {
    schemaVersion: 1,
    kernelVersion: "",
    configDigest: "",
    headEntryId: null as number | null,
    watermarkEntryId: baseEntryId + activeSize,
    epoch: 1,
    refs: refsForArchive(archiveCount, baseEntryId - 1),
    archivedRefs: [] as Array<{ epoch: number; refs: Record<string, unknown> }>,
    stateJson: JSON.stringify(createInitialState()),
    summaries: [] as Array<Record<string, unknown>>,
    stats: { rounds: 0, folds: 0, tokensCompressed: 0 },
  };
  let currentDoc = doc;
  const fixture: Fixture = {
    manager: undefined as unknown as DurableContextManager,
    archiveCount,
    scanCount: 0,
    docBytes: 0,
    refsAfterFlush: 0,
    beforeRequest: async (input: readonly Message[]) => { await fixture.manager.beforeRequest(input, { models: fakeModels } as never, ctx); },
    flush: async () => {
      await fixture.manager.flush(ctx);
      fixture.refsAfterFlush = Object.keys(currentDoc.refs).length;
    },
  };
  const model = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", reasoning: false,
    input: ["text"], contextWindow: MODEL_CONTEXT_WINDOW, maxTokens: 4_096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const fakeModels = {
    getAuth: async () => undefined,
    getModel: () => model,
    completeSimple: async () => assistantMessage("summary", Date.now()),
  } as unknown as DurableBotOptions["models"];
  const fakeConversation = {
    id: 1,
    context: async () => ({ head: undefined, entries, messages }),
    entries: async () => { fixture.scanCount += 1; return { items: [], next: undefined }; },
    commit: async (fn: (tx: { doc: () => Promise<typeof doc> }) => unknown) => {
      const result = await fn({ doc: async (token: { definition: { kind: string } }) => token.definition.kind === "mybuddy.context-session" ? { sessionId: "performance-fixture" } : currentDoc,
        latestHeadMarker: async () => undefined, latestEntryId: async () => entries.at(-1)?.id } as never);
      fixture.docBytes = JSON.stringify(currentDoc).length;
      return result;
    },
    agent: async () => ({ model: { provider: "fixture", modelId: "fixture" } }),
  };
  fixture.manager = new DurableContextManager({
    conversation: fakeConversation as never,
    models: fakeModels,
    policy: () => ({ ratio: 0.8, absoluteTokens: null }),
    contextWindow: () => MODEL_CONTEXT_WINDOW,
    modelKey: () => "fixture/fixture",
    toolEstimateTokens: () => 0,
    log: () => {},
  });
  return fixture;
}

async function measure(activeSize: number, archiveCount: number): Promise<{ p50: number; docBytes: number; scanCount: number; refs: number }> {
  const fixture = createFixture(activeSize, archiveCount);
  const { messages } = activeHistory(activeSize, archiveCount + 10);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const started = performance.now();
    await fixture.beforeRequest(messages);
    samples.push(performance.now() - started);
  }
  await fixture.flush();
  const p50 = median(samples.slice(WARMUP));
  console.log(`[perf] active=${activeSize} archive=${archiveCount} p50=${p50.toFixed(2)}ms samples=[${samples.map(value => value.toFixed(1)).join(",")}] docBytes=${fixture.docBytes} refs=${fixture.refsAfterFlush} entryScans=${fixture.scanCount}`);
  fixture.manager.dispose();
  return { p50, docBytes: fixture.docBytes, scanCount: fixture.scanCount, refs: fixture.refsAfterFlush };
}

const archived1K = await measure(200, 1_000);
const archived10K = await measure(200, 10_000);
const archived100K = await measure(200, 100_000);
const active800 = await measure(800, 1_000);
const active2000 = await measure(2_000, 1_000);

// 归档规模不得让每轮请求准备变慢（成本只能来自活动视图）。
assert(archived100K.p50 <= archived1K.p50 * 10 + 300,
  `归档 100K 的请求准备耗时异常：1K=${archived1K.p50.toFixed(1)}ms 100K=${archived100K.p50.toFixed(1)}ms`);
// 请求准备不得扫描归档 entries。
assert.equal(archived1K.scanCount, 0, "beforeRequest 不得调用 conversation.entries 全量扫描");
assert.equal(archived100K.scanCount, 0, "beforeRequest 不得调用 conversation.entries 全量扫描");
// refs 必须有上界（摘要覆盖 + 最近窗口），否则 state 文档随历史无限增长。
assert(archived100K.refs <= 20_500, `100K 归档后持久 refs 必须被裁剪到上界，实际 ${archived100K.refs}`);
assert(archived100K.docBytes < 4_000_000, `state 文档不得随归档线性膨胀，实际 ${archived100K.docBytes} bytes`);
// 活动视图增大允许变慢，但必须有界（暴露出全量/二阶行为时立即失败）。
assert(active2000.p50 < 5_000, `活动视图 2000 条的请求准备过慢：${active2000.p50.toFixed(1)}ms`);

console.log(`[perf] archive scaling 1K/10K/100K = ${archived1K.p50.toFixed(2)}/${archived10K.p50.toFixed(2)}/${archived100K.p50.toFixed(2)} ms`);
console.log(`[perf] active scaling 200/800/2000 = ${archived1K.p50.toFixed(2)}/${active800.p50.toFixed(2)}/${active2000.p50.toFixed(2)} ms`);
console.log("durable context performance test passed");
