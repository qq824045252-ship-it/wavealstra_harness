import assert from "node:assert/strict";
import { createConversationRuntimeExtension } from "../src/main/agent/conversation-runtime-extension";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { ConversationGoalService } from "../src/main/agent/ConversationGoalService";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { DESKTOP_USER_GRANTS, WorkService } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";
import type { AgentUiPatch } from "../src/shared/agent-ipc";

const root = mkdtempSync(join(tmpdir(), "mybuddy-conversation-runtime-"));
const db = new AppDatabase(join(root, "runtime.db"));
const patches: AgentUiPatch[] = [];
const emit = (patch: AgentUiPatch) => patches.push(patch);

try {
  db.upsertTask({ id: "task-a", title: "A", updatedAt: Date.now() });
  db.upsertTask({ id: "task-b", title: "B", updatedAt: Date.now() });
  const interactions = new ConversationInteractionService(new ConversationInteractionRepository(db.connection), emit);
  const bots = new BotRegistry(db.connection);
  bots.ensureDefaultBot(LOCAL_USER_ID);
  const work = new WorkService(db.connection, { bots });
  const goals = new ConversationGoalService(work, emit, { userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID });
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

  // Upgrade replay retires only the old completion tool's durable question.
  db.upsertTask({ id: "task-watch-upgrade", title: "Upgrade watch", updatedAt: Date.now() });
  const upgradeCtx = { taskId: "task-watch-upgrade", executionId: "watch-execution", assistantMessageId: "watch-assistant" };
  const oldObserver = new AbortController();
  const obsolete = interactions.requestDurable(upgradeCtx, { kind: "confirm", title: "确认完成 Work？" }, { key: "complete-call", signal: oldObserver.signal });
  const unrelated = interactions.requestDurable({ ...upgradeCtx, executionId:'other-tool-execution' }, { kind: "short_text", title: "请补充目标来源" }, { key: "other-call", signal: oldObserver.signal });
  const detachedOld = assert.rejects(obsolete, /交互观察已结束/), detachedOther = assert.rejects(unrelated, /交互观察已结束/);
  oldObserver.abort(); await Promise.all([detachedOld,detachedOther]);
  const replayService = new ConversationInteractionService(new ConversationInteractionRepository(db.connection), emit);
  const replayTools = new Map<string,any>();
  createConversationRuntimeExtension({ resolveContext: () => upgradeCtx, interaction: replayService,
    goal: { getLive: () => ({ id: "watch-work", title: "发布准备" }), workService: { getWork: () => ({ mode: "watch" }) } } as any,
  })({ on: () => {}, registerTool: (tool:any) => replayTools.set(tool.name,tool) } as any);
  const resumedResult = await replayTools.get("conversation_goal_propose_complete").execute("complete-call", { summary:"READY", expectedStateVersion:1, expectedIntentRevision:1, expectedOwnerEpoch:1 },new AbortController().signal);
  assert.equal(resumedResult.details.handledBy,"watch_supervision");
  const upgraded = replayService.listByTask(upgradeCtx.taskId);
  assert.equal(upgraded.find(item=>item.title==='确认完成 Work？')!.status,'cancelled');
  assert.equal(upgraded.find(item=>item.title==='请补充目标来源')!.status,'pending','unrelated same-task question remains intact');
  assert.equal(replayService.cancelDurable(upgradeCtx,'not-this-call').ok,false);

  const created = goals.create({ taskId: "task-a", title: "交付", criteria: [{ text: "类型检查通过" }] });
  assert.equal(created.ok, true);
  assert.equal(goals.create({ taskId: "task-a", title: "冲突" }).ok, false);
  const progressed = goals.update({
    goalId: created.goal.id,
    progressSummary: "主链完成",
    criterionUpdates: [{ id: created.goal.criteria[0]!.id, status: "met", evidence: "typecheck" }],
  });
  assert.equal(progressed.ok, true);
  const cloned = goals.cloneLive("task-a", "task-b");
  assert.equal(cloned?.taskId, "task-b");
  assert.equal(cloned?.id, created.goal.id, "one work authority is shared by the branch conversation");
  assert.equal(cloned?.criteria[0]?.status, "met");
  const completed = goals.update({ goalId: created.goal.id, status: "achieved", progressSummary: "完成" });
  assert.equal(completed.ok, true);
  assert.equal(completed.ok ? completed.goal.status : undefined, "achieved");
  assert.equal(work.getWork(created.goal.id)?.closureConclusion, "succeeded");

  // Ordinary Goal completion must hash outside the transaction and retain a
  // committed artifact invalidation when the close request is rejected.
  const fileGoal = goals.create({ taskId: "task-b", title: "Current artifact", criteria: [{ text: "current content verified" }] });
  assert(fileGoal.ok);
  const owner = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS } as const;
  db.upsertTask({ id: "goal-artifact-worker", title: "artifact worker", updatedAt: Date.now() });
  const dispatched = work.dispatchExecution(owner, { operationId: "goal-artifact-dispatch", workId: fileGoal.goal.id,
    botId: DEFAULT_BOT_ID, taskId: "goal-artifact-worker", durableStoreKey: "goal-artifact-store", conversationId: "1",
    workspaceBinding: root, delegatedScope: ["workspace:read"] });
  assert(dispatched.ok);
  const fileBinding = work.repo.listBindings(fileGoal.goal.id)[0]!;
  const artifact = join(root, "goal-output.txt");
  writeFileSync(artifact, "verified content");
  const fingerprint = work.artifacts.register(fileBinding, [artifact]);
  work.transaction(() => work.artifacts.record(fileBinding, fingerprint));
  assert(work.reconcileExecution({ kind: "system", reason: "goal-artifact-test" }, { bindingId: fileBinding.bindingId, outcome: "completed", usageTokens: 0 }).ok);
  const criterionId = work.getWork(fileGoal.goal.id)!.criteria[0]!.id;
  assert(goals.update({ goalId: fileGoal.goal.id, criterionUpdates: [{ id: criterionId, status: "met", evidence: "checked original artifact" }] }).ok);
  writeFileSync(artifact, "external replacement");
  const rejectedClose = goals.update({ goalId: fileGoal.goal.id, status: "achieved" });
  assert.equal(rejectedClose.ok, false);
  assert.equal(work.getWork(fileGoal.goal.id)!.lifecycle, "active");
  assert.equal(work.getWork(fileGoal.goal.id)!.criteria[0]!.status, "pending", "failed close preserves committed artifact invalidation");

  assert.ok(patches.some((patch) => patch.type === "conversation_interaction_snapshot"));
  assert.ok(patches.some((patch) => patch.type === "conversation_goal_snapshot"));
  assert.equal(interactions.deleteFrom("task-a", 0), 2);
  assert.equal(interactions.listByTask("task-a").length, 0);
  console.log("conversation runtime tests: ok");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
