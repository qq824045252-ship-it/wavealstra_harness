import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { CodemodeStoreDoc } from "@earendil-works/pi-durable/codemode";
import type { EntryDraft } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { CONFIG_DIR_NAME, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ConversationBranchAgentPort } from "../src/main/agent/ConversationBranchService";
import type { CreateConversationBranchRequest } from "../src/shared/conversation-branch";

const root = mkdtempSync(join(tmpdir(), "durable-branch-service-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { DurableBotRuntime } = await import("../src/main/agent/durable/DurableBotRuntime");
const { DurableBotService } = await import("../src/main/agent/durable/DurableBotService");
const { ConversationBranchService } = await import("../src/main/agent/ConversationBranchService");
const { TaskWorkspaceBrancher } = await import("../src/main/task/TaskWorkspaceBrancher");
const { TaskExecutionWorkspace } = await import("../src/main/task/TaskExecutionWorkspace");
const { ArtifactService } = await import("../src/main/artifact/ArtifactService");
const { ArtifactStorage } = await import("../src/main/artifact/ArtifactStorage");
const { ArtifactRepository } = await import("../src/main/artifact/ArtifactRepository");
const { ArtifactRegistry } = await import("../src/main/artifact/ArtifactRegistry");
const { installModelInvocationAdmission } = await import("../src/main/agent/ModelInvocationAdmission");
const agentDir = join(root, ".mybuddy");
mkdirSync(agentDir, { recursive: true });
const db = new AppDatabase(join(root, "app.db"));
const workspace = new TaskExecutionWorkspace(join(root, "workspaces"));
const sourceCwd = workspace.ensureTaskExecutionWorkspace("source");
writeFileSync(join(sourceCwd, "notes.txt"), "source notes");
db.upsertTask({ id: "source", title: "Source", cwd: sourceCwd, updatedAt: 1, modelId: "fixture/model" });
const models = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
  modelsStorePath: join(agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
let requests = 0;
const answer = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop",
  api: "openai-completions", provider: "fixture", model: "model", timestamp: Date.now(),
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } } });
models.registerProvider("fixture", { api: "openai-completions", apiKey: "fixture", baseUrl: "http://127.0.0.1:1",
  models: [{ id: "model", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], streamSimple: () => {
    requests++;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message: answer("new reply") }); stream.end(); });
    return stream;
  } });
await models.refresh({ allowNetwork: false });
const sourceDirectory = join(agentDir, "durable", createHash("sha256").update("source").digest("hex"));
const runtimeOptions = { models, toolMode: "native" as const, instructions: () => "fixture", onSnapshot: () => {} };
const source = await DurableBotRuntime.open({ ...runtimeOptions, directory: sourceDirectory, cwd: sourceCwd });
const append = (entry: EntryDraft, stage: string) => source.conversation.commit(async tx => {
  (await tx.doc(CodemodeStoreDoc, source.conversation.id)).values = { stage };
  return tx.appendEntry(source.conversation.id, entry);
}, context);
const user1 = await append({ kind: "mybuddy.user", model: [{ role: "user", content: "q1", timestamp: 1 }],
  data: { mybuddyInput: { text: "q1", displayText: "question one", attachments: [] } } }, "before-first");
await append({ kind: "pi.assistant", model: [{ ...answer(""), stopReason: "toolUse",
  content: [{ type: "toolCall", id: "before-leaf", name: "read", arguments: { path: "notes.txt" } }] }] }, "after-tool");
const result1 = await append({ kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "before-leaf", toolName: "read",
  timestamp: 2, isError: false, content: [{ type: "text", text: "source notes" }] }] }, "after-tool");
