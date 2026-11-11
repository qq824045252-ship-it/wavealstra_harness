import { WorkCollaborationContext } from "../src/main/agent/work/WorkCollaborationContext";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkCollaborationService } from "../src/main/agent/work/WorkCollaborationService";
import { MemoryService } from "../src/main/memory/MemoryService";
import { projectMemoryContext } from "../src/main/agent/MemoryContextProjection";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";
import type { WorkCollaborationInput } from "../src/shared/bot-work-collaboration";

const root = mkdtempSync(join(tmpdir(), "phase3-collaboration-"));
const path = join(root, "work.db");
const db = new AppDatabase(path);
const bots = new BotRegistry(db.connection);
const grants = { ...DESKTOP_USER_GRANTS, allowRedelegation: true };
for (const botId of [DEFAULT_BOT_ID, "collaborator", "uninvolved"]) bots.registerBot({ botId, userId: LOCAL_USER_ID,
  displayName: botId, authorization: grants });
bots.registerBot({ botId: "foreign", userId: "other-user", displayName: "foreign", authorization: grants });
const works = new WorkService(db.connection, { bots });
const collaboration = new WorkCollaborationService(db.connection, works, bots);
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants };
const owner: WorkActor = { kind: "bot", userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, host: "foreground", grants };
const collaborator: WorkActor = { kind: "bot", userId: LOCAL_USER_ID, botId: "collaborator", host: "foreground", grants };
const unwrap = (value: WorkControlResult) => { if (!value.ok) throw new Error(`${value.code}: ${value.message}`); return value.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
try {
  let work = unwrap(works.createWork(user, { operationId: "create", title: "协作资料保持隔离", authorization: grants, inputSnapshotId: "input-1" }));
  work = unwrap(works.addParticipant(user, { operationId: "participant", workId: work.workId, botId: "collaborator", delegatedScope: ["workspace:read"] }));
  db.upsertTask({ id: "collaborator-root", title: "collaborator-root", updatedAt: Date.now() });
  work = unwrap(works.dispatchExecution(user, { operationId: "worker", workId: work.workId, botId: "collaborator", taskId: "collaborator-root",
    durableStoreKey: "collaborator-store", conversationId: "1", workspaceBinding: root, delegatedScope: ["workspace:read"] }));
  const binding = works.repo.listBindings(work.workId)[0];
  const ref = { bindingId: binding.bindingId, taskId: binding.taskId, durableStoreKey: binding.durableStoreKey,
    conversationId: binding.conversationId, workspaceBinding: binding.workspaceBinding };
  const input = (kind: WorkCollaborationInput["kind"], id: string, actor = owner): WorkCollaborationInput => ({
    messageId: id, workId: work.workId, kind, recipientBotIds: [actor === owner ? "collaborator" : DEFAULT_BOT_ID],
    body: `${kind} 的有界协作请求或事实`, executionRefs: ["result", "blocked"].includes(kind) ? [ref] : [],
    versionGuard: guard(works.getWork(work.workId)!),
  });
  const first = input("delegate", "delegate");
  const delivered = collaboration.send(owner, first);
  assert.equal(delivered.replayed, false);
  const version = works.getWork(work.workId)!.stateVersion;
  assert.equal(collaboration.send(owner, first).replayed, true);
  assert.equal(works.getWork(work.workId)!.stateVersion, version);
  assert.throws(() => collaboration.send(owner, { ...first, body: "different" }), /idempotency_conflict/);
  for (const kind of ["accepted", "question", "result", "blocked"] satisfies WorkCollaborationInput["kind"][]) {
    collaboration.send(collaborator, { ...input(kind, kind, collaborator), replyToMessageId: "delegate" });
  }
  for (const kind of ["change", "cancel", "handoff"] satisfies WorkCollaborationInput["kind"][]) collaboration.send(owner, input(kind, kind));
  assert.equal(collaboration.list(user, work.workId).length, 8);
  assert.equal(works.getWork(work.workId)!.lifecycle, "active", "cancel message cannot execute a Work control");
  assert.equal(works.getWork(work.workId)!.intentRevision, 1, "change message cannot amend requirements");
  assert.equal(works.repo.listBindings(work.workId).length, 1, "delegate message cannot bypass dispatch authorization");
  assert.throws(() => collaboration.send(owner, { ...input("question", "crossuser"), recipientBotIds: ["foreign"] }), /合法参与范围/);
  assert.throws(() => collaboration.send(owner, { ...input("question", "outside"), recipientBotIds: ["uninvolved"] }), /合法参与范围/);
  assert.throws(() => collaboration.send(collaborator, input("delegate", "redelegate", collaborator)), /负责人/);
  assert.throws(() => collaboration.send({ kind: "worker", botId: "collaborator", bindingId: binding.bindingId }, input("delegate", "child-recursion", collaborator)), /负责人/);
  assert.throws(() => collaboration.send(collaborator, { ...input("result", "forged", collaborator), executionRefs: [{ ...ref, durableStoreKey: "another-store" }] }), /命名空间/);
  assert.throws(() => collaboration.send(owner, { ...input("question", "causation"), causalMessageId: "causation" }), /循环/);
  assert.throws(() => collaboration.list({ kind: "user", userId: "other-user", grants }, work.workId), /找不到/);

  collaboration.send(owner, { ...input("question", "owner-private-route"), recipientBotIds: [DEFAULT_BOT_ID], body: "owner-only-routed-message" });
  const collaborationContext = new WorkCollaborationContext(works);
  const sources = collaborationContext.sources("collaborator-root");
  assert.equal(sources.length, 1);
  assert.match(sources[0]!.text, /执行|result/);
  assert.doesNotMatch(sources[0]!.text, /owner-only-routed-message/);
  const witness = sources[0]!.access;
  if (!witness || witness.kind !== "work-collaboration") throw new Error("missing persistent access witness");
  collaborationContext.validate("collaborator-root", witness);
  assert.throws(() => collaborationContext.validate("unrelated-task", witness), /授权范围/);
  const savedBinding = works.repo.getBinding(binding.bindingId)!;
  works.transaction(() => works.repo.updateBinding({ ...savedBinding, invalidatedAt: Date.now() }));
  assert.throws(() => collaborationContext.validate("collaborator-root", witness), /授权范围/);
  assert.deepEqual(collaborationContext.sources("collaborator-root"), []);
  works.transaction(() => works.repo.updateBinding(savedBinding));
  const resumed = { ...savedBinding, bindingId: "same-task-recovery", operationId: "recovery-op", admittedAt: savedBinding.admittedAt + 1 };
  works.transaction(() => works.repo.insertBinding(resumed));
  collaborationContext.validate("collaborator-root", witness);
  assert.equal(collaborationContext.sources("collaborator-root")[0]!.access?.kind, "work-collaboration");
  for (const patch of [{ botId: "uninvolved" }, { workspaceBinding: root + "-other" }, { durableStoreKey: "foreign-store" },
    { conversationId: "foreign-conversation" }, { intentRevision: savedBinding.intentRevision + 1 }]) {
    works.transaction(() => {
      db.connection.prepare("DELETE FROM work_execution_bindings WHERE binding_id=?").run(resumed.bindingId);
      works.repo.insertBinding({ ...resumed, ...patch });
    });
    assert.throws(() => collaborationContext.validate("collaborator-root", witness), /授权范围/);
  }
  works.transaction(() => db.connection.prepare("DELETE FROM work_execution_bindings WHERE binding_id=?").run(resumed.bindingId));
  const memory = new MemoryService(db, { semantic: false });
  const own = memory.create({ kind: "fact", title: "collaborator own private", content: "worker-own-memory", scopeType: "bot", scopeId: "collaborator", sourceType: "user" });
  const other = memory.create({ kind: "fact", title: "owner private", content: "owner-style-detail", scopeType: "bot", scopeId: DEFAULT_BOT_ID, sourceType: "user" });
  const context = projectMemoryContext(memory, { taskId: "collaborator-root", botId: DEFAULT_BOT_ID, trackRecall: false, limit: 30 });
  // Personal Work memory follows its persisted owner, not its temporary executor.
  // The executing Bot's private facts must not leak into someone else's commission.
  assert.match(context.text, /owner-style-detail/);
  assert.doesNotMatch(context.text, /worker-own-memory/);
  assert.equal(memory.canAccess(other.id, { taskId: "collaborator-root" }), true);
  assert.equal(memory.canAccess(own.id, { taskId: "collaborator-root" }), false);
  assert.throws(() => memory.updateFromTask("collaborator-root", { id: other.id, content: "stolen" }), /不能改写共享事实|作用域|scope/i);
  assert.equal("budget" in works.getWork(work.workId)!, false);
  const messages = collaboration.history(work.workId);
  db.close();
  const reopened = new AppDatabase(path);
  const reopenedBots = new BotRegistry(reopened.connection);
  const reopenedWorks = new WorkService(reopened.connection, { bots: reopenedBots });
  const restored = new WorkCollaborationService(reopened.connection, reopenedWorks, reopenedBots);
  assert.deepEqual(restored.list(user, work.workId), messages);
  assert.equal(restored.send(owner, first).replayed, true);
  assert.equal("budget" in reopenedWorks.getWork(work.workId)!, false);
  reopened.close();
  console.log("Phase 3 collaboration: eight message kinds, durable replay, namespace/recipient/recursion guards and actual Memory isolation passed");
} finally { try { db.close(); } catch { /* already closed for restart */ } rmSync(root, { recursive: true, force: true }); }
