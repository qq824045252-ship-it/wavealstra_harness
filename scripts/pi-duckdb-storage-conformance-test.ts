import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  Harness,
  StorageRequestError,
  type ConversationId,
  type EntryId,
  type Seq,
} from "@earendil-works/pi-durable";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { Type } from "typebox";
import { DuckDbStorage, StorageFencedError } from "../src/main/agent/durable/DuckDbStorage";
import {
  durableStorageExists,
  openDurablePassiveStorage,
  openDurableStorage,
  purgeDurableStorage,
  setDefaultPiStorageClient,
} from "../src/main/agent/durable/DurableStorage";
import { DurableStorageOwnedError } from "../src/main/agent/durable/DurableStorageLease";
import { assertExpectedPiVersion } from "../src/main/host/pi-version";
import { CoreBusinessClient } from "../src/main/platform/core-business-client";
import { initializeCoreDatabase, shutdownCoreWorker } from "../src/main/platform/core-client";
import { locateRuntimeAudit, RuntimeAuditReader, RuntimeAuditUnknownOperationError, type PiStorageClient } from "../src/main/platform/runtime-audit";

function partialDeepMatch(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (expected === null || typeof expected !== "object") return false;
  if (actual === null || typeof actual !== "object") return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((item, idx) => partialDeepMatch(actual[idx], item));
  }
  const actualObj = actual as Record<string, unknown>;
  for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
    if (!(k in actualObj) || !partialDeepMatch(actualObj[k], v)) return false;
  }
  return true;
}

const CrashDoc = defineDoc({
  kind: "test.crash_state",
  version: 1,
  scope: "session",
  initial: () => ({ step: 0, note: "" }),
  checkpointWhen: () => false,
});

async function crashFixtureModels(agentDir: string, pauseAfterEffect?: () => void): Promise<ModelRuntime> {
  const models = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  models.registerProvider("probe", {
    api: "openai-completions",
    apiKey: "offline",
    baseUrl: "http://127.0.0.1:1",
    models: [{
      id: "test",
      name: "test",
      reasoning: false,
      input: ["text"] satisfies Array<"text" | "image">,
      contextWindow: 16_000,
      maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(_model, request) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const done = request.messages.some(m => m.role === "toolResult");
        if (done && pauseAfterEffect) {
          pauseAfterEffect();
          return;
        }
        const content: AssistantMessage["content"] = done
          ? [{ type: "text", text: "sigkill-done" }]
          : [{ type: "toolCall", id: "c1", name: "record_effect", arguments: {} }];
        const stopReason = done ? "stop" : "toolUse";
        stream.push({
          type: "done",
          reason: stopReason,
          message: {
            role: "assistant",
            content,
            api: "openai-completions",
            provider: "probe",
            model: "test",
            timestamp: Date.now(),
            stopReason,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          },
        });
        stream.end();
      });
      return stream;
    },
  });
  return models;
}

function crashFixtureRegistry(sideEffectFile: string) {
  const effectTool = defineTool({
    name: "record_effect",
    description: "side effect",
    parameters: Type.Object({}),
    replay: "unsafe",
    execute: async () => {
      await appendFile(sideEffectFile, "effect\n", "utf8");
      return { output: [{ type: "text", text: "ok" }] };
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "sigkill-ext", tools: [effectTool] }));
  return registry;
}

