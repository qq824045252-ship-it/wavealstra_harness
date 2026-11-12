/** Production manager/runtime + real SQLite; fixture providers only. Four actual SIGKILL boundaries. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { Conversation, Harness, Storage } from "@earendil-works/pi-durable";
import { DurableBotRuntime, type DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";
import { DurableContextManager } from "../src/main/agent/durable/context/DurableContextManager";
import { DurableContextStateDoc, type DurableContextPersistedState } from "../src/main/agent/durable/context/DurableContextState";
import { readDurableContextStatus } from "../src/main/agent/durable/context/DurableContextStatus";
import { createDurableContextTools } from "../src/main/agent/durable/context/DurableContextTools";

function assistant(text: string, timestamp = 1): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp, api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop",
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function seed(): Message[] {
  return Array.from({ length: 10 }, (_, index) => {
    const content = `EXACT_ORIGINAL_${index}: /archive/record-${index}.txt ERROR_26 v4.7\n` + "Archived observation details. ".repeat(500);
    return index % 2 ? assistant(content, index + 1) : { role: "user", content, timestamp: index + 1 };
  });
}
function fixture(contextWindow = 128_000) {
  let calls = 0;
  let action: ((signal?: AbortSignal) => Promise<void>) | undefined;
  const model = { id: "fixture", provider: "fixture", api: "openai-completions", name: "fixture", reasoning: false,
    input: ["text"], contextWindow, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const models = { getModel: () => model, getAuth: async () => undefined,
    streamSimple: () => { throw new Error("Status/maintenance must not start a business generation"); },
    completeSimple: async (_model: unknown, _input: unknown, options?: { signal?: AbortSignal }) => {
      calls++; await action?.(options?.signal); return assistant("Earlier notes preserve the archive paths, exact errors and versions; originals remain retrievable.");
    } } as unknown as DurableBotOptions["models"];
  return { models, calls: () => calls, setAction: (next?: typeof action) => { action = next; } };
}
type Internals = { contextManager: DurableContextManager; conversation: Conversation; harness: Harness; storage: Storage };
function internals(runtime: DurableBotRuntime): Internals { return runtime as unknown as Internals; }
function options(directory: string, source: ReturnType<typeof fixture>, history?: Message[], onStatus?: NonNullable<DurableBotOptions["contextManagement"]>["onStatus"]): DurableBotOptions {
  return { directory, cwd: directory, models: source.models, model: { provider: "fixture", modelId: "fixture" }, toolMode: "native", instructions: () => "", onSnapshot: () => {},
    ...(history ? { initialHistory: { messages: history, context: [] } } : {}),
    contextManagement: { policy: () => ({ ratio: 0.8, absoluteTokens: null }), toolEstimateTokens: () => 0, onStatus } };
}
async function open(directory: string, source: ReturnType<typeof fixture>, history?: Message[]) {
  await mkdir(directory, { recursive: true });
  return DurableBotRuntime.open(options(directory, source, history));
}
async function state(runtime: DurableBotRuntime) {
  const { harness, conversation } = internals(runtime);
  return await harness.snapshot(DurableContextStateDoc, conversation.id, ctx) as DurableContextPersistedState;
}
async function files(directory: string): Promise<string> {
  const result: unknown[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name); const info = await stat(path);
    if (info.isFile()) result.push([name, info.mtimeMs, createHash("sha256").update(await readFile(path)).digest("hex")]);
  }
  return JSON.stringify(result);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const crashMode = process.argv[2];
if (crashMode === "--crash") {
  const boundary = process.argv[3]!;
  const directory = process.argv[4]!;
  const source = fixture(boundary === "native-commit-before-ledger" ? 32_000 : 128_000);
  let originalId = 0;
  const stop = () => {
    process.send!({ boundary, calls: source.calls(), originalId });
    // Keep the callback precisely at this boundary until the parent actually kills this process.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
  await mkdir(directory, { recursive: true });
  const runtime = await DurableBotRuntime.open(options(directory, source, seed(), status => {
    if (boundary === "before-summary" && status.phase === "summarizing") stop();
  }));
  const { contextManager: manager, conversation } = internals(runtime);
  await manager.ensureReady(ctx);
  originalId = (await conversation.context(ctx)).entries[0]!.id;
  if (boundary === "native-commit-before-ledger") {
    const taskId = await conversation.compact(undefined, ctx);
    const finished = await internals(runtime).harness.waitForTask(taskId, ctx);
    assert.equal(finished.state.outcome.status, "completed");
    if (finished.state.outcome.status === "completed" && finished.state.outcome.result.submissionId) {
      await (await internals(runtime).harness.submission(finished.state.outcome.result.submissionId, ctx))?.wait(ctx);
    }
    assert.equal((await state(runtime)).lastOperation?.phase, "applying");
    assert.equal((await conversation.context(ctx)).head?.kind, "pi.compaction");
    stop();
  }
  if (boundary === "after-summary-before-commit" || boundary === "after-commit-before-publish") {
    const commit = conversation.commit.bind(conversation);
    conversation.commit = async (change, context, settings) => {
      let terminal = false;
      const result = await commit(async tx => {
        const result = await change(tx);
        const doc = await tx.doc(DurableContextStateDoc, conversation.id);
        terminal = doc.lastOperation?.phase === "completed";
        if (terminal && boundary === "after-summary-before-commit") stop();
        return result;
      }, context, settings);
      if (terminal && boundary === "after-commit-before-publish") {
        assert.equal((await state(runtime)).lastOperation?.phase, "completed");
        stop(); // durable commit resolved, but manager.save has not received it or published any success
      }
      return result;
    };
  }
  await manager.compressNow(ctx);
  throw new Error(`Did not reach crash boundary ${boundary}`);
} else {
  const root = await mkdtemp(join(tmpdir(), "context-operations-"));
  try {
    // A real completed operation and session identity survive reopen. Passive reads don't write or start models.
    const source = fixture();
    const directory = join(root, "restart");
    let runtime = await open(directory, source, seed());
    let { contextManager: manager, conversation } = internals(runtime);
    const untouched = await files(directory);
    const statusTool = createDurableContextTools({ manager: async () => manager })[0]!;
    await statusTool.execute({}, { conversationId: conversation.id } as never, ctx);
    assert.equal(await files(directory), untouched, "acp_status must not initialize or repair a durable document");
    assert.equal(source.calls(), 0);
    const result = await manager.compressNow(ctx);
    assert(result.applied, JSON.stringify(result));
    const completed = await state(runtime);
    assert.equal(completed.lastOperation?.phase, "completed");
    assert.equal(completed.lastOperation?.revision, completed.revision);
    assert(completed.sessionId && completed.lastOperation.operationId.startsWith(completed.sessionId));
    assert(completed.lastOperation.source.viewDigest && completed.lastOperation.configDigest);
    const entries = (await conversation.context(ctx)).entries;
    const originalId = entries[0]!.id;
    const reader = { entry: async (id: number) => (await internals(runtime).storage.entry(conversation.id, id as never, ctx))?.entry };
    const page = await manager.retrieveOriginal({ entryId: originalId, limit: 200 }, reader, ctx);
    assert(page.page?.nextCursor);
    await runtime.close();
    const before = await files(directory); const calls = source.calls();
    const cold = await readDurableContextStatus(directory);
    assert.equal(cold?.phase, "completed"); assert.equal(cold?.operationId, completed.lastOperation.operationId);
    assert.equal(await files(directory), before); assert.equal(source.calls(), calls);
    assert.equal(await readDurableContextStatus(join(root, "does-not-exist")), undefined);
    runtime = await open(directory, source);
    ({ contextManager: manager, conversation } = internals(runtime));
    assert.equal(runtime.contextManagementStatus()?.phase, "completed");
    assert.equal(runtime.contextManagementStatus()?.operationId, cold.operationId);
    const resumed = await manager.retrieveOriginal({ entryId: originalId, cursor: page.page!.nextCursor, limit: 200 }, reader, ctx);
    assert.equal(resumed.page?.offset, 200); assert(resumed.text.length > 0);
    assert.equal(source.calls(), calls);
    const revision = manager.statusSnapshot().revision!;
    const view = await conversation.context(ctx);
    await manager.beforeRequest(view.messages, { models: source.models } as never, ctx);
    assert.equal(manager.statusSnapshot().revision, revision, "ephemeral pressure does not invent revisions");
    assert.equal(manager.statusSnapshot().operationId, cold.operationId);
    const current = manager.statusSnapshot();
    const stale = await manager.applyModelCompression({ startRef: "m00001", endRef: "m00003", summary: "stale", expectedRevision: current.revision! - 1 }, ctx);
    assert.equal(stale.ok, false); assert.match(stale.message, /版本已变化/);
    const configStale = await manager.applyModelCompression({ startRef: "m00001", endRef: "m00003", summary: "stale", expectedConfigDigest: "obsolete" }, ctx);
    assert.equal(configStale.ok, false);
    await assert.rejects(manager.retrieveOriginal({ entryId: originalId, cursor: Buffer.from(JSON.stringify({ target: "old", index: 0, skip: 200, offset: 200 })).toString("base64url") }, reader, ctx), /第一页/);
    const otherSource = fixture(); const other = await open(join(root, "other"), otherSource, seed());
    const otherInternal = internals(other);
    const otherId = (await otherInternal.conversation.context(ctx)).entries[0]!.id;
    assert.equal(otherInternal.conversation.id, conversation.id); assert.equal(otherId, originalId);
    await assert.rejects(otherInternal.contextManager.retrieveOriginal({ entryId: otherId, cursor: page.page!.nextCursor }, { entry: reader.entry }, ctx), /会话.*第一页/);
    assert.notEqual((await state(other)).sessionId, (await state(runtime)).sessionId);
    await other.close(); await runtime.close();
    console.log("PASS durable identity, reopen pagination, cross-store/legacy cursor rejection, model-view/config rejection and passive status");

    // Cancellation and provider failure produce durable terminal outcomes without losing committed coverage.
    for (const terminal of ["cancelled", "failed", "skipped"] as const) {
      const source = fixture(); const directory = join(root, terminal);
      const runtime = await open(directory, source, terminal === "skipped" ? [] : seed());
      const { contextManager: manager } = internals(runtime);
      if (terminal === "failed") source.setAction(async () => { throw new Error("injected provider failure"); });
      if (terminal === "cancelled") source.setAction(async signal => {
        manager.cancelMaintenance(); signal?.throwIfAborted();
      });
      const outcome = await manager.compressNow(ctx);
      assert.equal(outcome.applied, false);
      const saved = await state(runtime);
      assert.equal(saved.lastOperation?.phase, terminal);
      assert.equal(saved.summaries.length, 0);
      assert.equal(manager.statusSnapshot().durable, true);
      await runtime.close(); assert.equal((await readDurableContextStatus(directory))?.phase, terminal);
    }
    console.log("PASS persisted cancelled/failed/skipped outcomes");

    for (const mode of ["model-head", "manual-edit"]) {
      const source = fixture(); const runtime = await open(join(root, mode), source, seed());
      const { contextManager: manager, conversation } = internals(runtime);
      await manager.ensureReady(ctx);
      const view = await conversation.context(ctx);
      await manager.beforeRequest(view.messages, { models: source.models } as never, ctx);
      await manager.flush(ctx);
      const before = await state(runtime);
      const startRef = manager.refsForEntry(view.entries[0]!.id)[0]!;
      const endRef = manager.refsForEntry(view.entries[3]!.id)[0]!;
      const read = conversation.context.bind(conversation); let reads = 0;
      conversation.context = async (...args) => {
        if (++reads === 2) await conversation.commit(async tx => {
          await tx.appendEntry(conversation.id, mode === "model-head"
            ? { kind: "pi.reset", head: "self", model: [{ role: "user", content: "replacement head", timestamp: 20 }] }
            : { kind: "fixture.edit", edits: [{ target: view.entries[0]!.id, action: "replace", messages: [{ role: "user", content: "edited source", timestamp: 20 }] }] });
        }, ctx);
        return read(...args);
      };
      if (mode === "model-head") await assert.rejects(manager.applyModelCompression({ startRef, endRef, summary: "The original archive observations preserved exact paths, errors and versions before this source changed." }, ctx).then(result => {
        throw new Error(`Unexpected result before stale-source guard: ${JSON.stringify({ result, reads, startRef, endRef })}`);
      }), /视图已变化/);
      else assert.equal((await manager.compressNow(ctx)).applied, false);
      assert.deepEqual((await state(runtime)).stateJson, before.stateJson, "no old coverage can be committed under a new source identity");
      assert.equal(source.calls(), 0, "stale source is rejected before model work");
      await runtime.close();
    }
    console.log("PASS head/edit changes between computation and begin cannot relabel old coverage with a new source");

    for (const entrant of ["maintenance", "flush"]) {
      const source = fixture(); const runtime = await open(join(root, `init-${entrant}`), source, seed());
      const { contextManager: manager, conversation } = internals(runtime);
      const entered = deferred(); const release = deferred(); let commits = 0;
      const commit = conversation.commit.bind(conversation);
      conversation.commit = (change, context, settings) => commit(async tx => {
        commits++;
        const result = await change(tx);
        const doc = await tx.doc(DurableContextStateDoc, conversation.id);
        if (doc.stateJson && !doc.lastOperation && commits === 2) { entered.resolve(); await release.promise; }
        return result;
      }, context, settings);
      const reading = manager.readState(ctx); await entered.promise;
      const startingCommits = commits; let readSettled = false;
      const secondRead = manager.readState(ctx).then(result => { readSettled = true; return result; });
      const flush = entrant === "flush" ? manager.flush(ctx) : undefined;
      const maintenance = manager.compressNow(ctx);
      if (entrant === "maintenance") await manager.flush(ctx);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(readSettled, false, "an initialized kernel object is not evidence that its commit completed");
      assert.equal(commits, startingCommits, "no competing save may bypass pending initialization");
      assert.equal(manager.readStatusSnapshot().state, undefined, "passive status hides an uncommitted initial kernel");
      assert.equal(source.calls(), 0);
      release.resolve(); await reading; await secondRead; await flush;
      const result = await maintenance;
      assert.equal(result.applied, entrant === "maintenance");
      if (entrant === "flush") assert.equal(source.calls(), 0);
      await runtime.close();
    }
    console.log("PASS pending initialization blocks concurrent reads, maintenance and flush until the initial commit settles");

    // Same-manager races are rejected synchronously, before the first await and again while coverage is staged.
    {
      const source = fixture(); const runtime = await open(join(root, "same-manager"), source, seed());
      const { contextManager: manager, conversation } = internals(runtime);
      await manager.ensureReady(ctx);
      const view = await conversation.context(ctx);
      await manager.beforeRequest(view.messages, { models: source.models } as never, ctx); await manager.flush(ctx);
      const baseline = await state(runtime);
      const input = { startRef: manager.refsForEntry(view.entries[0]!.id)[0]!, endRef: manager.refsForEntry(view.entries[3]!.id)[0]!,
        summary: "The original archive observations preserved exact paths, errors and versions for later retrieval." };
      const firstEntered = deferred(); const firstRelease = deferred(); const staged = deferred(); const stagedRelease = deferred();
      const read = conversation.context.bind(conversation); let reads = 0;
      conversation.context = async (...args) => {
        reads++;
        if (reads === 1) { firstEntered.resolve(); await firstRelease.promise; }
        if (reads === 3) { staged.resolve(); await stagedRelease.promise; }
        return read(...args);
      };
      const first = manager.applyModelCompression(input, ctx); await firstEntered.promise;
      assert.equal((await manager.applyModelCompression(input, ctx)).ok, false);
      assert.equal(reads, 1, "second operation cannot pass the first await with shared mutable state");
      await manager.beforeRequest(view.messages, { models: source.models } as never, ctx); await manager.flush(ctx);
      assert.deepEqual(await state(runtime), baseline);
      firstRelease.resolve(); await staged.promise;
      const started = await state(runtime); assert.equal(started.lastOperation?.phase, "summarizing");
      assert.equal((await manager.applyModelCompression(input, ctx)).ok, false);
      await manager.beforeRequest(view.messages, { models: source.models } as never, ctx); await manager.flush(ctx);
      assert.deepEqual(await state(runtime), started, "non-fold prepare and flush cannot commit another operation's staged coverage");
      assert.equal(manager.statusSnapshot().blocks, 0); assert.equal((await manager.readState(ctx))?.blocks.length, 0);
      stagedRelease.resolve(); assert.equal((await first).ok, true);
      assert.equal((await state(runtime)).lastOperation?.phase, "completed");
      assert((await state(runtime)).summaries.length > 0);
      await runtime.close();
    }
    console.log("PASS same-manager admission and staging isolation, including non-fold preparation and flush");

    // A newer manager replaces the started operation; its revision/result wins over an old model callback.
    {
      const source = fixture(); const runtime = await open(join(root, "stale-callback"), source, seed());
      const { contextManager: old, conversation } = internals(runtime);
      const entered = deferred(); const release = deferred();
      source.setAction(async () => { entered.resolve(); await release.promise; });
      const late = old.compressNow(ctx); await entered.promise;
      const pending = await readDurableContextStatus(join(root, "stale-callback"));
      assert.equal(pending?.phase, "summarizing", "a live owner is not mislabeled interrupted");
      const newerSource = fixture();
      const newer = new DurableContextManager({ conversation, models: newerSource.models, policy: () => ({ ratio: 0.8, absoluteTokens: null }), contextWindow: () => 128_000 });
      await newer.ensureReady(ctx);
      assert((await newer.compressNow(ctx)).applied);
      const saved = await state(runtime);
      release.resolve(); await late;
      assert.deepEqual(await state(runtime), saved, "old completion/failure callback must not overwrite newer state");
      assert(saved.revision! > pending!.revision!);
      newer.dispose(); await runtime.close();
    }
    console.log("PASS stale callback CAS and active-owner passive status");

    // Real SDK storage faults at start, terminal write and lost acknowledgement; never claim uncertain success.
    for (const boundary of ["start-write", "terminal-write", "terminal-ack"]) {
      const source = fixture(); const directory = join(root, boundary);
      const runtime = await open(directory, source, seed());
      const { contextManager: manager, storage, conversation } = internals(runtime);
      await manager.ensureReady(ctx);
      const originalCommit = storage.commit.bind(storage);
      let injected = false;
      const reject = async (...args: Parameters<Storage["commit"]>): ReturnType<Storage["commit"]> => {
        if (boundary === "terminal-ack") await originalCommit(args[0], () => {}, args[2]);
        throw new Error(`injected ${boundary} disk failure`);
      };
      const commit = conversation.commit.bind(conversation);
      conversation.commit = (change, context, settings) => commit(async tx => {
        const result = await change(tx);
        const doc = await tx.doc(DurableContextStateDoc, conversation.id);
        if (!injected && doc.lastOperation?.phase === (boundary === "start-write" ? "summarizing" : "completed")) {
          injected = true; storage.commit = reject;
        }
        return result;
      }, context, settings);
      const result = await manager.compressNow(ctx);
      assert.equal(result.applied, false); assert.equal(manager.statusSnapshot().durable, false);
      assert(injected, `storage failure must occur at ${boundary}`);
      if (boundary === "start-write") assert.equal(source.calls(), 0);
      storage.commit = originalCommit;
      await runtime.close();
      const cold = await readDurableContextStatus(directory);
      assert.equal(cold?.phase, boundary === "start-write" ? "idle" : boundary === "terminal-ack" ? "completed" : "failed");
      assert.equal(Boolean(cold?.interrupted), boundary === "terminal-write");
      assert.equal(Boolean(cold?.summaries?.length), boundary === "terminal-ack");
    }
    console.log("PASS real storage start/terminal/ack failures preserve committed coverage and cannot publish uncertain success");

    {
      const source = fixture(); const runtime = await open(join(root, "hot-config"), source, seed());
      const { conversation } = internals(runtime); let ratio = 0.8;
      const manager = new DurableContextManager({ conversation, models: source.models, policy: () => ({ ratio, absoluteTokens: null }), contextWindow: () => 128_000 });
      source.setAction(async () => { ratio = 0.6; });
      assert.equal((await manager.compressNow(ctx)).applied, false);
      assert.equal((await state(runtime)).summaries.length, 0);
      assert.equal((await state(runtime)).lastOperation?.phase, "failed");
      const revision = manager.statusSnapshot().revision!;
      source.setAction(); assert((await manager.compressNow(ctx)).applied);
      assert(manager.statusSnapshot().revision! > revision); assert.equal(manager.statusSnapshot().lastError, undefined);
      manager.dispose(); await runtime.close();
    }
    console.log("PASS mid-summary config change rejects old coverage and a later operation recovers with a higher revision");

    {
      const source = fixture(32_000); const directory = join(root, "unrelated-native-head");
      const runtime = await open(directory, source, seed());
      const { contextManager: manager, conversation, harness } = internals(runtime);
      await manager.ensureReady(ctx);
      const task = await conversation.compact(undefined, ctx);
      const finished = await harness.waitForTask(task, ctx);
      assert.equal(finished.state.outcome.status, "completed");
      if (finished.state.outcome.status === "completed" && finished.state.outcome.result.submissionId) {
        await (await harness.submission(finished.state.outcome.result.submissionId, ctx))?.wait(ctx);
      }
      assert.equal((await state(runtime)).lastOperation?.phase, "applying");
      await conversation.commit(tx => tx.appendEntry(conversation.id, { kind: "pi.reset", head: "self",
        model: [{ role: "user", content: "An unrelated replacement head is not compaction proof.", timestamp: 30 }] }), ctx);
      await runtime.close();
      const cold = await readDurableContextStatus(directory);
      assert.equal(cold?.phase, "failed"); assert.equal(cold?.interrupted, true);
      const reopened = await open(directory, source); await internals(reopened).contextManager.ensureReady(ctx);
      assert.equal((await state(reopened)).lastOperation?.phase, "failed");
      await reopened.close();
    }
    console.log("PASS unrelated native head cannot masquerade as this operation's committed outcome");

    for (const boundary of ["before-summary", "after-summary-before-commit", "after-commit-before-publish", "native-commit-before-ledger"]) {
      const directory = join(root, boundary);
      const child = fork(fileURLToPath(import.meta.url), ["--crash", boundary, directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      let stderr = ""; child.stderr?.on("data", chunk => { stderr += String(chunk); });
      const reached = await new Promise<{ calls: number; originalId: number }>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timeout ${boundary}: ${stderr}`)); }, 20_000);
        child.once("message", message => { clearTimeout(timer); resolve(message as { calls: number; originalId: number }); });
        child.once("exit", code => { clearTimeout(timer); reject(new Error(`early exit ${boundary} ${code}: ${stderr}`)); });
      });
      const killed = new Promise<void>((resolve, reject) => child.once("exit", (_code, signal) => signal === "SIGKILL" ? resolve() : reject(new Error(`not killed: ${signal}`))));
      child.kill("SIGKILL"); await killed;
      assert.equal(reached.calls > 0, boundary !== "before-summary");
      const bytes = await files(directory); const cold = await readDurableContextStatus(directory);
      assert.equal(await files(directory), bytes, "passive cold status makes zero filesystem changes");
      const committed = boundary === "after-commit-before-publish" || boundary === "native-commit-before-ledger";
      assert.equal(cold?.phase, committed ? "completed" : "failed");
      assert.equal(Boolean(cold?.interrupted), !committed);
      assert.equal(Boolean(cold?.summaries?.length), boundary === "after-commit-before-publish");
      const source = fixture(); const runtime = await open(directory, source);
      const { contextManager: manager, conversation, storage } = internals(runtime);
      await manager.ensureReady(ctx);
      const reopened = await state(runtime);
      assert.equal(reopened.lastOperation?.phase, committed ? "completed" : "failed");
      assert.equal(reopened.lastOperation?.operationId, cold?.operationId);
      assert.equal(source.calls(), 0, "recovery never replays summary or business model calls");
      const text = await manager.retrieveOriginal({ entryId: reached.originalId, limit: 400 }, { entry: async id => (await storage.entry(conversation.id, id as never, ctx))?.entry }, ctx);
      assert(text.text.includes("EXACT_ORIGINAL_0"));
      const stableRevision = reopened.revision;
      await manager.ensureReady(ctx); assert.equal((await state(runtime)).revision, stableRevision, "recovery is idempotent");
      await runtime.close();
      console.log(`PASS actual SIGKILL ${boundary}: originals retained, committed outcome truthful, no replay`);
    }
    console.log("durable context operation tests passed");
  } finally { await rm(root, { recursive: true, force: true }); }
}