const reply1 = await append({ kind: "pi.assistant", model: [answer("a1")] }, "after-first");
await append({ kind: "pi.compaction", head: "self", model: [{ role: "user", content: "compacted q1", timestamp: 3 }] }, "compacted");
const user2 = await append({ kind: "pi.user", model: [{ role: "user", content: "q2", timestamp: 4 }] }, "before-second");
await append({ kind: "pi.assistant", model: [answer("a2")] }, "after-second");
const sourceContext = await source.conversation.context(context);
await source.close();
const consumed: string[] = [];
const bots = new DurableBotService({ db, models, agentDir, mcpDir: join(agentDir, "mcp"),
  resolveCwd: taskId => db.getTask(taskId)?.cwd ?? workspace.ensureTaskExecutionWorkspace(taskId),
  instructions: () => "fixture", toolMode: () => "native", defaultModel: () => "fixture/model", emit: () => {},
  onEntries: (taskId, entries) => { if (entries.length) consumed.push(taskId); } });
let enabled = true;
const port: ConversationBranchAgentPort = {
  isTaskBusy: taskId => bots.busy(taskId),
  resolveTaskExecutionWorkspaceCwd: taskId => db.getTask(taskId)?.cwd ?? workspace.ensureTaskExecutionWorkspace(taskId),
  getAppSettings: () => ({ conversationBranchEnabled: enabled }), setTaskConnectorIds: () => {},
  previewConversationBranch: request => bots.previewBranch(request),
  materializeConversationBranch: (...args) => bots.materializeBranch(...args),
  commitConversationBranch: (...args) => bots.commitBranch(...args),
};
const artifacts = new ArtifactService(new ArtifactStorage(join(root, "artifacts")), new ArtifactRepository(db.connection), new ArtifactRegistry());
const brancher = new TaskWorkspaceBrancher(workspace);
const service = new ConversationBranchService({ db, agent: port, brancher, artifactService: artifacts });
const request = (overrides: Partial<CreateConversationBranchRequest> = {}): CreateConversationBranchRequest => ({
  sourceTaskId: "source", entryId: String(user1.id), position: "after_reply", requestId: randomUUID(), ...overrides,
});
const openChild = async (taskId: string) => {
  await bots.release(taskId);
  const binding = db.connection.prepare("SELECT directory,cwd FROM durable_bot_bindings WHERE task_id=?").get(taskId) as { directory: string; cwd: string };
  return DurableBotRuntime.open({ ...runtimeOptions, ...binding });
};
try {
  await artifacts.register({ taskId: "source", kind: "code", title: "Before", content: "before", producerToolCallId: "before-leaf" });
  await artifacts.register({ taskId: "source", kind: "code", title: "After", content: "after", producerToolCallId: "after-leaf" });
  assert.equal((await service.preview(request())).ok, true, "a new Durable task needs no sessionFile");
  for (const anchor of [reply1, result1]) {
    const preview = await service.preview(request({ entryId: String(anchor.id) }));
    assert(preview.ok, "assistant/tool-result entry IDs from the real branch button resolve their owning user turn");
  }
  const same = request({ entryId: String(reply1.id) });
  const [first, duplicate] = await Promise.all([service.create(same), service.create(same)]);
  assert(first.ok && duplicate.ok);
  const childId = first.result.task.id;
  assert.equal(duplicate.result.task.id, childId, "concurrent duplicate requests produce one child");
  assert.equal(first.result.task.sessionFile, undefined);
  assert.equal(first.result.inheritedArtifactCount, 1, "only artifacts before the chosen reply are inherited");
  assert.equal(first.result.task.cwd, workspace.resolveTaskExecutionWorkspaceDir(childId));
  assert.equal(readFileSync(join(first.result.task.cwd!, "notes.txt"), "utf8"), "source notes");
  assert.equal(requests, 0, "creating and previewing branches never invokes the provider");
  assert.equal((await bots.history(childId)).messages.filter(message => message.role === "user")[0].text, "question one");
  assert(!consumed.includes(childId), "inherited records do not re-enter usage, memory or audit consumers");
  const child = await openChild(childId);
  assert.equal((await child.harness.snapshot(CodemodeStoreDoc, child.conversation.id, context))?.values.stage, "after-first");
  assert(!(await child.conversation.context(context)).messages.some(message => message.role === "user" && message.content === "q2"));
  await child.close();

  const later = await service.create(request({ entryId: String(user2.id) }));
  assert(later.ok);
  const laterRuntime = await openChild(later.result.task.id);
  assert.deepEqual((await laterRuntime.conversation.context(context)).messages, sourceContext.messages, "context heads survive copying");
  await laterRuntime.close();
  const inheritedUser = (await bots.history(later.result.task.id)).messages.find(message => message.role === "user");
  assert(inheritedUser?.entryId);
  const grandchild = await service.create(request({ sourceTaskId: later.result.task.id, entryId: inheritedUser.entryId, position: "after_user" }));
  assert(grandchild.ok);
  assert.equal(grandchild.result.branch.rootTaskId, "source");
  const grandRuntime = await openChild(grandchild.result.task.id);
  assert.equal((await grandRuntime.harness.snapshot(CodemodeStoreDoc, grandRuntime.conversation.id, context))?.values.stage, "before-first",
    "forking inside inherited history restores the native store at that earlier entry");
  assert.deepEqual((await grandRuntime.conversation.context(context)).messages, user1.model);
  await grandRuntime.close();

  const empty = await service.create(request({ workspaceStrategy: "conversation_only" }));
  assert(empty.ok);
  assert(!existsSync(join(empty.result.task.cwd!, "notes.txt")));
  enabled = false;
  assert.equal((await service.create(request())).ok, false);
  enabled = true;
  const missing = await service.create(request({ entryId: "missing" }));
  assert(!missing.ok && missing.code === "ANCHOR_NOT_FOUND");
  const count = db.listTasks().length;
  const lineageCount = db.listConversationBranchChildren("source").length;
  db.connection.exec("CREATE TRIGGER fail_branch_watermark BEFORE INSERT ON durable_bot_memory_projection BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  const failed = await service.create(request());
  assert(!failed.ok && failed.code === "TASK_CREATE_FAILED");
  assert.equal(db.listTasks().length, count);
  assert.equal(db.listConversationBranchChildren("source").length, lineageCount);
  db.connection.exec("DROP TRIGGER fail_branch_watermark");
  const collision = await service.create({ ...same, sourceTaskId: "unrelated" });
  assert(!collision.ok && collision.code === "INVALID_REQUEST");

  // Process policy denies the model; the bound task directory explicitly allows it.
  const fallbackDir = join(root, "process-policy");
  mkdirSync(fallbackDir);
  const fallback = SettingsManager.create(fallbackDir, fallbackDir);
  fallback.setEnabledModels(["missing/model"]);
  await fallback.flush();
  installModelInvocationAdmission(models, () => fallback);
  const projectConfigDir = join(first.result.task.cwd!, CONFIG_DIR_NAME);
  mkdirSync(projectConfigDir, { recursive: true });
  const projectConfigFile = join(projectConfigDir, "settings.json");
  writeFileSync(projectConfigFile, JSON.stringify({ enabledModels: ["fixture/model"] }));
  const accepted = await bots.prompt({ taskId: childId, text: "continue", userMessageId: "new-input", assistantMessageId: "new-answer" }, false);
  assert.equal(accepted.receipt?.status, "done", "the task's model policy overrides process cwd");
  assert.equal(requests, 1);
  await bots.release(childId);
  writeFileSync(projectConfigFile, JSON.stringify({ enabledModels: ["missing/model"] }));
  const rejected = await bots.prompt({ taskId: childId, text: "denied", userMessageId: "denied-input", assistantMessageId: "denied-answer" }, false);
  assert(rejected.error || rejected.receipt?.status !== "done");
  assert.equal(requests, 1, "a reopened task still enforces its directory's enabledModels");
  await bots.release("source");
  const reopened = await DurableBotRuntime.open({ ...runtimeOptions, directory: sourceDirectory, cwd: sourceCwd });
  assert.deepEqual((await reopened.conversation.context(context)).messages, sourceContext.messages, "child continuation never changes the source");
  await reopened.close();
  console.log("PASS native branches, historical store/context, inheritance, idempotency, rollback and task model policy");
} finally { await bots.close(); db.close(); }
