/**
 * Deleting a user message must stay bounded while subagents are still running.
 *
 * The report behind this test: with nine children dispatched in parallel, choosing "删除这条消息"
 * left the dialog on "删除中" — no completion, no error. Deleting forks the visible branch from an
 * entry before the chosen message, and the fork refuses while the source conversation is live. A
 * stop issued from the renderer reaches the root turn only; the children are separate conversations
 * that keep the graph live. `abort()` uses a background abort, which resolves once every reached
 * task is terminal — and the service's context carries no abort signal to cut that wait, so a child
 * that never settles owns the caller's admission forever.
 *
 * The contract asserted here has two halves:
 *   1. a stop issued through the service also cancels this task's live children;
 *   2. when the native stop cannot settle, the bounded stop gives the admission back so the delete
 *      and later input fail loudly instead of hanging.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "durable-delete-stop-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
const agentDir = join(root, ".mybuddy");
mkdirSync(agentDir, { recursive: true });

const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { DurableBotRuntime } = await import("../src/main/agent/durable/DurableBotRuntime");
const { DurableBotService } = await import("../src/main/agent/durable/DurableBotService");
const { DurableUserEntryNotFoundError } = await import("../src/main/agent/durable/DurableConversationBranch");
type DurableBotRuntimeType = Awaited<ReturnType<typeof DurableBotRuntime.open>>;
type DurableBotOptions = Parameters<typeof DurableBotRuntime.open>[0];

const db = new AppDatabase(join(root, "app.db"));
const cwd = join(root, "workspace");
mkdirSync(cwd, { recursive: true });
db.upsertTask({ id: "busy", title: "busy", cwd, updatedAt: 1, modelId: "fixture/fixture" });
db.upsertTask({ id: "idle", title: "idle", cwd, updatedAt: 1, modelId: "fixture/fixture" });

/** Every runtime the service opened, so the test can tell what the stop actually reached. */
const opened: Array<{ taskId: string; aborts: number; closed: boolean; hang: boolean }> = [];
const hung: Array<() => void> = [];
let hangAbort = false;

const realOpen = DurableBotRuntime.open.bind(DurableBotRuntime);
DurableBotRuntime.open = (async (options: DurableBotOptions) => {
  if (options.readOnly) return realOpen(options);
  const taskId = String(options.taskId);
  const state = { taskId, aborts: 0, closed: false, hang: hangAbort };
  opened.push(state);
  const runtime = {
    snapshot: { busy: false, queued: 0, messages: [] },
    isSessionFailed: () => false,
    onSessionFailed: () => {},
    canRebindWorkspace: async () => true,
    close: async () => { state.closed = true; },
    compact: async () => ({ kind: "skipped" }),
    harness: { commit: async () => true },
    refresh: async () => runtime.snapshot,
    conversation: {
      id: "fixture-conversation",
      /**
       * A stop that a child never answers: the promise stays pending, which is exactly the state
       * the production background abort reaches when a subagent stops responding.
       */
      abort: async () => {
        state.aborts++;
        if (state.hang) await new Promise<void>(resolve => hung.push(resolve));
      },
      entries: async () => ({ items: [], next: undefined }),
      fork: async () => { throw new Error("任务仍在运行，请先停止生成"); },
    },
    forkAt: async () => { throw new Error("任务仍在运行，请先停止生成"); },
    submit: async () => { throw new Error("not used"); },
    abort: async () => {
      state.aborts++;
      if (state.hang) await new Promise<void>(resolve => hung.push(resolve));
    },
  };
  return runtime as unknown as DurableBotRuntimeType;
}) as typeof DurableBotRuntime.open;

const service = new DurableBotService({
  db, models: { getModel: () => ({ provider: "fixture", id: "fixture" }) } as never,
  agentDir, mcpDir: join(agentDir, "mcp"),
  resolveCwd: () => cwd, instructions: () => "fixture", toolMode: () => "native",
  defaultModel: () => "fixture/fixture", emit: () => {},
  tools: async () => ({ tools: [], contextHooks: [] }),
} as never);

