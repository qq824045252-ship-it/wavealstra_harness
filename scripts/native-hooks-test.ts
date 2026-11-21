import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineTool, type JsonObject } from "@earendil-works/pi-durable";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { exampleHook, type HookDraft } from "../src/shared/native-hooks";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { createAgentDurableFixture } from "./agent-durable-fixture";
import { DurableBotRuntime, type DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";
import { improvementOracleDecision, improvementOwnsConversation } from "../src/main/agent/durable/DurableImprovementRuntime";
import { sourceDiagnostics, sourceGeneration } from "../src/main/agent/hooks/ImprovementSourceContext";
import Database from "better-sqlite3";
import { GenerationTask } from "@earendil-works/pi-durable";
import { createDurableSubagentTools } from "../src/main/agent/durable/DurableSubagents";

const root = mkdtempSync(join(tmpdir(), "mybuddy-native-hooks-"));
const agentDir = join(root, ".mybuddy");
process.env.HOME = process.env.USERPROFILE = root;
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "plugins", "mcp"), { recursive: true });
const db = new AppDatabase(join(root, "app.db"));
const taskId = "hook-task";
db.upsertTask({ id: taskId, title: "Hook task", welcomeMode: "general", updatedAt: 1 });
type Reply = (input: TranscriptContext) => AssistantMessage["content"];
const text = (text: string): AssistantMessage["content"] => [{ type: "text", text }];
let sequence = 0;
const call = (name: string, args: JsonObject): AssistantMessage["content"] => [
  { type: "toolCall", id: "call-" + ++sequence, name, arguments: args },
];
let reply: Reply = () => text("[]");
const fixture = await createAgentDurableFixture(root, db, input => reply(input));
await fixture.agent.updateAppSettings({ memoryEnabled: false });
const store = fixture.agent.nativeHooks;
const options: DurableBotOptions = { models: fixture.models, model: { provider: "fixture", modelId: "model" },
  taskId, directory: join(root, "root"), cwd: root, toolMode: "native", instructions: () => "hook fixture", onSnapshot: () => {},
  nativeHooks: { store, scope: () => ({ taskId }) } };
