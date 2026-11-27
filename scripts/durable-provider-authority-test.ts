import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { streamSimple as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as streamBedrock } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { DurableBotRuntime, durableAuthorityRequestOptions, type DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";
import { setDefaultPiStorageClient } from "../src/main/agent/durable/DurableStorage";
import { installModelInvocationAdmission } from "../src/main/agent/ModelInvocationAdmission";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { CoreMemoryExtractionUnavailable } from "../src/main/memory/MemoryCoreExtraction";
import type { CoreMemoryExtractionReadyBasis } from "../src/main/memory/MemoryCoreExtractionWire";
import { MemoryService } from "../src/main/memory/MemoryService";
import { shutdownCoreWorker } from "../src/main/platform/core-client";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";

assert.deepEqual(durableAuthorityRequestOptions("openai-codex-responses", true), { maxRetries: 0 });
assert.deepEqual({ transport: "auto", maxRetries: 7, ...durableAuthorityRequestOptions("openai-codex-responses", false) }, { transport: "auto", maxRetries: 7 });
assert.deepEqual(durableAuthorityRequestOptions("openai-responses", true), { maxRetries: 0 });
const executable = locateRuntimeAudit(process.cwd());
assert(executable, "Provider admission requires the Core worker");
const root = await mkdtemp(join(await realpath(tmpdir()), "durable-authority-"));
const database = join(root, "app.duckdb");
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
await mkdir(process.env.PI_CODING_AGENT_DIR);
let sends = 0;
let websocketUpgrades = 0;
let lastRequestPath: string | undefined;
let lastRequestBody = "";
let failNext: (() => void) | undefined;
let extractionResponse: string | undefined;
const server = createServer(async (request, response) => {
  const body: Buffer[] = [];
  for await (const part of request) body.push(part);
  lastRequestPath = request.url;
  const bytes = Buffer.concat(body);
  lastRequestBody = (request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8");
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
  const item = { type: "message", id: `msg_${sends}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: extractionResponse ?? "fixture answer", annotations: [] }] };
  extractionResponse = undefined;
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const type of ["response.output_item.added", "response.output_item.done"]) response.write(`data: ${JSON.stringify({ type, output_index: 0, item })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${sends}`, model: "fixture", status: "completed", output: [item], usage: { input_tokens: 3, output_tokens: 2 } } })}\n\n`);
});
server.on("upgrade", (_request, socket) => { websocketUpgrades++; socket.destroy(); });
let db: AppDatabase | undefined;
const runtimes: DurableBotRuntime[] = [];
try {
  db = await AppDatabase.open(database, { runtimeAuditExecutable: executable, runtimeAuditSupervised: true });
  const app = db;
  const reader = app.runtimeAuditReader!;
  setDefaultPiStorageClient(reader);
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
  const fakeAccount = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local-fixture" } })).toString("base64");
  models.registerProvider("fixture-codex", { api: "openai-codex-responses", apiKey: `fixture.${fakeAccount}.fixture`,
    baseUrl: `http://127.0.0.1:${address.port}/fixture`,
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, context, options) => streamCodex(model as import("@earendil-works/pi-ai").Model<"openai-codex-responses">, context, options),
  });
  await models.refresh({ allowNetwork: false });
  const usage: Array<{ conversationId: string; generationTaskId: number; reported: boolean; inputTokens: number; outputTokens: number }> = [];
  const setup = async (id: string, provider = "fixture", duringCheck?: () => Promise<void>) => {
    await app.writeTaskRecord({ id, title: id, updatedAt: Date.now() });
    let block = false;
    const options: DurableBotOptions = { directory: join(root, id), cwd: root, models, model: { provider, modelId: "fixture" }, toolMode: "native", instructions: () => "isolated authority fixture", onSnapshot: () => {}, executionIdentity: { taskId: id, sourceKind: "main", executionScope: id },
      initialHistory: { messages: Array.from({ length: 4 }, (_, i) => ({ role: "user" as const, content: `old ${i} ` + "context ".repeat(4000), timestamp: i })), context: [] },
      beforeProviderRequest: async () => {
        const access = await reader.readWorkTaskAccess(id);
        await duringCheck?.();
        if (!access?.taskExists || access.hasWorkBinding || block) throw new Error("fixture task revoked");
      },
      onProviderUsage: input => { usage.push(input); },
    };
    const runtime = await DurableBotRuntime.open(options);
    runtimes.push(runtime);
    return { runtime, revoke: () => { block = true; }, reopen: async () => {
      await runtime.close(); runtimes.splice(runtimes.indexOf(runtime), 1);
      const reopened = await DurableBotRuntime.open(options); runtimes.push(reopened); return reopened;
    } };

  };
  const denied = await setup("denied");
  denied.revoke();
  const refused = await (await denied.runtime.submit("hello", "denied-input")).wait(ctx);
  assert.notEqual(refused.status, "done");
  assert.equal(sends, 0, "authority refusal never reaches the local HTTP provider");
  await assert.rejects(denied.runtime.compact());
  assert.equal(sends, 0, "compaction authority refusal also never reaches HTTP");
  const accepted = await setup("accepted");
  // Independent invocations share a Models instance but never their admission identity.
  const outcomes = await Promise.all([
    (await denied.runtime.submit("retry", "retry-input")).wait(ctx),
    (await accepted.runtime.submit("hello", "accepted-input")).wait(ctx),
  ]);
  assert.notEqual(outcomes[0]!.status, "done"); assert.equal(outcomes[1]!.status, "done");
  accepted.revoke();
  assert.notEqual((await (await accepted.runtime.submit("revoked", "revoked-input")).wait(ctx)).status, "done");
  assert.equal(sends, 1, "task authority refusal also fails before HTTP");
  await assert.rejects(accepted.runtime.compact());
  assert.equal(sends, 1, "compaction authority refusal also fails before HTTP");
  const compaction = await setup("compaction-reopen");
  const beforeCompactionSends = sends;
  await compaction.runtime.compact();
  assert.equal(sends, beforeCompactionSends + 1);
  const firstRequests = usage.slice();
  assert.equal(firstRequests.length, 1);
  const reopened = await compaction.reopen();
  await reopened.conversation.commit(async tx => {
    for (let i = 0; i < 4; i++) await tx.appendEntry(reopened.conversation.id, { kind: "pi.user",
      model: [{ role: "user", content: `new ${i} ` + "context ".repeat(4000), timestamp: i + 10 }] });
  }, ctx);
  await reopened.compact();
  assert.equal(sends, beforeCompactionSends + 2);
  const compactedRequests = usage.slice();
  assert.equal(compactedRequests.length, 2);
  assert.equal(new Set(compactedRequests.map(request => request.generationTaskId)).size, 2, "compaction IDs remain distinct after reopening");
  assert(compactedRequests.every(request => request.reported));
  const retried = await setup("provider-503");
  const before503 = sends;
  failNext = retried.revoke;
  assert.notEqual((await (await retried.runtime.submit("try once", "503-input")).wait(ctx)).status, "done");
  assert.equal(sends, before503 + 1, "503 must not retry inside the provider after authority is revoked");
  const bedrock = await setup("bedrock-checked", "fixture-bedrock");
  const beforeBedrock = sends;
  assert.notEqual((await (await bedrock.runtime.submit("checked Bedrock", "bedrock-input")).wait(ctx)).status, "done");
  await assert.rejects(bedrock.runtime.compact());
  assert.equal(sends, beforeBedrock + 2, "Bedrock generation and compaction support the same awaited authority check");
  let ordinaryAdmissions = 0;
  const ordinary = await DurableBotRuntime.open({ directory: join(root, "bedrock-ordinary"), cwd: root, models,
    model: { provider: "fixture-bedrock", modelId: "fixture" }, toolMode: "native", instructions: () => "isolated ordinary chat", onSnapshot: () => {},
    executionIdentity: { taskId: "ordinary-unbound", sourceKind: "main", executionScope: "ordinary-unbound" },
    beforeProviderRequest: () => { ordinaryAdmissions++; },
  });
  runtimes.push(ordinary);
  await (await ordinary.submit("ordinary Bedrock remains enabled", "ordinary-input")).wait(ctx);
  assert.equal(ordinaryAdmissions, 1);
  assert.equal(sends, beforeBedrock + 3, "unbound ordinary Bedrock reaches the real native SDK's local HTTP endpoint");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const suspended = await setup("suspended-authority", "fixture", async () => {
    entered.resolve();
    await release.promise;
  });
  const free = await setup("independent-authority");
  const beforeSuspended = sends;
  const pending = (await suspended.runtime.submit("await authority", "suspended")).wait(ctx);
  try {
    await entered.promise;
    assert.equal(sends, beforeSuspended, "the provider must wait for the async authority decision");
    assert.equal((await (await free.runtime.submit("independent", "free")).wait(ctx)).status, "done");
    suspended.revoke();
  } finally {
    release.resolve();
  }
  assert.notEqual((await pending).status, "done");
  assert.equal(sends, beforeSuspended + 1, "revocation only blocks the task waiting for confirmation");

  const evidenceTask = "suspended-evidence";
  await app.writeTaskRecord({ id: evidenceTask, title: evidenceTask, updatedAt: Date.now() });
  const memory = new MemoryService(app, { semantic: false });
  const marker = "CORE_EVIDENCE_CALIBRATION_L1";
  await memory.createSettingsMemory({ kind: "constraint", title: "Calibration rule", content: marker,
    sourceType: "manual", scopeType: "global", explicit: true });
  const evidenceCheck = Promise.withResolvers<void>();
  const releaseEvidence = Promise.withResolvers<void>();
  let checkingPayload = false;
  let suspendEvidence = false;
  let startedEvidenceCheck = false;
  const verifyEvidence = async () => {
    if (checkingPayload) {
      startedEvidenceCheck = true;
      evidenceCheck.resolve();
      await releaseEvidence.promise;
    }
    const task = await app.readTask(evidenceTask);
    if (!task || task.archived) throw new Error("fixture evidence revoked");
  };
  const evidenceRuntime = await DurableBotRuntime.open({ directory: join(root, evidenceTask), cwd: root,
    models, model: { provider: "fixture", modelId: "fixture" }, toolMode: "native", instructions: () => "isolated evidence fixture",
    onSnapshot: () => {}, executionIdentity: { taskId: evidenceTask, sourceKind: "main", executionScope: evidenceTask },
    beforeProviderRequest: () => { checkingPayload = suspendEvidence; },
    evidenceProjection: {
      memory, enabled: () => true,
      scope: async () => ({ taskId: (await app.readTask(evidenceTask))?.id }),
      supplementalEvidence: async () => [{ id: "local-evidence", kind: "project", revision: "1", text: "Private fixture evidence",
        access: { kind: "project-note", projectId: "fixture" }, validate: verifyEvidence }],
      validateEvidenceAccess: verifyEvidence,
    },
  });
  runtimes.push(evidenceRuntime);
  const beforeRecall = sends;
  assert.equal((await (await evidenceRuntime.submit("Which calibration rule applies?", "recall-input")).wait(ctx)).status, "done");
  assert.equal(sends, beforeRecall + 1);
  assert(lastRequestBody.includes(marker), "an authorized persisted Core L1 appears in the HTTP payload");
  console.log("PASS default-enabled ordinary Pi sends a verified, persisted Core L1");
  suspendEvidence = true;
  const beforeEvidence = sends;
  const waitingEvidence = (await evidenceRuntime.submit("check live evidence", "evidence-input")).wait(ctx);
  try {
    await Promise.race([evidenceCheck.promise, waitingEvidence.then(async outcome => {
      if (startedEvidenceCheck) return;
      await evidenceRuntime.conversation.waitForIdle(ctx);
      const entries = (await evidenceRuntime.conversation.entries({ order: "descending" }, 8, undefined, ctx)).items;
      const errors = entries.flatMap(entry => (entry.model ?? []).flatMap(message =>
        message.role === "assistant" && message.errorMessage ? [message.errorMessage] : []));
      throw new Error(`Provider did not wait for evidence validation (${JSON.stringify(outcome)}) ${errors.join("; ")}`);
    })]);
    await app.archiveTaskAsync(evidenceTask, true);
    assert.equal((await app.readTask(evidenceTask))?.archived, true);
    assert.equal(sends, beforeEvidence, "provider has not sent while authorization is pending");
  } finally {
    releaseEvidence.resolve();
  }
  assert.notEqual((await waitingEvidence).status, "done");
  assert.equal(sends, beforeEvidence, "evidence revoked during provider admission never reaches HTTP");
  console.log("PASS real Pi provider awaits Core evidence validation after authentication");

  const extractionTask = "guarded-memory-extraction";
  await app.writeTaskRecord({ id: extractionTask, title: extractionTask, updatedAt: Date.now() });
  const extractionSettings = SettingsManager.inMemory({});
  installModelInvocationAdmission(models, () => extractionSettings);
  const extractionModel = models.getModel("fixture-codex", "fixture");
  assert(extractionModel);
  const quote = "Remember that our fixture torque is 17 Nm.";
  const basisTurns = [{ id: "grounded", taskId: extractionTask, userText: quote, capturedAt: 1,
    assistantText: "ASSISTANT_ONLY_EXTRACTION_MARKER", metadataJson: '{"trace":"UNVERIFIED_TOOL_MARKER"}' },
  { id: "opted-out", taskId: extractionTask, userText: "Do not remember PRIVATE_OPTOUT_MARKER.", capturedAt: 2 },
  { id: "exposed-credential", taskId: extractionTask, userText: "API key: SECRET_USER_MARKER", capturedAt: 3 }];
  const basis: CoreMemoryExtractionReadyBasis = { kind: "extractionBasis", status: "ready", basisStamp: "fixture-basis",
    turns: basisTurns, withheldSourceCount: 0, scopes: [{ scopeType: "task", scopeId: extractionTask }, { scopeType: "global", scopeId: null }], records: [
      ...Array.from({ length: 40 }, (_, index) => ({ id: `unrelated-${index}`, kind: "fact" as const, title: `Chalk ${index}`,
        content: "Unrelated chalk", scopeType: "global" as const, scopeId: null, status: "active", contentHash: `hash-${index}`,
        revision: 1, mutationAllowed: false })),
      { id: "old-fixture-torque", kind: "constraint", title: "Old torque setting", content: "Fixture torque is 12 Nm.",
        scopeType: "task", scopeId: extractionTask, status: "active", contentHash: "hash-old-torque", revision: 4, mutationAllowed: true },
      { id: "shared-guidance", kind: "constraint", title: "Shared setting", content: "Default fixture torque is 13 Nm.",
        scopeType: "global", scopeId: null, status: "active", contentHash: "hash-shared", revision: 3, mutationAllowed: false },
    ] };
  const request = {
    taskId: extractionTask, model: extractionModel, modelRuntime: models, settings: extractionSettings,
    basis, isEnabled: () => true, assertCurrent: async () => {
      if ((await app.readTask(extractionTask))?.archived !== false) throw new CoreMemoryExtractionUnavailable("提炼范围已经撤销");
    },
  };
  const beforeExtraction = sends;
  const baseCandidate = { kind: "constraint", scopeType: "task", confidence: 0.99, importance: 1, explicit: true, operationHint: "create" };
  extractionResponse = JSON.stringify({ candidates: [
    { ...baseCandidate, title: "Fixture torque", content: "Fixture torque is 17 Nm.", sourceTurnId: "grounded", userEvidence: quote },
    { ...baseCandidate, title: "Torque for fixture assembly", content: "Fixture torque is 17 Nm.", sourceTurnId: "grounded", userEvidence: quote },
    { ...baseCandidate, title: "Other source", content: "Unsupported fact.", sourceTurnId: "opted-out", userEvidence: quote },
    { ...baseCandidate, title: "Task torque setting", content: "Current fixture torque is 17 Nm.", replaces: "Old torque setting",
      operationHint: "update", sourceTurnId: "grounded", userEvidence: quote },
    { ...baseCandidate, title: "Shared torque setting", content: "Current fixture torque is 17 Nm.", replaces: "Shared setting",
      operationHint: "update", scopeType: "global", sourceTurnId: "grounded", userEvidence: quote },
  ] });
  const plan = await memory.extractCorePlan(request);
  assert.equal(sends, beforeExtraction + 1);
  assert.equal(lastRequestPath, "/fixture/codex/responses");
  assert.equal(websocketUpgrades, 0, "background Codex extraction uses the authority-checked HTTP transport");
  assert(lastRequestBody.includes(quote));
  assert(lastRequestBody.includes("Old torque setting") && lastRequestBody.includes("Shared setting"),
    "unrelated global atoms do not crowd authorized matching task and global atoms out of the prompt window");
  for (const omitted of ["ASSISTANT_ONLY_EXTRACTION_MARKER", "UNVERIFIED_TOOL_MARKER", "PRIVATE_OPTOUT_MARKER", "SECRET_USER_MARKER"]) {
    assert(!lastRequestBody.includes(omitted), `extraction request must omit ${omitted}`);
  }
  assert.deepEqual(plan, { basisStamp: "fixture-basis", candidates: [
    { ...baseCandidate, scopeId: extractionTask, title: "Fixture torque", content: "Fixture torque is 17 Nm.",
      evidence: { turnId: "grounded", quote }, action: { kind: "create" } },
    { ...baseCandidate, scopeId: extractionTask, title: "Other source", content: "Unsupported fact.", explicit: false,
      evidence: undefined, action: { kind: "review" } },
    { ...baseCandidate, scopeId: extractionTask, title: "Task torque setting", content: "Current fixture torque is 17 Nm.",
      replaces: "Old torque setting", operationHint: "update", evidence: { turnId: "grounded", quote },
      action: { kind: "update", targetId: "old-fixture-torque", expectedRevision: 4 } },
    { ...baseCandidate, scopeType: "global", scopeId: null, title: "Shared torque setting", content: "Current fixture torque is 17 Nm.",
      replaces: "Shared setting", operationHint: "update", evidence: { turnId: "grounded", quote }, action: { kind: "review" } },
  ] });
  assert.deepEqual(await memory.extractCorePlan({ ...request, basis: { ...basis, basisStamp: "withheld-basis", turns: [], withheldSourceCount: 1 } }),
    { basisStamp: "withheld-basis", candidates: [] });
  assert.equal(sends, beforeExtraction + 1, "Core-authorized filtering of every source completes without a model request");
  const blockedExtractionAdmission = Promise.withResolvers<void>();
  const releaseExtractionAdmission = Promise.withResolvers<void>();
  let extractionChecks = 0;
  const pendingExtraction = memory.extractCorePlan({ ...request, assertCurrent: async () => {
    if (++extractionChecks === 4) {
      blockedExtractionAdmission.resolve();
      await releaseExtractionAdmission.promise;
    }
    await request.assertCurrent();
  } });
  const rejectedExtraction = assert.rejects(pendingExtraction, CoreMemoryExtractionUnavailable);
  try {
    await Promise.race([blockedExtractionAdmission.promise, rejectedExtraction.then(() => {
      throw new Error("Extraction stopped before the Pi request authority check");
    })]);
    await app.archiveTaskAsync(extractionTask, true);
    assert.equal(sends, beforeExtraction + 1);
  } finally {
    releaseExtractionAdmission.resolve();
  }
  await rejectedExtraction;
  assert.equal(sends, beforeExtraction + 1, "provider transport must not send after extraction scope revocation");
  assert.equal(websocketUpgrades, 0);
  console.log("PASS real Pi Codex extraction uses guarded SSE, grounds quotes and refuses authority loss at HTTP send");
  console.log("PASS lifecycle-checked tasks avoid hidden retries and Bedrock is available");
  console.log("PASS Bedrock supports both the awaited authority check and ordinary execution");
  console.log("PASS successful compact/reopen/compact keeps two reported receipts and 503 retry cannot bypass revocation");
  console.log("PASS real Pi provider gate: denied/retried/concurrent/revoked/compaction HTTP counts and raw compaction telemetry");
} finally {
  for (const runtime of runtimes) await runtime.close();
  setDefaultPiStorageClient(undefined);
  await db?.runtimeAuditReader?.close();
  db?.close();
  await shutdownCoreWorker(root, database);
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(root, { recursive: true, force: true });
}
