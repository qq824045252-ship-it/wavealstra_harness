import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";

function ids<T extends { memory: { id: string } }>(hits: T[]): Set<string> {
  return new Set(hits.map((hit) => hit.memory.id));
}

const db = new AppDatabase(":memory:");
try {
  assert.equal(db.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION, "fresh DB must materialize the current schema directly");

  const root = db.createSpace({ id: "ws-root", name: "Root" });
  const child = db.createSpace({ id: "ws-child", name: "Child", parentId: root.id });
  const sibling = db.createSpace({ id: "ws-sibling", name: "Sibling", parentId: root.id });
  db.connection.prepare(
    `INSERT INTO projects (id,name,description,instructions,created_at,updated_at,archived,resource_budget_chars)
     VALUES ('proj-a','Project A',NULL,NULL,?,?,0,128000)`,
  ).run(Date.now(), Date.now());
  db.upsertTask({
    id: "task-a",
    title: "Task A",
    spaceId: child.id,
    projectId: "proj-a",
    status: "in_progress",
    updatedAt: Date.now(),
  });

  const memory = new MemoryService(db, { semantic: false });

  const global = memory.create({
    kind: "preference",
    title: "偏好短验证",
    content: "开发期只跑相关短验证，不跑长 E2E。",
    scopeType: "global",
    sourceType: "user",
    explicit: true,
    confidence: 1,
    importance: 2,
  });
  const parent = memory.create({
    kind: "constraint",
    title: "根空间约束",
    content: "所有子空间继承该约束。",
    scopeType: "workspace",
    scopeId: root.id,
    sourceType: "manual",
    explicit: true,
    confidence: 1,
  });
  const local = memory.create({
    kind: "fact",
    title: "当前空间事实",
    content: "Child 使用统一 Memory Kernel。",
    scopeType: "workspace",
    scopeId: child.id,
    sourceType: "agent",
    confidence: 0.9,
  });
  const siblingOnly = memory.create({
    kind: "fact",
    title: "兄弟空间私有事实",
    content: "这个内容不应泄漏给 Child。",
    scopeType: "workspace",
    scopeId: sibling.id,
    sourceType: "agent",
    confidence: 0.9,
  });
  const project = memory.create({
    kind: "decision",
    title: "项目决策",
    content: "Project A 使用统一项目记忆。",
    scopeType: "project",
    scopeId: "proj-a",
    sourceType: "user",
    explicit: true,
    confidence: 1,
    importance: 3,
    evidence: [{ evidenceKind: "task", refId: "task-a" }],
  });
  const task = memory.create({
    kind: "progress",
    title: "任务检查点",
    content: "当前正在验证 scope isolation。",
    scopeType: "task",
    scopeId: "task-a",
    sourceType: "agent",
    confidence: 0.85,
  });

  // Task > Project > current Workspace > ancestors > Global; sibling must not leak.
  const visible = memory.search({ taskId: "task-a", includeInherited: true, limit: 100 });
  const visibleIds = ids(visible);
  for (const expected of [global, parent, local, project, task]) {
    assert.ok(visibleIds.has(expected.id), `expected visible memory: ${expected.title}`);
  }
  assert.ok(!visibleIds.has(siblingOnly.id), "sibling workspace memory must not leak");

  // Lexical retrieval must not require an exact full-query SQL substring.
  const lexical = memory.search({ taskId: "task-a", query: "为什么项目统一记忆", limit: 20 });
  assert.ok(lexical.some((hit) => hit.memory.id === project.id), "token similarity should find related project decision");

  // Actor-side promotion boundary: current/ancestor allowed, sibling/foreign project denied.
  assert.equal(memory.canPromoteFromTask("task-a", "workspace", root.id), true);
  assert.equal(memory.canPromoteFromTask("task-a", "workspace", sibling.id), false);
  assert.equal(memory.canPromoteFromTask("task-a", "project", "proj-a"), true);
  assert.equal(memory.canPromoteFromTask("task-a", "project", "proj-foreign"), false);

  // Promotion adds a binding to the SAME record; no content clone / duplicate record.
  const beforeTotal = memory.stats().total;
  const promoted = memory.promote(local.id, "workspace", root.id);
  assert.equal(promoted.id, local.id);
  assert.ok(promoted.scopes.some((scope) => scope.scopeType === "workspace" && scope.scopeId === root.id && scope.binding === "promoted"));
  assert.equal(memory.stats().total, beforeTotal, "promote must not duplicate memory_records");

  // Revision timeline snapshots new durable states: r1 created, r2 updated.
  const updated = memory.update({
    id: project.id,
    content: "Project A 已切换到 Memory Kernel v21。",
    changedBy: "user",
    changeReason: "explicit confirmation",
  });
  assert.match(updated.content, /v21/);
  const projectHistory = memory.history(project.id);
  assert.equal(projectHistory.length, 2);
  assert.equal(projectHistory[0]?.revision, 2);
  assert.match(projectHistory[0]?.content ?? "", /v21/, "latest revision must snapshot the new state");
  assert.equal(projectHistory[1]?.revision, 1);

  // Supersede keeps history and explicit relationship; old record is no longer active.
  const replacement = memory.supersede(parent.id, {
    kind: "constraint",
    title: "根空间新约束",
    content: "新约束取代旧根空间约束。",
    scopeType: "workspace",
    scopeId: root.id,
    sourceType: "user",
    explicit: true,
    confidence: 1,
  });
  assert.equal(memory.get(parent.id)?.status, "superseded");
  assert.ok(memory.get(replacement.id)?.relations.some((rel) => rel.relation === "SUPERSEDES" && rel.toMemoryId === parent.id));
  assert.ok(memory.history(parent.id).some((revision) => revision.status === "superseded"));

  // Supersede is one L1 transaction: a relation failure must roll back both records and revisions.
  const atomicOld = memory.create({
    kind: "fact",
    title: "Atomic supersede source",
    content: "old truth",
    scopeType: "project",
    scopeId: "proj-a",
    sourceType: "manual",
  });
  const atomicHistoryBefore = memory.history(atomicOld.id).length;
  db.connection.exec(
    `CREATE TRIGGER fail_test_supersedes BEFORE INSERT ON memory_relations
     WHEN NEW.relation='SUPERSEDES' BEGIN SELECT RAISE(ABORT, 'test relation failure'); END`,
  );
  assert.throws(() => memory.supersede(atomicOld.id, {
    kind: "fact",
    title: "Atomic supersede replacement",
    content: "new truth",
    scopeType: "project",
    scopeId: "proj-a",
    sourceType: "manual",
  }), /test relation failure/);
  db.connection.exec("DROP TRIGGER fail_test_supersedes");
  assert.equal(memory.get(atomicOld.id)?.status, "active", "failed supersede keeps old L1 active");
  assert.equal(memory.history(atomicOld.id).length, atomicHistoryBefore, "failed supersede rolls back old revision");
  assert.equal(memory.list().some((item) => item.title === "Atomic supersede replacement"), false, "failed supersede rolls back replacement L1");

  // Hard forget removes record plus cascaded revision/scope/evidence truth.
  memory.forget(task.id);
  assert.equal(memory.get(task.id), undefined);
  assert.equal(memory.history(task.id).length, 0);
  const orphanCounts = db.connection.prepare(
    `SELECT
      (SELECT COUNT(1) FROM memory_scopes WHERE memory_id=?) scopes,
      (SELECT COUNT(1) FROM memory_evidence WHERE memory_id=?) evidence,
      (SELECT COUNT(1) FROM memory_revisions WHERE memory_id=?) revisions,
      (SELECT COUNT(1) FROM memory_embeddings WHERE memory_id=?) embeddings`,
  ).get(task.id, task.id, task.id, task.id) as { scopes: number; evidence: number; revisions: number; embeddings: number };
  assert.deepEqual(orphanCounts, { scopes: 0, evidence: 0, revisions: 0, embeddings: 0 });

  // FTS5 trigram lexical path is scope-first and CJK friendly.
  const ftsHits = memory.repository.searchFts("项目决策", [...visibleIds], 20);
  assert.ok(ftsHits.some((hit) => hit.memoryId === project.id), "Memory FTS should retrieve project memory");
  const bm25Search = memory.search({ taskId: "task-a", query: "为什么项目决策发生变化", limit: 20 });
  assert.ok(bm25Search.some((hit) => hit.memory.id === project.id && hit.reasons.includes("bm25")), "lexical recall should expose bm25 reason");

  // Every completed turn is eligible; the serialized worker can coalesce pending turns.
  const pipeline = new MemoryPipelineManager(db);
  const capture = (n: number, text = `普通对话 ${n}`) => pipeline.capture({
    taskId: "task-a",
    sessionId: "session-a",
    userMessageId: `u-${n}`,
    assistantMessageId: `a-${n}`,
    userText: text,
    assistantText: `回复 ${n}`,
    capturedAt: 1000 + n,
  });
  const p1 = capture(1);
  assert.equal(p1.shouldExtractL1, true);
  assert.equal(p1.reason, "turn_completed");
  pipeline.beginL1(p1.pendingTurns);
  pipeline.completeL1("task-a", p1.pendingTurns);
  const p2 = capture(2);
  assert.equal(p2.shouldExtractL1, true);
  pipeline.beginL1(p2.pendingTurns);
  pipeline.completeL1("task-a", p2.pendingTurns);
  const p3 = capture(3);
  assert.equal(p3.shouldExtractL1, true, "turn 3 must not wait forever for a fourth turn");
  const p4 = capture(4);
  assert.equal(p4.shouldExtractL1, true, "every completed turn schedules the pending batch");
  assert.deepEqual(p4.pendingTurns.map((turn) => turn.assistantMessageId), ["a-3", "a-4"], "pending batch must include skipped intermediate turn");
  pipeline.beginL1(p4.pendingTurns);
  pipeline.completeL1("task-a", p4.pendingTurns);
  const p5 = capture(5, "以后必须优先做短验证");
  assert.equal(p5.shouldExtractL1, true);
  assert.equal(p5.reason, "turn_completed");
  pipeline.beginL1(p5.pendingTurns);
  pipeline.completeL1("task-a", p5.pendingTurns);
  assert.equal(pipeline.turns.listByTask("task-a").length, 5);
  assert.equal(memory.stats().l0Turns, 5);
  assert.equal(memory.stats().pendingTurns, 0);
  assert.equal(memory.listTurns({ taskId: "task-a", query: "短验证" }).some((turn) => turn.id === p5.turn.id), true, "L0 list supports task/query audit filters");
  const auditMemory = memory.create({
    kind: "constraint",
    title: "短验证约定",
    content: "优先做短验证。",
    scopeType: "workspace",
    scopeId: child.id,
    sourceType: "agent",
    confidence: 0.9,
    evidence: [{ evidenceKind: "conversation", refId: p5.turn.id, refTitle: "L0 conversation turn" }],
  });
  assert.equal(memory.getTurn(p5.turn.id)?.userText, "以后必须优先做短验证", "L0 detail must preserve exact user text");
  assert.equal(memory.memoriesForTurn(p5.turn.id).some((item) => item.id === auditMemory.id), true, "L0 must reverse-link to supported L1");

  // Hard task purge removes raw L0 + its conversation evidence, but keeps durable L1 cognition.
  db.upsertTask({ id: "task-purge", title: "Purge Me", spaceId: child.id, status: "todo", updatedAt: Date.now() });
  const purgePipeline = new MemoryPipelineManager(db);
  const purgeTurn = purgePipeline.capture({
    taskId: "task-purge",
    userMessageId: "u-purge",
    assistantMessageId: "a-purge",
    userText: "这个长期事实需要保留",
    assistantText: "已记录",
  }).turn;
  const durableAfterPurge = memory.create({
    kind: "fact",
    title: "任务删除后仍保留的长期事实",
    scopeType: "workspace",
    scopeId: child.id,
    sourceType: "user",
    explicit: true,
    confidence: 1,
    evidence: [{ evidenceKind: "conversation", refId: purgeTurn.id }],
  });
  db.deleteTask("task-purge");
  assert.equal(purgePipeline.turns.get(purgeTurn.id), undefined, "task purge must delete full raw L0");
  assert.ok(memory.get(durableAfterPurge.id), "task purge must not erase durable L1 cognition");
  const retainedEvidence = memory.get(durableAfterPurge.id)?.evidence.find((e) => e.refId === purgeTurn.id);
  assert.ok(retainedEvidence, "L1 must retain conversation evidence after source task purge");
  assert.match(retainedEvidence?.excerpt ?? "", /这个长期事实需要保留/, "retained evidence must preserve a bounded source excerpt");

  // Context budget is bounded and recall is observable.
  const context = memory.resolveContext({ taskId: "task-a", query: "统一记忆", budgetChars: 1200, limit: 20 });
  assert.ok(context.includedChars <= context.budgetChars);
  assert.ok(context.text === "" || context.text.startsWith("历史记忆证据"));
  assert.ok(memory.stats().recalled >= context.items.length);

  // Project cognition is a baseline for bound tasks even when the prompt shares no words with it.
  const unrelated = memory.resolveContext({ taskId: "task-a", query: "继续", budgetChars: 4000, limit: 20, trackRecall: false });
  assert.ok(unrelated.items.some((item) => item.id === project.id), "project memory must reach context for unrelated prompts");
  assert.ok(!unrelated.items.some((item) => item.id === local.id), "baseline must not widen non-project scopes");

  // Long prompts must still match memories mentioned late in the message.
  const lateFact = memory.create({
    kind: "fact", title: "WX9000 采集仪标定", content: "标定周期为每季度一次。",
    scopeType: "task", scopeId: "task-a", sourceType: "manual", explicit: true, confidence: 1,
  });
  const longQuery = "请先帮我整理一下今天上午会议里提到的所有事项，按负责人和截止时间排好顺序，然后起草一封发给客户的邮件说明当前交付风险与下周安排，最后另外查一下WX9000多久做一次";
  assert.ok(memory.search({ taskId: "task-a", query: longQuery, limit: 20 }).some((hit) => hit.memory.id === lateFact.id), "late query terms must reach FTS");
  memory.forget(lateFact.id);

  // Scope detach: non-last binding removes only that scope; last binding hard-forgets the atom.
  const multi = memory.create({
    kind: "fact",
    title: "多作用域记忆",
    content: "同时绑定 child 和 root。",
    scopeType: "workspace",
    scopeId: child.id,
    sourceType: "manual",
    explicit: true,
  });
  memory.promote(multi.id, "workspace", root.id);
  assert.equal(memory.get(multi.id)?.scopes.length, 2);
  assert.deepEqual(memory.detachScope(multi.id, "workspace", root.id), { detached: true, forgotten: false });
  assert.equal(memory.get(multi.id)?.scopes.length, 1);
  assert.equal(memory.get(multi.id)?.scopes[0]?.scopeId, child.id);
  assert.deepEqual(memory.detachScope(multi.id, "workspace", child.id), { detached: true, forgotten: true });
  assert.equal(memory.get(multi.id), undefined, "last scope detach must hard-forget the atom");
  const orphanScopes = db.connection.prepare("SELECT COUNT(1) n FROM memory_scopes WHERE memory_id=?").get(multi.id) as { n: number };
  assert.equal(orphanScopes.n, 0);
  assert.deepEqual(memory.detachScope(multi.id, "workspace", child.id), { detached: false, forgotten: false });

  // Failed L0 turns regain a fresh retry budget; completed turns are untouched.
  db.upsertTask({ id: "task-retry", title: "Retry", spaceId: child.id, status: "in_progress", updatedAt: Date.now() });
  const retryPipeline = new MemoryPipelineManager(db);
  const retryTurn = retryPipeline.capture({
    taskId: "task-retry",
    userMessageId: "u-r1",
    assistantMessageId: "a-r1",
    userText: "失败重试内容",
    assistantText: "好",
  }).turn;
  const doneTurn = retryPipeline.capture({
    taskId: "task-retry",
    userMessageId: "u-r2",
    assistantMessageId: "a-r2",
    userText: "完成的 turn",
    assistantText: "好",
  }).turn;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    retryPipeline.turns.markProcessing([retryTurn.id]);
    retryPipeline.turns.markFailed([retryTurn.id], new Error("boom"));
  }
  retryPipeline.turns.markCompleted([doneTurn.id]);
  assert.equal(retryPipeline.turns.listPending("task-retry").some((item) => item.id === retryTurn.id), false, "exhausted turn is not retryable");
  assert.equal(memory.stats().failedTurns, 1);
  const resetResult = memory.retryFailedTurns();
  assert.equal(resetResult.reset, 1);
  assert.deepEqual(resetResult.taskIds, ["task-retry"]);
  const retried = retryPipeline.turns.get(retryTurn.id);
  assert.equal(retried?.extractionState, "pending");
  assert.equal(retried?.attemptCount, 0);
  assert.equal(retried?.lastError ?? null, null);
  assert.equal(retryPipeline.turns.get(doneTurn.id)?.extractionState, "completed", "reset must not touch completed turns");
  assert.equal(retryPipeline.turns.listPending("task-retry").some((item) => item.id === retryTurn.id), true, "reset turn is retryable again");
  assert.equal(memory.retryFailedTurns().reset, 0, "no failed turns left to reset");

  // Projection dismissal is durable: ids are content-derived, so the ledger (not the row) carries the suppression.
  const projections = memory.cognition.projections;
  const projScope = { scopeType: "workspace" as const, scopeId: child.id };
  const drafted = projections.replaceScenarios(projScope, [
    { title: "测试场景一", summary: "场景摘要一", sourceMemoryIds: [local.id] },
  ]);
  assert.equal(drafted.length, 1);
  const dismissedScenario = drafted[0]!;
  const profile = projections.replaceCoreProfile(projScope, {
    title: "测试画像", content: "画像内容", sourceScenarioIds: [dismissedScenario.id],
  });
  assert.ok(profile);
  assert.equal(memory.dismissProjection(dismissedScenario.id, "scenario"), true);
  assert.equal(projections.listScenarios(projScope, "all", 10).length, 0, "dismissed scenario row is removed");
  assert.equal(memory.listDismissedProjections().some((item) => item.id === dismissedScenario.id), true);
  assert.equal(
    projections.listCoreProfiles(projScope, "active", 10).length, 0,
    "dismissing a scenario must stale profiles that referenced it",
  );
  const regenerated = projections.replaceScenarios(projScope, [
    { title: "测试场景一", summary: "场景摘要一", sourceMemoryIds: [local.id] },
  ]);
  assert.equal(regenerated.length, 0, "dismissed scenario must not be regenerated from identical content");
  assert.equal(memory.restoreProjection(dismissedScenario.id), true);
  const regrown = projections.replaceScenarios(projScope, [
    { title: "测试场景一", summary: "场景摘要一", sourceMemoryIds: [local.id] },
  ]);
  assert.equal(regrown.length, 1, "restored projection regenerates on the next run");
  assert.equal(memory.restoreProjection(dismissedScenario.id), false, "double restore reports no-op");

  assert.equal(memory.dismissProjection(profile!.id, "profile"), true);
  assert.equal(projections.listCoreProfiles(projScope, "all", 10).length, 0, "dismissed profile row is removed");
  const regenProfile = projections.replaceCoreProfile(projScope, {
    title: "测试画像", content: "画像内容", sourceScenarioIds: [dismissedScenario.id],
  });
  assert.equal(regenProfile, undefined, "dismissed profile must not be regenerated");
  assert.equal(memory.restoreProjection(profile!.id), true);
  assert.ok(projections.replaceCoreProfile(projScope, {
    title: "测试画像", content: "画像内容", sourceScenarioIds: [dismissedScenario.id],
  }), "restored profile regenerates");

  // Manual-approval flow: generated drafts land as pending proposals; only approve writes the live row.
  assert.equal(projections.proposeScenarios(projScope, [
    { title: "提案场景", summary: "提案摘要", sourceMemoryIds: [local.id] },
  ]), 1);
  const pendingProposal = memory.listProjectionProposals("pending").find((item) => item.title === "提案场景");
  assert.ok(pendingProposal);
  assert.equal(
    projections.listScenarios(projScope, "all", 20).some((s) => s.title === "提案场景"),
    false,
    "pending proposal must not create a live row",
  );
  assert.equal(memory.approveProjectionProposal(pendingProposal!.id), true);
  assert.equal(
    projections.listScenarios(projScope, "active", 20).some((s) => s.title === "提案场景"),
    true,
    "approved proposal becomes a live scenario",
  );
  assert.equal(memory.approveProjectionProposal(pendingProposal!.id), false, "consumed proposal cannot be approved twice");

  assert.equal(projections.proposeScenarios(projScope, [
    { title: "被拒场景", summary: "被拒摘要", sourceMemoryIds: [local.id] },
  ]), 1);
  const rejectedProposal = memory.listProjectionProposals("pending").find((item) => item.title === "被拒场景");
  assert.ok(rejectedProposal);
  assert.equal(memory.rejectProjectionProposal(rejectedProposal!.id), true);
  assert.equal(
    projections.proposeScenarios(projScope, [
      { title: "被拒场景", summary: "被拒摘要", sourceMemoryIds: [local.id] },
    ]),
    0,
    "identical rejected content must not be re-proposed",
  );
  assert.equal(memory.restoreProjectionProposal(rejectedProposal!.id), true);
  assert.equal(
    memory.listProjectionProposals("pending").some((item) => item.id === rejectedProposal!.id),
    true,
    "restored proposal returns to pending",
  );

  // Memory Kernel is the only durable memory truth.
  assert.ok(memory.stats().total >= 5);
  console.log("Memory Kernel: all focused checks passed");
} finally {
  db.close();
}


