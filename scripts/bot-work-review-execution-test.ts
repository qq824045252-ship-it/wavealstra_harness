import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService } from "../src/main/agent/work/WorkService";
import { ConversationGoalService } from "../src/main/agent/ConversationGoalService";
import { WorkExecutionAdapter, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Cursor, EntryQuery, EntryRecord, SubmissionRecord } from "@earendil-works/pi-durable";
import { readDurableWorkExecution } from "../src/main/agent/durable/DurableWorkExecutionProjection";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult } from "../src/shared/bot-work";

const root = mkdtempSync(join(tmpdir(), "bot-work-review-execution-"));
const db = new AppDatabase(join(root, "work.db"));
const bots = new BotRegistry(db.connection);
bots.ensureDefaultBot(LOCAL_USER_ID);
const service = new WorkService(db.connection, { bots });
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: {
  allowedScopes: ["workspace:read", "workspace:write"], targetWhitelist: [],
  allowGitBranchOrWorktree: false, allowRedelegation: true,
} };
let serial = 0;
const operation = () => `review-execution-${++serial}`;
const unwrap = (result: WorkControlResult) => {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.work;
};
const create = (taskId = operation()) => unwrap(service.createWork(user, {
  operationId: operation(), title: "执行接线检查", inputSnapshotId: "input-A",
  conversationId: taskId, legacyTaskId: taskId, authorization: user.grants,
  criteria: [{ id: "verified", text: "成果已核验" }],
}));
const bind = (workId: string, taskId: string) => {
  const dispatched = unwrap(service.dispatchExecution(user, {
    operationId: operation(), workId, botId: DEFAULT_BOT_ID, taskId,
    durableStoreKey: `store:${taskId}`, conversationId: `native:${taskId}`, workspaceBinding: root,
  }));
  return service.repo.getBinding(dispatched.activeExecutionIds.at(-1)!)!;
};
const failures: string[] = [];
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}`, error); }
}

try {
  await check("a background execution keeps worker authority when calling legacy Goal tools", () => {
    const taskId = operation();
    const work = create(taskId);
    const binding = bind(work.workId, taskId);
    const goals = new ConversationGoalService(service, () => {}, { resolveBotId: () => DEFAULT_BOT_ID });
    const before = service.getWork(work.workId)!;
    const result = goals.update({ goalId: work.workId, status: "cancelled" }, {
      actor: goals.modelActor(taskId), versionGuard: {
        expectedStateVersion: before.stateVersion, expectedIntentRevision: before.intentRevision,
        expectedOwnerEpoch: before.ownerEpoch,
      },
    });
    assert.equal(result.ok, false, "a worker must not cancel its owner's Work through the Goal facade");
    assert.equal(service.getWork(work.workId)?.lifecycle, "active");
    assert.deepEqual(goals.modelActor(taskId), { kind: "worker", botId: binding.botId, bindingId: binding.bindingId });
    assert.equal(goals.modelActor("unbound-desktop-task").kind, "bot", "foreground calls retain their host-derived Bot identity");
    unwrap(service.cancelWork(user, { operationId: operation(), workId: work.workId }));
    unwrap(service.reconcileExecution(user, { bindingId: binding.bindingId, outcome: "stopped" }));
  });

  await check("Goal reads an unlinked worker's assigned Work and cannot create another owner obligation", () => {
    const work = unwrap(service.createWork(user, { operationId: operation(), title: "受限委托", inputSnapshotId: "input-A",
      authorization: { ...user.grants, allowRedelegation: false } }));
    const taskId = operation();
    const binding = bind(work.workId, taskId);
    const goals = new ConversationGoalService(service, () => {}, { resolveBotId: () => DEFAULT_BOT_ID });
    assert.deepEqual(service.repo.listConversationIds(work.workId), [], "worker context does not become a foreground conversation");
    assert.equal(goals.getLive(taskId)?.id, work.workId);
    assert.equal(goals.getLive(taskId, "unrelated-work"), undefined, "an explicit unrelated Work cannot replace the trusted binding");
    const before = service.listWorks(LOCAL_USER_ID, { includeClosed: true }).length;
    const result = goals.create({ taskId, title: "worker-created-long-term-work" }, { actor: goals.modelActor(taskId) });
    assert.equal(result.ok, false, "Goal create must not promote a worker to an owner");
    assert.equal(service.listWorks(LOCAL_USER_ID, { includeClosed: true }).length, before);
    const otherUser = new ConversationGoalService(service, () => {}, { userId: "other-user" });
    assert.equal(otherUser.getLive(taskId), undefined, "the trusted binding does not grant a different user access");
    unwrap(service.cancelWork(user, { operationId: operation(), workId: work.workId }));
    unwrap(service.reconcileExecution(user, { bindingId: binding.bindingId, outcome: "stopped" }));
    assert.equal(goals.getLive(taskId), undefined, "closed Work is not advertised as a live Goal");
  });

  await check("cancelled recovery settles a completed original receipt before trying to stop a changed active conversation", async () => {
    const work = create();
    const binding = bind(work.workId, operation());
    unwrap(service.cancelWork(user, { operationId: operation(), workId: work.workId }));
    const receipt: AgentSubmissionReceipt = { taskId: binding.taskId, operationId: binding.operationId,
      submissionId: 7, status: "done" };
    let submissions = 0;
    let stops = 0;
    const errors: unknown[] = [];
    const port: WorkExecutionPort = {
      prepare: async () => { throw new Error("existing recovery must use its original namespace"); },
      find: async candidate => candidate.bindingId === binding.bindingId ? receipt : undefined,
      submit: async () => { submissions++; throw new Error("completed input must not be submitted again"); },
      inspect: async () => ({ status: "completed", summary: "原执行完成", hasWriteConflicts: false, artifactRefs: ["result.txt"] }),
      stop: async () => { stops++; throw new Error("停止目标与原执行会话不一致"); },
    };
    const adapter = new WorkExecutionAdapter(service, port, LOCAL_USER_ID, () => true, (_id, error) => errors.push(error));
    await adapter.flush();
    await adapter.close();
    assert.equal(stops, 0, "a completed original input needs reconciliation, not a new abort against the active task");
    assert.equal(submissions, 0);
    assert.deepEqual(errors, []);
    assert.equal(service.repo.getBinding(binding.bindingId)?.status, "completed");
    assert.equal(service.getWork(work.workId)?.closureConclusion, "cancelled");
    assert.deepEqual(service.repo.listDeliverables(work.workId).map(item => item.artifactRefs), [["result.txt"]]);
  });
  await check("cancelled running input is stopped in its original binding and inspected again", async () => {
    const work = create();
    const binding = bind(work.workId, operation());
    unwrap(service.cancelWork(user, { operationId: operation(), workId: work.workId }));
    const receipt: AgentSubmissionReceipt = { taskId: binding.taskId, operationId: binding.operationId,
      submissionId: 8, status: "placed" };
    const calls: string[] = [];
    const errors: unknown[] = [];
    const port: WorkExecutionPort = {
      prepare: async () => { throw new Error("must recover the existing namespace"); },
      find: async candidate => { assert.equal(candidate.bindingId, binding.bindingId); return receipt; },
      submit: async () => { throw new Error("must not submit another input after cancellation"); },
      stop: async candidate => {
        assert.equal(candidate.bindingId, binding.bindingId);
        assert.equal(candidate.conversationId, binding.conversationId);
        calls.push("stop");
      },
      inspect: async (candidate, accepted) => {
        assert.equal(candidate.bindingId, binding.bindingId); assert.deepEqual(accepted, receipt);
        const stopped = calls.includes("stop"); calls.push("inspect");
        return stopped ? { status: "stopped", summary: "已停止原执行", hasWriteConflicts: false, artifactRefs: [] }
          : { status: "running" };
      },
    };
    const adapter = new WorkExecutionAdapter(service, port, LOCAL_USER_ID, () => true, (_id, error) => errors.push(error));
    await adapter.flush(); await adapter.close();
    assert.deepEqual(calls, ["inspect", "stop", "inspect"]);
    assert.deepEqual(errors, []);
    assert.equal(service.repo.getBinding(binding.bindingId)?.status, "stopped");
    assert.equal(service.getWork(work.workId)?.closureConclusion, "cancelled");
  });

  const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({ role: "assistant", content,
    stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
    api: "openai-completions", model: "fixture", provider: "fixture", timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const entry = (id: number, conversationId: number, model: EntryRecord["model"] = []): EntryRecord => ({
    id: id as EntryRecord["id"], conversationId: conversationId as EntryRecord["conversationId"],
    kind: "pi.assistant", model,
  });
  const effectEntries = (start: number, conversationId: number, path: string, conflicts: string[] = []) => [
    entry(start, conversationId, [assistant([{ type: "toolCall", id: `call-${start}`, name: "fixture", arguments: {} }])]),
    entry(start + 1, conversationId, [{ role: "toolResult", toolCallId: `call-${start}`, toolName: "fixture",
      content: [{ type: "text", text: "已完成工具" }], details: { imagePaths: [path], nested: { writeConflicts: conflicts } },
      isError: false, timestamp: 2 }]),
  ];
  const completed = (input: number, answer: number, conversationId = 1): SubmissionRecord => ({ type: "input", status: "done",
    id: 9 as SubmissionRecord["id"], requestId: "original-operation", conversationId: conversationId as SubmissionRecord["conversationId"],
    entry: input as EntryRecord["id"], answer: answer as EntryRecord["id"],
  });
  const persisted = (entries: EntryRecord[], onPage = () => {}) => ({
    scanEntries: async (query: EntryQuery, limit: number, cursor?: Cursor) => {
      onPage();
      const selected = entries.filter(item => item.conversationId === query.conversationId
        && item.id >= (query.minEntryId ?? 0) && item.id <= (query.maxEntryId ?? Infinity))
        .sort((left, right) => query.order === "ascending" ? left.id - right.id : right.id - left.id);
      const offset = typeof cursor?.offset === "number" ? cursor.offset : 0;
      const end = offset + limit;
      return { items: selected.slice(offset, end), next: end < selected.length ? { offset: end } : undefined };
    },
  });

  await check("original submission evidence excludes earlier and later inputs and a different active conversation", async () => {
    const entries = [
      ...effectEntries(1, 1, "old.png", ["old-conflict"]),
      entry(10, 1), ...effectEntries(11, 1, "original.png"),
      entry(13, 1, [assistant([{ type: "text", text: "本次成果" }])]),
      ...effectEntries(14, 1, "later.png", ["later-conflict"]),
      ...effectEntries(11, 2, "active-fork.png", ["fork-conflict"]),
    ];
    const result = await readDurableWorkExecution(persisted(entries), completed(10, 13));
    assert.deepEqual(result, { status: "completed", summary: "本次成果", hasWriteConflicts: false, artifactRefs: ["original.png"], sourceEntryId: 13, usageTokens: 4 });
  });

  await check("a long submission retains early conflict evidence beyond the bounded UI history window", async () => {
    let pages = 0;
    const entries = [entry(20, 1), ...effectEntries(21, 1, "early.png", ["actual-conflict"]),
      ...Array.from({ length: 205 }, (_, index) => entry(index + 23, 1)),
      entry(228, 1, [assistant([{ type: "text", text: "长执行成果" }])]),
    ];
    const result = await readDurableWorkExecution(persisted(entries, () => pages++), completed(20, 228));
    assert.equal(result.status, "completed");
    assert.equal(result.hasWriteConflicts, true, "an early real conflict must still block acceptance");
    assert.deepEqual(result.artifactRefs, ["early.png"]);
    assert.ok(pages > 1, "persisted evidence must span the scan boundary");
  });
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
if (failures.length) throw new Error(`${failures.length} execution review regressions failed: ${failures.join(", ")}`);
console.log(`${passed} execution review regressions passed`);
