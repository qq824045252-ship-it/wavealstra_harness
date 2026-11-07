/** Isolated model/effect fixtures; execution, children, policy, storage and recovery are production code. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { JsonObject } from "@earendil-works/pi-durable";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkHostAuthority } from "../src/main/agent/work/WorkHostAuthority";
import { WorkExecutionAdapter } from "../src/main/agent/work/WorkExecutionAdapter";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { WorkToolResourcePolicy } from "../src/main/agent/work/WorkToolResourcePolicy";
import { WorkProjectionJournal } from "../src/main/agent/work/WorkProjectionJournal";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { createDurableSubagentTools } from "../src/main/agent/durable/DurableSubagents";
import { createDurableToolPolicy } from "../src/main/agent/durable/DurableToolPolicy";
import { guardSubagentWriteCall } from "../src/main/capabilities/subagent/write-conflict";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ExecutionAttemptRepository } from "../src/main/agent/ExecutionAttemptRepository";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";

export const HOST_LEASE_TTL_MS = 1000;
// Shared parallel writers are explicitly permitted in this isolated fixture; each model requests shared.
// No branch/worktree is created by this test. The separate BW-A32 suite covers forbidden isolation.
export const grants = { ...DESKTOP_USER_GRANTS, allowedScopes: ["workspace:read", "workspace:write", "delegate"], allowRedelegation: true, allowGitBranchOrWorktree: true };
export const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants };
export const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
export const unwrap = (result: WorkControlResult) => { if (!result.ok) throw Error(`${result.code}: ${result.message}`); return result.work; };
export const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
export async function waitFor(predicate: () => boolean | Promise<boolean>, description: string, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) { if (Date.now() > deadline) throw Error(`timeout: ${description}`); await delay(20); }
}
const deferred = () => { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; };
const bodyText = (content: TranscriptContext["messages"][number]["content"]) => typeof content === "string" ? content : content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");

export async function openNativeHost(root: string, stage: number) {
  const cwd = join(root, "workspace"), agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true }); mkdirSync(cwd, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(join(agentDir, "agents", "writer.md"), "---\nname: writer\ndescription: native story isolated file worker\ntools: write\n---\nPerform exactly the assigned isolated fixture write.\n");
  const ids = ["old", "root", "retain", "blocked", "gap", "repair", "watch", "front", "provenance"];
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "phase5", defaultModel: "root", enabledModels: ids.map(id => `phase5/${id}`) }));
  writeFileSync(join(agentDir, "subagent.json"), JSON.stringify({ maxConcurrency: 2 }));
  const db = new AppDatabase(join(root, "business.db"));
  // This database observes *actual* provider/tool calls. It never supplies Work/native terminal facts.
  const ledger = new Database(join(root, "external.db"));
  ledger.pragma("journal_mode=WAL"); ledger.pragma("synchronous=FULL");
  ledger.exec(`CREATE TABLE IF NOT EXISTS model_calls(id INTEGER PRIMARY KEY AUTOINCREMENT,stage INTEGER NOT NULL,model TEXT NOT NULL,last_role TEXT,last_error INTEGER NOT NULL,prompt_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS effects(id INTEGER PRIMARY KEY AUTOINCREMENT,stage INTEGER NOT NULL,task_id TEXT NOT NULL,conversation_id TEXT NOT NULL,marker TEXT NOT NULL,path TEXT NOT NULL,content_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,effect_key TEXT NOT NULL,receipt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS steps(number INTEGER PRIMARY KEY,name TEXT NOT NULL,evidence_json TEXT NOT NULL);`);
  const bots = new BotRegistry(db.connection);
  for (const botId of [DEFAULT_BOT_ID, "phase5-next-owner", "phase5-collaborator"]) if (!bots.getBot(botId)) bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: botId, authorization: grants });
  const lease = new WorkHostAuthority(db.connection, `host-${process.pid}`, HOST_LEASE_TTL_MS);
  assert(lease.start().ok, "each real process must acquire the same persisted authority lease");
  const works = new WorkService(db.connection, { bots, isAuthority: () => lease.isAuthority() });
  const oldGate = deferred(), repairGate = deferred();
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
  models.registerProvider("phase5", {
    api: "openai-completions", apiKey: "isolated-model-fixture-only", baseUrl: "http://127.0.0.1:1",
    models: ids.map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple: (model, request) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const last = request.messages.at(-1), latestUser = [...request.messages].reverse().find(message => message.role === "user"), input = latestUser ? bodyText(latestUser.content) : "";
        const call = ledger.prepare("INSERT INTO model_calls(stage,model,last_role,last_error,prompt_hash) VALUES (?,?,?,?,?)")
          .run(stage, model.id, last?.role ?? null, last?.role === "toolResult" && last.isError ? 1 : 0, hash(input)).lastInsertRowid;
        const text = (value: string): AssistantMessage["content"] => [{ type: "text", text: value }];
        const tool = (name: string, args: JsonObject): AssistantMessage["content"] => [{ type: "toolCall", id: `phase5-${call}`, name, arguments: args }];
        let content: AssistantMessage["content"];
        if (model.id === "provenance") {
          if ((last?.role === "toolResult" && last.toolName !== "fixture_hold") || input.includes("provenance-probe")) content = text("原生来源检查完成");
          else if (input.includes("multi-hold") && last?.role !== "toolResult") content = tool("fixture_hold", {});
          else content = tool("conversation_goal_create", { title: "Isolated native input provenance" });
        }
        else if (model.id === "front") content = text("原生后台继续执行；当前事项等待成果审核，普通讨论没有创建新后台任务。");
        else if (last?.role === "toolResult") {
          if (model.id === "old" && stage === 1) await oldGate.promise;
          if (model.id === "repair" && stage === 2) await repairGate.promise;
          content = text(model.id === "root" ? "代码与自动检查通过，等待 Omarchy 实测；是否可验收须逐项核对真实子项结果。" : "原生范围执行结束，等待负责人审核。");
        } else if (model.id === "root") {
          const continuation = input.includes("只完成以下已受理");
          const tasks = continuation ? [{ agent: "writer", task: "gap-two: write the second required result", model: "phase5/gap", isolation: "shared" }]
            : [{ agent: "writer", task: "retain-one: write the first result", model: "phase5/retain", isolation: "shared" },
              { agent: "writer", task: "gap-two: write the second required result", model: "phase5/blocked", isolation: "shared" }];
          content = tool("subagent", { tasks });
        } else {
          const marker = ({ old: "r1-historical", retain: "retain-one", blocked: "must-not-write", gap: "gap-two", repair: "repair-v2", watch: "watch-b" } as Record<string, string>)[model.id];
          assert(marker, `unexpected fixture model ${model.id}`);
          if (model.id === "blocked") await waitFor(() => existsSync(join(cwd, "shared-result.txt")), "first real parallel child write");
          const filename = ["retain", "blocked"].includes(model.id) ? "shared-result.txt" : `${marker}.txt`;
          content = tool("write", { path: join(cwd, filename), content: `${marker}\n` });
        }
        const stopReason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
        const message: AssistantMessage = { role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: stopReason, message }); stream.end();
      });
      return stream;
    },
  });
  const native = new DurableBotService({ db, models, agentDir: join(root, "native"), mcpDir: join(root, "mcp"), resolveCwd: () => cwd,
    instructions: () => "Execute only the assigned isolated fixture scope. Never infer acceptance or closure from root completion.", defaultModel: () => "phase5/root", toolMode: () => "native", toolAllowed: () => true, mcpSelection: () => [],
    beforeSubmit: request => { const problem = works.checkTaskInput(request.taskId, request.userMessageId); if (problem) throw Error(problem); },
    tools: async task => {
      const allowGitIsolation = () => {
        const binding = works.repo.bindingForTask(task.id);
        return Boolean(binding && works.getWork(binding.workId)?.authorization.allowGitBranchOrWorktree);
      };
      const policy = createDurableToolPolicy({ taskId: task.id, taskRoot: cwd, getPermissionMode: () => "auto", toolAllowed: () => true,
        interactions: new ConversationInteractionService(new ConversationInteractionRepository(db.connection), () => {}),
        attempts: new ExecutionAttemptRepository(db.connection), failures: new ExecutionFailureRepository(db.connection),
        resourcePolicy: new WorkToolResourcePolicy(works.resourceGate, context => {
          const binding = works.repo.bindingForTask(context.taskId); assert(binding, "all background tools use a real persisted Work binding");
          return { taskId: binding.taskId, durableStoreKey: binding.durableStoreKey, conversationId: binding.conversationId,
            workspaceBinding: binding.workspaceBinding, bindingId: binding.bindingId, workId: binding.workId,
            childId: String(context.conversationId) === binding.conversationId ? undefined : String(context.conversationId) };
        }, { allowGitBranchOrWorktree: allowGitIsolation }),
        admitWorkAction: input => works.admitTaskAction(task.id, input), settleWorkAction: (operationId, outcome) => works.settleTaskAction(task.id, operationId, outcome) });
      return { contextHooks: [], toolHooks: {
        beforeTool: async (call, api, context) => guardSubagentWriteCall(call, api.conversationId, task.id) ?? await policy.hooks.beforeTool?.(call, api, context),
        afterTool: async (call, result, api, context) => {
          const settled = await policy.hooks.afterTool?.(call, result, api, context) ?? result;
          if (call.name === "write" && !settled.isError) {
            const path = String(call.arguments.path), content = String(call.arguments.content);
            assert.equal(resolve(path), join(cwd, path.split(/[\\/]/).at(-1)!), "native writes stay in the isolated workspace");
            assert.equal(readFileSync(path, "utf8"), content, "the production write tool must have performed the exact effect");
            // Count every successful real native write; no deduplication hides repeated calls.
            ledger.prepare("INSERT INTO effects(stage,task_id,conversation_id,marker,path,content_hash) VALUES (?,?,?,?,?,?)")
              .run(stage, task.id, String(api.conversationId), content.trim(), path, hash(readFileSync(path)));
          }
          return settled;
        },
      }, tools: createDurableSubagentTools({ taskId: task.id, cwd, models, permissionMode: () => "auto", allowGitBranchOrWorktree: allowGitIsolation }) };
    }, emit: () => {} });
  const port = { ...native.workExecutionPort(), resourceBoundary: "host-action-gate" as const };
  const errors: unknown[] = [];
  const adapter = new WorkExecutionAdapter(works, port, LOCAL_USER_ID, () => lease.isAuthority(), (_binding, error) => errors.push(error));
  let dispatchModel = "phase5/old";
  const queue = new WorkDispatchQueue(db, works, adapter, () => lease.isAuthority(), () => dispatchModel);
  const counts = () => ({ modelCalls: (ledger.prepare("SELECT COUNT(*) AS count FROM model_calls").get() as { count: number }).count,
    effects: (ledger.prepare("SELECT COUNT(*) AS count FROM effects").get() as { count: number }).count,
    perModel: ledger.prepare("SELECT model,COUNT(*) AS count FROM model_calls GROUP BY model ORDER BY model").all(),
    perEffect: ledger.prepare("SELECT marker,COUNT(*) AS count FROM effects GROUP BY marker ORDER BY marker").all() });
  const effectCount = (marker: string) => (ledger.prepare("SELECT COUNT(*) AS count FROM effects WHERE marker=?").get(marker) as { count: number }).count;
  const step = (number: number, name: string, evidence: unknown) => {
    ledger.prepare("INSERT INTO steps(number,name,evidence_json) VALUES (?,?,?)").run(number, name, JSON.stringify(evidence));
    console.log(`STEP ${number} PASS ${name}`);
  };
  const flushUntil = async (predicate: () => boolean, description: string) => waitFor(async () => { await queue.flush(); assert.deepEqual(errors.map(String), []); return predicate(); }, description);
  const directSubmission = async (workId: string, taskId: string, modelId: string, botId = DEFAULT_BOT_ID, operationId = `native:${taskId}`) => {
    db.upsertTask({ id: taskId, title: taskId, cwd, modelId, permissionMode: "auto", updatedAt: Date.now() });
    const namespace = await port.prepare(taskId);
    const work = unwrap(works.dispatchExecution(user, { operationId, workId, botId, ...namespace, reserveTokens: 100,
      delegatedScope: ["workspace:read", "workspace:write", "delegate"], versionGuard: guard(works.getWork(workId)!) }));
    const binding = works.repo.listBindings(work.workId).find(entry => entry.taskId === taskId)!; assert(binding);
    works.markDispatchAttempt(binding.bindingId, `attempt:${taskId}`);
    const receipt = await port.submit(binding, works.repo.executionInput(binding));
    return { binding, receipt };
  };
  const queuedSubmissionWithoutReceipt = async (workId: string, operationId: string, modelId: string) => {
    dispatchModel = modelId;
    works.transaction(() => queue.enqueue(works.getWork(workId)!, operationId));
    const request = db.connection.prepare("SELECT task_id,bot_id FROM work_dispatch_requests WHERE operation_id=? AND work_id=?")
      .get(operationId, workId) as { task_id: string; bot_id: string } | undefined;
    assert(request, "the production queue owns the persisted dedicated native request");
    // The real port commits the original input, but the host dies before returning that receipt to the business adapter.
    return directSubmission(workId, request.task_id, modelId, request.bot_id, `dispatch:${operationId}`);
  };
  const close = async () => { await queue.close(); await adapter.close(); await native.close(); lease.stop(); db.close(); ledger.close(); };
  return { root, cwd, db, ledger, bots, lease, works, models, native, port, adapter, queue, errors, journal: new WorkProjectionJournal(db.connection, works),
    oldGate, repairGate, counts, effectCount, step, flushUntil, directSubmission, queuedSubmissionWithoutReceipt,
    setDispatchModel: (model: string) => { dispatchModel = model; }, close };
}
export type NativeHost = Awaited<ReturnType<typeof openNativeHost>>;
