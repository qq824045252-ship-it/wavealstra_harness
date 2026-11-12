import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { z } from "zod";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openDurableStorage } from "../src/main/agent/durable/DurableStorage";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkExecutionAdapter } from "../src/main/agent/work/WorkExecutionAdapter";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { createDurableSubagentTools } from "../src/main/agent/durable/DurableSubagents";
import { createDurableToolPolicy } from "../src/main/agent/durable/DurableToolPolicy";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ExecutionAttemptRepository } from "../src/main/agent/ExecutionAttemptRepository";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor } from "../src/shared/bot-work";

const root = await mkdtemp(join(tmpdir(), "bot-work-owned-usage-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = join(root, "agent"); process.env.PI_CODING_AGENT_DIR = agentDir;
const cwd = join(root, "workspace"); await mkdir(cwd); await mkdir(join(agentDir, "agents"), { recursive: true });
await writeFile(join(agentDir, "agents", "worker.md"), "---\nname: worker\ndescription: fixture child\ntools: proof\n---\nAnswer the assigned question.\n");
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "root", enabledModels: ["fixture/root", "fixture/child"] }));
const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "catalog.json"), refreshOnCreate: false });
let rootRequests = 0, childRequests = 0;
let scenario = "success", effects = 0;
let firstChildRequestAt = 0;
models.registerProvider("fixture", { api: "openai-completions", apiKey: "local-only", baseUrl: "http://127.0.0.1:1",
  models: ["root", "child"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  streamSimple: (model, request) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const child = model.id === "child"; child ? childRequests++ : rootRequests++;
      if (child && childRequests === 1) firstChildRequestAt = Date.now();
      const rejected = child && (scenario === "quota" && childRequests === 1 || scenario === "business" || scenario === "after-tool" && childRequests > 1);
      const call = !child && request.messages.at(-1)?.role !== "toolResult";
      const childCall = child && scenario === "after-tool" && childRequests === 1;
      const content: AssistantMessage["content"] = rejected ? [] : childCall ? [{ type: "toolCall", id: "child-effect", name: "proof", arguments: {} }] : call
        ? [{ type: "toolCall", id: "owned-child", name: "subagent", arguments: { agent: "worker", task: "answer briefly", model: "fixture/child", isolation: "shared" } }]
        : [{ type: "text", text: child ? "owned child result" : "parent result" }];
      const stopReason = rejected ? "error" : call || childCall ? "toolUse" : "stop";
      const message: AssistantMessage = { role: "assistant", content, stopReason, provider: model.provider, model: model.id, api: model.api,
        ...(rejected ? { errorMessage: scenario === "business" ? "400: business validation failed" : "400: [code=tier_limit_exceeded] membership concurrency limit exceeded" } : {}),
        timestamp: Date.now(), usage: { input: rejected ? 0 : child ? 10 : 3, output: rejected ? 0 : child ? 7 : 2, cacheRead: 0, cacheWrite: 0, totalTokens: rejected ? 0 : child ? 17 : 5,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      if (stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: stopReason, message });
      stream.end();
    }); return stream;
  },
});
const db = new AppDatabase(join(root, "business.db"));
const bots = new BotRegistry(db.connection);
const grants = { ...DESKTOP_USER_GRANTS, allowedScopes: ["workspace:read", "workspace:write", "delegate"], allowRedelegation: true };
bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "fixture", authorization: grants });
const works = new WorkService(db.connection, { bots });
const native = new DurableBotService({ db, models, agentDir, mcpDir: join(root, "mcp"), resolveCwd: () => cwd, instructions: () => "delegate one readonly child then reply",
  defaultModel: () => "fixture/root", toolMode: () => "native", mcpSelection: () => [], toolAllowed: (_task, name) => ["subagent", "subagent_list", "proof"].includes(name),
  beforeSubmit: request => { const error = works.checkTaskInput(request.taskId, request.userMessageId); if (error) throw new Error(error); },
  tools: async task => {
    const policy = createDurableToolPolicy({ taskId: task.id, taskRoot: cwd, getPermissionMode: () => "auto", interactions: new ConversationInteractionService(new ConversationInteractionRepository(db.connection), () => {}),
      attempts: new ExecutionAttemptRepository(db.connection), failures: new ExecutionFailureRepository(db.connection),
      admitWorkAction: input => works.admitTaskAction(task.id, input), settleWorkAction: (operationId, outcome) => works.settleTaskAction(task.id, operationId, outcome) });
    return { contextHooks: [], toolHooks: policy.hooks, tools: [defineTool({ name: "proof", description: "count actual fixture effects", parameters: Type.Object({}), replay: "unsafe",
      execute: async () => { effects++; appendFileSync(join(root, "effects.txt"), `${task.id}\n`); return { output: [{ type: "text", text: "proof recorded" }] }; } }),
      ...createDurableSubagentTools({ taskId: task.id, cwd, models, permissionMode: () => "auto" })] };
  }, emit: () => {} });