async function runSigkillChildWorker(args: string[]): Promise<void> {
  const [exe, coreDir, dbPath, storeDir, agentDir, sideEffectFile] = args;
  const reader = new RuntimeAuditReader(exe, dbPath, { coreDataDirectory: coreDir });
  setDefaultPiStorageClient(reader);
  await mkdir(join(agentDir, "agents"), { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["probe/test"] }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const models = await crashFixtureModels(agentDir, () => process.stdout.write("SIGKILL_CHILD_READY\n"));
  const handle = await openDurableStorage(storeDir, context, { reader });
  const harness = await Harness.open(handle.storage, { models, registry: crashFixtureRegistry(sideEffectFile) }, context);
  const root = await harness.root(context, { agent: { cwd: coreDir, model: { provider: "probe", modelId: "test" } } });
  await harness.commit(async tx => {
    const doc = await tx.doc(CrashDoc);
    doc.step = 42;
    doc.note = "durable-before-sigkill";
  }, context);
  await root.submit({ type: "input", content: "Run crash check", requestId: "req-sigkill-1" }, context);
  // Keep the first Host alive while the second model response is paused after the durable tool result.
  setInterval(() => {}, 1_000);
}

async function main(): Promise<void> {
  if (process.argv[2] === "--sigkill-child") {
    await runSigkillChildWorker(process.argv.slice(3));
    return;
  }

  const exe = process.env.MYBUDDY_RUNTIME_AUDIT_EXE?.trim() || locateRuntimeAudit(process.cwd());
  assert(exe, "Could not locate mybuddy-runtime-audit binary");
  const rootDir = await mkdtemp(join(tmpdir(), "mybuddy-pi-duckdb-test-"));
  const dbPath = join(rootDir, "app.duckdb");
  const { actual: piVersion, expected: expectedPiVersion } = assertExpectedPiVersion();
  let reader: RuntimeAuditReader | undefined;

  try {
    await initializeCoreDatabase(exe, rootDir, dbPath, 1);
    reader = new RuntimeAuditReader(exe, dbPath, { coreDataDirectory: rootDir });
    setDefaultPiStorageClient(reader);

    // 1. Official @earendil-works/pi-durable Storage Conformance Suite (30+ cases)
    console.log("[1/6] Running @earendil-works/pi-durable Storage conformance suite...");
    let storeSeq = 0;
    const cases = createStorageConformance({
      assertions: {
        ok: (value, message) => assert.ok(value, message),
        strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
        deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
        partialDeepEqual: (actual, expected) => {
          assert.ok(
            partialDeepMatch(actual, expected),
            `Expected partial match.\nActual: ${JSON.stringify(actual)}\nExpected: ${JSON.stringify(expected)}`,
          );
        },
        greaterThan: (actual, expected) => assert.ok(actual > expected, `Expected ${actual} > ${expected}`),
        rejects: async (operation, messageIncludes) => {
          let err: unknown;
          try {
            await operation;
          } catch (e) {
            err = e;
          }
          assert.ok(err instanceof Error, `Expected rejection containing "${messageIncludes}", got resolve`);
          assert.ok(
            err.message.toLowerCase().includes(messageIncludes.toLowerCase()) || String(err).toLowerCase().includes(messageIncludes.toLowerCase()),
            `Expected error message "${err.message}" to include "${messageIncludes}"`,
          );
        },
      },
      withStorage: async use => {
        const storeId = `conf-${++storeSeq}-${randomUUID()}`;
        const storage = await DuckDbStorage.openWriter(reader!, storeId);
        try {
          await use(storage);
        } finally {
          await storage.close(context).catch(() => undefined);
        }
      },
    });
    for (const testCase of cases) {
      await testCase.run();
      console.log(`  PASS: ${testCase.name}`);
    }
    console.log(`  All ${cases.length} official Pi Storage conformance cases passed.`);

    const lostReplies = new Set(["mintId", "commit"]);
    const receiptCommands = new Map<string, Record<string, unknown> & { action: string }>();
    const receiptClient: PiStorageClient = {
      async piStorage<T>(command: Record<string, unknown> & { action: string }, signal?: AbortSignal): Promise<T | undefined> {
        const reply = await reader!.piStorage<T>(command, signal);
        if (lostReplies.delete(command.action)) {
          assert((reply as { ok?: boolean }).ok, "Expected committed data before losing the reply");
          assert.equal(typeof command.operationId, "string");
          receiptCommands.set(command.action, command);
          throw new RuntimeAuditUnknownOperationError(randomUUID(), "piStorage");
        }
        if (receiptCommands.has(command.action)) assert.deepEqual(command, receiptCommands.get(command.action));
        return reply;
      },
    };
    const receiptStore = await DuckDbStorage.openWriter(receiptClient, "lost-reply");
    try {
      const conversationId = await receiptStore.mintId<ConversationId>();
      assert.equal(conversationId, 2);
      receiptCommands.delete("mintId");
      const received: Seq[] = [];
      const result = await receiptStore.commit([[{ type: "conversation", value: { id: conversationId } }]],
        (_, seq) => received.push(seq), context);
      assert.equal(result.stored, 1);
      assert.deepEqual(received, [1]);
      assert.equal(await receiptStore.mintId(), 3);
      const command = receiptCommands.get("commit")!;
      const reused = await reader.piStorage<{ ok: boolean; message?: string }>({ ...command, batches: [] });
      assert.equal(reused?.ok, false);
      assert.match(reused?.message ?? "", /different request/);
      assert.deepEqual(await receiptStore.conversation(conversationId, context), { id: conversationId });
      assert.equal(lostReplies.size, 0);
    } finally {
      await receiptStore.close(context);
    }
    console.log("  PASS: lost mint and commit replies replay once with their original operation identity");

    // 2. Multi-store isolation & concurrent writes (PI-02, CC-03)
    console.log("[2/6] Verifying 4-store concurrent isolation...");
    const storeIds = Array.from({ length: 4 }, (_, i) => `iso-${i}-${randomUUID()}`);
    const stores = await Promise.all(storeIds.map(id => DuckDbStorage.openWriter(reader!, id)));
    try {
      await Promise.all(stores.map(async (st, idx) => {
        const cId = await st.mintId<ConversationId>();
        assert.equal(cId, 2);
        const eId = await st.mintId<EntryId>();
        assert.equal(eId, 3);
        const seqs: Seq[] = [];
        const res = await st.commit([
          [{ type: "conversation", value: { id: cId } }],
          [{ type: "entry", value: { id: eId, conversationId: cId, kind: `iso-${idx}`, data: { storeIndex: idx } } }],
        ], (_i, s) => seqs.push(s), context);
        assert.equal(res.stored, 2);
        assert.deepEqual(seqs, [1, 2]);
      }));
      for (let i = 0; i < stores.length; i += 1) {
        const page = await stores[i].scanEntries({ conversationId: 2 as ConversationId }, 10, undefined, context);
        assert.equal(page.items.length, 1);
        assert.equal(page.items[0].kind, `iso-${i}`);
        assert.deepEqual(page.items[0].data, { storeIndex: i });
      }
    } finally {
      await Promise.all(stores.map(s => s.close(context).catch(() => undefined)));
    }

    // 3. Writer epoch & host generation fencing (PI-04)
    console.log("[3/6] Verifying writer epoch & host generation fencing...");
    const fenceStoreId = `fence-${randomUUID()}`;
    const w1 = await DuckDbStorage.openWriter(reader, fenceStoreId, {
      hostGeneration: "gen-w1",
      leaseHolder: "holder-w1",
      leaseTtlMs: 30_000,
    });
    await assert.rejects(
      DuckDbStorage.openWriter(reader, fenceStoreId, { leaseHolder: "holder-w2" }),
      DurableStorageOwnedError,
    );
    const w2 = await DuckDbStorage.openWriter(reader, fenceStoreId, {
      hostGeneration: "gen-w2",
      leaseHolder: "holder-w2",
      forceTakeover: true,
    });
    assert.ok((w2.writerEpoch ?? 0) > (w1.writerEpoch ?? 0));
    await assert.rejects(w1.mintId(), StorageFencedError);
    await assert.rejects(w1.heartbeatLease(), StorageFencedError);
    await assert.rejects(
      w1.commit([[{ type: "conversation", value: { id: 1 as ConversationId } }]], () => {}, context),
      StorageFencedError,
    );
    const seq2 = await w2.mintId<ConversationId>();
    assert.equal(seq2, 2);
    await w1.close(context).catch(() => undefined);

    const fenceRes = await reader.piHost<{ fenced?: boolean }>({
      action: "fenceGeneration",
      hostGeneration: "gen-w2",
      reason: "test_fenced_generation",
    });
    assert.equal(fenceRes?.fenced, true);
    await assert.rejects(w2.mintId(), StorageFencedError);
    await w2.close(context).catch(() => undefined);

    // 4. Passive read-only & purgeStore (PI-03, PI-07)
    console.log("[4/6] Verifying passive read-only open & purgeStore...");
    const lifecycleDir = join(rootDir, "store-lifecycle");
    assert.equal(await durableStorageExists(lifecycleDir, reader), false);
    assert.equal(await openDurablePassiveStorage(lifecycleDir, context, reader), undefined);
    const liveHandle = await openDurableStorage(lifecycleDir, context, { reader });
    const convId = await liveHandle.storage.mintId<ConversationId>();
    await liveHandle.storage.commit([[{ type: "conversation", value: { id: convId } }]], () => {}, context);
    assert.equal(await durableStorageExists(lifecycleDir, reader), true);
    const passive = await openDurablePassiveStorage(lifecycleDir, context, reader);
    assert(passive);
    const history = await reader.openDurable(lifecycleDir);
    assert(history);
    assert.equal(await history.head(convId, 100), "");
    assert.deepEqual(await passive.conversation(convId, context), { id: convId });
    await assert.rejects(passive.mintId(), /read-only/);
    await liveHandle.storage.close(context);
    liveHandle.lease.release();

    await purgeDurableStorage(lifecycleDir, reader);
    assert.equal(await durableStorageExists(lifecycleDir, reader), false);
    assert.equal(await openDurablePassiveStorage(lifecycleDir, context, reader), undefined);
    const reopened = await openDurableStorage(lifecycleDir, context, { reader });
    try {
      const reusedId = await reopened.storage.mintId<ConversationId>();
      assert.equal(reusedId, convId);
      const result = await reopened.storage.commit([[{ type: "conversation", value: { id: reusedId } }]], () => {}, context);
      assert.equal(result.stored, 1);
      assert.deepEqual(await reopened.storage.conversation(reusedId, context), { id: reusedId });
      await assert.rejects(passive.conversation(reusedId, context), StorageFencedError);
      assert.equal(await history.head(reusedId, 100), undefined);
    } finally {
      await history.close();
      await passive.close(context);
      await reopened.storage.close(context);
      reopened.lease.release();
    }

    // 5. Real child-process SIGKILL crash recovery (PI-05)
    console.log("[5/6] Verifying real SIGKILL crash & idempotent recovery...");
    const crashStoreDir = join(rootDir, "sigkill-store");
    const crashAgentDir = join(rootDir, "sigkill-agent");
    const sideEffectFile = join(rootDir, "sigkill-effects.txt");
    const child = spawn(
      process.execPath,
      [process.argv[1], "--sigkill-child", exe, rootDir, dbPath, crashStoreDir, crashAgentDir, sideEffectFile],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let childStdout = "";
    let childStderr = "";
    child.stderr?.on("data", chunk => { childStderr += chunk.toString(); });
    await new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error(`SIGKILL child timed out. stderr=${childStderr}`)), 25_000);
      child.once("exit", code => {
        clearTimeout(timer);
        rejectReady(new Error(`SIGKILL child exited early (${code}). stderr=${childStderr}`));
      });
      child.stdout?.on("data", chunk => {
        childStdout += chunk.toString();
        if (childStdout.includes("SIGKILL_CHILD_READY")) {
          clearTimeout(timer);
          child.removeAllListeners("exit");
          resolveReady();
        }
      });
    });
    child.kill("SIGKILL");
    await new Promise<void>(resolveExit => child.once("exit", () => resolveExit()));

    const recoveredHandle = await openDurableStorage(crashStoreDir, context, { reader });
    try {
      const models2 = await crashFixtureModels(crashAgentDir);
      const registry = crashFixtureRegistry(sideEffectFile);
      const harness2 = await Harness.open(recoveredHandle.storage, { models: models2, registry }, context);
      try {
        const root2 = await harness2.root(context);
        const saved = await recoveredHandle.storage.submissionByRequest(root2.id, "req-sigkill-1", context);
        assert(saved, "Original submission must survive the hard kill");
        assert.notEqual(saved.status, "done", "The hard kill must precede settlement");
        const receipt = await harness2.submission(saved.id, context);
        assert(receipt);
        const settled2 = await receipt.wait(context);
        assert.equal(settled2.status, "done");
        assert.equal(await readFile(sideEffectFile, "utf8"), "effect\n");
        const snap = await harness2.snapshot(CrashDoc, context);
        assert.deepEqual(snap, { step: 42, note: "durable-before-sigkill" });
        await assert.rejects(
          recoveredHandle.storage.entry(999_999 as ConversationId, 1 as EntryId, context),
          StorageRequestError,
        );
      } finally {
        await harness2.close(context);
      }
    } finally {
      await recoveredHandle.storage.close(context);
      recoveredHandle.lease.release();
    }

    // 6. 3-phase PiNodeHost readiness & anti-double-dispatch over real Core IPC (PI-06, APP-05)
    console.log("[6/6] Verifying 3-phase PiNodeHost readiness & non-double-dispatch...");
    const hostClient = await CoreBusinessClient.connect(exe, dbPath, {
      dataDirectory: rootDir,
      role: "execution-host",
      clientId: "test-exec-host",
    });
    const dispatchedIds = new Set<string>();
    const offDispatch = hostClient.onExecutionDispatch(dispatch => {
      const execId = dispatch.execution?.executionId;
      if (execId) dispatchedIds.add(execId);
    });
    try {
      const storageRoot3p = join(rootDir, "host-3p");
      const boot = await hostClient.piHost<{ accepted?: boolean; status?: string }>({
        action: "bootstrap",
        hostId: "h-3p-e2e",
        pid: process.pid,
        hostGeneration: "gen-3p-e2e",
        storageRoot: storageRoot3p,
        dbPath,
        piVersion,
        expectedPiVersion,
      });
      assert.equal(boot?.accepted, true);
      assert.equal(boot?.status, "bootstrapping");

      await hostClient.request({
        operation: "coreExecution",
        action: "submit",
        executionId: "exec-rec-3p",
        idempotencyKey: "k-rec-3p",
        taskId: "task-rec-3p",
        kind: "pi_turn",
        payload: { prompt: "rec" },
      });
      await hostClient.request({
        operation: "coreExecution",
        action: "submit",
        executionId: "exec-fresh-3p",
        idempotencyKey: "k-fresh-3p",
        taskId: "task-fresh-3p",
        kind: "pi_turn",
        payload: { prompt: "fresh" },
      });
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
      assert.equal(dispatchedIds.size, 0, "Bootstrapping host must block all new dispatches");

      const badReg = await hostClient.piHost<{ accepted?: boolean; reason?: string }>({
        action: "register",
        hostId: "h-3p-e2e",
        pid: process.pid,
        hostGeneration: "gen-3p-e2e",
        storageRoot: storageRoot3p,
        dbPath,
        piVersion,
        expectedPiVersion,
        capabilities: [],
        recoveredTaskIds: [],
        requireManifest: true,
      });
      assert.equal(badReg?.accepted, false);
      assert.equal(badReg?.reason, "capability_manifest_required");
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
      assert.equal(dispatchedIds.size, 0, "Rejected empty manifest must keep waiting tasks queued");

      const okReg = await hostClient.piHost<{ accepted?: boolean }>({
        action: "register",
        hostId: "h-3p-e2e",
        pid: process.pid,
        hostGeneration: "gen-3p-e2e",
        storageRoot: storageRoot3p,
        dbPath,
        piVersion,
        expectedPiVersion,
        capabilities: ["pi_turn"],
        recoveredTaskIds: ["task-rec-3p"],
        requireManifest: true,
      });
      assert.equal(okReg?.accepted, true);

      const deadline = Date.now() + 2_000;
      while (!dispatchedIds.has("exec-fresh-3p") && Date.now() < deadline) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
      }
      assert.ok(dispatchedIds.has("exec-fresh-3p"), "Expected fresh waiting execution to dispatch after ready registration");
      assert.ok(!dispatchedIds.has("exec-rec-3p"), "Recovered task must not be double-dispatched");

      const recStatus = await hostClient.request<{ execution?: { status?: string; waitReason?: string } }>({
        operation: "coreExecution",
        action: "status",
        executionId: "exec-rec-3p",
      });
      assert.equal(recStatus?.execution?.status, "running");
      assert.equal(recStatus?.execution?.waitReason, "recovered_in_host");
    } finally {
      offDispatch();
      await hostClient.close().catch(() => undefined);
    }

    console.log("ALL PI DUCKDB STORAGE CONFORMANCE & INTEGRATION CHECKS PASSED.");
  } finally {
    setDefaultPiStorageClient(undefined);
    await reader?.close().catch(() => undefined);
    await shutdownCoreWorker(rootDir, dbPath).catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

void main().catch(error => {
  console.error("Conformance test failed:", error);
  process.exit(1);
});
