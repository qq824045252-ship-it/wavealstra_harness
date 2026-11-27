import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineTool, type JsonObject } from "@earendil-works/pi-durable";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { exampleHook, type HookDraft, type NativeHookReceipt } from "../src/shared/native-hooks";
import { NativeHookStore } from "../src/main/agent/hooks/NativeHookStore";
import { ReadRecoveryHints, type ReadHintMutation } from "../src/main/agent/hooks/ReadRecoveryHints";
import { setDefaultPiStorageClient } from "../src/main/agent/durable/DurableStorage";
import { shutdownCoreWorker } from "../src/main/platform/core-client";
import { RuntimeAuditReader, locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import { DurableBotRuntime, type DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";
import { improvementOracleDecision, improvementOwnsConversation } from "../src/main/agent/durable/DurableImprovementRuntime";
import { sourceDiagnostics, sourceGeneration } from "../src/main/agent/hooks/ImprovementSourceContext";
import Database from "better-sqlite3";
import { GenerationTask } from "@earendil-works/pi-durable";
import { createDurableSubagentTools } from "../src/main/agent/durable/DurableSubagents";

const executable = process.env.RUNTIME_AUDIT_BINARY ?? locateRuntimeAudit(process.cwd());
assert(executable && existsSync(executable), "The real supervised Rust worker is required");
const root = mkdtempSync(join(tmpdir(), "mybuddy-native-hooks-"));
const agentDir = join(root, ".mybuddy");
process.env.HOME = process.env.USERPROFILE = root;
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "plugins", "mcp"), { recursive: true });
const database = join(agentDir, "app.duckdb");
const connect = () => new RuntimeAuditReader(executable, database, { coreDataDirectory: agentDir });
const core = connect();
const otherCore = new RuntimeAuditReader(executable, database, { coreDataDirectory: agentDir, coreRole: "background-service" });
setDefaultPiStorageClient(core);
const taskId = "hook-task";
type Reply = (input: TranscriptContext) => AssistantMessage["content"];
const text = (text: string): AssistantMessage["content"] => [{ type: "text", text }];
let sequence = 0;
const call = (name: string, args: JsonObject): AssistantMessage["content"] => [
  { type: "toolCall", id: "call-" + ++sequence, name, arguments: args },
];
let reply: Reply = () => text("[]");
const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
  modelsStorePath: join(root, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
models.registerProvider("fixture", {
  api: "openai-completions", apiKey: "offline-fixture", baseUrl: "http://127.0.0.1:1",
  models: [{ id: "model", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128_000,
    maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  streamSimple(model, input) {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const content = reply(input);
      const stopReason = content.some(part => part.type === "toolCall") ? "toolUse" : "stop";
      stream.push({ type: "done", reason: stopReason, message: {
        role: "assistant", content, stopReason, provider: model.provider, model: model.id, api: model.api,
        timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
          totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } });
      stream.end();
    });
    return stream;
  },
});
await models.refresh({ allowNetwork: false });
const store = new NativeHookStore(core);
const otherStore = new NativeHookStore(otherCore);
const options: DurableBotOptions = { models, model: { provider: "fixture", modelId: "model" },
  taskId, directory: join(root, "root"), cwd: root, toolMode: "native", instructions: () => "hook fixture", onSnapshot: () => {},
  nativeHooks: { store, scope: () => ({ taskId }) } };
const rule = (event: HookDraft["event"], script: string, expected: string | true, tool = ""): HookDraft => ({
  title: event, event, actor: "all", tool, scope: { kind: "task", id: taskId }, script, cases: [{ input: {}, expected }],
});
const done = async (runtime: DurableBotRuntime, input: string, expected = "done") => {
  const receipt = await runtime.submit(input, "submission-" + ++sequence);
  const settled = await receipt.wait(ctx);
  await runtime.conversation.waitForIdle(ctx);
  assert.equal(settled.status, expected, JSON.stringify(settled));
  return settled.status;
};
try {
  const draft = exampleHook();
  const first = await store.publish(draft);
  await assert.rejects(store.publish({ ...draft, script: "return true;" }, first), /用例 1/);
  await assert.rejects(store.publish({ ...draft, script: "return process.cwd();" }, first), /process/);
  assert.equal((await store.list())[0].revision, 1);
  const concurrent = await Promise.allSettled([store.publish({ ...draft, title: "new" }, first), otherStore.publish({ ...draft, title: "other" }, first)]);
  assert.equal(concurrent.filter(r => r.status === "fulfilled").length, 1);
  const second = (await store.list())[0];
  assert.deepEqual([second.generation, second.versions], [2, [2, 1]]);
  const restored = await store.activate(first.id, second.generation, 1, true);
  assert.equal(restored.hash, first.hash);
  await assert.rejects(store.activate(first.id, second.generation, 2, false), /已变化/);

  const pre = await store.publish(rule("beforeRequest", 'return "include project code";', "include project code"));
  const requests: TranscriptContext[] = [];
  reply = input => { requests.push(input); return text("ordinary answer"); };
  const requestRuntime = await DurableBotRuntime.open({ ...options, directory: join(root, "request") });
  try {
    assert.equal(await done(requestRuntime, "request with hook"), "done");
    assert(requests.some(r => JSON.stringify(r.messages.at(-1)).includes("include project code")));
    assert.equal((await store.receipts(pre.id))[0].taskId, taskId);
  } finally { await requestRuntime.close(); }
  await store.activate(pre.id, pre.generation, pre.revision, false);

  // Try an empty write, correct the argument, then try to finish before reading the actual output.
  const message = "请读取 report.md，确认内容后交付。";
  const finish = await store.publish(rule("beforeFinish",
    `return event.userText === "prepare report" && event.recentTools.some(t => t.tool === "read" && t.path === "report.md" && !t.isError && t.text.includes("正文")) ? true : ${JSON.stringify(message)};`, message));
  const post = await store.publish(rule("afterTool", 'return "read receipt";', "read receipt", "read"));
  const unrelated = await store.publish({ ...first.draft, scope: { kind: "project", id: "other" } });
  let step = 0;
  const seen: string[] = [];
  reply = input => {
    seen.push(JSON.stringify(input.messages.at(-1)));
    switch (++step) {
      case 1: return call("write", { path: "blocked.md", content: "" });
      case 2: return call("write", { path: "report.md", content: "正文" });
      case 3: return text("premature");
      case 4: return call("read", { path: "report.md" });
      default: return text("verified");
    }
  };
  const runtime = await DurableBotRuntime.open(options);
  try {
    assert.equal(await done(runtime, "prepare report"), "done");
    assert.equal(existsSync(join(root, "blocked.md")), false);
    assert.equal(readFileSync(join(root, "report.md"), "utf8"), "正文");
    assert.match(seen[1], /请补上非空/); assert.match(seen[3], /确认内容后交付/); assert.match(seen[4], /read receipt/);
    assert.equal(step, 5);
    assert.deepEqual((await store.receipts(finish.id)).map(r => r.outcome), ["pass", "feedback"]);
    assert.equal((await store.receipts(unrelated.id)).length, 0);
    const off = await store.activate(finish.id, finish.generation, finish.revision, false);
    reply = () => text("ordinary answer");
    assert.equal(await done(runtime, "ordinary task"), "done");
    assert.equal((await store.receipts(off.id)).length, 2);
    const enabled = await store.activate(off.id, off.generation, off.revision, true);
    assert.equal(await done(runtime, "cannot repair", "unanswered"), "unanswered");
    assert.equal((await store.receipts(finish.id)).length, 5, "two continuations followed by a failed submission");
    await store.activate(enabled.id, enabled.generation, enabled.revision, false);
  } finally { await runtime.close(); }

  const childRule = await store.publish({ ...rule("beforeTool", 'return "child must skip this read";', "child must skip this read", "read"), actor: "subagent" });
  const childTools = createDurableSubagentTools({ cwd: root, taskId, models, permissionMode: () => "auto",
    builtinRoles: [{ name: "inspect-hook", description: "Inspect a file", systemPrompt: "Inspect a file", tools: ["read"], source: "builtin", readOnly: true }] });
  const family = await DurableBotRuntime.open({ ...options, directory: join(root, "family"), tools: childTools });
  const childReplied: string[] = [];
  try {
    reply = input => {
      const last = input.messages.at(-1);
      if (last?.role === "toolResult") { childReplied.push(JSON.stringify(last)); return text("received"); }
      if (JSON.stringify(last).includes("parent-dispatch")) return call("subagent", { agent: "inspect-hook", task: "child-inspect", model: "fixture/model", isolation: "shared" });
      return call("read", { path: "report.md" });
    };
    assert.equal(await done(family, "parent-dispatch"), "done");
    const receipts = await store.receipts(childRule.id);
    assert.equal(receipts.length, 1, JSON.stringify(childReplied));
    assert.equal(receipts[0].actor, "subagent");
    assert.notEqual(receipts[0].conversationId, String(family.conversation.id));
    assert(childReplied.some(input => input.includes("child must skip this read")));
  } finally { await family.close(); }

  // Keep a safe nested ToolTask in execute, shut down the native harness, then recover the same call.
  const after = await store.publish(rule("afterTool", 'return "pinned-v1";', "pinned-v1", "hold"));
  const before = await store.publish(rule("beforeTool", "return true;", true, "hold"));
  let entered!: () => void, holds = 0, admissions = 0;
  const holdCalls: { taskId: number; callId: string }[] = [];
  const holding = new Promise<void>(r => { entered = r; });
  const hold = defineTool({ name: "hold", description: "Hold until restart", parameters: Type.Object({}), replay: "safe",
    execute: async (_args, api, context) => {
      holdCalls.push({ taskId: api.taskId, callId: api.callId });
      if (++holds === 1) {
        entered();
        await new Promise<void>((_, reject) => context.abortSignal!.addEventListener("abort", () => reject(Error("closed")), { once: true }));
      }
      return { output: [{ type: "text", text: "recovered" }] };
    } });
  reply = input => input.messages.at(-1)?.role === "toolResult" ? text("settled")
    : call("codemode", { code: 'await tools.write({path:"no-empty.md",content:""});' });
  const codeOptions: DurableBotOptions = { ...options, directory: join(root, "code"), toolMode: "codemode", tools: [hold],
    toolHooks: { beforeTool: async c => { if (c.name === "hold") admissions++; return undefined; } } };
  let code = await DurableBotRuntime.open(codeOptions);
  try {
    assert.equal(await done(code, "try nested write"), "done");
    assert.equal(existsSync(join(root, "no-empty.md")), false);
    assert((await store.receipts(first.id)).some(r => r.callId.includes("/") && r.outcome === "feedback"));
    const outerResults: string[] = [];
    reply = input => {
      // Reopening can append a system tool-registry update after the recovered result.
      const last = input.messages.findLast(message => message.role !== "system");
      if (last?.role === "toolResult") { outerResults.push(JSON.stringify(last)); return text("settled"); }
      return call("codemode", { code: 'if (await tools.hold({}) !== "recovered") throw Error("corrupted return value"); text("return value intact");' });
    };
    const submission = await code.submit("hold for recovery", "held");
    await Promise.race([holding, code.conversation.waitForIdle(ctx).then(() => { throw Error("hold tool never entered"); })]);
    const checkedAt = (await store.receipts(before.id))[0].at;
    await code.close();
    await store.publish(rule("afterTool", 'return "new-v2";', "new-v2", "hold"), after);
    code = await DurableBotRuntime.open(codeOptions);
    const recovered = await code.harness.submission(submission.id, ctx);
    assert.equal((await recovered!.wait(ctx)).status, "done");
    assert.equal(holds, 2, JSON.stringify(holdCalls));
    assert.deepEqual(holdCalls[1], holdCalls[0], "safe recovery resumes the original call identity");
    assert.equal(admissions, 1);
    assert((await store.receipts(before.id))[0].at > checkedAt, "safe recovery rechecks the pinned hook even though Pi skipped beforeTool");
    assert.deepEqual((await store.receipts(after.id)).map(r => [r.revision, r.message]), [[1, "pinned-v1"]]);
    assert.equal(await done(code, "new operation"), "done");
    assert.equal((await store.receipts(after.id))[0].revision, 2);
    assert(outerResults.every(value => value.includes("return value intact")));
    assert.match(outerResults[0], /pinned-v1/); assert.match(outerResults[1], /new-v2/);
  } finally { await code.close(); }
  assert((await store.receipts(post.id)).some(r => r.actor === "main"));
  const parentByConversation = new Map([[2, 1], [3, 1], [4, 2], [5, 6], [6, 5]]);
  const graph = { conversation: async (id: number) => ({ owner: parentByConversation.has(id) ? { conversationId: parentByConversation.get(id)! } : undefined }) };
  assert.equal(await improvementOwnsConversation(graph as never, 4, 2, ctx), true);
  assert.equal(await improvementOwnsConversation(graph as never, 1, 2, ctx), false);
  assert.equal(await improvementOwnsConversation(graph as never, 3, 2, ctx), false);
  assert.equal(await improvementOwnsConversation(graph as never, 5, 2, ctx), false);
  assert.deepEqual(improvementOracleDecision({ status: "passed", missing: [] }, "不应阻止"), { event: "falseTrigger", note: "" });
  assert.deepEqual(improvementOracleDecision({ status: "missing", missing: ["data.csv"] }, ""), { event: "error", note: "交付检查还缺少：data.csv" });
  assert.deepEqual(improvementOracleDecision({ status: "unknown", missing: [] }, "待核验"), { note: "待核验" });
  const source = { taskId: "t", conversationId: "2", actor: "main" as const, input: 10, trigger: 11, entry: 12, at: 1 };
  const sourceGraph = {
    entry: async (id: number) => ({ entry: { conversationId: id === 13 ? 3 : 2, byTaskId: 20 } }),
    task: async (id: number) => id === 20 ? { id, conversationId: 2, kind: "pi.tool", owner: 19 } : { id, conversationId: 2, kind: GenerationTask.definition.name },
    submission: async () => ({ type: "input", status: "done", answer: 11, conversationId: 2 }),
  };
  assert.equal(await sourceGeneration(sourceGraph as never, source), 19);
  assert.equal(await sourceGeneration(sourceGraph as never, { ...source, trigger: 13 }), undefined);
  assert.equal(await sourceGeneration(sourceGraph as never, { ...source, actor: "subagent", childReceipt: "assignment" }), 19);
  assert.equal(await sourceGeneration({ ...sourceGraph, submission: async () => ({type:"input", status:"unanswered", conversationId:2}) } as never,
    { ...source, actor: "subagent", childReceipt: "assignment" }), undefined);
  const evidenceDb = new Database(":memory:");
  try {
    evidenceDb.exec("CREATE TABLE task_request_diagnostics(task_id TEXT,started_at INTEGER,record_json TEXT); CREATE TABLE task_tool_diagnostics(task_id TEXT,started_at INTEGER,record_json TEXT); CREATE TABLE conversation_interactions(id TEXT,task_id TEXT,execution_id TEXT,kind TEXT,status TEXT,created_at INTEGER,resolved_at INTEGER)");
    const insert = evidenceDb.prepare("INSERT INTO task_request_diagnostics VALUES(?,?,?)");
    for (const [generation, conversation, executionId] of [[19,"2","own"],[20,"2","later"],[19,"3","sibling"]] as const)
      insert.run("t",1,JSON.stringify({generationTaskId:generation,conversationId:conversation,executionId,sourceKind:"main",executionScope:"t"}));
    evidenceDb.prepare("INSERT INTO conversation_interactions VALUES(?,?,?,?,?,?,?)").run("a","t","own","confirm","resolved",1,2);
    evidenceDb.prepare("INSERT INTO conversation_interactions VALUES(?,?,?,?,?,?,?)").run("b","t","later","confirm","pending",1,null);
    const result = sourceDiagnostics(evidenceDb,source,19);
    assert.deepEqual(result.requests?.map(r => r.executionId), ["own"]);
    assert.deepEqual(result.interactions?.map(r => (r as {id:string}).id), ["a"]);
  } finally { evidenceDb.close(); }

  const managedKey = "improvement-" + "a".repeat(64);
  const managedDraft = rule("beforeFinish", 'return "verify before delivery";', "verify before delivery");
  const installed = await Promise.all([
    store.installImprovement(managedDraft, managedKey),
    otherStore.installImprovement(managedDraft, managedKey),
  ]);
  assert.deepEqual(installed.map(hook => [hook.id, hook.revision, hook.versions]), [
    [managedKey, 1, [1]], [managedKey, 1, [1]],
  ]);
  const written: NativeHookReceipt = {
    id: managedKey, revision: 1, event: "beforeFinish", taskId, conversationId: "managed",
    nativeTaskId: 11, actor: "subagent", tool: "", callId: "", at: 100, outcome: "feedback", message: "written",
  };
  const verified: NativeHookReceipt = { ...written, nativeTaskId: 12, at: 101, outcome: "pass", message: "" };
  await assert.rejects(store.record(verified, "turn-1", undefined, { inputEntry: 7, observed: "written" }), /凭据/);
  await store.record(written, "turn-1", undefined, { inputEntry: 7, observed: "written" });
  await otherStore.record(verified, "turn-1", undefined, { inputEntry: 7, observed: "verified" });
  await store.record({ ...written, at: 99, outcome: "pass", message: "stale retry" }, "turn-1");
  const sources = [{ task: taskId, conversation: "managed", generation: 11 }];
  const metrics = await store.improvement(managedKey, 1, sources);
  assert.deepEqual([metrics.triggers, metrics.repaired, metrics.errors, metrics.recurrences], [1, 1, 0, 1]);
  assert.deepEqual(await store.childReviewReceipts(taskId, "managed"), [{ id: managedKey, revision: 1, executions: 2 }]);
  assert.deepEqual((await store.generationReceipts(taskId, "managed", [12, 11, 12])).map(r => [r.nativeTaskId, r.outcome]),
    [[12, "pass"], [11, "feedback"]]);

  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "archive"));
  writeFileSync(join(root, "docs", "manifest.txt"), "current manifest");
  writeFileSync(join(root, "archive", "manifest.txt"), "archived manifest");
  const paths = new ReadRecoveryHints(core);
  const otherPaths = new ReadRecoveryHints(otherCore);
  const mapping = { cwd: root, missing: "manifest.txt", found: "docs/manifest.txt" };
  assert.equal(await paths.publish("accepted-path", taskId, mapping, "2026-11-23"), true);
  assert.equal(await paths.has(taskId, root), true);
  assert.match((await paths.suggest(taskId, root, "manifest.txt", "trace", "turn", "call-1")) ?? "", /docs\/manifest\.txt/);
  await paths.suggest(taskId, root, "manifest.txt", "trace", "turn", "call-1");
  await paths.suggest(taskId, root, "manifest.txt", "trace", "turn", "call-2");
  await paths.observe(taskId, root, "docs/manifest.txt", false, "", "trace", "turn", "call-3");
  const acceptedPath = (await paths.list()).find(item => item.hint.key === "accepted-path");
  assert.deepEqual([acceptedPath?.triggers, acceptedPath?.repaired], [2, 1]);

  assert.deepEqual(await Promise.all([
    paths.publish("conflict-current", "other-task", mapping, "2026-11-23"),
    otherPaths.publish("conflict-archive", "other-task", { ...mapping, found: "archive/manifest.txt" }, "2026-11-23"),
  ]), [true, true]);
  assert.equal(await paths.has("other-task", root), false);
  assert.deepEqual((await paths.list()).filter(item => item.hint.task === "other-task")
    .map(item => [item.hint.found, item.hint.enabled]), [["archive/manifest.txt", false], ["docs/manifest.txt", false]]);

  let startUse!: () => void, resumeUse!: () => void;
  const useReached = new Promise<void>(resolve => { startUse = resolve; });
  const pendingUse = new Promise<void>(resolve => { resumeUse = resolve; });
  const paused = new ReadRecoveryHints({
    readPathHints: core.readPathHints.bind(core),
    async writePathHints<T>(mutation: ReadHintMutation) {
      if (mutation.kind === "recordUse") {
        startUse();
        await pendingUse;
      }
      return core.writePathHints<T>(mutation);
    },
  });
  const suggestion = paused.suggest(taskId, root, "manifest.txt", "trace", "turn", "raced-call");
  try {
    await Promise.race([useReached, suggestion.then(() => { throw new Error("fixture never reached the usage check"); })]);
    await otherPaths.disable("accepted-path");
  } finally {
    resumeUse();
  }
  assert.equal(await suggestion, undefined, "a disable before admission blocks the stale suggestion");

  await core.close();
  await otherCore.close();
  await shutdownCoreWorker(agentDir, database);
  const reopened = connect();
  try {
    const persisted = new NativeHookStore(reopened);
    assert.deepEqual((await persisted.versions([{ id: after.id, revision: 1 }, { id: after.id, revision: 2 }]))
      .map(h => h.draft.cases[0].expected), ["pinned-v1", "new-v2"]);
    const afterRestart = await persisted.improvement(managedKey, 1, sources);
    assert.deepEqual([afterRestart.hook?.generation, afterRestart.triggers, afterRestart.repaired, afterRestart.recurrences], [1, 1, 1, 1]);
    const afterDisable = (await new ReadRecoveryHints(reopened).list()).find(item => item.hint.key === "accepted-path");
    assert.deepEqual([afterDisable?.hint.enabled, afterDisable?.triggers, afterDisable?.repaired], [false, 2, 1]);
    assert.equal(existsSync(join(agentDir, "native-hooks.sqlite")), false);
  } finally { await reopened.close(); }
  console.log("PASS supervised DuckDB hooks and path hints: version fences, pinned Pi recovery, atomic readback, conflicting paths and stale-use rejection");
} finally {
  setDefaultPiStorageClient(undefined);
  await core.close();
  await otherCore.close();
  await shutdownCoreWorker(agentDir, database);
  rmSync(root, { recursive: true, force: true });
}