// Same-version startup purges retired memory storage instead of migrating or reading it.
const legacyPurgeRoot = mkdtempSync(join(tmpdir(), "mybuddy-memory-retired-purge-"));
const legacyPurgePath = join(legacyPurgeRoot, "app.db");
try {
  const current = new AppDatabase(legacyPurgePath);
  current.close();

  const raw = new Database(legacyPurgePath);
  raw.exec("ALTER TABLE soul ADD COLUMN memory_digest TEXT NOT NULL DEFAULT ''");
  raw.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  raw.prepare("UPDATE soul SET memory_digest=? WHERE id=1").run("- retired global memory");
  raw.prepare("INSERT INTO memories (id,space_id,content,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run("retired-memory", "retired-space", "retired workspace memory", 1, 1);
  raw.close();

  const reopened = new AppDatabase(legacyPurgePath);
  try {
    const retiredTable = reopened.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories'").get();
    assert.equal(retiredTable, undefined, "same-version startup must drop retired memories table");
    const soulColumns = reopened.connection.pragma("table_info(soul)") as Array<{ name: string }>;
    assert.equal(soulColumns.some((column) => column.name === "memory_digest"), false, "same-version startup must drop retired soul.memory_digest");
  } finally {
    reopened.close();
  }
  console.log("Memory Kernel retired storage purge: old memory removed");
} finally {
  rmSync(legacyPurgeRoot, { recursive: true, force: true });
}


// Development DB contract: any incompatible file version is discarded instead of migrated.
const resetRoot = mkdtempSync(join(tmpdir(), "mybuddy-memory-current-only-"));
const resetPath = join(resetRoot, "app.db");
try {
  const seed = new AppDatabase(resetPath);
  seed.upsertTask({ id: "old-task", title: "Old Task", status: "completed", updatedAt: Date.now() });
  const seedMemory = new MemoryService(seed, { semantic: false });
  const oldMemory = seedMemory.create({
    kind: "decision", title: "Old memory", content: "must be discarded with incompatible DB",
    scopeType: "task", scopeId: "old-task", sourceType: "manual", explicit: true,
  });
  seed.connection.pragma(`user_version = ${CURRENT_DATABASE_SCHEMA_VERSION - 2}`);
  seed.close();

  const reset = new AppDatabase(resetPath);
  try {
    assert.equal(reset.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION, "incompatible DB resets directly to current schema");
    assert.equal(reset.getTask("old-task"), undefined, "old task data is intentionally discarded");
    const memory = new MemoryService(reset, { semantic: false });
    assert.equal(memory.get(oldMemory.id), undefined, "old Memory truth is intentionally discarded");
    const table = reset.connection.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='memory_skill_revision_candidates'").get() as { ok: number } | undefined;
    assert.equal(table?.ok, 1, "reset database contains the complete current Memory schema");
  } finally {
    reset.close();
  }
  console.log("Memory Kernel current-only reset: incompatible DB discarded");
} finally {
  rmSync(resetRoot, { recursive: true, force: true });
}


// Interrupted L1 processing is retryable after process restart; interrupted attempts do not consume retry budget.
const recoveryRoot = mkdtempSync(join(tmpdir(), "mybuddy-memory-processing-recovery-"));
const recoveryPath = join(recoveryRoot, "app.db");
try {
  const first = new AppDatabase(recoveryPath);
  try {
    const ws = first.createSpace({ id: "recovery-ws", name: "Recovery" });
    first.upsertTask({ id: "recovery-task", title: "Recovery Task", spaceId: ws.id, status: "in_progress", updatedAt: Date.now() });
    const pipeline = new MemoryPipelineManager(first);
    const decision = pipeline.capture({
      taskId: "recovery-task",
      assistantMessageId: "recovery-a1",
      userText: "记住这个恢复测试。",
      assistantText: "已记录。",
    });
    pipeline.beginL1(decision.pendingTurns);
    const before = pipeline.turns.get(decision.turn.id);
    assert.equal(before?.extractionState, "processing");
    assert.equal(before?.attemptCount, 1);
  } finally {
    first.close();
  }

  const reopened = new AppDatabase(recoveryPath);
  try {
    const pipeline = new MemoryPipelineManager(reopened);
    const turn = pipeline.turns.getByAssistantMessageId("recovery-a1");
    assert.equal(turn?.extractionState, "failed", "startup must recover interrupted processing as retryable failed");
    assert.equal(turn?.attemptCount, 0, "interrupted process exit must not consume retry budget");
    assert.match(turn?.lastError ?? "", /interrupted before L1 completion/);
    assert.equal(pipeline.turns.listPending("recovery-task").some((item) => item.id === turn?.id), true);
  } finally {
    reopened.close();
  }
  console.log("Memory Pipeline restart recovery: processing -> retryable failed");
} finally {
  rmSync(recoveryRoot, { recursive: true, force: true });
}
