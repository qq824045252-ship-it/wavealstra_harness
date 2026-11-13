/** Real native roots/tools/storage; only the model response stream is a local fixture. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotCreationService } from "../src/main/agent/work/BotCreationService";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkExecutionAdapter } from "../src/main/agent/work/WorkExecutionAdapter";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { createDurableToolPolicy } from "../src/main/agent/durable/DurableToolPolicy";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ExecutionAttemptRepository } from "../src/main/agent/ExecutionAttemptRepository";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { LOCAL_USER_ID, type WorkActor } from "../src/shared/bot-work";
import { collectOwnerSummaryFacts } from "../src/main/agent/work/WorkOwnerSummaryFacts";
import type { CreateTeamWorkRequest } from "../src/shared/bot-work-team";

const root = mkdtempSync(join(tmpdir(), "bot-team-native-"));
const cwd = join(root, "workspace"); mkdirSync(cwd);
writeFileSync(join(cwd, "alpha.txt"), "ALPHA_REAL_SOURCE_17\n");
writeFileSync(join(cwd, "beta.txt"), "BETA_REAL_SOURCE_29\n");
const outside = join(root, "outside.txt"); writeFileSync(outside, "OUTSIDE_SECRET_MUST_NOT_READ\n");
const hasSystemVerification = process.platform === "linux";
const forbidden = join(cwd, "forbidden.txt");
const body = (content: TranscriptContext["messages"][number]["content"]) => typeof content === "string" ? content : content.flatMap(item => item.type === "text" ? [item.text] : []).join("\n");
const modelCalls: Array<{ input: string; role: string; tool?: string; error?: boolean }> = [];
const toolsObserved: Array<{ taskId: string; name: string; error: boolean }> = [];
const errors: string[] = [];
let sequence = 0;
let holdAlpha = false;
let releaseAlpha: (() => void) | undefined;
const text = (value: string): AssistantMessage["content"] => [{ type: "text", text: value }];
const tool = (name: string, args: Record<string, string>): AssistantMessage["content"] => [{ type: "toolCall", id: `team-call-${++sequence}`, name, arguments: args }];
const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
models.registerProvider("teamfixture", { api: "openai-completions", apiKey: "local-fixture-only", baseUrl: "http://127.0.0.1:1",
  models: [{ id: "test", name: "Team fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  streamSimple: (model, request) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      const last = request.messages.at(-1), user = [...request.messages].reverse().find(message => message.role === "user");
      const input = user ? body(user.content) : "";
      modelCalls.push({ input, role: last?.role ?? "", tool: last?.role === "toolResult" ? last.toolName : undefined,
        error: last?.role === "toolResult" ? last.isError : undefined });
      const assignment = JSON.parse(input).teamAssignment;
      if (holdAlpha && assignment.responsibility === "READ_ALPHA_ASSIGNMENT" && last?.role !== "toolResult")
        await new Promise<void>(resolve => { releaseAlpha = resolve; });
      let content: AssistantMessage["content"];
      let failureReason: string | undefined;
      if (assignment.responsibility === "RECOVERY_SUMMARY_ASSIGNMENT") {
        assert(input.includes("RETAINED_NATIVE_SOURCE_17"), "owner receives the earlier native partial finding");
        assert(input.includes("native provider failure 2"), "latest failure is separate from retained findings");
        assert(assignment.previousResults.some((item: any) => item.executionStatus === "not_started" && !item.bindingId),
          "unstarted dependent has no fabricated native receipt");
        content = text("PARTIAL_NATIVE_SUMMARY: 保留已核实来源，原生提供方失败，后置分工未启动；目标未完成，未验收。");
      } else if (assignment.responsibility === "FAIL_AFTER_SOURCE_ASSIGNMENT") {
        if (assignment.recovery) { failureReason = "400: native provider failure 2"; content = []; }
        else if (last?.role !== "toolResult") content = tool("read", { path: join(cwd, "alpha.txt") });
        else {
          assert(body(last.content).includes("ALPHA_REAL_SOURCE_17"), "partial finding follows a real native file read");
          failureReason = "400: native provider failure 1"; content = text("RETAINED_NATIVE_SOURCE_17: ALPHA_REAL_SOURCE_17");
        }
      } else if (assignment.responsibility === "MUST_NOT_START_ASSIGNMENT") {
        throw Error("dependent member must not run after terminal prerequisite failure");
      } else if (assignment.role === "owner_summary") {
        assert(input.includes("ALPHA_REAL_SOURCE_17") && input.includes("BETA_REAL_SOURCE_29"), "owner must receive actual member results");
        assert(input.includes("proposed"), "owner input preserves pending acceptance");
        content = text("TEAM_NATIVE_SUMMARY: ALPHA_REAL_SOURCE_17 + BETA_REAL_SOURCE_29；成员工具已执行，交付真实结果。");
      } else if (assignment.responsibility === "READ_ALPHA_ASSIGNMENT") {
        if (last?.role !== "toolResult") content = tool("read", { path: join(cwd, "alpha.txt") });
        else if (last.toolName === "read") {
          assert(body(last.content).includes("ALPHA_REAL_SOURCE_17"), "production read returned file bytes");
          content = hasSystemVerification ? tool("bash", { command: 'wc -c "./alpha.txt"' })
            : tool("write", { path: forbidden, content: "must never be written" });
        } else if (last.toolName === "bash") {
          assert(!last.isError, "team trusted verification must not be rejected as opaque host access");
          const output = body(last.content);
          assert(output.length > 0, "verification comes from the real system command");
          const count = request.messages.filter(message => message.role === "toolResult" && message.toolName === "bash").length;
          if (count === 1) {
            assert(output.includes(String(Buffer.byteLength("ALPHA_REAL_SOURCE_17\n"))), "wc reads the exact source byte count");
            content = tool("bash", { command: 'stat "./alpha.txt"' });
          } else if (count === 2) content = tool("bash", { command: 'ls -l "./alpha.txt"' });
          else content = tool("write", { path: forbidden, content: "must never be written" });
        } else {
          assert(!last.isError, "legacy member scope must not block writing the temporary test fixture");
          content = text("ALPHA_REAL_SOURCE_17；真实写入完成，旧scope不再限制工具执行。");
        }
      } else {
        assert(assignment.responsibility === "READ_BETA_ASSIGNMENT", "member responsibility enters native immutable input");
        const priorReads = request.messages.filter(message => message.role === "toolResult" && message.toolName === "read");
        if (!priorReads.length) content = tool("read", { path: join(cwd, "beta.txt") });
        else if (priorReads.length === 1) {
          assert(body(priorReads[0]!.content).includes("BETA_REAL_SOURCE_29"));
          content = tool("read", { path: outside });
        } else {
          assert(last?.role === "toolResult" && !last.isError, "application grants do not block reading the sibling synthetic fixture");
          assert(body(last.content).includes("OUTSIDE_SECRET_MUST_NOT_READ"));
          content = text("BETA_REAL_SOURCE_29；临时目录读取完成，交付真实读取结果。");
        }
      }
      const stopReason = failureReason ? "error" : content.some(item => item.type === "toolCall") ? "toolUse" : "stop";
      const message: AssistantMessage = { role: "assistant", content, stopReason, api: model.api, model: model.id, provider: model.provider,
        ...(failureReason ? { errorMessage: failureReason } : {}), timestamp: Date.now(), usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      if (stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: stopReason, message });
      stream.end();
    }); return stream;
  },
});
let db!: AppDatabase, bots!: BotRegistry, works!: WorkService, native!: DurableBotService, adapter!: WorkExecutionAdapter, queue!: WorkDispatchQueue;
function open() {
  db = new AppDatabase(join(root, "app.db")); bots = new BotRegistry(db.connection); works = new WorkService(db.connection, { bots });
  native = new DurableBotService({ db, models, agentDir: join(root, "native"), mcpDir: join(root, "mcp"), resolveCwd: () => cwd,
    instructions: () => "Execute only the immutable team assignment. No external actions or invented acceptance.", defaultModel: () => "teamfixture/test",
    toolMode: () => "native", toolAllowed: () => true, mcpSelection: () => [],
    beforeSubmit: request => { const problem = works.checkTaskInput(request.taskId, request.userMessageId); if (problem) throw Error(problem); },
    tools: async task => {
      const policy = createDurableToolPolicy({ taskId: task.id, taskRoot: cwd, getPermissionMode: () => "auto", toolAllowed: () => true,
        interactions: new ConversationInteractionService(new ConversationInteractionRepository(db.connection), () => {}),
        attempts: new ExecutionAttemptRepository(db.connection), failures: new ExecutionFailureRepository(db.connection),
        admitWorkAction: input => works.admitTaskAction(task.id, input), settleWorkAction: (operationId, outcome) => works.settleTaskAction(task.id, operationId, outcome) });
      return { contextHooks: [], tools: [], toolHooks: { beforeTool: policy.hooks.beforeTool,
        afterTool: async (call, result, api, context) => {
          const settled = await policy.hooks.afterTool?.(call, result, api, context) ?? result;
          toolsObserved.push({ taskId: task.id, name: call.name, error: Boolean(settled.isError) }); return settled;
        } } };
    }, onSettled: () => adapter?.wake(), emit: () => {} });
  adapter = new WorkExecutionAdapter(works, native.workExecutionPort(), LOCAL_USER_ID, () => true, (_id, error) => errors.push(String(error)));
  queue = new WorkDispatchQueue(db, works, adapter, () => true, () => "teamfixture/test");
}
async function close() { await queue.close(); await adapter.close(); await native.close(); db.close(); }
async function until(predicate: () => boolean, label: string) {
  const end = Date.now() + 30000;
  while (!predicate()) { await queue.drain(); if (Date.now() > end) throw Error(`timeout ${label}: ${JSON.stringify(works.listProjections(LOCAL_USER_ID))}; ${errors.join(";")}`); await delay(20); }
}
open();
try {
  const creation = new BotCreationService(db.connection, bots, { userId: LOCAL_USER_ID, isAuthority: () => true });
  const ids = ["Native owner", "Native alpha", "Native beta", "Native successor"].map(displayName => {
    const result = creation.createBot({ requestId: randomUUID(), displayName, responsibilitySummary: displayName });
    assert(result.ok, JSON.stringify(result)); return result.bot.botId;
  });
  const request: CreateTeamWorkRequest = { operationId: randomUUID(), title: "Native team verification", goalDescription: "Read both independent files and summarize actual results",
    ownerBotId: ids[0]!, ownerResponsibility: "Summarize supplied member results without changing files", workspacePath: cwd,
    members: [{ botId: ids[1]!, responsibility: "READ_ALPHA_ASSIGNMENT", delegatedScope: ["workspace:read"] },
      { botId: ids[2]!, responsibility: "READ_BETA_ASSIGNMENT", delegatedScope: ["workspace:read"] }], criteria: ["Both source contents and denied actions are correctly reported"] };
  const actor: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: { ...DESKTOP_USER_GRANTS, allowRedelegation: true } };
  const saved = works.teams.handle(actor, { kind: "save_template", request: { operationId: "native-team", name: "Native team", plan: {
    ownerBotId: request.ownerBotId, ownerResponsibility: request.ownerResponsibility, members: request.members } } });
  assert(saved.ok && saved.template, JSON.stringify(saved)); request.templateId = saved.template.templateId;
  const result = works.teams.handle(actor, { kind: "create", request }); assert(result.ok && result.work, JSON.stringify(result));
  const workId = result.work.workId;
  await until(() => works.teams.get(workId)?.executions[0]?.status === "completed", "first member native settlement");
  assert.equal(works.repo.listBindings(workId).length, 1, "next member must not start before settled predecessor");
  assert.equal(modelCalls.length, hasSystemVerification ? 6 : 3);
  assert(works.pauseWork(actor, { operationId: "pause-mid-team", workId }).ok);
  const handedOff = works.handoffOwner(actor, { operationId: "handoff-mid-team", workId, targetBotId: ids[3]! });
  assert(handedOff.ok, JSON.stringify(handedOff));
  const persistedTasks = works.teams.get(workId)!.executions.map(item => item.taskId);
  await close(); open();
  assert.deepEqual(works.teams.get(workId)!.executions.map(item => item.taskId), persistedTasks, "queued identities survive host reopen");
  for (let pass = 0; pass < 3; pass++) await queue.drain();
  assert.equal(modelCalls.length, hasSystemVerification ? 6 : 3, "paused team cannot start queued member after restart");
  assert.equal(works.teams.get(workId)?.state, "paused");
  assert(works.resumeWork(actor, { operationId: "resume-mid-team", workId }).ok);
  await until(() => works.teams.get(workId)?.state === "awaiting_review", "team native settlement after mid-team restart");
  await queue.drain();
  const team = works.teams.get(workId)!; assert.equal(team.executions.length, 3);
  assert(team.executions.every(item => item.status === "completed"));
  assert.deepEqual(team.executions.map(item => item.botId), [ids[1], ids[2], ids[3]]);
  const bindings = works.repo.listBindings(workId); assert.equal(bindings.length, 3);
  assert.equal(new Set(bindings.map(item => item.durableStoreKey)).size, 3);
  assert.equal(new Set(bindings.map(item => item.taskId)).size, 3);
  assert(bindings.every(item => item.delegatedScope.length === 1 && item.delegatedScope[0] === "workspace:read"));
  assert.equal(works.getWork(workId)?.lifecycle, "active");
  assert(works.repo.listDeliverables(workId).every(item => item.status === "proposed"));
  assert.equal(works.repo.listDeliverables(workId).length, 3);
  assert(!collectOwnerSummaryFacts(works, works.getWork(workId)!, Date.now()).payload.waitingForBotIds.includes(ids[0]!), "former owner recipient is not a missing executor after handoff");
  assert.equal(works.getWork(workId)?.acceptedDeliverableIds.length, 0);
  assert(existsSync(forbidden));
  assert.equal(toolsObserved.filter(item => item.name === "bash" && !item.error).length, hasSystemVerification ? 3 : 0);
  assert.equal(toolsObserved.filter(item => item.name === "read" && !item.error).length, 3);
  // The marker is a hard-coded synthetic string; no external model or credentials are used.
  const callsBefore = modelCalls.length, tasksBefore = db.listTasks().map(task => task.id).sort();
  assert.equal(callsBefore, hasSystemVerification ? 10 : 7, "trusted verification plus member turns and owner summary");
  const messages = works.collaboration.history(workId);
  assert.equal(messages.filter(item => item.kind === "delegate").length, 2);
  assert.equal(messages.filter(item => item.kind === "result").length, 3);
  const firstBeta = modelCalls.findIndex(item => JSON.parse(item.input).teamAssignment.botId === ids[2]);
  assert(firstBeta >= (hasSystemVerification ? 6 : 3), "beta starts only after alpha settles");
  await close(); open();
  const replay = works.teams.handle(actor, { kind: "create", request }); assert(replay.ok && replay.replayed);
  for (let pass = 0; pass < 5; pass++) { await queue.drain(); await delay(20); }
  assert.equal(modelCalls.length, callsBefore, "reopen and repeat create never repeat native execution");
  assert.deepEqual(db.listTasks().map(task => task.id).sort(), tasksBefore);
  assert.equal(works.teams.get(workId)?.state, "awaiting_review");
  // 共享资源隔离退役：真实只读校验不再持久化租约或指纹。
  if (hasSystemVerification) {
    assert.equal(works.repo.listOpenBlockers(workId).filter(item => item.reasonCode?.startsWith("resource-")).length, 0);
  }
  assert.equal(works.collaboration.history(workId).length, messages.length);
  // Real durable roots overlap only when explicitly selected. Hold the alpha model
  // response while beta reads its real file; the owner cannot start early.
  holdAlpha = true;
  const parallelRequest: CreateTeamWorkRequest = { ...request, operationId: randomUUID(), title: "Parallel native team",
    executionPolicy: "parallel", maxConcurrency: 2 };
  const parallel = works.teams.handle(actor, { kind: "create", request: parallelRequest });
  assert(parallel.ok && parallel.work, JSON.stringify(parallel));
  const parallelId = parallel.work.workId;
  await until(() => works.teams.get(parallelId)?.executions[1]?.status === "completed", "independent beta finishes while alpha is held");
  assert.equal(works.teams.get(parallelId)!.executions[0]!.status, "running");
  assert.equal(works.repo.listBindings(parallelId).length, 2, "owner barrier retains both original member identities");
  assert(releaseAlpha); holdAlpha = false; releaseAlpha();
  await until(() => works.teams.get(parallelId)?.state === "awaiting_review", "parallel native owner result");
  const parallelCalls = modelCalls.length;
  await close(); open();
  for (let pass = 0; pass < 4; pass++) { await queue.drain(); await delay(20); }
  assert.equal(modelCalls.length, parallelCalls, "parallel reopening does not replay effects");
  assert.equal(works.repo.listBindings(parallelId).length, 3);
  console.log("PASS native parallel team: real overlapping roots, real file verification, owner barrier and reopened idempotency");
  // Real Durable failure/recovery receipts, not a FakeHost projection: a prior
  // member's actual read succeeds, the next retains a finding then fails twice,
  // and the owner summarizes without ever starting the blocked dependency.
  const failedRequest = { ...request, operationId: randomUUID(),
    title: "Native exhausted chain", ownerBotId: ids[3]!, ownerResponsibility: "RECOVERY_SUMMARY_ASSIGNMENT",
    members: [request.members[0]!, { botId: ids[2]!, responsibility: "FAIL_AFTER_SOURCE_ASSIGNMENT", delegatedScope: ["workspace:read"] },
      { botId: ids[0]!, responsibility: "MUST_NOT_START_ASSIGNMENT", delegatedScope: ["workspace:read"] }] };
  const failedTemplate = works.teams.handle(actor, { kind: "save_template", request: { operationId: "native-failure-template", name: "Failure recovery team",
    plan: { ownerBotId: failedRequest.ownerBotId, ownerResponsibility: failedRequest.ownerResponsibility, members: failedRequest.members } } });
  assert(failedTemplate.ok && failedTemplate.template);
  const failedChain = works.teams.handle(actor, { kind: "create", request: { ...failedRequest, templateId: failedTemplate.template.templateId } });
  assert(failedChain.ok && failedChain.work, JSON.stringify(failedChain));
  const failedId = failedChain.work.workId;
  await until(() => works.teams.get(failedId)?.executions.at(-1)?.status === "completed", "native owner accounts for terminal failed chain");
  const failedTeam = works.teams.get(failedId)!;
  assert.equal(failedTeam.state, "blocked");
  assert.equal(failedTeam.executions[2]!.status, "blocked");
  assert(failedTeam.executions[2]!.notStartedReason);
  assert.equal(works.repo.listBindings(failedId).length, 4, "one success, two failed attempts, one owner summary");
  assert.equal(works.repo.listBindings(failedId).filter(binding => binding.taskId === failedTeam.executions[0]!.taskId).length, 1);
  assert.equal(works.repo.listBindings(failedId).some(binding => binding.taskId === failedTeam.executions[2]!.taskId), false);
  assert(works.repo.listDeliverables(failedId).some(item => item.summary.includes("PARTIAL_NATIVE_SUMMARY")));
  assert.equal(works.getWork(failedId)!.acceptedDeliverableIds.length, 0);
  const finalCalls = modelCalls.length;
  await close(); open();
  for (let pass = 0; pass < 4; pass++) { await queue.drain(); await delay(20); }
  assert.equal(modelCalls.length, finalCalls, "native summary is not repeated after restart");
  console.log("PASS native failed chain: retained real-read finding, distinct failures, unstarted dependency, truthful owner summary and restart dedupe");
  assert.deepEqual(errors, []);
  console.log("PASS real native team: separate identities/namespaces, actual file reads, temporary fixture write/sibling read without retired application grants, sequential results, owner synthesis, proposed acceptance and reopened idempotency");
} finally { await close(); rmSync(root, { recursive: true, force: true }); }
