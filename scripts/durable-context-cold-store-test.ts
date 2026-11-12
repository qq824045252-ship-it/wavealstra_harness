/**
 * Issue #26: real official-storage archive, process-cold runtime reopen and request preparation.
 *
 * Unlike durable-context-performance-test, these are persisted original entries,
 * not invented ref maps. The corpus uses the product's supported history import:
 * N originals followed by a native context head containing 200 active messages.
 * Every measurement reopens a copy in a fresh Node process. OS page cache is NOT
 * evicted. BC growth establishes its own head through the production strategy.
 * Archive hydration is measured as an unmet closure requirement, not hidden by a
 * permissive latency assertion. Correctness/request/retrieval gates still fail.
 *
 * Default: 1K/10K/100K, five process-cold samples each, six warm requests/sample,
 * plus BC-only growing text at the same scales and process-cold/warm probes.
 * COLD_CONTEXT_SCALES=1000 COLD_CONTEXT_SAMPLES=1 COLD_CONTEXT_BC_SCALES=1000
 * is a smoke test, not full evidence. Empty COLD_CONTEXT_BC_SCALES skips only that
 * diagnostic; the report states the exact scales and samples actually executed.
 * COLD_CONTEXT_REPORT selects the persistent JSON report. Temporary stores are
 * removed after success unless COLD_CONTEXT_KEEP=1; failures retain evidence.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { MemoryStorage, type Cursor, type EntryId, type HookApi } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { DurableBotRuntime, type DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";
import { DurableContextManager } from "../src/main/agent/durable/context/DurableContextManager";
import { DurableContextStateDoc } from "../src/main/agent/durable/context/DurableContextState";

const ACTIVE_MESSAGES = 200;
const WARM_REQUESTS = 6;
const WINDOW = 128_000;
const RETRIEVAL_LIMIT = 512;
const MODEL = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions",
  reasoning: false, input: ["text"], contextWindow: WINDOW, maxTokens: 4_096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const COUNTER_KEYS = ["scanCalls", "entriesReturned", "archivedEntriesReturned", "entryReads", "replayedEntries", "archivedPointReads", "coreEntriesVisited", "stringifyCalls", "stringifyChars"] as const;
type Counters = Record<typeof COUNTER_KEYS[number], number>;
type Memory = ReturnType<typeof process.memoryUsage>;
type Sample = { ms: number; counters: Counters };
type ManagerSample = Sample & { inputMessages: number };
type Target = { index: number; entryId: number; kind: string; text: string };
type Manifest = { count: number; boundaryId: number; firstKeptEntryId: number; activeMessages: number; totalEntries: number;
  archivePayloadBytes: number; targets: Target[]; seedMs: number; files: Record<string, number>; stateBytes: number; kernelBytes: number; kernelRefs: number; kernelBlocks: number; backend: string };
type Probe = { reopen: Sample; firstProvider: Sample; warmProvider: Sample[]; manager: ManagerSample[];
  before: Memory; afterOpen: Memory; retainedAfterOpen: Memory; afterRequests: Memory; peakRssBytes: number;
  peakSampledHeapBytes: number; retrieval: Array<{ entryId: number; pages: number; chars: number; ms: number; counters: Counters }>;
  files: Record<string, number>; stateBytes: number; kernelBytes: number; activeEntries: number; activeMessages: number; kernelRefs: number; kernelBlocks: number; backend: string };
type BcDiagnostic = { count: number; seedOpenMs: number; summaryCalls: number;
  rounds: Array<{ originals: number; ms: number; activeEntries: number; activeMessages: number;
    headBefore: number | null; headAfter: number | null; counters: Counters; error?: string }>;
  stateBytes: number; kernelBytes: number; kernelRefs: number; kernelBlocks: number; retainedMemory: Memory;
  peakRssBytes: number; boundedRequestPreparation: boolean; limitation: string;
  manifest: Manifest };

function zeros(): Counters { return Object.fromEntries(COUNTER_KEYS.map(key => [key, 0])) as Counters; }

function difference(after: Counters, before: Counters): Counters {
  return Object.fromEntries(COUNTER_KEYS.map(key => [key, after[key] - before[key]])) as Counters;
}
function quantiles(values: number[]) {
  assert(values.length, "quantiles require samples");
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
  return { n: values.length, p50: pick(0.5), p95: pick(0.95), min: sorted[0], max: sorted.at(-1), spread: sorted.at(-1)! - sorted[0]!, samples: values };
}
function assistant(text: string, timestamp: number): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", api: "openai-completions",
    provider: "fixture", model: "fixture", timestamp,
    usage: { input: 0, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 8,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function originalText(index: number, count: number): string {
  const marker = `ARCHIVE_${count}_${index}`;
  const targeted = index === 0 || index === Math.floor(count / 2) || index === count - 1;
  return `${marker}\n${"Original wind observation; preserve exact spelling and punctuation. ".repeat(targeted ? 140 : 2)}\nEND_${marker}`;
}
function history(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => index % 2
    ? assistant(originalText(index, count), index + 1)
    : { role: "user", content: originalText(index, count), timestamp: index + 1 });
}
function activeHistory(): Message[] {
  return Array.from({ length: ACTIVE_MESSAGES }, (_, index) => {
    const text = `ACTIVE_${index}: retain the current weather task and the exact selected observation.`;
    return index % 2 ? assistant(text, 1_000_000 + index)
      : { role: "user", content: text, timestamp: 1_000_000 + index };
  });
}
function fixture(onProvider?: (messages: readonly Message[]) => void, summarize?: () => AssistantMessage): DurableBotOptions["models"] {
  let requests = 0;
  return {
    getAuth: async () => undefined, getModel: () => MODEL,
    completeSimple: async () => {
      if (summarize) return summarize();
      throw new Error("Unexpected summarization: fixed active fixture must fit without compression");
    },
    streamSimple: (_model: unknown, context: { messages: readonly Message[] }) => {
      onProvider?.(context.messages);
      const stream = createAssistantMessageEventStream();
      const message = assistant(`Local fixture answer ${++requests}.`, 2_000_000 + requests);
      queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); });
      return stream;
    },
  } as unknown as DurableBotOptions["models"];
}
function options(directory: string, workspace: string, models: DurableBotOptions["models"], count?: number): DurableBotOptions {
  return { directory, cwd: workspace, models, model: { provider: "fixture", modelId: "fixture" },
    toolMode: "native", instructions: () => "Offline cold-store measurement. Answer briefly.", onSnapshot: () => {},
    ...(count === undefined ? {} : { initialHistory: () => Promise.resolve({ messages: history(count), context: activeHistory() }) }),
    contextManagement: { policy: () => ({ ratio: 0.8, absoluteTokens: null }), engine: () => "billion-context", toolEstimateTokens: () => 0 } };
}
async function turn(runtime: DurableBotRuntime, index: number): Promise<void> {
  const submission = await runtime.submit(`Active request ${index}: acknowledge.`, `cold-store-${index}`);
  const settled = await submission.wait(ctx);
  assert.equal(settled.status, "done", JSON.stringify(settled));
  await runtime.conversation.waitForIdle(ctx);
  await runtime.refresh();
  assert.notEqual(runtime.contextManagementStatus()?.phase, "failed", "manager failures cannot silently pass via raw fallback");
}
async function filesIn(directory: string, prefix = ""): Promise<Record<string, number>> {
  const files: Record<string, number> = {};
  for (const item of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const name = join(prefix, item.name);
    if (item.isDirectory()) Object.assign(files, await filesIn(directory, name));
    else if (item.isFile()) files[name] = (await stat(join(directory, name))).size;
  }
  return files;
}
async function stateSize(runtime: DurableBotRuntime) {
  const state = await runtime.harness.snapshot(DurableContextStateDoc, runtime.conversation.id, ctx);
  assert(state?.stateJson, "real request must persist production manager state");
  const kernel = JSON.parse(state.stateJson);
  return { stateBytes: Buffer.byteLength(JSON.stringify(state)), kernelBytes: Buffer.byteLength(state.stateJson),
    kernelRefs: Object.keys(kernel.messageRefs?.byRef ?? {}).length, kernelBlocks: (kernel.blocks ?? []).length };
}
async function backend(directory: string): Promise<string> {
  try { return JSON.parse(await readFile(join(directory, ".mybuddy-storage.json"), "utf8")).backend; }
  catch { return (await filesIn(directory))["main.jsonl"] !== undefined ? "jsonl" : "unknown"; }
}
async function seed(directory: string, workspace: string, count: number): Promise<Manifest> {
  const started = performance.now();
  const runtime = await DurableBotRuntime.open(options(directory, workspace, fixture(), count));
  try {
    const view = await runtime.conversation.context(ctx);
    const boundaryId = view.head?.id;
    assert(boundaryId, "fixture must archive originals behind a real Durable head");
    assert(view.head?.head !== undefined, "head must identify first retained original");
    assert.equal(view.messages.length, ACTIVE_MESSAGES);
    assert(!JSON.stringify(view.messages).includes("ARCHIVE_"), "archived originals leaked into active context");
    const targets: Target[] = [];
    let cursor: Cursor | undefined;
    let originals = 0;
    let totalEntries = 0;
    let archivePayloadBytes = 0;
    do {
      const page = await runtime.conversation.entries({ order: "ascending" }, 500, cursor, ctx);
      for (const entry of page.items) {
        totalEntries++;
        if (entry.id >= boundaryId) continue;
        const expected = originalText(originals, count);
        const message = entry.model?.[0];
        assert(message, `original entry ${entry.id} lacks its model payload`);
        const actual = typeof message.content === "string" ? message.content
          : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        assert.equal(actual, expected, `stored original ${originals} differs`);
        archivePayloadBytes += Buffer.byteLength(JSON.stringify(entry));
        if (originals === 0 || originals === Math.floor(count / 2) || originals === count - 1)
          targets.push({ index: originals, entryId: entry.id, kind: entry.kind, text: expected });
        originals++;
      }
      cursor = page.next;
    } while (cursor);
    assert.equal(originals, count, "must measure actual persisted originals, not refs");
    await turn(runtime, -1);
    // close() flushes the same production manager used by beforeRequest.
    await runtime.close();
    const reopened = await DurableBotRuntime.open(options(directory, workspace, fixture()));
    try {
      return { count, boundaryId, firstKeptEntryId: view.head!.head, activeMessages: ACTIVE_MESSAGES, totalEntries, archivePayloadBytes, targets,
        seedMs: performance.now() - started, backend: await backend(directory), files: await filesIn(directory), ...await stateSize(reopened) };
    } finally { await reopened.close(); }
  } finally { await runtime.close(); }
}

/** Grow real text originals in bounded batches; only the production strategy may create a head.
 * Seeding includes boundary creation cost. Probes later measure steady process-cold opens separately. */