const rule = (event: HookDraft["event"], script: string, expected: string | true, tool = ""): HookDraft => ({
  title: event, event, actor: "all", tool, scope: { kind: "task", id: taskId }, script, cases: [{ input: {}, expected }],
});
const done = async (runtime: DurableBotRuntime, input: string) => {
  const receipt = await runtime.submit(input, "submission-" + ++sequence);
  const settled = await receipt.wait(ctx);
  await runtime.conversation.waitForIdle(ctx);
  return settled.status;
};
try {
  const draft = exampleHook();
  const first = await store.publish(draft);
  await assert.rejects(store.publish({ ...draft, script: "return true;" }, first), /用例 1/);
  await assert.rejects(store.publish({ ...draft, script: "return process.cwd();" }, first), /process/);
  assert.equal(store.list()[0].revision, 1);
  const concurrent = await Promise.allSettled([store.publish({ ...draft, title: "new" }, first), store.publish({ ...draft, title: "other" }, first)]);
  assert.equal(concurrent.filter(r => r.status === "fulfilled").length, 1);
  const second = store.list()[0];
  const restored = store.activate(first.id, second.generation, 1, true);
  assert.equal(restored.hash, first.hash);
  assert.throws(() => store.activate(first.id, second.generation, 2, false), /已变化/);

  const pre = await store.publish(rule("beforeRequest", 'return "include project code";', "include project code"));
  await fixture.prompt({ taskId, text: "request with hook", userMessageId: "user", assistantMessageId: "answer" });
  assert(fixture.requests.some(r => JSON.stringify(r.input.messages.at(-1)).includes("include project code")));
  assert.equal(store.receipts(pre.id)[0].taskId, taskId);
  store.activate(pre.id, pre.generation, pre.revision, false);

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
    assert.deepEqual(store.receipts(finish.id).map(r => r.outcome), ["pass", "feedback"]);
    assert.equal(store.receipts(unrelated.id).length, 0);
    const off = store.activate(finish.id, finish.generation, finish.revision, false);
    reply = () => text("ordinary answer");
    assert.equal(await done(runtime, "ordinary task"), "done");
    assert.equal(store.receipts(off.id).length, 2);
    const enabled = store.activate(off.id, off.generation, off.revision, true);
    assert.equal(await done(runtime, "cannot repair"), "unanswered");
    assert.equal(store.receipts(finish.id).length, 5, "two continuations followed by a failed submission");
    store.activate(enabled.id, enabled.generation, enabled.revision, false);
  } finally { await runtime.close(); }

  const childRule = await store.publish({ ...rule("beforeTool", 'return "child must skip this read";', "child must skip this read", "read"), actor: "subagent" });
  const childTools = createDurableSubagentTools({ cwd: root, taskId, models: fixture.models, permissionMode: () => "auto",
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
    const receipts = store.receipts(childRule.id);
    assert.equal(receipts.length, 1, JSON.stringify(childReplied));
    assert.equal(receipts[0].actor, "subagent");
    assert.notEqual(receipts[0].conversationId, String(family.conversation.id));
    assert(childReplied.some(input => input.includes("child must skip this read")));
  } finally { await family.close(); }

  // Keep a safe nested ToolTask in execute, shut down the native harness, then recover the same call.
  const after = await store.publish(rule("afterTool", 'return "pinned-v1";', "pinned-v1", "hold"));
  const before = await store.publish(rule("beforeTool", "return true;", true, "hold"));
  let entered!: () => void, holds = 0, admissions = 0;
  const holding = new Promise<void>(r => { entered = r; });
  const hold = defineTool({ name: "hold", description: "Hold until restart", parameters: Type.Object({}), replay: "safe",
    execute: async (_args, _api, context) => {
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
    assert(store.receipts(first.id).some(r => r.callId.includes("/") && r.outcome === "feedback"));
    const outerResults: string[] = [];
    reply = input => {
      const last = input.messages.at(-1);
      if (last?.role === "toolResult") { outerResults.push(JSON.stringify(last)); return text("settled"); }
      return call("codemode", { code: 'if (await tools.hold({}) !== "recovered") throw Error("corrupted return value"); text("return value intact");' });
    };
    const submission = await code.submit("hold for recovery", "held");
    await Promise.race([holding, code.conversation.waitForIdle(ctx).then(() => { throw Error("hold tool never entered"); })]);
    const checkedAt = store.receipts(before.id)[0].at;
    await code.close();
    await store.publish(rule("afterTool", 'return "new-v2";', "new-v2", "hold"), after);
    code = await DurableBotRuntime.open(codeOptions);
    const recovered = await code.harness.submission(submission.id, ctx);
    assert.equal((await recovered!.wait(ctx)).status, "done");
    assert.equal(holds, 2); assert.equal(admissions, 1);
    assert(store.receipts(before.id)[0].at > checkedAt, "safe recovery rechecks the pinned hook even though Pi skipped beforeTool");
    assert.deepEqual(store.receipts(after.id).map(r => [r.revision, r.message]), [[1, "pinned-v1"]]);
    assert.equal(await done(code, "new operation"), "done");
    assert.equal(store.receipts(after.id)[0].revision, 2);
    assert(outerResults.every(value => value.includes("return value intact")));
    assert.match(outerResults[0], /pinned-v1/); assert.match(outerResults[1], /new-v2/);
  } finally { await code.close(); }
  assert(store.receipts(post.id).some(r => r.actor === "main"));
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
  console.log("PASS native hooks: verification, concurrent publish, rollback, product admission, tool correction, bounded completion, child identity, Code Mode and pinned restart");
} finally { await fixture.close(); db.close(); }
