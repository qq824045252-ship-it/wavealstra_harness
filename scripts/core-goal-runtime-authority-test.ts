import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { MemoryStorage, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { DurableBotRuntime, type DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";

const root = await mkdtemp(join(tmpdir(), "mybuddy-goal-authority-"));
const taskId = "fixture-task";
const marker = { taskId, workId: "fixture-work", intentRevision: 2, ownerEpoch: 3, attempt: 1, attemptSerial: 7,
  claimOperationId: "fixture-claim", hostGeneration: "original-host", storeId: "fixture-store" };
const requestId = "goal-continuation:fixture-work:2:7";
const model = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", reasoning: false, input: ["text"],
  contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<"openai-completions">;
const ref = { provider: model.provider, modelId: model.id };
const text = (value: string) => [{ type: "text" as const, text: value }];
const metadata = { text: "Goal nudge", displayText: "Goal nudge", attachments: [], goalContinuation: marker };

function fixture(name: string, mode: "valid" | "stale-payload" | "stale-tool" | "resume-tool") {
  const backend = new MemoryStorage();
  const storage = new Proxy(backend, { get(target, key, receiver) {
    if (key === "close") return async () => {};
    const member = Reflect.get(target, key, receiver);
    return typeof member === "function" ? member.bind(target) : member;
  } });
  let allowed = true;
  let sends = 0;
  let toolChecks = 0;
  let initialToolCalls = 0;
  const file = join(root, `${name}.txt`);
  const effect = defineTool({ name: "fixture_effect", description: "write fixture marker", parameters: Type.Object({}), replay: "safe",
    execute: async (_args, _api, context) => {
      if (mode === "resume-tool" && initialToolCalls++ === 0) await new Promise<never>((_resolve, reject) => {
        const signal = context.abortSignal!;
        signal.throwIfAborted();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      await writeFile(file, "effect committed");
      return { output: text("fixture effect committed") };
    } });
  const models = { getModel: () => model, getAuth: async () => undefined,
    streamSimple: (_model: Model<"openai-completions">, _input: unknown, options: Parameters<Models["streamSimple"]>[2]) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        let message: AssistantMessage = { role: "assistant", content: [], stopReason: "stop", api: model.api, model: model.id, provider: model.provider,
          timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        try {
          if (mode === "stale-payload") allowed = false;
          await options?.onPayload?.({}, model);
          sends++;
          if (mode === "stale-tool") allowed = false;
          if (sends === 1) {
            message = { ...message, stopReason: "toolUse", content: [{ type: "toolCall", id: "effect", name: effect.name, arguments: {} }] };
            stream.push({ type: "done", reason: "toolUse", message });
          } else {
            message = { ...message, content: text("fixture done") };
            stream.push({ type: "done", reason: "stop", message });
          }
        } catch (error) {
          stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted", errorMessage: String(error) } });
        }
        stream.end();
      })();
      return stream;
    } } as unknown as Models;
  const options: DurableBotOptions = { directory: join(root, name), cwd: root, taskId, storage, models, model: ref, toolMode: "native",
    tools: [effect], instructions: () => "Goal fixture", onSnapshot: () => {},
    beforeToolExecution: () => { toolChecks++; },
    verifyGoalContinuation: async origin => {
      const { conversationId, runTaskId, ...scope } = origin;
      assert(conversationId > 0 && runTaskId > 0);
      assert.deepEqual(scope, { taskId, workId: marker.workId, intentRevision: 2, ownerEpoch: 3, attemptSerial: 7,
        claimOperationId: marker.claimOperationId, hostGeneration: marker.hostGeneration, storeId: marker.storeId });
      if (!allowed) throw new Error("fixture claim fenced");
    } };
  return { open: () => DurableBotRuntime.open(options), file, sends: () => sends, toolChecks: () => toolChecks,
    started: () => initialToolCalls, fence: () => { allowed = false; },
    toolStates: async () => (await storage.scanTasks({}, 100, undefined, ctx)).items.filter(task => task.kind.includes("tool")).map(task => task.state) };
}

try {
  for (const mode of ["valid", "stale-payload", "stale-tool"] as const) {
    const gate = fixture(mode, mode);
    const runtime = await gate.open();
    try {
      runtime.resume();
      const submission = await runtime.submit("Goal nudge", requestId, "reject", metadata);
      const result = await submission.wait({ ...ctx, abortSignal: AbortSignal.timeout(10_000) });
      if (mode === "valid") {
        assert.equal(result.status, "done");
        assert.equal(await readFile(gate.file, "utf8"), "effect committed");
        assert.equal(gate.sends(), 2);
      } else {
        assert.equal(result.status, "unanswered");
        await assert.rejects(readFile(gate.file), { code: "ENOENT" });
        assert.equal(gate.sends(), mode === "stale-payload" ? 0 : 1);
        if (mode === "stale-tool") assert.equal(gate.toolChecks(), 1);
      }
    } finally { await runtime.close(); }
  }

  const gate = fixture("restart", "resume-tool");
  let runtime = await gate.open();
  try {
    runtime.resume();
    const submission = await runtime.submit("Goal nudge", requestId, "reject", metadata);
    for (let tick = 0; gate.started() === 0 && tick < 250; tick++) await setTimeout(10);
    assert.equal(gate.started(), 1, "the safe tool's first invocation entered before the interruption");
    await runtime.close();
    const before = await gate.toolStates();
    assert.equal(before[0]?.status, "pending", "close preserved the safe native tool's checkpoint");
    gate.fence();
    runtime = await gate.open();
    const restored = await runtime.harness.submission(submission.id, ctx);
    runtime.resume();
    assert.equal((await restored?.wait({ ...ctx, abortSignal: AbortSignal.timeout(10_000) }))?.status, "unanswered");
    assert.equal(gate.started(), 1, "Pi recovery did not run the stale tool's effect again");
    await runtime.refresh();
    assert.equal(gate.toolChecks(), 2, "the resumed safe tool reached the final claim gate");
    assert(runtime.snapshot.messages.some(message => message.tools?.some(tool => tool.output?.includes("fixture claim fenced"))));
    await assert.rejects(readFile(gate.file), { code: "ENOENT" });
    const foreground = await runtime.submit("foreground after restart", "ordinary-request", "reject");
    assert.equal((await foreground.wait({ ...ctx, abortSignal: AbortSignal.timeout(10_000) })).status, "done");
  } finally { await runtime.close(); }
} finally { await rm(root, { recursive: true, force: true }); }

console.log("PASS persisted Goal marker gates the real Pi provider, native tool and resumed safe tool while foreground input still runs");
