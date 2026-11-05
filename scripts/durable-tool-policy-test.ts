import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AssistantMessage, TextContent, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { defineTool, type ToolRegistration, type JsonObject } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { PermissionMode } from "../src/shared/agent-ipc";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { ConversationGoalRepository } from "../src/main/agent/ConversationGoalRepository";
import { ConversationGoalService } from "../src/main/agent/ConversationGoalService";
import { createConversationRuntimeExtension } from "../src/main/agent/conversation-runtime-extension";
import { ExecutionAttemptRepository } from "../src/main/agent/ExecutionAttemptRepository";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { TaskFileAccessPolicy } from "../src/main/security/TaskFileAccessPolicy";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { currentDurableExecutionContext } from "../src/main/agent/durable/DurableExecutionContext";
import { durableDomainTools } from "../src/main/agent/durable/DurableDomainTools";
import { createDurableToolPolicy } from "../src/main/agent/durable/DurableToolPolicy";
import { recoverInterruptedExecutions } from "../src/main/agent/ExecutionRestartRecovery";
import { prepareFileEffect, verifyFileEffect, type ExternalEffectRecovery } from "../src/main/agent/durable/DurableEffectRecovery";

const root = await mkdtemp(join(tmpdir(), "mybuddy-durable-policy-"));
const db = new AppDatabase(join(root, "app.db"));
const attempts = new ExecutionAttemptRepository(db.connection);
const failures = new ExecutionFailureRepository(db.connection);
const goals = new ConversationGoalService(new ConversationGoalRepository(db.connection), () => {});
let interactions = new ConversationInteractionService(new ConversationInteractionRepository(db.connection), () => {});
const call = (name: string, args: JsonObject): AssistantMessage["content"] => [{ type: "toolCall", id: `fixture-${name}`, name, arguments: args }];
const text = (value: string): TextContent[] => [{ type: "text", text: value }];

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Fixture did not reach the expected native execution state");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(taskId: string, respond: (request: TranscriptContext) => AssistantMessage["content"],
  mode: "native" | "codemode" = "native", extraTools: ToolRegistration[] = [], isolatedSourceRoots: string[] = [], effectRecovery?: ExternalEffectRecovery) {
  const cwd = join(root, taskId);
  await mkdir(cwd);
  db.upsertTask({ id: taskId, title: taskId, updatedAt: Date.now() });
  const models = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "catalog.json"), refreshOnCreate: false });
  models.registerProvider("fixture", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "model", name: "fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, request) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const content = respond(request);
        const stopReason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
        const message: AssistantMessage = { role: "assistant", content, stopReason, api: model.api,
          provider: model.provider, model: model.id, timestamp: Date.now(),
          usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "done", reason: stopReason, message }); stream.end();
      });
      return stream;
    },
  });
  const state = { permission: "auto" as PermissionMode, allowed: true, deniedTools: new Set<string>() };
  const open = async () => {
    const policy = createDurableToolPolicy({ taskId, taskRoot: cwd, getPermissionMode: () => state.permission,
      interactions, attempts, failures, getPolicy: () => new TaskFileAccessPolicy({ taskId, taskRoot: cwd, isolatedSourceRoots }),
      effectRecovery,
      toolAllowed: name => !state.deniedTools.has(name) && (state.allowed || !["write", "mcp__filesystem__write_file"].includes(name)),
    });
    const domain = await durableDomainTools([createConversationRuntimeExtension({ interaction: interactions, goal: goals,
      resolveContext: currentDurableExecutionContext,
      requestInteraction: (context, request, signal, toolCallId) => interactions.requestDurable(context, request, { key: toolCallId, signal }),
    })], { taskId, cwd, models });
    return DurableBotRuntime.open({ taskId, cwd, directory: join(cwd, "state"), models,
      model: { provider: "fixture", modelId: "model" }, toolMode: mode, tools: [...domain.tools, ...extraTools],
      contextHooks: domain.contextHooks, toolHooks: policy.hooks, instructions: () => "fixture", onSnapshot: () => {},
    });
  };
  return { taskId, cwd, state, open };
}

