import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { MemoryStorage, SessionFailed, StorageRequestError, type Storage } from "@earendil-works/pi-durable";
import { DurableBotRuntime, type DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";

const root = await mkdtemp(join(tmpdir(), "mybuddy-durable-session-recovery-"));
console.log("Isolated recovery test directory:", root);

const model: any = {
  id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", reasoning: false,
  input: ["text"], contextWindow: 128000, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const ref = { provider: model.provider, modelId: model.id };

/** Provider fixture: one text answer per request, in order. */
function models(replies: string[]): any {
  let index = 0;
  const api: any = {
    getAuth: async () => undefined,
    getModel: () => model,
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      const text = replies[Math.min(index++, replies.length - 1)] ?? "complete";
      void Promise.resolve().then(() => {
        const message: any = {
          role: "assistant", content: [{ type: "text", text }], stopReason: "stop",
          api: model.api, model: model.id, provider: model.provider, timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    },
  };
  api.completeSimple = (m: any, c: any, o: any) => api.streamSimple(m, c, o).result();
  return api;
}

/**
 * Delegating Storage that can fail one method exactly once. Its close() is a no-op so the
 * underlying MemoryStorage stays open for the reopened Harness, exactly as a new JSONL
 * handle would observe the same committed directory.
 */
function injectable(inner: MemoryStorage): { storage: Storage; arm: (method: string, error: Error) => void } {
  let armed: { method: string; error: Error } | undefined;
  const storage = new Proxy(inner, {
    get(target, property) {
      if (property === "close") return async () => {};
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const bound = value.bind(target);
      return (...args: unknown[]) => {
        if (armed && armed.method === property) {
          const error = armed.error;
          armed = undefined;
          return Promise.reject(error);
        }
        return bound(...args);
      };
    },
  }) as unknown as Storage;
  return { storage, arm: (method, error) => { armed = { method, error }; } };
}

function options(directory: string, cwd: string, storage: Storage, replies: string[]): DurableBotOptions {
  return {
    directory, cwd, model: ref, toolMode: "native", instructions: () => "recovery fixture",
    onSnapshot: () => {}, storage, models: models(replies),
  };
}

// 1) A fatal Storage error fails the Session, is recognizable, and blocks later calls.
const fatal = new MemoryStorage();
const fatalInject = injectable(fatal);
const fatalCwd = join(root, "fatal");
await mkdir(fatalCwd, { recursive: true });
const directory = join(fatalCwd, "state");
const runtime = await DurableBotRuntime.open(options(directory, fatalCwd, fatalInject.storage, ["first reply", "second reply"]));
const first = await runtime.submit("first", "recovery-first");
assert.equal((await first.wait(ctx)).status, "done", "the first turn commits before failure injection");
const before = await runtime.refresh();
assert(before.messages.some(message => message.role === "assistant" && message.text === "first reply"), "first reply is projected");

fatalInject.arm("commit", new Error("injected storage commit failure"));
await assert.rejects(
  () => runtime.submit("second", "recovery-second"),
  (error: unknown) => {
    assert(error instanceof SessionFailed, `expected SessionFailed, got ${String(error)}`);
    assert(String((error as Error & { cause?: unknown }).cause).includes("injected storage commit failure"), "the original cause is preserved");
    return true;
  },
);
assert.equal(runtime.isSessionFailed(), true, "runtime reports the failed Session");
assert.equal((runtime.sessionFailure() as Error).message, "injected storage commit failure", "the failure cause is queryable");
await assert.rejects(() => runtime.refresh(), (error: unknown) => error instanceof SessionFailed, "later calls reject with SessionFailed");
await runtime.close();
await runtime.close(); // idempotent close, lease/MCP release path runs once

// 2) A fresh Harness over the same committed store recovers history without replaying the failed input.
const reopenInject = injectable(fatal);
const reopened = await DurableBotRuntime.open(options(directory, fatalCwd, reopenInject.storage, ["recovered reply"]));
const recovered = await reopened.refresh();
assert(recovered.messages.some(message => message.role === "assistant" && message.text === "first reply"), "committed history survives reopen");
assert(!recovered.messages.some(message => message.text.includes("second")), "the failed commit left no partial turn");
assert(!recovered.pendingInputs.some(input => input.text === "second"), "the failed input was never admitted");
const third = await reopened.submit("third", "recovery-third");
assert.equal((await third.wait(ctx)).status, "done", "the reopened runtime executes new work");
const after = await reopened.refresh();
assert(after.messages.some(message => message.role === "assistant" && message.text === "recovered reply"), "new work is projected after recovery");
await reopened.close();

// 3) StorageRequestError fails only that read and must never fail or reopen the Session.
const bestEffort = new MemoryStorage();
const bestEffortInject = injectable(bestEffort);
const bestEffortCwd = join(root, "best-effort");
await mkdir(bestEffortCwd, { recursive: true });
const healthy = await DurableBotRuntime.open(options(join(bestEffortCwd, "state"), bestEffortCwd, bestEffortInject.storage, ["healthy reply"]));
bestEffortInject.arm("scanEntries", new StorageRequestError("injected invalid request"));
await assert.rejects(
  () => healthy.conversation.entries({}, 10, undefined, ctx),
  (error: unknown) => error instanceof StorageRequestError,
  "StorageRequestError surfaces unchanged",
);
assert.equal(healthy.isSessionFailed(), false, "StorageRequestError must not fail the Session");
const stillHealthy = await healthy.refresh();
assert(Array.isArray(stillHealthy.messages), "the same runtime remains usable after a StorageRequestError");
const alive = await healthy.submit("alive", "recovery-alive");
assert.equal((await alive.wait(ctx)).status, "done", "the same runtime still executes work");
await healthy.close();

console.log("durable session recovery test passed");