async function diagnoseBcOnly(directory: string, workspace: string, count: number): Promise<BcDiagnostic> {
  let summaryCalls = 0;
  const models = fixture(undefined, () => assistant(`Compressed archive segment ${++summaryCalls}; originals remain retrievable.`, 3_000_000 + summaryCalls));
  const started = performance.now();
  const runtime = await DurableBotRuntime.open(options(directory, workspace, models));
  const seedOpenMs = performance.now() - started;
  const observation = instrument(0);
  const rounds: BcDiagnostic["rounds"] = [];
  const targets: Target[] = [];
  let archivePayloadBytes = 0;
  try {
    assert.equal((await runtime.conversation.context(ctx)).head, undefined, "BC growth cannot start with an imported head");
    const batchSize = 240;
    for (let offset = 0; offset < count; offset += batchSize) {
      const end = Math.min(count, offset + batchSize);
      await runtime.conversation.commit(async tx => {
        for (let index = offset; index < end; index++) {
          const text = originalText(index, count) + " Text-only growing observation.".repeat(70);
          const message: Message = index % 2 ? assistant(text, index + 1) : { role: "user", content: text, timestamp: index + 1 };
          const entry = await tx.appendEntry(runtime.conversation.id, { kind: index % 2 ? "pi.assistant" : "pi.user", model: [message] });
          archivePayloadBytes += Buffer.byteLength(JSON.stringify(entry));
          if (index === 0 || index === Math.floor(count / 2) || index === count - 1)
            targets.push({ index, entryId: entry.id, kind: entry.kind, text });
        }
      }, ctx);
      const before = await runtime.conversation.context(ctx);
      observation.setBoundary(before.head?.head ?? 0);
      const snapshot = { ...observation.counters };
      const begin = performance.now();
      let error: string | undefined;
      try { await turn(runtime, -(offset + 100)); } catch (failure) { error = String(failure); }
      const counters = difference(observation.counters, snapshot);
      const after = await runtime.conversation.context(ctx);
      rounds.push({ originals: end, ms: performance.now() - begin, activeEntries: after.entries.length,
        activeMessages: after.messages.length, headBefore: before.head?.id ?? null, headAfter: after.head?.id ?? null, counters,
        ...(error ? { error } : {}) });
      if (error) throw new Error(`BC growth rejected at ${end}/${count}: ${error}`);
    }
    for (const manager of observation.managers) await manager.flush(ctx);
    const view = await runtime.conversation.context(ctx);
    assert(view.head, "actual production text strategy must establish a boundary");
    assert(view.head.head !== undefined, "production boundary must identify first retained original");
    // Independent full verification, outside all steady-state timing windows.
    let cursor: Cursor | undefined;
    let originals = 0;
    let totalEntries = 0;
    do {
      const page = await runtime.conversation.entries({ order: "ascending" }, 500, cursor, ctx);
      for (const entry of page.items) {
        totalEntries++;
        const message = entry.model?.[0];
        const text = typeof message?.content === "string" ? message.content : message?.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        if (text?.startsWith(`ARCHIVE_${count}_`)) {
          assert.equal(text, originalText(originals, count) + " Text-only growing observation.".repeat(70));
          originals++;
        }
      }
      cursor = page.next;
    } while (cursor);
    assert.equal(originals, count);
    const sizes = await stateSize(runtime);
    await runtime.close();
    const files = await filesIn(directory);
    (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
    return { count, seedOpenMs, summaryCalls, rounds, ...sizes, retainedMemory: process.memoryUsage(),
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      boundedRequestPreparation: rounds.every(round => !round.error && round.counters.archivedEntriesReturned === 0 && round.counters.coreEntriesVisited < 2000)
        && sizes.kernelRefs < 1000 && sizes.kernelBlocks < 100 && sizes.stateBytes < 4_000_000,
      limitation: "Growing text-only originals with production boundaries; not arbitrary protected, tool/image or giant initial imports. Seed cost includes all appends and boundary summaries.",
      manifest: { count, boundaryId: view.head.id, firstKeptEntryId: view.head.head, activeMessages: view.messages.length, totalEntries, archivePayloadBytes, targets,
        seedMs: performance.now() - started, files, backend: await backend(directory), ...sizes } };
  } finally { observation.restore(); await runtime.close(); }
}

/** Transparent test-only observation. No fake store, replaced records or scan shortcuts. */
function instrument(boundaryId: number) {
  const counters = zeros();
  const manager: ManagerSample[] = [];
  const managers = new Set<DurableContextManager>();
  const prepare = MemoryStorage.prototype.prepareCommit;
  const restorers: Array<() => void> = [];
  for (const prototype of [JsonlStorage.prototype, SqliteStorage.prototype]) {
    const scan = prototype.scanEntries;
    const entry = prototype.entry;
    prototype.scanEntries = async function (...args) {
      counters.scanCalls++;
      const page = await scan.apply(this, args);
      counters.entriesReturned += page.items.length;
      counters.archivedEntriesReturned += page.items.filter(item => item.id < boundaryId).length;
      return page;
    };
    prototype.entry = async function (...args: Parameters<typeof entry>) {
      counters.entryReads++;
      const result = await entry.apply(this, args);
      if (result && result.entry.id < boundaryId) counters.archivedPointReads++;
      return result;
    } as typeof entry;
    restorers.push(() => { prototype.scanEntries = scan; prototype.entry = entry; });
  }
  MemoryStorage.prototype.prepareCommit = function (...args) {
    if (args[1] !== undefined) for (const write of args[0]) if (write.type === "entry") counters.replayedEntries++;
    return prepare.apply(this, args);
  };
  const hot = DurableContextManager.prototype as unknown as { buildCoreMessages: (...args: unknown[]) => unknown };
  const build = hot.buildCoreMessages;
  hot.buildCoreMessages = function (...args) { counters.coreEntriesVisited += (args[1] as unknown[]).length; return build.apply(this, args); };
  const stringify = JSON.stringify;
  JSON.stringify = function (...args: Parameters<typeof stringify>) {
    const result = stringify.apply(JSON, args);
    counters.stringifyCalls++;
    counters.stringifyChars += result?.length ?? 0;
    return result;
  } as typeof stringify;
  const before = DurableContextManager.prototype.beforeRequest;
  DurableContextManager.prototype.beforeRequest = async function (...args) {
    managers.add(this);
    const start = performance.now();
    const snapshot = { ...counters };
    try { return await before.apply(this, args); }
    finally { manager.push({ ms: performance.now() - start, inputMessages: args[0].length, counters: difference(counters, snapshot) }); }
  };
  return { counters, manager, managers, setBoundary: (id: number) => { boundaryId = id; }, restore: () => {
    MemoryStorage.prototype.prepareCommit = prepare;
    for (const restore of restorers) restore();
    hot.buildCoreMessages = build;
    JSON.stringify = stringify;
    DurableContextManager.prototype.beforeRequest = before;
  } };
}
async function probe(directory: string, workspace: string, manifest: Manifest): Promise<Probe> {
  const observation = instrument(manifest.firstKeptEntryId);
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  assert(gc, "run probes with --expose-gc so retained heap is comparable");
  gc();
  const before = process.memoryUsage();
  let peakSampledHeapBytes = before.heapUsed;
  const sampler = setInterval(() => { peakSampledHeapBytes = Math.max(peakSampledHeapBytes, process.memoryUsage().heapUsed); }, 20);
  const provider: Sample[] = [];
  let requestStarted = 0;
  let requestCounters = zeros();
  const models = fixture(messages => {
    assert(requestStarted > 0, "unexpected provider request during open");
    // A BC boundary can retain a small raw tail; exact imported-head leakage is checked during seed.
    assert(messages.length < 1000, "provider active message set grew beyond declared budget");
    assert(messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) < WINDOW * 0.8);
    provider.push({ ms: performance.now() - requestStarted, counters: difference(observation.counters, requestCounters) });
    requestStarted = 0;
  });
  const openedAt = performance.now();
  const runtime = await DurableBotRuntime.open(options(directory, workspace, models));
  const reopen: Sample = { ms: performance.now() - openedAt, counters: { ...observation.counters } };
  const afterOpen = process.memoryUsage();
  peakSampledHeapBytes = Math.max(peakSampledHeapBytes, afterOpen.heapUsed);
  gc();
  const retainedAfterOpen = process.memoryUsage();
  try {
    const active = await runtime.conversation.context(ctx);
    assert.equal(active.head?.id, manifest.boundaryId);
    for (let index = 0; index <= WARM_REQUESTS; index++) {
      requestCounters = { ...observation.counters };
      requestStarted = performance.now();
      await turn(runtime, index);
    }
    assert.equal(provider.length, WARM_REQUESTS + 1);
    assert.equal(observation.manager.length, WARM_REQUESTS + 1);
    for (const sample of [...provider, ...observation.manager]) {
      assert.equal(sample.counters.archivedEntriesReturned, 0, "request preparation scanned archived originals");
      assert(sample.counters.entriesReturned <= (Math.max(ACTIVE_MESSAGES, manifest.activeMessages) + 2 * WARM_REQUESTS + 20) * 8,
        `request preparation returned unexpectedly many entries: ${sample.counters.entriesReturned}`);
    }
    const reader = { entry: (id: number) => runtime.conversation.commit(tx => tx.entry(id as EntryId), ctx) };
    const manager = new DurableContextManager({ conversation: runtime.conversation, models,
      policy: () => ({ ratio: 0.8, absoluteTokens: null }), contextWindow: () => WINDOW, toolEstimateTokens: () => 0 });
    const retrieval: Probe["retrieval"] = [];
    try {
      for (const target of manifest.targets) {
        const start = performance.now();
        const snapshot = { ...observation.counters };
        let cursor: string | undefined;
        let text = "";
        let pages = 0;
        do {
          const previous = { ...observation.counters };
          const page = await manager.retrieveOriginal({ entryId: target.entryId, limit: RETRIEVAL_LIMIT, cursor }, reader, ctx);
          const reads = difference(observation.counters, previous);
          assert.equal(reads.archivedEntriesReturned, 0, `point retrieval scanned archived originals: ${JSON.stringify(reads)}`);
          // A new manager initializes from the bounded active view on its first page.
          // Keep that cost/counter in the result instead of pretending it is a point lookup.
          assert(reads.entriesReturned <= active.entries.length + 20, `retrieval initialization exceeded active-view budget: ${JSON.stringify(reads)}`);
          if (retrieval.length > 0 || pages > 0) assert.equal(reads.scanCalls, 0, "initialized point retrieval scanned entry pages");
          assert(reads.entryReads <= 16, "one original page exceeded 16 entry reads");
          assert(page.text.length > 0 && page.text.length <= RETRIEVAL_LIMIT, "unbounded/empty retrieval page");
          assert.deepEqual(page.entryIds, [target.entryId]);
          text += page.text;
          cursor = page.page?.nextCursor;
          assert(++pages <= 100, "retrieval cursor failed to advance");
        } while (cursor);
        const role = target.index % 2 ? "assistant" : "user";
        assert.equal(text, `[entry ${target.entryId} · ${target.kind}]\n${role}: ${target.text}`, "paginated original changed/lost/duplicated text");
        retrieval.push({ entryId: target.entryId, pages, chars: text.length, ms: performance.now() - start,
          counters: difference(observation.counters, snapshot) });
      }
    } finally { manager.dispose(); }
    for (const preparedManager of observation.managers) await preparedManager.flush(ctx);
    const sizes = await stateSize(runtime);
    assert(sizes.stateBytes < 4_000_000, "bounded active fixture's manager state grew past 4 MB");
    gc();
    const afterRequests = process.memoryUsage();
    peakSampledHeapBytes = Math.max(peakSampledHeapBytes, afterRequests.heapUsed);
    return { reopen, firstProvider: provider[0]!, warmProvider: provider.slice(1), manager: observation.manager,
      before, afterOpen, retainedAfterOpen, afterRequests,
      // Node reports ru_maxrss in KiB on its supported platforms.
      peakRssBytes: process.resourceUsage().maxRSS * 1024, peakSampledHeapBytes,
      retrieval, files: await filesIn(directory), ...sizes, activeEntries: active.entries.length, activeMessages: active.messages.length, backend: await backend(directory) };
  } finally {
    clearInterval(sampler);
    await runtime.close();
    observation.restore();
  }
}

