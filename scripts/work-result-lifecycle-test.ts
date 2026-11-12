import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import Database from "better-sqlite3";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { DurableBotRuntime, type DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";
import { durableStorageOwnerState } from "../src/main/agent/durable/DurableStorageLease";
import { openDurablePassiveStorage } from "../src/main/agent/durable/DurableStorage";
import { BotWorkResultTurn } from "../src/main/agent/work/BotWorkResultTurn";
import { WorkResultDeadline, WorkResultLifecycleError } from "../src/main/agent/work/WorkResultLifecycleError";

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const phase = (expected: WorkResultLifecycleError["phase"]) => (error: unknown) => error instanceof WorkResultLifecycleError && error.phase === expected;

// The deadline is one clock across phases, including time spent before reply.
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
try {
  const deadline = new WorkResultDeadline(() => true);
  const waiting = deferred<void>();
  mock.timers.tick(59000);
  await deadline.wait("reply", async () => "body");
  const idle = deadline.wait("idle", () => waiting.promise);
  const failed = assert.rejects(idle, phase("idle"));
  mock.timers.tick(1000);
  await failed;
  assert.equal(deadline.current(), false);
  deadline.dispose(); waiting.resolve();
} finally { mock.timers.reset(); }

const root = mkdtempSync(join(tmpdir(), "work-result-lifecycle-"));
const catalog = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
  modelsStorePath: join(root, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
let modelCalls = 0;
const answer = { decision: "deliver", outcome: "completed", reply: "真实夹具正文已保留。", missing: [] };
catalog.registerProvider("fixture", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
  models: [{ id: "review", name: "review", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  streamSimple: (model) => {
    modelCalls++;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: JSON.stringify(answer) }],
        stopReason: "stop", api: model.api, model: model.id, provider: model.provider, timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: "stop", message }); stream.end();
    });
    return stream;
  } });

let authority = true;
const openTurn = () => new BotWorkResultTurn({ models: catalog, directory: join(root, "reviews"),
  defaultModel: () => "fixture/review", botModel: () => "fixture/review", isAuthority: () => authority });
let turn = openTurn();
const input = (eventId: string) => ({ eventId, botId: "owner", context: { originalRequest: "核对已有成果", results: [{ summary: "已有成果" }] } });
const directory = (eventId: string) => join(root, "reviews", createHash("sha256").update(eventId).digest("hex"));
const originalOpen = DurableBotRuntime.open;
let opened = 0;
let hook: (runtime: DurableBotRuntime, options: DurableBotOptions) => Promise<void> | void = () => {};
mock.method(DurableBotRuntime, "open", async (options: DurableBotOptions) => {
  const runtime = await originalOpen(options); opened++; await hook(runtime, options); return runtime;
});

// Keep real native storage scheduling, and fire only this lane's registered
// deadline callbacks. No wall-clock delay or provider network is involved.
const realTimeout = globalThis.setTimeout;
const deadlines: Array<{ milliseconds: number; fire: () => void; handle: ReturnType<typeof setTimeout> }> = [];
mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => {
  const handle = realTimeout(callback, milliseconds, ...args);
  if (milliseconds === 60000 || milliseconds === 5000) deadlines.push({ milliseconds, handle, fire: () => callback(...args) });
  return handle;
});
const fire = (milliseconds: number) => {
  const timer = deadlines.filter(item => item.milliseconds === milliseconds).at(-1);
  assert(timer, `registered ${milliseconds}ms deadline must exist`);
  clearTimeout(timer.handle); timer.fire();
};
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

