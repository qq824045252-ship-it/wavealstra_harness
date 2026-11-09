/** Real native roots/tools/storage; only the model response stream is a local fixture. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkExecutionAdapter } from "../src/main/agent/work/WorkExecutionAdapter";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { WorkToolResourcePolicy } from "../src/main/agent/work/WorkToolResourcePolicy";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { createDurableToolPolicy } from "../src/main/agent/durable/DurableToolPolicy";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ExecutionAttemptRepository } from "../src/main/agent/ExecutionAttemptRepository";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { LOCAL_USER_ID, type WorkActor } from "../src/shared/bot-work";
import type { CreateTeamWorkRequest } from "../src/shared/bot-work-team";

const root = mkdtempSync(join(tmpdir(), "bot-team-approval-native-"));
const cwd = join(root, "workspace"); mkdirSync(cwd);
writeFileSync(join(cwd, "alpha.txt"), "ALPHA_REAL_SOURCE_17\n");
writeFileSync(join(cwd, "beta.txt"), "BETA_REAL_SOURCE_29\n");
const outside = join(root, "outside.txt"); writeFileSync(outside, "OUTSIDE_SECRET_MUST_NOT_READ\n");
const forbidden = join(cwd, "forbidden.txt");
const body = (content: TranscriptContext["messages"][number]["content"]) => typeof content === "string" ? content : content.flatMap(item => item.type === "text" ? [item.text] : []).join("\n");
const modelCalls: Array<{ input: string; role: string; tool?: string; error?: boolean }> = [];
const toolsObserved: Array<{ taskId: string; name: string; error: boolean }> = [];
const errors: string[] = [];
let sequence = 0;
const text = (value: string): AssistantMessage["content"] => [{ type: "text", text: value }];
const tool = (name: string, args: Record<string, string>): AssistantMessage["content"] => [{ type: "toolCall", id: `team-call-${++sequence}`, name, arguments: args }];
const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
models.registerProvider("teamfixture", { api: "openai-completions", apiKey: "local-fixture-only", baseUrl: "http://127.0.0.1:1",
  models: [{ id: "test", name: "Team fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  streamSimple: (model, request) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const last = request.messages.at(-1), user = [...request.messages].reverse().find(message => message.role === "user");
      const input = user ? body(user.content) : "";
      modelCalls.push({ input, role: last?.role ?? "", tool: last?.role === "toolResult" ? last.toolName : undefined,
        error: last?.role === "toolResult" ? last.isError : undefined });
      const assignment = JSON.parse(input).teamAssignment;
      let content: AssistantMessage["content"];
      if (assignment.role === "owner_summary") {
        assert(input.includes("APPROVED_TEAM_WRITE_VERIFIED"), "owner receives successful member result");
        assert(input.includes("READONLY_MEMBER_WRITE_BLOCKED"), "owner receives restricted member result");
        assert(input.includes("proposed"), "approval never implies business acceptance");
        content = text("TEAM_APPROVAL_OWNER_RESULT: APPROVED_TEAM_WRITE_VERIFIED; READONLY_MEMBER_WRITE_BLOCKED; awaiting acceptance.");
      } else if (assignment.responsibility === "WRITE_APPROVAL_ASSIGNMENT") {
        const results = request.messages.filter(message => message.role === "toolResult");
        if (results.length === 0) content = tool("write", { path: join(cwd, "approved.txt"), content: "APPROVED_TEAM_WRITE_VERIFIED\n" });
        else if (results.length === 1) {
          assert(last?.role === "toolResult" && !last.isError, "authorized team member write really succeeds");
          assert.equal(readFileSync(join(cwd, "approved.txt"), "utf8"), "APPROVED_TEAM_WRITE_VERIFIED\n");
          content = tool("write", { path: outside, content: "must not replace outside file" });
        } else if (results.length === 2) {
          assert(last?.role === "toolResult" && last.isError, "exact approval cannot override team directory boundary");
          content = tool("bash", { command: `printf forbidden > '${forbidden}'` });
        } else {
          assert(last?.role === "toolResult" && last.isError, "exact approval cannot authorize opaque team shell tools");
          content = text("APPROVED_TEAM_WRITE_VERIFIED; outside write and opaque shell blocked; awaiting acceptance.");
        }
      } else {
        assert.equal(assignment.responsibility, "READONLY_APPROVAL_ASSIGNMENT");
        if (last?.role !== "toolResult") content = tool("write", { path: join(cwd, "readonly-forbidden.txt"), content: "must not write" });
        else {
          assert(last.isError, "one-time Work grant cannot elevate the actual member bot's readonly authority");
          content = text("READONLY_MEMBER_WRITE_BLOCKED; awaiting acceptance.");
        }
      }
      const stopReason = content.some(item => item.type === "toolCall") ? "toolUse" : "stop";
      const message: AssistantMessage = { role: "assistant", content, stopReason, api: model.api, model: model.id, provider: model.provider,
        timestamp: Date.now(), usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: stopReason, message }); stream.end();
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
      const policy = createDurableToolPolicy({ taskId: task.id, taskRoot: cwd, getPermissionMode: () => db.getTask(task.id)?.permissionMode ?? "default", toolAllowed: () => true,
        interactions: new ConversationInteractionService(new ConversationInteractionRepository(db.connection), () => {}),
        attempts: new ExecutionAttemptRepository(db.connection), failures: new ExecutionFailureRepository(db.connection),
        resourcePolicy: new WorkToolResourcePolicy(works.resourceGate, context => {
          const binding = works.repo.bindingForTask(context.taskId); assert(binding);
          return { taskId: binding.taskId, durableStoreKey: binding.durableStoreKey, conversationId: binding.conversationId,
            workspaceBinding: binding.workspaceBinding, bindingId: binding.bindingId, workId: binding.workId };
        }, { allowGitBranchOrWorktree: () => false }),
        approveWorkAction: (input, signal) => works.approvals.request(input, signal),
        workActionApproved: (taskId, operationId, toolName) => works.approvals.approvedTaskAction(taskId, operationId, toolName),
        admitWorkAction: input => works.admitTaskAction(task.id, input), settleWorkAction: (operationId, outcome) => works.settleTaskAction(task.id, operationId, outcome) });
      return { contextHooks: [], tools: [], toolHooks: { beforeTool: policy.hooks.beforeTool,
        afterTool: async (call, result, api, context) => {
          const settled = await policy.hooks.afterTool?.(call, result, api, context) ?? result;
          toolsObserved.push({ taskId: task.id, name: call.name, error: Boolean(settled.isError) }); return settled;
        } } };
    }, onSettled: () => adapter?.wake(), emit: () => {} });
  adapter = new WorkExecutionAdapter(works, { ...native.workExecutionPort(), resourceBoundary: "host-action-gate" }, LOCAL_USER_ID, () => true, (_id, error) => errors.push(String(error)));
  queue = new WorkDispatchQueue(db, works, adapter, () => true, () => "teamfixture/test", () => "default");
}
async function close() { await queue.close(); await adapter.close(); await native.close(); db.close(); }
open();
try {
  const full = { ...DESKTOP_USER_GRANTS, targetWhitelist: [cwd], allowRedelegation: true };
  const readonly = { ...full, allowedScopes: ["workspace:read"] };
  const ids = ["team-owner", "team-writer", "team-reader"];
  ids.forEach((botId, index) => bots.registerBot({ userId: LOCAL_USER_ID, botId, displayName: botId,
    responsibilitySummary: "Explicit local regression fixture", authorization: index === 2 ? readonly : full }));
  const actor: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: full };
  const request: CreateTeamWorkRequest = { operationId: randomUUID(), title: "Native team exact approval regression",
    goalDescription: "Write authorized result, retain team boundaries, summarize actual results", ownerBotId: ids[0]!,
    ownerResponsibility: "Summarize actual member results; no implicit acceptance", workspacePath: cwd,
    members: [{ botId: ids[1]!, responsibility: "WRITE_APPROVAL_ASSIGNMENT", delegatedScope: ["workspace:read", "workspace:write"] },
      { botId: ids[2]!, responsibility: "READONLY_APPROVAL_ASSIGNMENT", delegatedScope: ["workspace:read"] }],
    criteria: ["Actual write and all denied boundary attempts are accurately reported"], budgetTokens: 32768 };
  const result = works.teams.handle(actor, { kind: "create", request }); assert(result.ok && result.work, JSON.stringify(result));
  const workId = result.work.workId;
  const approved: string[] = [];
  const deadline = Date.now() + 30_000;
  while (works.teams.get(workId)?.state !== "awaiting_review") {
    await queue.flush();
    for (const approval of works.approvals.list(workId).filter(item => item.status === "pending")) {
      assert.equal(db.getTask(approval.taskId)?.permissionMode, "default", "team-created task inherits callback default, never auto");
      if (approval.toolName === "write" && !approval.scopeMissing) {
        assert.match(approval.detail, /工作目录之外的写入/, "the remaining write card is a boundary attempt, never the authorized in-workspace write");
        assert.equal(existsSync(join(cwd, "approved.txt")), true,
          "the authorized in-workspace write already ran by scope, without a default-mode card");
      }
      const work = works.getWork(workId)!;
      const decision = { approvalId: approval.approvalId, workId, bindingId: approval.bindingId,
        expectedVersion: approval.version, expectedStateVersion: work.stateVersion,
        expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch,
        approved: true, grantScopeOnce: true };
      assert(works.approvals.decide(LOCAL_USER_ID, decision).ok);
      approved.push(approval.approvalId);
    }
    if (Date.now() > deadline) throw Error(`Team approval timed out: ${JSON.stringify(works.teams.get(workId))}; ${errors.join(";")}`);
    await delay(20);
  }
  await queue.flush();
  assert.deepEqual(errors, []);
  assert.equal(approved.length, 2, "only outside write and missing member scope require decisions; literal in-workspace printf is proven by policy");
  assert(works.approvals.list(workId).filter(item => approved.includes(item.approvalId)).every(item => item.toolName === "write"),
    "a proven local shell write does not request redundant approval, while the separate team tool boundary still rejects execution");
  assert.equal(readFileSync(join(cwd, "approved.txt"), "utf8"), "APPROVED_TEAM_WRITE_VERIFIED\n");
  assert.equal(readFileSync(outside, "utf8"), "OUTSIDE_SECRET_MUST_NOT_READ\n");
  assert(!existsSync(forbidden)); assert(!existsSync(join(cwd, "readonly-forbidden.txt")));
  assert.equal(toolsObserved.filter(item => !item.error && item.name === "write").length, 1);
  assert.equal(toolsObserved.filter(item => item.error).length, 3);
  const team = works.teams.get(workId)!;
  assert.equal(team.executions.length, 3); assert(team.executions.every(item => item.status === "completed"));
  assert(team.executions.at(-1)?.resultSummary?.includes("TEAM_APPROVAL_OWNER_RESULT"));
  const readerBinding = works.repo.listBindings(workId).find(binding => binding.botId === ids[2])!;
  assert.deepEqual(readerBinding.delegatedScope, ["workspace:read"]);
  assert.deepEqual(bots.getBot(ids[2]!)!.authorization.allowedScopes, ["workspace:read"]);
  assert.equal(works.getWork(workId)!.acceptedDeliverableIds.length, 0);
  assert(works.repo.listDeliverables(workId).every(item => item.status === "proposed"));
  assert.equal(works.collaboration.history(workId).filter(item => item.kind === "result").length, 3);
  const before = modelCalls.length;
  for (let i = 0; i < 3; i++) await queue.flush();
  assert.equal(modelCalls.length, before, "settled team never repeats native actions");
  console.log("PASS native team default approval: explicit write-authorized member writes real file, owner receives results; exact grants never bypass workspace/tool/member boundaries or accept results");
} finally { await close(); rmSync(root, { recursive: true, force: true }); }