const errors: unknown[] = [];
const adapter = new WorkExecutionAdapter(works, native.workExecutionPort(), LOCAL_USER_ID, () => true, (_id, error) => errors.push(error));
const queue = new WorkDispatchQueue(db, works, adapter, () => true, () => "fixture/root");
try {
  const actor: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants };
  const created = works.createWork(actor, { operationId: "create-owned", title: "owned total", inputSnapshotId: "source-v1", authorization: grants });
  assert(created.ok); works.transaction(() => queue.enqueue(created.work, "owned-dispatch"));
  await queue.drain();
  const until = Date.now() + 15000;
  while (works.repo.listBindings(created.work.workId)[0]?.status !== "completed") {
    if (Date.now() > until) throw new Error(`owned usage timeout: root=${rootRequests}, child=${childRequests}, ${JSON.stringify(works.getProjection(created.work.workId))}, errors=${errors.map(String).join(";")}`);
    await adapter.flush(); await delay(20);
  }
  assert.equal(rootRequests, 2); assert.equal(childRequests, 1);
  assert.deepEqual(errors, []);
  for (let repeat = 0; repeat < 3; repeat++) await adapter.flush();
  const initialBinding = works.repo.listBindings(created.work.workId)[0];
  const initialReceipt = await native.workExecutionPort().find(initialBinding); assert(initialReceipt);
  const initialObservation = await native.workExecutionPort().inspect(initialBinding, initialReceipt);
  assert(initialObservation.status !== "running");
  assert.equal(initialObservation.usageTokens, 27, "raw parent+child usage telemetry remains available without a quota module");
  console.log("PASS parent and owned child raw usage remains 27 without quota accounting");
  for (const mode of ["quota", "business", "after-tool"]) {
    scenario = mode; rootRequests = 0; childRequests = 0;
    const next = works.createWork(actor, { operationId: `create-${mode}`, title: mode, inputSnapshotId: `source-${mode}`, authorization: grants });
    assert(next.ok);
    works.transaction(() => queue.enqueue(next.work, `dispatch-${mode}`)); await queue.drain();
    const deadline = Date.now() + 15000;
    const expected = mode === "business" ? 10 : 27;
    while (works.repo.listBindings(next.work.workId)[0]?.status !== "completed") {
      if (Date.now() > deadline) throw new Error(`${mode} usage timeout: root=${rootRequests}, child=${childRequests}, ${JSON.stringify(works.getProjection(next.work.workId))}`);
      await adapter.flush(); await delay(20);
    }
    assert.equal(childRequests, mode === "business" ? 1 : 2, "only provider quota before tools may receive the native bounded retry");
    assert.equal(rootRequests, 2);
    assert.equal(works.repo.listBindings(next.work.workId).length, 1, "business adapter never adds another retry root");
    const binding = works.repo.listBindings(next.work.workId)[0];
    const history = await native.history(binding.taskId);
    if (mode === "quota") assert(JSON.stringify(history).includes("retried after provider concurrency rejection"), "successful retry retains its per-child recovery evidence");
    await native.release(binding.taskId);
    const handle = await openDurableStorage(binding.durableStoreKey, context, { readOnly: true });
    let identities = 0;
    try {
      const page = await handle.storage.scanConversations({}, 200, undefined, context);
      for (const conversation of page.items) {
        const document = await handle.storage.findDocument({ kind: "mybuddy.subagent", scope: { kind: "conversation", conversationId: conversation.id } }, "current", context);
        const stored = document && await handle.storage.document(document.id, "current", context);
        const parsed = z.object({ value: z.object({ taskId: z.literal(binding.taskId), deadline: z.number(), startedAt: z.number(), timeout: z.object({ timeoutMs: z.number() }) }) }).safeParse(stored?.value);
        if (!parsed.success) continue;
        identities++;
        assert(parsed.data.value.deadline <= firstChildRequestAt + parsed.data.value.timeout.timeoutMs, "retry must not extend the deadline beyond the original request's time budget");
      }
    } finally { await handle.storage.close(context); handle.lease?.release(); }
    assert.equal(identities, 1, "all attempts reuse the one original owned-child identity");
    for (let repeat = 0; repeat < 3; repeat++) await adapter.flush();
    console.log(`PASS BW-A12 ${mode}: child requests=${childRequests}, one business binding, original child deadline, expected telemetry=${expected}`);
  }
  assert.equal(effects, 1, "failure after a child tool must not repeat its actual effect");
} finally {
  await queue.close(); await adapter.close(); await native.close(); db.close();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