try {
  assert.deepEqual(await turn.review(input("normal")), answer);
  assert.equal(durableStorageOwnerState(directory("normal")), "inactive");

  for (const pendingPhase of ["submission", "reply", "idle"] as const) {
    const eventId = `blocked-${pendingPhase}`;
    const entered = deferred<void>(), late = deferred<void>();
    hook = runtime => {
      if (pendingPhase === "submission") {
        const submit = runtime.submit.bind(runtime);
        mock.method(runtime, "submit", async (...args: Parameters<DurableBotRuntime["submit"]>) => {
          const submission = await submit(...args); await runtime.reply(submission);
          entered.resolve(); await late.promise; return submission;
        });
      } else if (pendingPhase === "idle") mock.method(runtime.conversation, "waitForIdle", () => { entered.resolve(); return late.promise; });
      else {
        const reply = runtime.reply.bind(runtime);
        mock.method(runtime, "reply", async (...args: Parameters<DurableBotRuntime["reply"]>) => {
          const text = await reply(...args); entered.resolve(); await late.promise; return text;
        });
      }
    };
    const before = modelCalls;
    const review = turn.review(input(eventId));
    const rejected = assert.rejects(review, phase(pendingPhase));
    await entered.promise; fire(60000); await rejected;
    assert.equal(durableStorageOwnerState(directory(eventId)), "inactive", "timed-out review actually releases its SQLite writer lease");
    hook = () => {};
    assert.deepEqual(await turn.review(input(eventId)), answer);
    assert.equal(modelCalls, before + 1, "reopening observes the original native answer without another generation or JSON repair");
    const storage = await openDurablePassiveStorage(directory(eventId), context); assert(storage);
    try {
      const submissions = await storage.scanSubmissions({}, 100, undefined, context);
      assert.equal(submissions.items.length, 1, "one admitted native review, no repair submission");
      assert.equal(submissions.items[0].requestId, eventId);
    } finally { await storage.close(context); }
    late.resolve(); await drain();
  }

  // Production better-sqlite3 failure before native handle release, plus the
  // existing Session retry from #35. A failed close retains actual ownership.
  const closeEntered = deferred<void>();
  let native: Database.Database | undefined;
  let failures = 0;
  const nativeClose = Database.prototype.close;
  let restoreNativeClose = () => {};
  hook = () => {
    const closeMock = mock.method(Database.prototype, "close", function(this: Database.Database) {
      if (this.name.includes(directory("native-close-failure")) && !this.name.includes("writer-lock") && failures++ === 0) {
        native = this; closeEntered.resolve(); throw Error("fixture native close before release");
      }
      return nativeClose.call(this);
    });
    restoreNativeClose = () => closeMock.mock.restore();
  };
  const beforeClose = modelCalls;
  const closeFailure = assert.rejects(turn.review(input("native-close-failure")), phase("closing"));
  await closeEntered.promise; await closeFailure;
  assert.equal(native?.open, true, "failure did not release the native handle");
  assert.equal(durableStorageOwnerState(directory("native-close-failure")), "active");
  hook = () => {};
  assert.deepEqual(await turn.review(input("native-close-failure")), answer);
  assert.equal(native?.open, false, "retry reaches and actually releases the original native handle");
  assert.equal(durableStorageOwnerState(directory("native-close-failure")), "inactive");
  assert.equal(modelCalls, beforeClose + 1, "close recovery reuses the retained answer");
  restoreNativeClose();

  const beforeFailedOpen = modelCalls;
  const openHarness = Harness.open;
  let openingFailures = 0, openingCloseAttempts = 0;
  let unfinishedOpenHandle: Database.Database | undefined;
  let restoreOpenClose = () => {};
  const rootMock = mock.method(Harness, "open", async (...args: Parameters<typeof Harness.open>) => {
    const harness = await openHarness(...args);
    if (openingFailures++ === 0) mock.method(harness, "root", async () => {
      const closeMock = mock.method(Database.prototype, "close", function(this: Database.Database) {
        if (this.name.includes(directory("open-cleanup-failure")) && !this.name.includes("writer-lock")) {
          unfinishedOpenHandle = this;
          if (++openingCloseAttempts === 1) throw Error("fixture cleanup failed while opening");
        }
        return nativeClose.call(this);
      });
      restoreOpenClose = () => closeMock.mock.restore();
      throw Error("fixture native root observation failed");
    });
    return harness;
  });
  await assert.rejects(turn.review(input("open-cleanup-failure")), phase("opening"));
  assert.equal(openingCloseAttempts, 2, "opening failure hands its exact unfinished resource cleanup to the lane");
  assert.equal(unfinishedOpenHandle?.open, false);
  assert.equal(durableStorageOwnerState(directory("open-cleanup-failure")), "inactive");
  assert.equal(modelCalls, beforeFailedOpen, "failed opening did not submit another model request");
  rootMock.mock.restore(); restoreOpenClose();

  // A close that never settles does not claim release or retain a lane slot.
  const closeGate = deferred<void>(), closing = deferred<void>();
  hook = runtime => {
    const close = runtime.harness.close.bind(runtime.harness);
    mock.method(runtime.harness, "close", async (...args: Parameters<typeof close>) => {
      closing.resolve(); await closeGate.promise; return close(...args);
    });
  };
  const stuck = turn.review(input("stuck-close"));
  const stuckFailure = assert.rejects(stuck, phase("closing"));
  await closing.promise; fire(5000); await stuckFailure;
  assert.equal(durableStorageOwnerState(directory("stuck-close")), "active");
  const beforeDuplicate = opened;
  const duplicate = assert.rejects(turn.review(input("stuck-close")), phase("closing"));
  await drain(); fire(5000); await duplicate;
  assert.equal(opened, beforeDuplicate, "same directory cannot reopen while cleanup still owns it");
  hook = () => {};
  assert.deepEqual(await turn.review(input("independent-during-close")), answer, "another Work can proceed during retained cleanup");
  closeGate.resolve(); await drain();
  await turn.close();
  assert.equal(durableStorageOwnerState(directory("stuck-close")), "inactive");

  // Opening can finish after its deadline; cleanup retains and releases that
  // late runtime, while its provider guard has already been revoked.
  turn = openTurn();
  const openGate = deferred<void>(), opening = deferred<void>();
  let guard: DurableBotOptions["providerAuthorityGuarded"];
  hook = async (_runtime, options) => { guard = options.providerAuthorityGuarded; opening.resolve(); await openGate.promise; };
  const lateOpen = turn.review(input("late-open"));
  const lateFailure = assert.rejects(lateOpen, phase("closing"));
  await opening.promise; fire(60000); await drain(); fire(5000); await lateFailure;
  assert.equal(guard?.(), false, "late opening cannot begin another provider request");
  assert.equal(durableStorageOwnerState(directory("late-open")), "active");
  hook = () => {}; openGate.resolve(); await drain(); await turn.close();
  assert.equal(durableStorageOwnerState(directory("late-open")), "inactive");

  for (const revoked of ["authority", "close"] as const) {
    turn = openTurn();
    const idle = deferred<void>(), late = deferred<void>();
    hook = runtime => { mock.method(runtime.conversation, "waitForIdle", () => { idle.resolve(); return late.promise; }); };
    const review = turn.review(input(`revoked-${revoked}`));
    const rejection = assert.rejects(review, phase("idle"));
    await idle.promise;
    if (revoked === "authority") authority = false;
    else await turn.close();
    await rejection;
    assert.equal(durableStorageOwnerState(directory(`revoked-${revoked}`)), "inactive");
    authority = true; late.resolve(); await drain(); await turn.close();
  }
  console.log("PASS #39 fake deadline + real native SQLite: reply/idle/open/close bounds, retained cleanup/lease, late authority guard, same native identity/body, no extra model generation or format repair");
} catch (error) {
  console.error("work-result-lifecycle fixture failure", error);
  throw error;
} finally {
  authority = true; hook = () => {};
  await turn.close().catch(() => {});
  mock.restoreAll();
  for (const timer of deadlines) clearTimeout(timer.handle);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
