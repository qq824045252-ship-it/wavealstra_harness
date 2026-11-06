import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { appendFileSync } from "node:fs";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService } from "../src/main/agent/work/WorkService";
import { WorkExecutionAdapter } from "../src/main/agent/work/WorkExecutionAdapter";
import { createDurableToolPolicy } from "../src/main/agent/durable/DurableToolPolicy";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { ExecutionAttemptRepository } from "../src/main/agent/ExecutionAttemptRepository";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult } from "../src/shared/bot-work";

const root = await mkdtemp(join(tmpdir(), "bot-work-native-"));
const text = (value: string) => [{ type: "text" as const, text: value }];
const models = async (reply: (request: TranscriptContext) => AssistantMessage["content"]) => {
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
    modelsStorePath: join(root, "catalog.json"), refreshOnCreate: false });
  runtime.registerProvider("fixture", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, request) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const content = reply(request);
        const stopReason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
        const message: AssistantMessage = { role: "assistant", content, stopReason, api: model.api, model: model.id, provider: model.provider,
          timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: stopReason, message }); stream.end();
      });
      return stream;
    },
  });
  return runtime;
};
try {
// BW-A14/A15/A16: real SQLite and native Durable JSONL, reopened at delivery boundaries.
{
  const cwd = join(root, "work-execution"); await mkdir(cwd);
  const dbPath = join(cwd, "business.db");
  const agentDir = join(cwd, "agent");
  let generations = 0;
  let effects = 0;
  let writeConflicts: string[] = [];
  let cancelBeforeTool: string | undefined;
  const catalog = await models(request => {
    generations++;
    if (request.messages.at(-1)?.role === "toolResult") return text("原生后台成果");
    if (cancelBeforeTool) {
      unwrap(work.cancelWork(actor, { operationId: "cancel-before-tool", workId: cancelBeforeTool }));
      cancelBeforeTool = undefined;
    }
    return [{ type: "toolCall", id: "native-fixture-effect", name: "fixture_effect", arguments: {} }];
  });
  const actor: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: { allowedScopes: ["workspace:read", "workspace:write"], targetWhitelist: [], allowGitBranchOrWorktree: false, allowRedelegation: false } };
  const unwrap = (result: WorkControlResult) => { if (!result.ok) throw new Error(result.message); return result.work; };
  let db = new AppDatabase(dbPath);
  let bots = new BotRegistry(db.connection); bots.ensureDefaultBot(LOCAL_USER_ID);
  let work = new WorkService(db.connection, { bots });
  const openNative = () => new DurableBotService({ db, agentDir, mcpDir: join(agentDir, "mcp"), models: catalog,
    resolveCwd: () => cwd, instructions: () => "fixture", toolMode: () => "native", toolAllowed: (_task, name) => name === "fixture_effect",
    beforeSubmit: request => { const blocked = work.checkTaskInput(request.taskId, request.userMessageId); if (blocked) throw new Error(blocked); },
    tools: async task => {
      const policy = createDurableToolPolicy({ taskId: task.id, taskRoot: cwd, getPermissionMode: () => "auto",
        interactions: new ConversationInteractionService(new ConversationInteractionRepository(db.connection), () => {}),
        attempts: new ExecutionAttemptRepository(db.connection), failures: new ExecutionFailureRepository(db.connection),
        admitWorkAction: input => work.admitTaskAction(task.id, input),
        settleWorkAction: (operationId, outcome) => work.settleTaskAction(task.id, operationId, outcome),
      });
      return { contextHooks: [], toolHooks: policy.hooks, tools: [defineTool({ name: "fixture_effect", description: "isolated effect counter",
        parameters: Type.Object({}), replay: "unsafe", execute: async () => {
          effects++; appendFileSync(join(cwd, "effects.txt"), `${task.id}\n`);
          return { output: text("effect recorded"), isError: writeConflicts.length > 0, details: { writeConflicts } };
        } })] };
    },
    defaultModel: () => "fixture/fixture", mcpSelection: () => [], emit: () => {} });
  let native = openNative();
  const errors: unknown[] = [];
  const adapter = () => new WorkExecutionAdapter(work, native.workExecutionPort(), LOCAL_USER_ID, () => true, (_bindingId, error) => errors.push(error));
  const accept = (operationId: string) => unwrap(work.createWork(actor, { operationId, title: operationId,
    inputSnapshotId: operationId, authorization: actor.grants, criteria: [{ text: "核验成果" }] }));
  const bind = async (workId: string, operationId: string) => {
    db.upsertTask({ id: operationId, title: "真实后台执行", updatedAt: Date.now(), cwd, modelId: "fixture/fixture", permissionMode: "auto" });
    const namespace = await native.workExecutionPort().prepare(operationId);
    const dispatched = unwrap(work.dispatchExecution(actor, { operationId, workId, botId: DEFAULT_BOT_ID, ...namespace }));
    const binding = work.repo.getBinding(dispatched.activeExecutionIds[0]!); assert.ok(binding); return binding;
  };
  try {
    const a14 = accept("a14-create");
    const a14Binding = await bind(a14.workId, "a14-submit");
    db.upsertTask({ id: "a14-front", title: "可归档的前台对话", updatedAt: Date.now() });
    work.repo.linkConversation(a14.workId, "a14-front");
    db.archiveTask("a14-front", true);
    await native.close(); db.close();
    db = new AppDatabase(dbPath); bots = new BotRegistry(db.connection); work = new WorkService(db.connection, { bots }); native = openNative();
    let dispatcher = adapter();
    await dispatcher.flush();
    const a14Receipt = await native.workExecutionPort().find(a14Binding); assert.ok(a14Receipt);
    await native.submissionStatus(a14Receipt, true);
    await dispatcher.flush();
    assert.equal(work.repo.listDeliverables(a14.workId).length, 1);
    assert.equal(effects, 1, "recovered outbox produces exactly one actual fixture effect");
    assert.equal(work.listWorksByConversation("a14-front")[0]?.workId, a14.workId,
      "A02/A06 archived foreground conversation keeps the same Work while native execution continues");
    assert.equal(work.repo.getBinding(a14Binding.bindingId)?.status, "completed");
    const afterA14 = generations;
    await dispatcher.flush(); assert.equal(generations, afterA14, "replaying delivery does not rerun native business work");

    const a15 = accept("a15-create");
    const a15Binding = await bind(a15.workId, "a15-submit");
    work.markDispatchAttempt(a15Binding.bindingId, "attempt-before-crash");
    const a15Receipt = await native.workExecutionPort().submit(a15Binding, work.repo.executionInput(a15Binding));
    await native.submissionStatus(a15Receipt, true);
    assert.equal(work.repo.getBinding(a15Binding.bindingId)?.submissionReceipt, undefined, "fault boundary is before business receipt persistence");
    assert.equal(unwrap(work.cancelWork(actor, { operationId: "a15-cancel", workId: a15.workId })).lifecycle, "closing");
    const beforeRecovery = generations;
    const effectsBeforeRecovery = effects;
    await native.close(); db.close();
    db = new AppDatabase(dbPath); bots = new BotRegistry(db.connection); work = new WorkService(db.connection, { bots }); native = openNative(); dispatcher = adapter();
    await dispatcher.flush();
    assert.equal(generations, beforeRecovery, "cancelled recovery finds the original submission without a new generation");
    assert.equal(effects, effectsBeforeRecovery, "lost receipt recovery does not repeat the actual effect");
    assert.equal(work.getWork(a15.workId)?.lifecycle, "closed");
    assert.equal(work.getWork(a15.workId)?.closureConclusion, "cancelled");
    assert.equal(work.repo.listDeliverables(a15.workId).length, 1, "late result is retained even when cancellation preceded recovery");
    assert.equal(work.repo.getBinding(a15Binding.bindingId)?.taskId, a15Binding.taskId);
    assert.equal(work.repo.getBinding(a15Binding.bindingId)?.conversationId, a15Binding.conversationId);

    const a24 = accept("a24-create");
    const a24Binding = await bind(a24.workId, "a24-submit");
    cancelBeforeTool = a24.workId;
    const effectsBeforeCancel = effects;
    await dispatcher.flush();
    const a24Receipt = await native.workExecutionPort().find(a24Binding); assert.ok(a24Receipt);
    await native.submissionStatus(a24Receipt, true);
    await dispatcher.flush();
    assert.equal(effects, effectsBeforeCancel, "cancel before tool admission blocks the actual effect");
    assert.equal(work.getWork(a24.workId)?.closureConclusion, "cancelled");

    const a16 = accept("a16-create");
    const a16Binding = await bind(a16.workId, "a16-submit");
    const a16Receipt = await native.workExecutionPort().submit(a16Binding, work.repo.executionInput(a16Binding));
    await native.submissionStatus(a16Receipt, true);
    const effectsBeforeResultRecovery = effects;
    db.connection.exec(`CREATE TRIGGER fault_receiving_work_result BEFORE INSERT ON work_operation_receipts
      WHEN NEW.operation_type='submitDeliverable' BEGIN SELECT RAISE(ABORT, 'injected result receipt failure'); END`);
    await dispatcher.flush();
    assert.equal(errors.length, 1, "the persisted result-receipt boundary was reached");
    assert.equal(work.repo.listDeliverables(a16.workId).length, 0, "receipt failure rolls back the deliverable and outbox together");
    assert.equal(work.repo.getBinding(a16Binding.bindingId)?.status, "submitted");
    await native.close(); db.close();
    db = new AppDatabase(dbPath); bots = new BotRegistry(db.connection); work = new WorkService(db.connection, { bots }); native = openNative();
    db.connection.exec("DROP TRIGGER fault_receiving_work_result");
    errors.length = 0;
    await adapter().flush();
    assert.equal(work.repo.listDeliverables(a16.workId).length, 1);
    assert.equal(effects, effectsBeforeResultRecovery, "result recovery reads the native log without re-executing tools");

    const a33 = accept("a33-create");
    const a33Binding = await bind(a33.workId, "a33-submit");
    writeConflicts = ["必要文件写入被冲突守卫阻止"];
    await adapter().flush();
    const a33Receipt = await native.workExecutionPort().find(a33Binding); assert.ok(a33Receipt);
    await native.submissionStatus(a33Receipt, true);
    await adapter().flush();
    const conflicting = work.repo.listDeliverables(a33.workId)[0]; assert.ok(conflicting);
    assert.equal(conflicting.hasWriteConflicts, true, "native structured write-conflict evidence reaches the Work result");
    assert.equal(work.acceptDeliverable(actor, { operationId: "a33-accept", workId: a33.workId, deliverableId: conflicting.deliverableId }).ok, false);
    assert.equal(work.getWork(a33.workId)?.lifecycle, "active");
    writeConflicts = [];

    await native.close(); db.close();
    db = new AppDatabase(dbPath); bots = new BotRegistry(db.connection); work = new WorkService(db.connection, { bots }); native = openNative();
    await adapter().flush();
    assert.equal(work.repo.listDeliverables(a14.workId).length, 1, "reopen preserves one received result");
    assert.equal(work.repo.listDeliverables(a15.workId).length, 1);
    assert.deepEqual(errors, []);
  } finally { await native.close(); db.close(); }
  console.log("PASS BW-A14/A15/A16/A24/A33 native Work delivery/recovery, admission and result boundaries");
}

} finally { await rm(root, { recursive: true, force: true }); }