function attemptCount(taskId: string): number {
  const row = db.connection.prepare("SELECT count(*) AS n FROM execution_attempts WHERE task_id=?").get(taskId);
  assert(row && typeof row === "object" && "n" in row && typeof row.n === "number");
  return row.n;
}

try {
  const written = { path: "new/nested/proof.txt", content: "proof" };
  const writeIntent = await prepareFileEffect({ type: "toolCall", id: "write-proof", name: "write", arguments: written }, root);
  assert(writeIntent?.kind === "file");
  assert.equal((await verifyFileEffect(writeIntent)).status, "inconclusive");
  await createWriteTool(root).execute("write-proof", written);
  assert.equal((await verifyFileEffect(writeIntent)).status, "passed");
  assert.equal((await verifyFileEffect(writeIntent, AbortSignal.abort())).status, "inconclusive");
  await writeFile(join(root, written.path), "other");
  assert.equal((await verifyFileEffect(writeIntent)).status, "inconclusive", "a transport success cannot prove changed bytes");
  const edited = { path: "mixed.txt", edits: [{ oldText: "second\rthird", newText: "updated\nthird" }] };
  await writeFile(join(root, edited.path), "\uFEFFfirst\nsecond\rthird\r\nlast");
  const editIntent = await prepareFileEffect({ type: "toolCall", id: "edit-proof", name: "edit", arguments: edited }, root);
  assert(editIntent?.kind === "file");
  await createEditTool(root).execute("edit-proof", edited);
  assert.equal((await verifyFileEffect(editIntent)).status, "passed", "verification agrees with the installed native edit on BOM and mixed newlines");
  assert.equal((await verifyFileEffect({ ...writeIntent, path: root, canonicalPath: root })).status, "inconclusive", "directories cannot become an unbounded verification stream");
  console.log("PASS file recovery compares native output, rejects changed bytes and supports cancellation");

  let receiptReads = 0;
  let mutations = 0;
  const receiptRecovery: ExternalEffectRecovery = {
    prepare: async (_name, args, operationId) => ({ arguments: { ...args, operationId }, intent: {
      kind: "receipt", server: "filesystem", serverIdentity: "fixture", tool: "write_file", operationId,
      contract: { version: 1, idempotencyArgument: "operationId", receiptTool: "get_receipt", receiptArgument: "operationId",
        operationIdField: "operationId", statusField: "status", completedValues: ["completed"], failedValues: [] },
    } }),
    verify: async () => { receiptReads++; throw new Error("unauthorized receipt must not run"); },
  };
  const noReceipt = await fixture("receipt-not-authorized", request => request.messages.at(-1)?.role === "toolResult"
    ? text("wait for verification") : call("mcp_call_tool", { server: "filesystem", tool: "write_file", arguments: { path: "result.txt", content: "proof" } }), "native", [defineTool({
      name: "mcp_call_tool", description: "Receipt fixture", parameters: Type.Object({ server: Type.String(), tool: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }), replay: "unsafe",
      execute: async args => { mutations++; assert.equal(typeof args.arguments.operationId, "string"); return { output: text("accepted") }; },
    })], [], receiptRecovery);
  noReceipt.state.deniedTools.add("mcp__filesystem__get_receipt");
  const receiptRuntime = await noReceipt.open();
  try {
    await (await receiptRuntime.submit("write", "receipt-unavailable-input")).wait(ctx);
    assert.equal(mutations, 1); assert.equal(receiptReads, 0);
    assert(failures.list(noReceipt.taskId).some(item => item.causeCode === "effect-unverified" && !item.resolvedAt), "an unavailable verifier must not turn a transport success into verified completion");
  } finally { await receiptRuntime.close(); }

  const waiting = await fixture("waiting", request => {
    const last = request.messages.at(-1);
    if (last?.role === "toolResult" && last.toolName === "request_user_input") return call("write", { path: "answer.txt", content: "answered" });
    if (last?.role === "toolResult") return text("continued after saved answer");
    return call("request_user_input", { title: "Which measurement?", kind: "confirm" });
  });
  let runtime = await waiting.open();
  try {
    const submitted = await runtime.submit("ask", "stable-input");
    await waitUntil(() => interactions.listByTask(waiting.taskId).some(item => item.status === "pending"));
    const question = interactions.listByTask(waiting.taskId)[0]!;
    await runtime.close();
    assert.equal(interactions.listByTask(waiting.taskId)[0]?.status, "pending", "closing the host detaches observation and preserves the question");
    interactions = new ConversationInteractionService(new ConversationInteractionRepository(db.connection), () => {});
    runtime = await waiting.open();
    const resumed = await runtime.harness.submission(submitted.id, ctx);
    assert(resumed);
    const completed = resumed.wait(ctx);
    assert.equal(interactions.respond(question.id, true).ok, true);
    assert.equal((await completed).status, "done");
    assert.equal(await readFile(join(waiting.cwd, "answer.txt"), "utf8"), "answered");
    assert.equal(interactions.listByTask(waiting.taskId).length, 1, "native replay reuses the original question");
    const records = db.connection.prepare("SELECT record_json FROM execution_attempts WHERE task_id=?").all(waiting.taskId);
    assert.equal(records.length, 1, "one native write has one execution record");
    const duplicate = await runtime.submit("ask", "stable-input");
    assert.equal(duplicate.id, submitted.id);
    assert.equal((await duplicate.wait(ctx)).status, "done");
    assert.equal(attemptCount(waiting.taskId), 1);
  } finally { await runtime.close(); }
  console.log("PASS native question survives close/reopen, resumes the original input and records one completed write");

  const permission = await fixture("approval", request => request.messages.at(-1)?.role === "toolResult"
    ? text("done") : call("write", { path: "approved.txt", content: "approved" }));
  permission.state.permission = "default";
  runtime = await permission.open();
  try {
    const submitted = await runtime.submit("write", "approval-input");
    await waitUntil(() => interactions.listByTask(permission.taskId).some(item => item.status === "pending"));
    await assert.rejects(access(join(permission.cwd, "approved.txt")));
    const question = interactions.listByTask(permission.taskId)[0]!;
    await runtime.close();
    runtime = await permission.open();
    const resumed = await runtime.harness.submission(submitted.id, ctx); assert(resumed);
    const completed = resumed.wait(ctx);
    assert.equal(interactions.respond(question.id, true).ok, true);
    assert.equal((await completed).status, "done");
    assert.equal(await readFile(join(permission.cwd, "approved.txt"), "utf8"), "approved");
    assert.equal(interactions.listByTask(permission.taskId).length, 1);
  } finally { await runtime.close(); }
  console.log("PASS default permission waits for saved approval before native execution and survives reopen");

  for (const mode of ["native", "codemode"] as const) for (const restriction of ["readonly", "loadout"] as const) {
    const denied = await fixture(`${mode}-${restriction}`, request => request.messages.at(-1)?.role === "toolResult"
      ? text("blocked") : mode === "native" ? call("write", { path: "denied.txt", content: "forbidden" })
        : call("codemode", { code: 'await tools.write({path:"denied.txt",content:"forbidden"});' }), mode);
    denied.state.permission = restriction === "readonly" ? "readonly" : "auto";
    denied.state.allowed = restriction !== "loadout";
    runtime = await denied.open();
    try {
      const submitted = await runtime.submit("write", `denied-${mode}-${restriction}`);
      assert.equal((await submitted.wait(ctx)).status, "done");
      await assert.rejects(access(join(denied.cwd, "denied.txt")));
      assert.equal(interactions.listByTask(denied.taskId).length, 0);
      assert.equal(attemptCount(denied.taskId), 0, "blocked operations never start an execution attempt");
    } finally { await runtime.close(); }
  }
  console.log("PASS readonly and host tool policy apply to native writes and Code Mode nested writes");

  const protectedRoot = join(root, "source-repository");
  await mkdir(protectedRoot);
  for (const restriction of ["auto", "default", "readonly", "loadout"] as const) {
    let calls = 0;
    const wrapped = await fixture(`wrapped-${restriction}`, request => request.messages.at(-1)?.role === "toolResult"
      ? text("blocked") : call("mcp_call_tool", { server: "filesystem", tool: "write_file", arguments: { path: join(protectedRoot, "source.txt"), content: "forbidden" } }), "native", [defineTool({
        name: "mcp_call_tool", description: "MCP transport fixture", replay: "unsafe",
        parameters: Type.Object({ server: Type.String(), tool: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }),
        execute: async () => { calls++; return { output: text("wrote") }; },
      })], [protectedRoot]);
    wrapped.state.permission = restriction === "loadout" ? "auto" : restriction;
    wrapped.state.allowed = restriction !== "loadout";
    runtime = await wrapped.open();
    try {
      assert.equal((await (await runtime.submit("write", `wrapper-${restriction}`)).wait(ctx)).status, "done");
      assert.equal(calls, 0, "wrapped MCP writes obey actual tool authorization and isolated source paths");
      assert.equal(interactions.listByTask(wrapped.taskId).length, 0, "isolated source denial cannot be overridden by approval");
      assert.equal(attemptCount(wrapped.taskId), 0);
    } finally { await runtime.close(); }
  }
  console.log("PASS MCP wrapper enforces actual tool identity, readonly and non-overridable source isolation");

  let malformedCalls = 0;
  const malformed = await fixture("malformed-wrapper", request => request.messages.at(-1)?.role === "toolResult"
    ? text("correct invalid arguments") : call("mcp_call_tool", { server: "filesystem" }), "native", [defineTool({
      name: "mcp_call_tool", description: "MCP transport fixture", replay: "unsafe",
      parameters: Type.Object({ server: Type.String(), tool: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }),
      execute: async () => { malformedCalls++; return { output: text("unreachable") }; },
    })]);
  runtime = await malformed.open();
  try {
    assert.equal((await (await runtime.submit("invalid call", "malformed-input")).wait(ctx)).status, "done");
    assert.equal(malformedCalls, 0, "invalid MCP arguments finish as a normal tool error without execution or recovery loop");
  } finally { await runtime.close(); }
  console.log("PASS malformed MCP wrapper returns a tool validation error without restarting execution");

  let effects = 0;
  const effectFile = join(root, "unconfirmed-effect.txt");
  const interrupted = await fixture("interrupted", request => request.messages.at(-1)?.role === "toolResult"
    ? text("inspect the unconfirmed effect") : call("terminal_exec", { action: "execute" }), "native", [defineTool({
      name: "terminal_exec", description: "Fixture external side effect", parameters: Type.Object({ action: Type.String() }), replay: "unsafe",
      execute: async (_args, _api, context) => {
        await writeFile(effectFile, String(++effects));
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error("fixture host closed after side effect"));
          context.abortSignal.addEventListener("abort", abort, { once: true });
          if (context.abortSignal.aborted) abort();
        });
        return { output: text("unreachable") };
      },
    })]);
  runtime = await interrupted.open();
  try {
    const submitted = await runtime.submit("execute", "interrupted-input");
    await waitUntil(() => effects === 1);
    await runtime.close();
    recoverInterruptedExecutions(attempts, failures);
    runtime = await interrupted.open();
    const resumed = await runtime.harness.submission(submitted.id, ctx); assert(resumed);
    assert.equal((await resumed.wait(ctx)).status, "done");
    assert.equal(effects, 1, "an unconfirmed side effect must never replay");
    assert.equal(await readFile(effectFile, "utf8"), "1");
    assert.equal(attemptCount(interrupted.taskId), 1);
    const unresolved = failures.list(interrupted.taskId).filter(item => !item.resolvedAt);
    assert.equal(unresolved.length, 1, "restart projection and native recovery share one failure identity");
    assert.equal(unresolved[0]?.sideEffects, "unknown");
    assert.equal(unresolved[0]?.recovery, "requires-user-action");
  } finally { await runtime.close(); }
  console.log("PASS unsafe side effect retains one unknown-outcome record and never replays after reopen");

  const stopped = await fixture("stopped", request => request.messages.at(-1)?.role === "toolResult"
    ? text("stopped") : call("request_user_input", { title: "Stop this question", kind: "confirm" }));
  runtime = await stopped.open();
  try {
    await runtime.submit("ask", "stop-input");
    await waitUntil(() => interactions.listByTask(stopped.taskId).some(item => item.status === "pending"));
    await runtime.abort();
    assert.equal(interactions.listByTask(stopped.taskId)[0]?.status, "cancelled", "explicit Stop settles the question");
  } finally { await runtime.close(); }
  console.log("PASS explicit Stop cancels persistent interaction");
} finally { db.close(); }
