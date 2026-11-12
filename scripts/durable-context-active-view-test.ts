/** Real production BC prefix placement, cold identities and bounded warm model preparation. Offline providers. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { DurableBotRuntime, type DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";
import { DurableContextManager } from "../src/main/agent/durable/context/DurableContextManager";
import { DurableContextStateDoc } from "../src/main/agent/durable/context/DurableContextState";

function assistant(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 1, api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop",
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function history(count: number, epoch = 0): Message[] {
  return Array.from({ length: count }, (_, index) => {
    const content = `EXACT_EPOCH_${epoch}_ORIGINAL_${index}: /archive/${epoch}/${index}.txt ERROR_26\n` + "Original archive observation. ".repeat(70);
    return index % 2 ? assistant(content) : { role: "user", content, timestamp: index + 1 };
  });
}
function fixture() {
  let summaries = 0;
  let action: ((signal?: AbortSignal) => Promise<void>) | undefined;
  const requests: Array<readonly Message[]> = [];
  const model = { id: "fixture", provider: "fixture", api: "openai-completions", name: "fixture", reasoning: false,
    input: ["text"], contextWindow: 128_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const models = { getModel: () => model, getAuth: async () => undefined,
    completeSimple: async (_model: unknown, _input: unknown, options?: { signal?: AbortSignal }) => { summaries++; await action?.(options?.signal); return assistant("Archived observations and paths remain searchable and retrievable. Continue the current task."); },
    streamSimple: (_model: unknown, input: { messages: readonly Message[] }) => {
      requests.push(input.messages);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message: assistant("Acknowledged.") }); stream.end(); });
      return stream;
    } } as unknown as DurableBotOptions["models"];
  return { models, requests, summaries: () => summaries, model, setAction: (next?: typeof action) => { action = next; } };
}
function manager(runtime: DurableBotRuntime): DurableContextManager {
  return (runtime as unknown as { contextManager: DurableContextManager }).contextManager;
}
async function turn(runtime: DurableBotRuntime, key: string) {
  const result = await (await runtime.submit("Continue the current task.", key)).wait(ctx);
  assert.equal(result.status, "done", JSON.stringify(result));
  await runtime.conversation.waitForIdle(ctx);
  await manager(runtime).flush(ctx);
  assert.notEqual(runtime.contextManagementStatus()?.phase, "failed");
}
async function persisted(runtime: DurableBotRuntime) {
  const state = await runtime.harness.snapshot(DurableContextStateDoc, runtime.conversation.id, ctx);
  assert(state);
  return state;
}
async function append(runtime: DurableBotRuntime, messages: Message[]) {
  await runtime.conversation.commit(async tx => {
    for (const message of messages) await tx.appendEntry(runtime.conversation.id, { kind: message.role === "assistant" ? "pi.assistant" : "pi.user", model: [message] });
  }, ctx);
}
const root = await mkdtemp(join(tmpdir(), "durable-active-view-"));
const scales = (process.env.ACTIVE_CONTEXT_SCALES ?? "1000").split(",").map(Number);
try {
  for (const count of scales) {
    const directory = join(root, `bc-${count}`); await mkdir(directory);
    const source = fixture();
    const options: DurableBotOptions = { directory, cwd: directory, models: source.models, model: { provider: "fixture", modelId: "fixture" },
      toolMode: "native", instructions: () => "", onSnapshot: () => {},
      initialHistory: { messages: history(count), context: [] },
      contextManagement: { policy: () => ({ ratio: 0.8, absoluteTokens: null }), engine: () => "billion-context", toolEstimateTokens: () => 0 } };
    let runtime = await DurableBotRuntime.open(options);
    try {
      assert.equal((await runtime.conversation.context(ctx)).head, undefined, "no artificial preimported native head");
      const visits: number[] = [];
      const hot = manager(runtime) as unknown as { buildCoreMessages: (...args: unknown[]) => unknown };
      const build = hot.buildCoreMessages.bind(hot);
      hot.buildCoreMessages = (...args) => { visits.push((args[1] as EntryRecord[]).length); return build(...args); };
      await turn(runtime, "bootstrap");
      assert(source.summaries() > 0);
      assert((await runtime.conversation.context(ctx)).head, "production strategy must place a real head");
      visits.length = 0;
      for (let round = 0; round < 4; round++) await turn(runtime, `warm-${round}`);
      const state = await persisted(runtime);
      const kernel = JSON.parse(state.stateJson);
      assert(Math.max(...visits) < 150, `unbounded warm entry visits ${visits}`);
      assert(Object.keys(kernel.messageRefs.byRef).length < 200);
      assert(Buffer.byteLength(JSON.stringify(state)) < 250_000);
      console.log(JSON.stringify({ count, activeEntries: (await runtime.conversation.context(ctx)).entries.length,
        warmEntriesVisited: visits, kernelRefs: Object.keys(kernel.messageRefs.byRef).length,
        blocks: kernel.blocks.length, snapshotBytes: Buffer.byteLength(JSON.stringify(state)), summaryCalls: source.summaries() }));
      const oldRef = Object.keys(state.refs).find(ref => state.refs[ref]!.entryId > 0)!;
      assert(oldRef);
      const originalId = state.refs[oldRef]!.entryId;
      const reader = { entry: (id: number) => runtime.conversation.commit(tx => tx.entry(id as EntryId), ctx) };
      const original = await manager(runtime).retrieveOriginal({ ref: oldRef, limit: 12000 }, reader, ctx);
      const folded = await manager(runtime).compressNow(ctx);
      assert.equal(folded.applied, true, JSON.stringify(folded));
      const oldBlock = (await persisted(runtime)).summaries.at(-1)!;
      assert(oldBlock);
      const blockOriginal = await manager(runtime).retrieveOriginal({ blockId: oldBlock.blockId, limit: 12000 }, reader, ctx);
      assert(blockOriginal.text.length > 0);
      // An as-of entry observes documents committed before that entry, not later manual maintenance.
      await turn(runtime, "after-manual-block");
      const historicalTail = (await runtime.conversation.context(ctx)).entries.at(-1)!.id;
      const beforeHead = state.headEntryId;
      for (let epoch = 1; epoch <= 10; epoch++) {
        await append(runtime, history(240, epoch));
        await turn(runtime, `epoch-${epoch}`);
        const current = await persisted(runtime);
        const graph = JSON.parse(current.stateJson);
        assert(Object.keys(graph.messageRefs.byRef).length < 200, "retired graph grew across native epochs");
        assert.equal(current.archivedRefs.length, 0, "cold maps leaked into active document");
        assert.equal((await manager(runtime).compressNow(ctx)).applied, true, "each epoch contributes a real block to retire");
      }
      assert.notEqual((await persisted(runtime)).headEntryId, beforeHead);
      assert(!(await persisted(runtime)).summaries.some(block => block.blockId === oldBlock.blockId), "old block must be cold, not a retained UI mirror");
      assert.deepEqual(await manager(runtime).retrieveOriginal({ ref: oldRef, limit: 12000 }, reader, ctx), original);
      assert.deepEqual(await manager(runtime).retrieveOriginal({ blockId: oldBlock.blockId, limit: 12000 }, reader, ctx), blockOriginal);
      const fork = await runtime.conversation.fork((await runtime.conversation.context(ctx)).entries.at(-1)!.id, { ownership: { kind: "ownerless" } }, ctx);
      const forkManager = new DurableContextManager({ conversation: fork, archiveReader: runtime.harness, models: source.models,
        policy: options.contextManagement!.policy, contextWindow: () => 128_000 });
      assert.deepEqual((await forkManager.retrieveOriginal({ ref: oldRef, limit: 12000 }, reader, ctx)).text, original.text);
      forkManager.dispose();
      const historicalFork = await runtime.conversation.fork(historicalTail, { ownership: { kind: "ownerless" } }, ctx);
      const historicalManager = new DurableContextManager({ conversation: historicalFork, archiveReader: runtime.harness, models: source.models,
        policy: options.contextManagement!.policy, contextWindow: () => 128_000 });
      assert.equal((await historicalManager.retrieveOriginal({ ref: oldRef, limit: 12000 }, reader, ctx)).text, original.text);
      assert.equal((await historicalManager.retrieveOriginal({ blockId: oldBlock.blockId, limit: 12000 }, reader, ctx)).text, blockOriginal.text);
      const latest = await persisted(runtime);
      const futureRef = Object.keys(latest.refs).find(ref => latest.refs[ref]!.entryId > historicalTail)!;
      assert(futureRef);
      assert.equal((await historicalManager.retrieveOriginal({ ref: futureRef, limit: 12000 }, reader, ctx)).text, "", "as-of branch cannot see future refs");
      assert.equal((await historicalManager.retrieveOriginal({ blockId: latest.summaries.at(-1)!.blockId, limit: 12000 }, reader, ctx)).text, "", "as-of branch cannot see future blocks");
      historicalManager.dispose();
      await runtime.close();
      runtime = await DurableBotRuntime.open({ ...options, initialHistory: undefined });
      const reopenedReader = { entry: (id: number) => runtime.conversation.commit(tx => tx.entry(id as EntryId), ctx) };
      assert.equal((await manager(runtime).retrieveOriginal({ ref: oldRef, limit: 12000 }, reopenedReader, ctx)).text, original.text);
      assert.equal((await manager(runtime).retrieveOriginal({ entryId: originalId, limit: 12000 }, reopenedReader, ctx)).text, original.text);
      assert.equal((await manager(runtime).retrieveOriginal({ blockId: oldBlock.blockId, limit: 12000 }, reopenedReader, ctx)).text, blockOriginal.text);
      await turn(runtime, "reopened");
      console.log(`PASS BC-only ${count}: official prefix, ten epochs, old ref, fork, restart and bounded active graph`);
    } finally { await runtime.close(); }
  }
  // The SDK option is BC-specific. Native retains its original measured-usage threshold behavior.
  const directory = join(root, "native"); await mkdir(directory);
  const source = fixture();
  const runtime = await DurableBotRuntime.open({ directory, cwd: directory, models: source.models, model: { provider: "fixture", modelId: "fixture" },
    toolMode: "native", instructions: () => "", onSnapshot: () => {}, initialHistory: { messages: history(1000), context: [] },
    contextManagement: { policy: () => ({ ratio: 0.8, absoluteTokens: null }), engine: () => "native", toolEstimateTokens: () => 0 } });
  try {
    await turn(runtime, "native-observed-usage");
    assert.equal((await runtime.conversation.context(ctx)).head, undefined);
    assert.equal(source.summaries(), 0);
    assert(source.requests.at(-1)!.length > 1000);
    console.log("PASS native measured-usage behavior unchanged by BC raw-view opt-in");
  } finally { await runtime.close(); }
  for (const kind of ["image", "thinking", "incomplete-parallel", "split-parallel"] as const) {
    const directory = join(root, kind); await mkdir(directory);
    const source = fixture();
    const originals = history(40);
    if (kind === "image") originals[0] = { role: "user", content: [{ type: "text", text: "Preserve the original attachment." }, { type: "image", mimeType: "image/png", data: "opaque-image-payload" }], timestamp: 1 };
    else if (kind === "thinking") {
      const message = assistant("Preserve signed thinking with its original message.");
      message.content.unshift({ type: "thinking", thinking: "Opaque reasoning", thinkingSignature: "exact-signature" });
      originals[1] = message;
    } else {
      const message = assistant("Two parallel reads.");
      message.content.push({ type: "toolCall", id: "a", name: "read", arguments: {} }, { type: "toolCall", id: "b", name: "read", arguments: {} });
      originals[1] = message;
      originals[2] = { role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "Result A" }], isError: false, timestamp: 2 };
      if (kind === "split-parallel") originals[25] = { role: "toolResult", toolCallId: "b", toolName: "read", content: [{ type: "text", text: "Result B" }], isError: false, timestamp: 3 };
    }
    const runtime = await DurableBotRuntime.open({ directory, cwd: directory, models: source.models, model: { provider: "fixture", modelId: "fixture" },
      toolMode: "native", instructions: () => "", onSnapshot: () => {}, initialHistory: { messages: originals, context: [] },
      contextManagement: { policy: () => ({ ratio: 0.8, absoluteTokens: null }), engine: () => "billion-context", toolEstimateTokens: () => 0 } });
    try {
      const view = await runtime.conversation.context(ctx);
      const entries = view.entries.slice(0, 20);
      const before = JSON.stringify(view.entries);
      const decision = await manager(runtime).beforeCompact({ reason: "threshold", firstKept: view.entries[20]!.id,
        entries, messages: entries.flatMap(entry => entry.model ?? []) }, { models: source.models } as never, ctx);
      assert.deepEqual(decision, { decline: true });
      assert.equal(source.summaries(), 0, "protected prefix cannot be textified even for summarization");
      assert.equal(JSON.stringify((await runtime.conversation.context(ctx)).entries), before);
      assert.equal((await runtime.conversation.context(ctx)).head, undefined);
      console.log(`PASS ${kind}: unsafe fixed prefix declined, original bytes preserved`);
    } finally { await runtime.close(); }
  }
  for (const cancel of [false, true]) {
    const directory = join(root, cancel ? "cancel-prefix" : "queued-prefix"); await mkdir(directory);
    const source = fixture();
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    source.setAction(async signal => {
      entered();
      if (cancel) signal?.addEventListener("abort", release, { once: true });
      await blocked;
    });
    const originals = history(240);
    const parallel = assistant("Complete parallel reads before retiring the prefix.");
    parallel.content.push({ type: "toolCall", id: "complete-a", name: "read", arguments: { path: "/exact/a" } },
      { type: "toolCall", id: "complete-b", name: "read", arguments: { path: "/exact/b" } });
    originals[1] = parallel;
    for (const [index, id] of [[2, "complete-a"], [3, "complete-b"]] as const) originals[index] = {
      role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `Exact result ${id}` }], isError: false, timestamp: index,
    };
    const runtime = await DurableBotRuntime.open({ directory, cwd: directory, models: source.models, model: { provider: "fixture", modelId: "fixture" },
      toolMode: "native", instructions: () => "", onSnapshot: () => {}, initialHistory: { messages: originals, context: [] },
      contextManagement: { policy: () => ({ ratio: 0.8, absoluteTokens: null }), engine: () => "billion-context", toolEstimateTokens: () => 0 } });
    try {
      const first = await runtime.submit("FIRST_CURRENT_INPUT", "first");
      await started;
      assert.equal((await runtime.conversation.context(ctx)).head, undefined);
      if (cancel) {
        await runtime.abort();
        await first.wait(ctx); await runtime.conversation.waitForIdle(ctx);
        assert.equal((await runtime.conversation.context(ctx)).head, undefined, "late cancelled summary cannot place a head");
        assert.notEqual((await persisted(runtime)).lastOperation?.phase, "completed");
        source.setAction();
        await turn(runtime, "retry-after-cancel");
        assert((await runtime.conversation.context(ctx)).head);
        console.log("PASS cancelled native BC prefix rejects late result and later request recovers");
      } else {
        const second = await runtime.submit("QUEUED_CURRENT_INPUT", "queued");
        release();
        assert.equal((await first.wait(ctx)).status, "done");
        assert.equal((await second.wait(ctx)).status, "done");
        await runtime.conversation.waitForIdle(ctx);
        assert(source.requests.some(messages => JSON.stringify(messages).includes("FIRST_CURRENT_INPUT")));
        assert(JSON.stringify(source.requests.at(-1)).includes("QUEUED_CURRENT_INPUT"));
        assert((await runtime.conversation.context(ctx)).head);
        assert(!source.requests.flat().some(message => message.role === "toolResult" && message.toolCallId.startsWith("complete-")));
        console.log("PASS queued input stays under SDK admission and survives BC head placement");
      }
    } finally { release(); await runtime.close(); }
  }
} finally { await rm(root, { recursive: true, force: true }); }
