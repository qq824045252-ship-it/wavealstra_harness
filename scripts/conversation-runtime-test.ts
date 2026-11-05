import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { ConversationGoalRepository } from "../src/main/agent/ConversationGoalRepository";
import { ConversationGoalService } from "../src/main/agent/ConversationGoalService";
import type { AgentUiPatch } from "../src/shared/agent-ipc";

const root = mkdtempSync(join(tmpdir(), "mybuddy-conversation-runtime-"));
const db = new AppDatabase(join(root, "runtime.db"));
const patches: AgentUiPatch[] = [];
const emit = (patch: AgentUiPatch) => patches.push(patch);

try {
  db.upsertTask({ id: "task-a", title: "A", updatedAt: Date.now() });
  db.upsertTask({ id: "task-b", title: "B", updatedAt: Date.now() });
  const interactions = new ConversationInteractionService(new ConversationInteractionRepository(db.connection), emit);
  const goals = new ConversationGoalService(new ConversationGoalRepository(db.connection), emit);
  const ctx = { taskId: "task-a", executionId: "exec-a", assistantMessageId: "assistant-a" };

  const answerPromise = interactions.request(ctx, {
    title: "选择方案",
    kind: "single_select",
    options: [{ id: "a", label: "方案 A" }, { id: "b", label: "方案 B" }],
  });
  const pending = interactions.listByTask("task-a")[0]!;
  const invalid = interactions.respond(pending.id, "missing");
  assert.equal(invalid.ok, false);
  const accepted = interactions.respond(pending.id, "a");
  assert.equal(accepted.ok, true);
  assert.equal(await answerPromise, "a");
  assert.equal(interactions.respond(pending.id, "b").ok, false);

  const durableContext = { ...ctx, executionId: "durable:task-a:conversation:tool" };
  const question = { title: "重启后继续选择", kind: "confirm" as const };
  const observation = new AbortController();
  const detached = interactions.requestDurable(durableContext, question, { key: "stable-call", signal: observation.signal });
  const durablePending = interactions.listByTask("task-a").find(item => item.executionId === durableContext.executionId)!;
  const detachedResult = assert.rejects(detached, /交互观察已结束/);
  observation.abort();
  await detachedResult;
  const restarted = new ConversationInteractionService(new ConversationInteractionRepository(db.connection), emit);
  assert.equal(restarted.listByTask("task-a").find(item => item.id === durablePending.id)?.status, "pending");
  const resumed = restarted.requestDurable(durableContext, question, { key: "stable-call" });
  assert.equal(restarted.respond(durablePending.id, true).ok, true);
  assert.equal(await resumed, true);
  assert.equal(await restarted.requestDurable(durableContext, question, { key: "stable-call" }), true, "completed answer is reused after native replay");
  await assert.rejects(() => restarted.requestDurable(durableContext, { ...question, title: "a different question" }, { key: "stable-call" }), /不同问题/);
  assert.equal(interactions.listByTask("task-a").filter(item => item.executionId === durableContext.executionId).length, 1);

  const messageIdMap = new Map([["assistant-a", "assistant-child"]]);
  assert.equal(interactions.cloneTerminal("task-a", "task-b", messageIdMap), 2);
  assert.equal(interactions.listByTask("task-b")[0]?.status, "resolved");

  const created = goals.create({ taskId: "task-a", title: "交付", criteria: [{ text: "类型检查通过" }] });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error(created.message);
  assert.equal(goals.create({ taskId: "task-a", title: "冲突" }).ok, false);
  const progressed = goals.update({
    goalId: created.goal.id,
    progressSummary: "主链完成",
    criterionUpdates: [{ id: created.goal.criteria[0]!.id, status: "met", evidence: "typecheck" }],
  });
  assert.equal(progressed.ok, true);
  const cloned = goals.cloneLive("task-a", "task-b");
  assert.equal(cloned?.taskId, "task-b");
  assert.notEqual(cloned?.id, created.goal.id);
  assert.equal(cloned?.criteria[0]?.status, "met");

  assert.ok(patches.some((patch) => patch.type === "conversation_interaction_snapshot"));
  assert.ok(patches.some((patch) => patch.type === "conversation_goal_snapshot"));
  assert.equal(interactions.deleteFrom("task-a", 0), 2);
  assert.equal(interactions.listByTask("task-a").length, 0);
  console.log("conversation runtime tests: ok");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
