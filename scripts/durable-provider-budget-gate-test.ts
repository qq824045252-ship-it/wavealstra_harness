import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as streamBedrock } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DurableBotRuntime, durableBudgetRequestOptions, type DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor } from "../src/shared/bot-work";

assert.deepEqual(durableBudgetRequestOptions("openai-codex-responses", true), { maxRetries: 0, transport: "sse" });
assert.deepEqual({ transport: "auto", maxRetries: 7, ...durableBudgetRequestOptions("openai-codex-responses", false) }, { transport: "auto", maxRetries: 7 });
assert.deepEqual(durableBudgetRequestOptions("openai-responses", true), { maxRetries: 0 });
const root = await mkdtemp(join(tmpdir(), "durable-budget-gate-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
await mkdir(process.env.PI_CODING_AGENT_DIR);
let sends = 0;
let failNext: (() => void) | undefined;
const server = createServer(async (request, response) => {
  for await (const _ of request) { /* drain local fixture request */ }
  sends++;
  if (request.url?.includes("converse-stream")) {
    response.writeHead(400, { "content-type": "application/json", "x-amzn-errortype": "ValidationException" });
    response.end(JSON.stringify({ message: "local Bedrock transport reached" }));
    return;
  }
  if (failNext) {
    const failed = failNext; failNext = undefined; failed();
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "fixture overloaded", type: "server_error" } }));
    return;
  }
  const item = { type: "message", id: `msg_${sends}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "fixture answer", annotations: [] }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const type of ["response.output_item.added", "response.output_item.done"]) response.write(`data: ${JSON.stringify({ type, output_index: 0, item })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${sends}`, model: "fixture", status: "completed", output: [item], usage: { input_tokens: 3, output_tokens: 2 } } })}\n\n`);
});
const db = new AppDatabase(join(root, "business.db"));
const bots = new BotRegistry(db.connection);
bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "fixture", authorization: DESKTOP_USER_GRANTS });
const works = new WorkService(db.connection, { bots });
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const runtimes: DurableBotRuntime[] = [];
try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  models.registerProvider("fixture", {
    streamSimple: (model, context, options) => streamResponses(model as import("@earendil-works/pi-ai").Model<"openai-responses">, context, { ...options, maxRetries: options?.maxRetries ?? 2 }),
    api: "openai-responses", apiKey: "local-fixture-only", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  models.registerProvider("fixture-bedrock", { api: "bedrock-converse-stream", apiKey: "local-fixture-only", baseUrl: `http://127.0.0.1:${address.port}`,
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, context, options) => streamBedrock(model as import("@earendil-works/pi-ai").Model<"bedrock-converse-stream">, context, {
      ...options, env: { ...options?.env, AWS_BEDROCK_SKIP_AUTH: "1", AWS_BEDROCK_FORCE_HTTP1: "1", AWS_REGION: "us-east-1" },
    }),
  });
  await models.refresh({ allowNetwork: false });
  const setup = async (id: string, maxTokens: number, provider = "fixture") => {
    const created = works.createWork(user, { operationId: id, title: id, inputSnapshotId: id, authorization: DESKTOP_USER_GRANTS, workspacePath: root, budget: { maxTokens } });
    assert(created.ok); const workId = created.work.workId;
    const dispatched = works.dispatchExecution(user, { operationId: `dispatch:${id}`, workId, botId: DEFAULT_BOT_ID, taskId: id, durableStoreKey: id, conversationId: id, workspaceBinding: root, reserveTokens: 1 });
    assert(dispatched.ok);
    let block = false;
    const options: DurableBotOptions = { directory: join(root, id), cwd: root, models, model: { provider, modelId: "fixture" }, toolMode: "native", instructions: () => "isolated budget fixture", onSnapshot: () => {}, executionIdentity: { taskId: id, sourceKind: "main", executionScope: id },
      providerBudgetControlled: () => Boolean(works.repo.bindingForTask(id)),
      initialHistory: { messages: Array.from({ length: 4 }, (_, i) => ({ role: "user" as const, content: `old ${i} ` + "context ".repeat(4000), timestamp: i })), context: [] },
      beforeProviderRequest: () => { if (block) throw Error("fixture task revoked"); },
      onProviderRequest: input => { const admitted = works.budget.admitProviderRequest({ ...input, taskId: id }); if (!admitted.allowed) throw Error(admitted.message); },
      onProviderUsage: input => { assert(works.budget.settleProviderUsage({ ...input, taskId: id }).ok); },
      onResponse: (message, identity) => { assert(works.budget.settleProviderUsage({ taskId: id, ...identity, reported: message.stopReason !== "error" && message.stopReason !== "aborted", inputTokens: message.usage.input, outputTokens: message.usage.output, cacheReadTokens: message.usage.cacheRead, cacheWriteTokens: message.usage.cacheWrite }).ok); },
    };
    const runtime = await DurableBotRuntime.open(options);
    runtimes.push(runtime);
    return { runtime, workId, revoke: () => { block = true; }, reopen: async () => {
      await runtime.close(); runtimes.splice(runtimes.indexOf(runtime), 1);
      const reopened = await DurableBotRuntime.open(options); runtimes.push(reopened); return reopened;
    } };

  };
  const denied = await setup("denied", 1);
  const refused = await (await denied.runtime.submit("hello", "denied-input")).wait(ctx);
  assert.notEqual(refused.status, "done");
  assert.equal(sends, 0, "budget refusal never reaches the local HTTP provider");
  assert.equal(works.budget.listRequests(denied.workId).length, 0);
  assert.equal(works.budget.summary(denied.workId).window.unknownTokens, 0);
  await assert.rejects(denied.runtime.compact());
  assert.equal(sends, 0, "compaction budget refusal also never reaches HTTP");
  assert.equal(works.budget.settleProviderUsage({ taskId: "denied", conversationId: "missing", generationTaskId: 999, reported: true, inputTokens: 5 }).ok, false, "an unmatched trusted receipt must not silently settle");
  assert(works.repo.listOpenBlockers(denied.workId).some(blocker => blocker.reasonCode === "budget-reconciliation-conflict"), "unmatched trusted usage leaves visible reconciliation debt");
  const accepted = await setup("accepted", 500000);
  // Independent invocations share a Models instance but never their admission identity.
  const outcomes = await Promise.all([
    (await denied.runtime.submit("retry", "retry-input")).wait(ctx),
    (await accepted.runtime.submit("hello", "accepted-input")).wait(ctx),
  ]);
  assert.notEqual(outcomes[0]!.status, "done"); assert.equal(outcomes[1]!.status, "done");
  assert.equal(sends, 1); assert.equal(works.budget.listRequests(denied.workId).length, 0);
  assert.equal(works.budget.summary(accepted.workId).window.committedTokens, 5);
  const before = works.getWork(accepted.workId)!;
  const unchanged = works.budget.setPolicy(before, { maxTokens: 500000 });
  assert.deepEqual(unchanged, before); assert.equal(works.budget.listWindows(accepted.workId).length, 1);
  assert(works.budget.reserve({ workId: accepted.workId, reservationId: "pending", tokens: 10 }).ok);
  const reservedBefore = works.budget.summary(accepted.workId);
  assert.notEqual(typeof works.budget.setPolicy(before, { maxTokens: 500000 }), "string");
  assert.deepEqual(works.budget.summary(accepted.workId), reservedBefore);
  works.budget.commit(accepted.workId, "pending");
  const unknownBefore = works.budget.summary(accepted.workId);
  const saved = works.budget.setPolicy(before, { maxTokens: 500000 });
  assert.notEqual(typeof saved, "string"); assert.deepEqual(works.budget.summary(accepted.workId), unknownBefore);
  assert.equal(typeof works.budget.setPolicy(before, { maxTokens: 600000 }), "string");
  accepted.revoke();
  assert.notEqual((await (await accepted.runtime.submit("revoked", "revoked-input")).wait(ctx)).status, "done");
  assert.equal(sends, 1, "task authority refusal also fails before HTTP");
  await assert.rejects(accepted.runtime.compact());
  assert.equal(sends, 1, "compaction authority refusal also fails before HTTP");
  const compaction = await setup("compaction-reopen", 500000);
  const beforeCompactionSends = sends;
  await compaction.runtime.compact();
  assert.equal(sends, beforeCompactionSends + 1);
  const firstRequests = works.budget.listRequests(compaction.workId);
  assert.equal(firstRequests.length, 1);
  assert.equal(works.budget.summary(compaction.workId).window.committedTokens, 5);
  const reopened = await compaction.reopen();
  await reopened.conversation.commit(async tx => {
    for (let i = 0; i < 4; i++) await tx.appendEntry(reopened.conversation.id, { kind: "pi.user",
      model: [{ role: "user", content: `new ${i} ` + "context ".repeat(4000), timestamp: i + 10 }] });
  }, ctx);
  await reopened.compact();
  assert.equal(sends, beforeCompactionSends + 2);
  const compactedRequests = works.budget.listRequests(compaction.workId);
  assert.equal(compactedRequests.length, 2);
  assert.equal(new Set(compactedRequests.map(request => request.generation_task_id)).size, 2, "compaction IDs remain distinct after reopening");
  assert(compactedRequests.every(request => request.metering === "reported"));
  assert.equal(works.budget.summary(compaction.workId).window.committedTokens, 10);
  assert.equal(works.budget.summary(compaction.workId).window.unknownTokens, 0);
  const retried = await setup("provider-503", 500000);
  const before503 = sends;
  failNext = retried.revoke;
  assert.notEqual((await (await retried.runtime.submit("try once", "503-input")).wait(ctx)).status, "done");
  assert.equal(sends, before503 + 1, "503 must not retry inside the provider after authority is revoked");
  assert.equal(works.budget.listRequests(retried.workId).length, 1);
  const budgetRetried = await setup("provider-503-budget", 50000);
  const beforeBudget503 = sends;
  failNext = () => {};
  assert.notEqual((await (await budgetRetried.runtime.submit("try within budget", "503-budget-input")).wait(ctx)).status, "done");
  assert.equal(sends, beforeBudget503 + 1, "outer retry must reserve again and stop when its first unknown attempt consumed capacity");
  assert.equal(works.budget.listRequests(budgetRetried.workId).length, 1);
  assert(works.budget.summary(budgetRetried.workId).window.unknownTokens > 0);
  const bedrock = await setup("bedrock-bound", 500000, "fixture-bedrock");
  const beforeBedrock = sends;
  assert.notEqual((await (await bedrock.runtime.submit("blocked Work Bedrock", "bedrock-input")).wait(ctx)).status, "done");
  await assert.rejects(bedrock.runtime.compact());
  assert.equal(sends, beforeBedrock, "Work-bound Bedrock generation and compaction fail before HTTP");
  assert.equal(works.budget.listRequests(bedrock.workId).length, 0);
  assert.equal(works.budget.summary(bedrock.workId).window.unknownTokens, 0);
  assert.equal(works.budget.summary(bedrock.workId).window.reservedTokens, 0);
  let ordinaryAdmissions = 0;
  const ordinary = await DurableBotRuntime.open({ directory: join(root, "bedrock-ordinary"), cwd: root, models,
    model: { provider: "fixture-bedrock", modelId: "fixture" }, toolMode: "native", instructions: () => "isolated ordinary chat", onSnapshot: () => {},
    executionIdentity: { taskId: "ordinary-unbound", sourceKind: "main", executionScope: "ordinary-unbound" },
    onProviderRequest: input => {
      assert.equal(input.modelApi, "bedrock-converse-stream");
      assert(works.budget.admitProviderRequest({ ...input, taskId: "ordinary-unbound" }).allowed);
      ordinaryAdmissions++;
    },
  });
  runtimes.push(ordinary);
  await (await ordinary.submit("ordinary Bedrock remains enabled", "ordinary-input")).wait(ctx);
  assert.equal(ordinaryAdmissions, 1);
  assert.equal(sends, beforeBedrock + 1, "unbound ordinary Bedrock reaches the real native SDK's local HTTP endpoint");
  // Use the actual service wiring: callbacks exist for both ordinary and Work tasks.
  const serviceAdmissions = new Map<string, number>();
  let revokedServiceTask = "";
  const service = new DurableBotService({ db, models, agentDir: join(root, "service-agent"), mcpDir: join(root, "service-mcp"),
    resolveCwd: () => root, instructions: () => "isolated service fixture", toolMode: () => "native", defaultModel: () => "fixture/fixture", emit: () => {},
    providerBudgetControlled: taskId => Boolean(works.repo.bindingForTask(taskId)),
    beforeModelRequest: taskId => { if (taskId === revokedServiceTask) throw Error("fixture service authority revoked"); },
    onProviderRequest: (taskId, input) => {
      const result = works.budget.admitProviderRequest({ ...input, taskId });
      if (!result.allowed) throw Error(result.message);
      serviceAdmissions.set(taskId, (serviceAdmissions.get(taskId) ?? 0) + 1);
    },
  });
  try {
    for (const taskId of ["service-ordinary", "service-work", "service-bedrock"]) db.upsertTask({ id: taskId, title: taskId, modelId: taskId === "service-bedrock" ? "fixture-bedrock/fixture" : "fixture/fixture", updatedAt: Date.now() });
    const bound = works.createWork(user, { operationId: "service-work", title: "service work", inputSnapshotId: "service-work", authorization: DESKTOP_USER_GRANTS, workspacePath: root, budget: { maxTokens: 500000 } });
    assert(bound.ok);
    assert(works.dispatchExecution(user, { operationId: "service-dispatch", workId: bound.work.workId, botId: DEFAULT_BOT_ID, taskId: "service-work", durableStoreKey: "service-work", conversationId: "service-work", workspaceBinding: root, reserveTokens: 1 }).ok);
    const prompt = (taskId: string) => service.prompt({ taskId, text: "local service fixture", userMessageId: `${taskId}-input`, assistantMessageId: `${taskId}-answer` }, false);
    const beforeOrdinary = sends;
    failNext = () => {};
    assert.equal((await prompt("service-ordinary")).receipt?.status, "done");
    assert.equal(sends, beforeOrdinary + 2, "ordinary service keeps the provider's internal 503 retry");
    assert.equal(serviceAdmissions.get("service-ordinary"), 1, "ordinary retry is intentionally unchanged despite having an admission callback");
    const beforeWork = sends;
    failNext = () => { revokedServiceTask = "service-work"; };
    assert.notEqual((await prompt("service-work")).receipt?.status, "done");
    assert.equal(sends, beforeWork + 1, "Work service disables internal retry; outer retry rechecks authority");
    const beforeOrdinaryBedrock = sends;
    await prompt("service-bedrock");
    assert.equal(sends, beforeOrdinaryBedrock + 1, "ordinary Bedrock remains enabled through actual service wiring");
  } finally { await service.close(); }
  console.log("PASS actual DurableBotService preserves ordinary retries and Bedrock while guarding Work retries");
  console.log("PASS Work-bound Bedrock fails closed without usage debt; ordinary Bedrock still reaches native SDK HTTP transport");
  console.log("PASS successful compact/reopen/compact keeps two reported receipts and 503 retry cannot bypass revocation");
  console.log("PASS real Pi provider gate: denied/retried/concurrent/revoked/compaction HTTP counts and unchanged policy ledger preservation");
} finally {
  for (const runtime of runtimes) await runtime.close();
  db.close(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(root, { recursive: true, force: true });
}