/** Resolve with the deadline, so a hang shows up as a failed expectation instead of a stuck run. */
function within<T>(label: string, promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([promise, new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), ms))]);
}

try {
  // ---- a stop reaches the runtime even when nothing is running ------------------------------
  // `abort` guards on the durable binding, so the task has to be open first; that is the state the
  // product is in whenever the user can see a delete button.
  await (service as unknown as { open(taskId: string): Promise<unknown> }).open("idle");
  await service.abort("idle");
  assert.equal(opened.filter(entry => entry.taskId === "idle" && entry.aborts > 0).length, 1,
    "a stop must reach the task's native runtime");

  // ---- a stop that cannot settle gives the caller back instead of holding it ----------------
  hangAbort = true;
  opened.length = 0;
  await (service as unknown as { open(taskId: string): Promise<unknown> }).open("busy");
  opened.length = 0;
  const started = Date.now();
  const stop = await within("abort", service.abort("busy"), 20_000);
  assert.notEqual(stop, "timeout", "a stop whose children never settle must not own the caller forever");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 9_000, `the bounded stop must wait for its budget before giving up (waited ${elapsed}ms)`);

  // ---- the admission is free again: a later delete fails on its own terms, not by hanging ----
  let phase = "start";
  const originalTrack = (service as unknown as {
    trackAdmission<T>(taskId: string, operation: () => Promise<T>, mark?: (stage: string) => void, register?: (self: Promise<T>) => void): Promise<T>;
  }).trackAdmission.bind(service);
  (service as unknown as Record<string, unknown>).trackAdmission = function <T>(
    this: unknown, taskId: string, operation: () => Promise<T>, mark?: (stage: string) => void, register?: (self: Promise<T>) => void,
  ): Promise<T> {
    return originalTrack(taskId, operation, stage => { phase = String(stage); mark?.(stage); }, register);
  };
  const stopWithin = (service as unknown as {
    stopWithinAdmission(taskId: string, exclude?: Promise<unknown>): Promise<void>;
  }).stopWithinAdmission.bind(service);
  const probed = await within("direct", Promise.resolve().then(() => stopWithin("busy")), 15_000);
  assert.notEqual(probed, "timeout", "stopWithinAdmission must settle on its own");

  // `within` races the promise; capture rejection as a value so the failure is asserted, not thrown.
  const deleteStarted = Date.now();
  const deletion = await within("delete", Promise.resolve().then(() => service.deleteUserMessage({ taskId: "busy", userMessageIndex: 0 })).catch((error: unknown) => error), 25_000);
  const deleteElapsed = Date.now() - deleteStarted;
  assert.notEqual(deletion, "timeout",
    `the delete must return once the stop budget is spent (still pending after ${deleteElapsed}ms, last stage ${phase})`);
  // Nothing recorded at index 0 in this fixture, so the delete is expected to fail on its own terms.
  assert.ok(deletion instanceof Error, `the delete must report a reason, got ${String(deletion)}`);
  assert.match(deletion.message, /找不到|运行|停止/, "the delete must surface why it did not proceed");
  assert.ok(deleteElapsed < 15_000, `the delete must fail inside a single stop budget, took ${deleteElapsed}ms`);

  // ---- repeating the delete must not hang either -------------------------------------------
  // The branch is still live, so the fork keeps refusing; the point is that the second attempt
  // returns the same reason instead of queueing behind the first one forever.
  const repeated = await within("repeat",
    Promise.resolve().then(() => service.deleteUserMessage({ taskId: "busy", userMessageIndex: 0 })).catch((error: unknown) => error),
    25_000);
  assert.notEqual(repeated, "timeout", "repeating the delete must not hang either");
  assert.ok(repeated instanceof Error, "a delete against a live branch must reject with a reason");
  assert.match(repeated.message, /运行|停止|找不到/, "the reason must reach the user");
} finally {
  for (const release of hung) release();
  db.close?.();
}

console.log("PASS a stop reaches the native runtime and a child that never settles cannot pin the caller");
console.log("PASS a delete against a live branch rejects with a reason instead of hanging");
void DurableUserEntryNotFoundError;