async function child(mode: "seed" | "probe" | "bc-only", directory: string, workspace: string, count: number, resultFile: string, manifestFile: string) {
  await new Promise<void>((accept, reject) => {
    const processChild = spawn(process.execPath, [...process.execArgv.filter(arg => arg !== "--expose-gc"), "--expose-gc", fileURLToPath(import.meta.url),
      "--cold-child", mode, directory, workspace, String(count), resultFile, manifestFile], {
      env: { ...process.env, HOME: workspace, USERPROFILE: workspace,
        XDG_CONFIG_HOME: join(workspace, ".config"), XDG_CACHE_HOME: join(workspace, ".cache"),
        XDG_DATA_HOME: join(workspace, ".local", "share"), XDG_STATE_HOME: join(workspace, ".local", "state") }, stdio: "inherit",
    });
    processChild.once("error", reject);
    processChild.once("exit", (code, signal) => code === 0 ? accept() : reject(new Error(`${mode} ${count} exited ${code ?? signal}`)));
  });
}
function metrics(probes: Probe[], manifest: Manifest) {
  return {
        reopenMs: quantiles(probes.map(item => item.reopen.ms)),
        firstProviderMs: quantiles(probes.map(item => item.firstProvider.ms)),
        warmProviderMs: quantiles(probes.flatMap(item => item.warmProvider.map(sample => sample.ms))),
        firstManagerMs: quantiles(probes.map(item => item.manager[0]!.ms)),
        warmManagerMs: quantiles(probes.flatMap(item => item.manager.slice(1).map(sample => sample.ms))),
        retainedHeapDeltaBytes: quantiles(probes.map(item => item.retainedAfterOpen.heapUsed - item.before.heapUsed)),
        retainedRssDeltaBytes: quantiles(probes.map(item => item.retainedAfterOpen.rss - item.before.rss)),
        peakRssBytes: quantiles(probes.map(item => item.peakRssBytes)),
        activeEntries: probes.map(item => item.activeEntries),
        activeMessages: probes.map(item => item.activeMessages),
        kernelRefs: probes.map(item => item.kernelRefs),
        kernelBlocks: probes.map(item => item.kernelBlocks),
        reopenCounters: probes.map(item => item.reopen.counters),
        replayedEntries: probes.map(item => item.reopen.counters.replayedEntries),
        currentStateBytes: probes.map(item => item.stateBytes),
        archivePayloadBytes: manifest.archivePayloadBytes,
        backend: manifest.backend,
        selectedSqliteBytes: manifest.files["durable.sqlite"] ?? 0,
        legacyMainJsonlBytes: manifest.files["main.jsonl"] ?? 0,
        totalStoreBytes: Object.values(manifest.files).reduce((sum, bytes) => sum + bytes, 0),
        sidecarBytes: Object.entries(manifest.files).filter(([name]) => /^doc-.*\.jsonl$/.test(basename(name))).reduce((sum, [, bytes]) => sum + bytes, 0),
      };
}
async function sourceIdentity() {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src/main/agent/durable", "vendor/acp-kernel", "patches", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "scripts/durable-context-cold-store-test.ts"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).sort();
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[file] = createHash("sha256").update(await readFile(file)).digest("hex");
  return { files: hashes, sha256: createHash("sha256").update(JSON.stringify(hashes)).digest("hex") };
}
async function main() {
  const scales = (process.env.COLD_CONTEXT_SCALES ?? "1000,10000,100000").split(",").map(Number);
  const samples = Number(process.env.COLD_CONTEXT_SAMPLES ?? 5);
  const bcScales = (process.env.COLD_CONTEXT_BC_SCALES ?? "1000,10000,100000").split(",").filter(Boolean).map(Number);
  assert(scales.length && scales.every(count => Number.isSafeInteger(count) && count >= 10));
  assert(Number.isSafeInteger(samples) && samples >= 1 && samples <= 50);
  assert(bcScales.every(count => Number.isSafeInteger(count) && count >= 10));
  const root = await mkdtemp(join(process.env.COLD_CONTEXT_TMPDIR ?? tmpdir(), "durable-context-cold-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const reportPath = resolve(process.env.COLD_CONTEXT_REPORT ?? "out/tests/durable-context-cold-store-report.json");
  const results: Array<{ archiveEntries: number; manifest: Manifest; probes: Probe[]; metrics?: unknown }> = [];
  const report = {
    schemaVersion: 2, productAndBenchmarkIdentity: await sourceIdentity(), sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    trackedDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--", "src", "vendor", "patches", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"])).digest("hex"),
    invocation: { argv: process.argv, scales, bcScales, samples, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("COLD_CONTEXT_"))) },
    criteria: { maxActiveEntries: 1000, maxKernelRefs: 1000, maxKernelBlocks: 100, maxStateBytes: 4_000_000, maxRetainedHeapDeltaBytes: 64 * 1024 * 1024, maxPeakRssBytes: 256 * 1024 * 1024, maxWarmCoreEntriesVisited: 2000, maxReopenArchiveReads: 0, maxReplayedEntries: 0, finiteBudgetObserverMaxReturnedEntries: 51 },
    createdAt: new Date().toISOString(), node: process.version, tempRoot: root,
    method: "Fresh child process and copied official selected store per probe; OS page cache uncontrolled. Imported 200-message active head and independent production BC growing text shapes. Test-only prototype and JSON.stringify counters add observation overhead; stringify counts all serialization, not just originals. Entry counters observe returned SDK records, not SQLite internal row visits or OS physical reads. Seed creation/migration cost is excluded from steady probe latency.",
    acceptance: { correctnessAndBoundedRequestRetrieval: false, fullScaleEvidence: false, importedHeadColdStoreBounded: false, bcTextGrowthColdStoreBounded: false, importedHeadFiniteBudgetsSatisfied: false, bcTextGrowthFiniteBudgetsSatisfied: false, longHistoryColdStoreBounded: false },
    limitations: ["Finite-budget acceptance allows at most 51 returned records at open for the SDK observer window, including archived records; strict zero-archive acceptance is reported separately and is not replaced.",
      "Fixtures, not real Flash. No causal latency comparison with historical measurements under different machine load.",
      "Text-only BC does not establish bounds for arbitrary protected/image histories or giant initial imports. Migration is excluded from steady opens and must be measured separately.",
      "Five process samples yield descriptive nearest-rank p95, not statistically precise tail latency. Peak heap is sampled, not an exact high-water mark."],
    results, bcResults: [] as Array<{ archiveEntries: number; manifest: Manifest; probes: Probe[]; metrics: unknown }>, bcOnlyDiagnostics: [] as BcDiagnostic[], error: undefined as string | undefined,
    growth: [] as unknown[],
    endProductAndBenchmarkSha256: undefined as string | undefined, sourceStableDuringRun: false,
  };
  let successful = false;
  try {
    for (const count of scales) {
      const seedDirectory = join(root, `archive-${count}`);
      const manifestFile = join(root, `manifest-${count}.json`);
      await child("seed", seedDirectory, workspace, count, manifestFile, manifestFile);
      const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as Manifest;
      const probes: Probe[] = [];
      const result = { archiveEntries: count, manifest, probes, metrics: undefined as unknown };
      results.push(result);
      for (let index = 0; index < samples; index++) {
        const directory = join(root, `probe-${count}-${index}`);
        await cp(seedDirectory, directory, { recursive: true });
        const resultFile = join(root, `probe-${count}-${index}.json`);
        await child("probe", directory, workspace, count, resultFile, manifestFile);
        probes.push(JSON.parse(await readFile(resultFile, "utf8")) as Probe);
        await rm(directory, { recursive: true, force: true });
      }
      result.metrics = metrics(probes, manifest);
      console.log(`[cold-store] archive=${count} ${JSON.stringify(result.metrics)}`);
    }
    for (const count of bcScales) {
      const directory = join(root, `bc-only-${count}`);
      const resultFile = join(root, `bc-only-${count}.json`);
      await child("bc-only", directory, workspace, count, resultFile, resultFile);
      const diagnostic = JSON.parse(await readFile(resultFile, "utf8")) as BcDiagnostic;
      report.bcOnlyDiagnostics.push(diagnostic);
      const manifestFile = join(root, `bc-manifest-${count}.json`);
      await writeFile(manifestFile, JSON.stringify(diagnostic.manifest));
      const probes: Probe[] = [];
      const result = { archiveEntries: count, manifest: diagnostic.manifest, probes, metrics: undefined as unknown };
      report.bcResults.push(result);
      for (let index = 0; index < samples; index++) {
        const copy = join(root, `bc-probe-${count}-${index}`);
        await cp(directory, copy, { recursive: true });
        const file = join(root, `bc-probe-${count}-${index}.json`);
        await child("probe", copy, workspace, count, file, manifestFile);
        probes.push(JSON.parse(await readFile(file, "utf8")) as Probe);
        await rm(copy, { recursive: true, force: true });
      }
      result.metrics = metrics(probes, diagnostic.manifest);
      console.log(`[cold-store] bc-only=${count} ${JSON.stringify(result.metrics)}`);
    }
    report.endProductAndBenchmarkSha256 = (await sourceIdentity()).sha256;
    report.sourceStableDuringRun = report.endProductAndBenchmarkSha256 === report.productAndBenchmarkIdentity.sha256;
    report.acceptance.correctnessAndBoundedRequestRetrieval = true;
    report.acceptance.fullScaleEvidence = report.sourceStableDuringRun && [1_000, 10_000, 100_000].every(count => scales.includes(count)) && samples >= 5;
    // Derived finite-scale evidence, never a claim about arbitrary histories.
    const bounded = (probe: Probe, allowBoundedObserver = false) => probe.backend === "sqlite" && probe.reopen.counters.replayedEntries === 0
      && (allowBoundedObserver
        ? probe.reopen.counters.entriesReturned <= report.criteria.finiteBudgetObserverMaxReturnedEntries
          && probe.reopen.counters.archivedEntriesReturned <= report.criteria.finiteBudgetObserverMaxReturnedEntries
        : probe.reopen.counters.archivedEntriesReturned === 0)
      && probe.reopen.counters.archivedPointReads === 0
      && probe.activeEntries < report.criteria.maxActiveEntries && probe.kernelRefs < report.criteria.maxKernelRefs
      && probe.kernelBlocks < report.criteria.maxKernelBlocks && probe.stateBytes < report.criteria.maxStateBytes
      && probe.retainedAfterOpen.heapUsed - probe.before.heapUsed < report.criteria.maxRetainedHeapDeltaBytes
      && probe.peakRssBytes < report.criteria.maxPeakRssBytes
      && probe.manager.every(item => item.counters.coreEntriesVisited < report.criteria.maxWarmCoreEntriesVisited);
    report.acceptance.importedHeadColdStoreBounded = report.acceptance.fullScaleEvidence
      && results.every(result => result.probes.every(probe => bounded(probe)));
    report.acceptance.bcTextGrowthColdStoreBounded = report.sourceStableDuringRun && [1000, 10000, 100000].every(count => bcScales.includes(count)) && samples >= 5
      && report.bcOnlyDiagnostics.every(item => item.boundedRequestPreparation)
      && report.bcResults.every(result => result.probes.every(probe => bounded(probe)));
    report.acceptance.importedHeadFiniteBudgetsSatisfied = report.acceptance.fullScaleEvidence
      && results.every(result => result.probes.every(probe => bounded(probe, true)));
    report.acceptance.bcTextGrowthFiniteBudgetsSatisfied = report.sourceStableDuringRun
      && [1000, 10000, 100000].every(count => bcScales.includes(count)) && samples >= 5
      && report.bcOnlyDiagnostics.every(item => item.boundedRequestPreparation)
      && report.bcResults.every(result => result.probes.every(probe => bounded(probe, true)));
    report.acceptance.longHistoryColdStoreBounded = report.acceptance.importedHeadColdStoreBounded && report.acceptance.bcTextGrowthColdStoreBounded;
    report.growth = [results, report.bcResults].map((shape, index) => ({ shape: index === 0 ? "imported-active-head" : "bc-text-growth",
      scales: shape.map(result => ({ originals: result.archiveEntries,
        retainedHeapDeltaBytes: quantiles(result.probes.map(p => p.retainedAfterOpen.heapUsed - p.before.heapUsed)),
        peakRssBytes: quantiles(result.probes.map(p => p.peakRssBytes)), activeEntries: quantiles(result.probes.map(p => p.activeEntries)),
        kernelRefs: quantiles(result.probes.map(p => p.kernelRefs)), kernelBlocks: quantiles(result.probes.map(p => p.kernelBlocks)),
        stateBytes: quantiles(result.probes.map(p => p.stateBytes)),
        warmCoreEntriesVisited: quantiles(result.probes.flatMap(p => p.manager.slice(1).map(m => m.counters.coreEntriesVisited))),
        warmEntriesReturned: quantiles(result.probes.flatMap(p => p.warmProvider.map(m => m.counters.entriesReturned))),
        reopenArchivedEntriesReturned: quantiles(result.probes.map(p => p.reopen.counters.archivedEntriesReturned)) })),
      interpretation: "Finite workload measurements and spread, not an asymptotic complexity proof." }));
    successful = true;
  } catch (error) {
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
    throw error;
  } finally {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[cold-store] report=${reportPath} acceptance=${JSON.stringify(report.acceptance)}`);
    if (successful && process.env.COLD_CONTEXT_KEEP !== "1") await rm(root, { recursive: true, force: true });
    else console.log(`[cold-store] retained evidence=${root}`);
  }
}

if (process.argv[2] === "--cold-child") {
  const [, , , mode, directory, workspace, count, resultFile, manifestFile] = process.argv;
  assert(directory && workspace && count && resultFile && manifestFile);
  const result = mode === "seed" ? await seed(directory, workspace, Number(count))
    : mode === "bc-only" ? await diagnoseBcOnly(directory, workspace, Number(count))
      : await probe(directory, workspace, JSON.parse(await readFile(manifestFile, "utf8")) as Manifest);
  await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`);
} else await main();
