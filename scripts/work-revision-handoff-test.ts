import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkExecutionAdapter, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";
import type { WorkSubitemResult } from "../src/shared/bot-work-phase3";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkControlResult, type WorkDto, type WorkExecutionBindingDto } from "../src/shared/bot-work";

const root = mkdtempSync(join(tmpdir(), "work-revision-handoff-"));
const database = join(root, "app.db");
let db = new AppDatabase(database), bots = new BotRegistry(db.connection);
bots.ensureDefaultBot(LOCAL_USER_ID);
let works = new WorkService(db.connection, { bots });
const user = { kind: "user" as const, userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const unwrap = (result: WorkControlResult) => { assert(result.ok, JSON.stringify(result)); return result.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
const make = (id: string) => unwrap(works.createWork(user, { operationId: id, title: id, inputSnapshotId: `input:${id}`,
  authorization: DESKTOP_USER_GRANTS, workspacePath: root, constraints: ["保留 A，只调整 B；不发送、不发布"],
  criteria: [{ id: "a", text: "A 可读取" }, { id: "b", text: "B 符合最新输入", requiresRealEnvironmentCheck: true, requiredEnvironment: "fixture" }] }));
const bind = (work: WorkDto, id: string) => {
  unwrap(works.dispatchExecution(user, { operationId: id, workId: work.workId, botId: work.ownerBotId,
    taskId: id, durableStoreKey: `store:${id}`, conversationId: "1", workspaceBinding: root }));
  return works.repo.bindingForTask(id)!;
};
const item = (id: string, outcome: WorkSubitemResult["outcome"], artifactRefs: string[] = []): WorkSubitemResult => ({
  itemId: id, task: `task-${id}`, summary: `summary-${id}`, required: true, dependencies: [], criterionIds: [id.toLowerCase()],
  nativeStatus: outcome, outcome, artifactRefs, writeConflicts: [],
});
const receipt = (binding: WorkExecutionBindingDto): AgentSubmissionReceipt => ({
  taskId: binding.taskId, operationId: binding.operationId, submissionId: 1, status: "placed",
});
const amend = (work: WorkDto, id: string, fields: Partial<Parameters<WorkService["amendWork"]>[1]>) =>
  unwrap(works.amendWork(user, { operationId: id, workId: work.workId, versionGuard: guard(works.getWork(work.workId)!), ...fields }));
const project = (binding: WorkExecutionBindingDto) => JSON.parse(works.revisionHandoff.executionInput(binding, works.repo.executionInput(binding)));
function trace<T>(fn: () => T) {
  const original = db.connection.prepare.bind(db.connection), sql: string[] = [];
  db.connection.prepare = ((text: string) => { sql.push(text); return original(text); }) as typeof db.connection.prepare;
  try { return { result: fn(), sql }; } finally { db.connection.prepare = original; }
}

try {
  const work = make("personal"), r1 = bind(work, "personal-r1");
  const originalInput = works.repo.executionInput(r1);
  assert.equal(works.revisionHandoff.executionInput(r1, originalInput), originalInput, "no history preserves exact input bytes");
  const original = join(root, "partial-a.txt"), immutable = join(root, "partial-a-sha256.txt");
  writeFileSync(original, "A-READY"); writeFileSync(immutable, "A-READY");
  const digest = createHash("sha256").update("A-READY").digest("hex");
  works.markDispatchAttempt(r1.bindingId, "attempt:r1");
  works.recordSubmissionReceipt(r1.bindingId, JSON.stringify(receipt(r1)));
  assert.deepEqual(works.nativeResults.receive(r1, receipt(r1), { status: "running",
    generatedArtifacts: [
      { path: original, snapshotPath: immutable, digest, sizeBytes: 7, registeredAt: 1, sourceEntryId: 1 },
      { path: join(root, "mutable-only.txt"), digest: "mutable", sizeBytes: 2, registeredAt: 2, sourceEntryId: 2 },
    ], subitems: [item("A", "completed", [original]), item("B", "unknown")] }), []);
  const action = works.admitNewAction(user, { admissionId: "external-B", operationId: "external-B-original", workId: work.workId, bindingId: r1.bindingId, actionKind: "send" });
  assert(action.ok); assert(works.settleAdmission(action.admission.admissionId, "unknown").ok);
  const completedAction = works.admitNewAction(user, { admissionId: "write-A", operationId: "write-A-original", workId: work.workId, bindingId: r1.bindingId, actionKind: "write" });
  assert(completedAction.ok); assert(works.settleAdmission(completedAction.admission.admissionId, "consumed").ok);

  const r2Work = amend(work, "change-B", { goalDescription: "保留 A，B 改为 B-REVISED。" });
  assert.equal(r2Work.intentRevision, 2);
  const r2 = bind(r2Work, "personal-r2");
  // Preserve complete user input and revisions, even beyond typical summary sizes.
  const longRequest = "原始约束不得裁掉。".repeat(5000);
  for (const [revision, text] of [[1, longRequest], [2, "只改 B，A 保持不变。"]] as const) {
    const id = `source-${revision}`;
    db.connection.prepare(`INSERT INTO bot_work_user_inputs(work_id,source_message_id,intent_revision,source_version,messages_json,references_json)
      VALUES (?,?,?,?,?,'[]')`).run(work.workId, id, revision, 1, JSON.stringify([{ messageId: id, conversationId: "original",
      role: "user", text, ordinal: revision, intentRevision: revision, sourceVersion: 1 }]));
  }
  const beforeWork = works.getWork(work.workId), beforeFacts = db.connection.prepare("SELECT * FROM work_subitem_results WHERE work_id=?").all(work.workId);
  const envelope = project(r2), handoff = envelope.revisionHandoff;
  assert.deepEqual(envelope.userRequest.messages.map((m: { text: string }) => m.text), [longRequest, "只改 B，A 保持不变。"]);
  const { revisionHandoff: _history, ...unchanged } = envelope;
  assert.deepEqual(unchanged, JSON.parse(works.repo.executionInput(r2)), "all original request fields and revision history survive");
  assert.equal(handoff.completedSubitems.length, 1); assert.equal(handoff.completedSubitems[0].task, "task-A");
  assert.equal(handoff.completedSubitems[0].summary, "summary-A");
  assert.equal(handoff.completedSubitems[0].source.bindingId, r1.bindingId);
  assert.equal(handoff.completedSubitems[0].source.intentRevision, 1);
  assert.equal(handoff.completedSubitems[0].source.inputSnapshotId, work.inputSnapshotId);
  assert(handoff.completedSubitems[0].deliverableId.startsWith("partial:"));
  assert.equal(handoff.unresolvedSubitems[0].itemId, "B");
  assert.equal(handoff.unresolvedOperations[0].operationId, "external-B-original");
  assert.equal(handoff.unresolvedOperations[0].state, "unknown");
  assert.equal(handoff.completedOperations[0].operationId, "write-A-original");
  assert.equal(handoff.unsettledExecutions[0].source.bindingId, r1.bindingId);
  const file = handoff.registeredFiles.find((f: { originalPath: string }) => f.originalPath === original);
  assert(file.immutable); assert.equal(file.snapshotPath, immutable); assert.equal(file.digest, digest);
  assert.equal(handoff.registeredFiles.find((f: { digest: string }) => f.digest === "mutable").immutable, false);
  writeFileSync(original, "CHANGED");
  assert.equal(readFileSync(file.snapshotPath, "utf8"), "A-READY", "immutable registered version remains reusable after source path changes");
  assert.equal(readFileSync(file.originalPath, "utf8"), "CHANGED");
  assert.deepEqual(works.getWork(work.workId), beforeWork); assert.deepEqual(db.connection.prepare("SELECT * FROM work_subitem_results WHERE work_id=?").all(work.workId), beforeFacts);
  assert(works.getWork(work.workId)!.criteria.every(c => c.status === "pending"), "history does not satisfy r2 criteria");
  assert.equal(works.closeWork(user, { operationId: "must-not-auto-pass-r2", workId: work.workId,
    conclusion: "succeeded", versionGuard: guard(works.getWork(work.workId)!) }).ok, false);

  // On restart the next native submission gets the same facts, not a process-local cache.
  db.close(); db = new AppDatabase(database); bots = new BotRegistry(db.connection); works = new WorkService(db.connection, { bots });
  const submissions: string[] = [], errors: unknown[] = [], receipts = new Map([[r1.bindingId, receipt(r1)]]);
  const native: WorkExecutionPort = {
    prepare: async taskId => ({ taskId, durableStoreKey: taskId, conversationId: "1", workspaceBinding: root }),
    find: async binding => receipts.get(binding.bindingId),
    submit: async (binding, text) => { submissions.push(text); const value = receipt(binding); receipts.set(binding.bindingId, value); return value; },
    inspect: async () => ({ status: "running" }), stop: async () => {},
  };
  const adapter = new WorkExecutionAdapter(works, native, LOCAL_USER_ID, () => true, (_id, error) => errors.push(error));
  await adapter.flush(); await adapter.flush(); await adapter.close();
  assert.deepEqual(errors, []); assert.equal(submissions.length, 1);
  assert.equal(JSON.parse(submissions[0]).revisionHandoff.completedSubitems[0].itemId, "A");
  let historyReads = 0;
  const historyInput = works.revisionHandoff.executionInput.bind(works.revisionHandoff);
  works.revisionHandoff.executionInput = (...args) => { historyReads++; return historyInput(...args); };
  await adapter.flush(); await adapter.close();
  assert.equal(historyReads, 0, "polling an existing submission never rescans revision history");

  // Input-only change retains revision but requires fresh benchmark/evidence.
  const updated = amend(r2Work, "new-source", { inputSnapshotId: "input:new-code" });
  assert.equal(updated.intentRevision, 2); assert.equal(updated.sourceVersion, 2);
  const r2NewInput = bind(updated, "personal-new-input"), sourceInput = project(r2NewInput);
  assert.equal(sourceInput.inputSnapshotId, "input:new-code");
  assert(sourceInput.revisionHandoff.completedSubitems.some((v: { itemId: string }) => v.itemId === "A"));
  assert(works.getWork(work.workId)!.criteria.every(c => c.status === "pending"));
  assert(sourceInput.revisionHandoff.instructions.includes("benchmark"));
  assert(sourceInput.revisionHandoff.instructions.includes("与其无依赖的独立工作仍可推进"));

  // Different Works, owners and owner epochs never enter this projection.
  const other = make("other-work"), otherBinding = bind(other, "other-r1");
  works.transaction(() => works.partialResults.record(otherBinding, [item("FOREIGN-WORK", "completed")]));
  const foreignOwner = { ...r1, bindingId: "foreign-owner", operationId: "foreign-owner", taskId: "foreign-owner", botId: "other-bot" };
  works.repo.insertBinding(foreignOwner);
  const foreignEpoch = { ...r1, bindingId: "foreign-epoch", operationId: "foreign-epoch", taskId: "foreign-epoch", ownerEpoch: 99 };
  works.repo.insertBinding(foreignEpoch);
  for (const b of [foreignOwner, foreignEpoch]) db.connection.prepare(`INSERT INTO work_subitem_results(fact_id,work_id,binding_id,item_id,result_json,created_at)
    VALUES (?,?,?,?,?,?)`).run(b.bindingId, work.workId, b.bindingId, b.bindingId, JSON.stringify(item(b.bindingId, "completed")), 1);
  assert(!JSON.stringify(project(r2NewInput)).includes("FOREIGN-WORK"));
  assert(!JSON.stringify(project(r2NewInput)).includes("foreign-owner"));
  assert(!JSON.stringify(project(r2NewInput)).includes("foreign-epoch"));
  assert.equal(works.revisionHandoff.executionInput({ ...r2NewInput, ownerEpoch: 99 }, "{\"unchanged\":true}"), "{\"unchanged\":true}");
  const otherInput = works.repo.executionInput(otherBinding);
  assert.equal(works.revisionHandoff.executionInput(otherBinding, otherInput), otherInput);

  const sameRevision = make("source-only"), sameRevisionOld = bind(sameRevision, "source-only-old");
  works.transaction(() => works.partialResults.record(sameRevisionOld, [item("SOURCE-ONLY", "completed")]));
  const refreshed = amend(sameRevision, "source-only-refresh", { inputSnapshotId: "fresh-code" });
  assert.equal(refreshed.intentRevision, sameRevision.intentRevision);
  const freshBinding = bind(refreshed, "source-only-new");
  const freshInput = project(freshBinding);
  assert.equal(freshInput.revisionHandoff.completedSubitems[0].source.inputSnapshotId, sameRevision.inputSnapshotId);
  assert.equal(freshInput.inputSnapshotId, "fresh-code");
  assert(works.getWork(sameRevision.workId)!.criteria.every(c => c.status === "pending"));

  const unboundWork = make("unbound-action");
  const unboundAction = works.admitNewAction(user, { admissionId: "unbound", operationId: "unbound-send", workId: unboundWork.workId, actionKind: "send" });
  assert(unboundAction.ok); works.settleAdmission(unboundAction.admission.admissionId, "unknown");
  const unboundUpdated = amend(unboundWork, "unbound-revision", { goalDescription: "先核对旧发送结果，然后处理新缺项" });
  const unboundBinding = bind(unboundUpdated, "unbound-new");
  const unboundInput = project(unboundBinding);
  assert.equal(unboundInput.revisionHandoff.unresolvedOperations[0].operationId, "unbound-send");
  assert.equal(unboundInput.revisionHandoff.unresolvedOperations[0].bindingId, null);
  assert.equal(unboundInput.revisionHandoff.unresolvedOperations[0].inputSnapshotId, null);

  // Bound result sets and exact omitted counts, without scanning unrelated Works.
  db.connection.transaction(() => { for (let i = 0; i < 65; i++) {
    db.connection.prepare(`INSERT INTO work_subitem_results(fact_id,work_id,binding_id,item_id,result_json,created_at)
      VALUES (?,?,?,?,?,?)`).run(`bound-${i}`, work.workId, r1.bindingId, `bound-${i}`, JSON.stringify(item(`bound-${i}`, "completed")), 1000 + i);
  } })();
  const read = trace(() => project(r2NewInput));
  assert.equal(read.result.revisionHandoff.completedSubitems.length, 40);
  assert.equal(read.result.revisionHandoff.omittedCounts.completedSubitems, 26);
  const factQueries = read.sql.filter(sql => /JOIN work_subitem_results|JOIN work_generated_artifacts|FROM work_action_admissions/.test(sql));
  assert.equal(factQueries.length, 5);
  for (const sql of factQueries) {
    assert(sql.includes("work_id=@workId")); assert(sql.includes("LIMIT @limit"));
    const plan = db.connection.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ workId: work.workId, botId: r2NewInput.botId,
      ownerEpoch: r2NewInput.ownerEpoch, bindingId: r2NewInput.bindingId, admittedAt: r2NewInput.admittedAt,
      revision: r2NewInput.intentRevision, inputId: r2NewInput.inputSnapshotId, limit: 40 }) as Array<{ detail: string }>;
    assert(!plan.some(row => /SCAN (?:i|a)\b/.test(row.detail)), `fact reads must use scoped indexes: ${JSON.stringify(plan)}`);
  }
  const resumed = new WorkService(db.connection, { bots });
  assert.deepEqual(JSON.parse(resumed.revisionHandoff.executionInput(r2NewInput, resumed.repo.executionInput(r2NewInput))), read.result);

  // Large native text and many refs cannot balloon the added context. User input
  // remains complete, and retained references/identities are never cut into new ones.
  const manyRefs = Array.from({ length: 1000 }, (_, index) => index === 0 ? `/${"x".repeat(2000)}` : `${root}/ref-${index}.txt`);
  const largeTask = "新要求仍需核对。".repeat(1000), largeSummary = "历史详细证据😀。".repeat(5000);
  const longFactId = `large-fact:${"identity-".repeat(40)}`, longItemId = `large-item:${"identity-".repeat(40)}`;
  const largeItem = { ...item(longItemId, "completed", manyRefs), task: largeTask, summary: largeSummary,
    childId: `child:${"identity-".repeat(80)}`, dependencies: manyRefs, writeConflicts: manyRefs, criterionIds: manyRefs };
  db.connection.transaction(() => {
    for (let index = 0; index < 65; index++) db.connection.prepare("UPDATE work_subitem_results SET result_json=? WHERE fact_id=?")
      .run(JSON.stringify({ ...largeItem, itemId: `bound-${index}` }), `bound-${index}`);
    db.connection.prepare(`INSERT INTO work_subitem_results(fact_id,work_id,binding_id,item_id,result_json,created_at)
      VALUES (?,?,?,?,?,?)`).run(longFactId, work.workId, r1.bindingId, longItemId, JSON.stringify(largeItem), Date.now() + 100);
  })();
  const fullInput = JSON.parse(works.repo.executionInput(r2NewInput)), largeProjection = project(r2NewInput);
  const { revisionHandoff: bounded, ...stillOriginal } = largeProjection;
  assert.deepEqual(stillOriginal, fullInput);
  assert.equal(stillOriginal.userRequest.messages[0].text, longRequest);
  assert(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 32 * 1024);
  assert.equal(bounded.maxBytes, 32 * 1024); assert.equal(bounded.truncated, true);
  const clipped = bounded.completedSubitems.find((row: { factId: string }) => row.factId === longFactId);
  assert(clipped); assert.equal(clipped.itemId, longItemId); assert.equal(clipped.childId, largeItem.childId);
  assert.equal(clipped.source.bindingId, r1.bindingId); assert.equal(clipped.source.inputSnapshotId, work.inputSnapshotId);
  assert.equal(clipped.task.length, 512); assert(clipped.summary.length <= 1200); assert(clipped.truncated);
  assert.equal(clipped.truncatedFields.task.omittedCharacters, largeTask.length - clipped.task.length);
  assert.equal(clipped.truncatedFields.summary.omittedCharacters, largeSummary.length - clipped.summary.length);
  assert.deepEqual(clipped.artifactRefs, manyRefs.slice(1, 8));
  assert.equal(clipped.truncatedFields.artifactRefs.omittedItems, 993);
  assert.equal(bounded.completedSubitems.length + bounded.omittedCounts.completedSubitems, 67);
  assert(bounded.omittedCounts.completedSubitems > 27, "overall byte budget omits additional complete records beyond the SQL row cap");
  assert(bounded.registeredFiles.some((row: { digest: string }) => row.digest === digest), "large summaries do not crowd out A's immutable file");
  assert.equal(bounded.unresolvedOperations[0].operationId, "external-B-original", "uncertainty survives the total byte budget");
  const hugeFactId = "huge-identity:" + "x".repeat(40_000);
  db.connection.prepare(`INSERT INTO work_subitem_results(fact_id,work_id,binding_id,item_id,result_json,created_at)
    VALUES (?,?,?,?,?,?)`).run(hugeFactId, work.workId, r1.bindingId, "huge-identity-item", JSON.stringify(item("huge-identity-item", "completed")), Date.now() + 200);
  const hugeIdentity = project(r2NewInput).revisionHandoff;
  assert(Buffer.byteLength(JSON.stringify(hugeIdentity), "utf8") <= 32 * 1024);
  assert.equal(hugeIdentity.completedSubitems.length + hugeIdentity.omittedCounts.completedSubitems, 68);
  assert(!hugeIdentity.completedSubitems.some((row: { factId: string }) => row.factId.startsWith("huge-identity:")), "an identity that cannot fit is omitted as a whole, never shortened");
  const hugeInputId = `input:${"i".repeat(40_000)}`;
  const hugeInputWork = amend(updated, "huge-input-identity", { inputSnapshotId: hugeInputId });
  const hugeInputBinding = bind(hugeInputWork, "huge-input-new"), hugeInputProjection = project(hugeInputBinding);
  assert.equal(hugeInputProjection.inputSnapshotId, hugeInputId, "current identity in original input is never shortened");
  assert(hugeInputProjection.revisionHandoff.currentIdentityOutsideHandoff);
  assert(Buffer.byteLength(JSON.stringify(hugeInputProjection.revisionHandoff), "utf8") <= 32 * 1024);
  console.log("PASS revision handoff: persisted A + unknown B, immutable files, native submit/restart, new input revalidation, owner/Work scope, bounded history, no acceptance or replay");
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }
