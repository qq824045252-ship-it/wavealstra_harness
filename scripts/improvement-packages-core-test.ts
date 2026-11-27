import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImprovementKnowledge } from "../src/main/agent/hooks/ImprovementKnowledge";
import { ImprovementPackages, type ImprovementUse } from "../src/main/agent/hooks/ImprovementPackages";
import { ImprovementReviewStore, type ReviewSnapshot } from "../src/main/agent/hooks/ImprovementReviewStore";
import { NativeHookStore } from "../src/main/agent/hooks/NativeHookStore";
import { executeDeliveryTool } from "../src/main/agent/hooks/DeliveryTool";
import { shutdownCoreWorker } from "../src/main/platform/core-client";
import { RuntimeAuditReader, locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import type { MemoryRecordDto } from "../src/shared/memory-kernel";

const executable = process.env.RUNTIME_AUDIT_BINARY ?? locateRuntimeAudit(process.cwd());
assert(executable && existsSync(executable), "The real supervised Core worker is required");
const root = realpathSync(mkdtempSync(join(tmpdir(), "mybuddy-improvement-core-")));
const database = join(root, "app.duckdb");
const started = Date.parse("2026-11-23T10:00:00Z");
const week = "2026-11-23";
const following = "2026-11-30";
const followingStart = Date.parse(following + "T00:00:00Z");
let now = started;

const memory = new Map<string, MemoryRecordDto>();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const knowledge = new ImprovementKnowledge(join(root, "knowledge"), {
  getWeeklyObservationMemory(id) { return memory.get(id); },
  stageWeeklyObservationMemory(scope, source) {
    const id = "mem_weekly_" + source.taskId;
    const content = "核对交付物实际保存的章节和附件。";
    const row: MemoryRecordDto = {
      id, kind: "fact", title: "交付要求回读", content, status: "active", explicit: true,
      importance: 1, confidence: 1, sourceType: "event", sourceTaskId: source.taskId, contentHash: sha(content),
      createdAt: started, updatedAt: started, recallCount: 0, metadata: {}, evidence: [], relations: [],
      scopes: [{ memoryId: id, scopeType: scope.kind, scopeId: scope.id, binding: "owned", createdAt: started }],
    };
    memory.set(id, row);
    return row;
  },
});

function connect(coreRole?: "background-service") {
  const reader = new RuntimeAuditReader(executable, database, { coreDataDirectory: root, coreRole });
  const packages = new ImprovementPackages(reader, new NativeHookStore(reader), () => now, () => knowledge, async (draft, dir) => {
    const original = "# Draft\n";
    writeFileSync(join(dir, draft.contract.document), original);
    const evidence = await executeDeliveryTool(draft.tool, dir, draft.contract);
    return { ...evidence, expectedEvidence: { [draft.contract.document]: sha(original) } };
  });
  return { reader, packages, review: new ImprovementReviewStore(reader) };
}

const first = connect();
const other = connect("background-service");
let reopened: ReturnType<typeof connect> | undefined;
const draft = (id: string, taskId: string) => first.packages.createDraft(id, { kind: "task", id: taskId },
  { taskId, conversationId: "observation", actor: "main", entry: 1, trigger: 1, input: 1, at: started - 100 },
  { document: "report.md", headings: ["Results"], attachments: ["support.csv"] }, week);
const usage = (task: string, run: number, event: string, at: number, generation = "101"): ImprovementUse => ({
  task, conversation: "trace", actor: "main", run: String(run), kind: "hook", event, generation, at,
});

try {
  const original = await draft("versioned", "version-task");
  const initial = await first.packages.publish(original, 0);
  assert.deepEqual([initial.revision, initial.generation, initial.enabled, initial.previous], [1, 1, true, null]);
  const changes = ["先核对图表。", "先核对附件。"];
  now += 500;
  const staged = await Promise.all(changes.map((change, index) =>
    [first, other][index].packages.stage({ ...original, convention: original.convention + change })));
  const raced = await Promise.allSettled(staged.map((key, index) => [first, other][index].packages.activate(key, 1)));
  const winner = raced.filter(result => result.status === "fulfilled");
  assert.equal(winner.length, 1);
  const refused = raced.find(result => result.status === "rejected");
  assert.match(String(refused?.reason), /基础版本已变化/);
  const second = winner[0].value;
  assert.deepEqual([second.revision, second.generation, second.previous], [2, 2, 1]);

  const revisionThree = { ...original, convention: original.convention + "核对实际结果。" };
  const stale = await first.packages.stage(revisionThree);
  const regressed = { status: "missing" as const, missing: ["标题: Results"], evidence: {} };
  const late = usage("version-task", 21, "error", now + 100);
  await other.packages.regression("versioned", 1, regressed, late);
  assert.equal((await first.packages.current("versioned"))?.release.hash, second.hash);
  await assert.rejects(first.packages.activate(stale, 2), /回放证据已变化/);

  const activeFault = usage("version-task", 22, "error", now + 150);
  const failedVariant = { ...regressed, missing: ["support.csv"] };
  const checkedAgain = await first.packages.stage(revisionThree);
  assert.equal(checkedAgain, stale);
  await Promise.all([
    first.packages.regression("versioned", 2, failedVariant, activeFault),
    other.packages.regression("versioned", 2, failedVariant, activeFault),
  ]);
  assert.deepEqual((await first.packages.current("versioned"))?.release, { ...initial, generation: 3 });
  assert.equal((await first.packages.uses("versioned", 2)).length, 1);
  await other.packages.regression("versioned", 1, regressed, late);
  assert.equal((await first.packages.current("versioned"))?.release.generation, 3, "A duplicate old receipt must not retire the restored version");
  await assert.rejects(first.packages.activate(checkedAgain, 3), /回放证据已变化/);
  const third = await first.packages.publish(revisionThree, 3);
  assert.deepEqual([third.revision, third.generation, third.previous], [3, 4, 1]);
  await first.packages.record("versioned", 2, usage("version-task", 23, "error", now + 200));
  assert.equal((await other.packages.select({ taskId: "version-task" }))?.release.hash, third.hash);
  console.log("PASS release races, stale replay rejection and duplicate regression safety");

  const cohort = await first.packages.publish(await draft("cohort", "report-task"), 0);
  const time = now + 1_000;
  const inputs = [{ entry: 11, at: time, eligible: true }, { entry: 12, at: time + 1, eligible: true }];
  await Promise.all([first.packages.indexInputs("report-task", "trace", "main", inputs),
    other.packages.indexInputs("report-task", "trace", "main", inputs)]);
  const passed = usage("report-task", 11, "passed", time + 100);
  await first.packages.record(cohort.id, 1, passed);
  await other.packages.record(cohort.id, 1, { ...passed, event: "accepted", at: time + 200 });
  await first.packages.record(cohort.id, 1, { ...passed, generation: "102" });
  const pending = await first.packages.pendingAcceptance("report-task");
  assert.deepEqual(pending.map(row => [row.run, row.generation]), [["11", "102"]]);
  const weekly = await first.packages.metrics(week);
  assert.deepEqual([weekly.userInputs, weekly.eligibleInputs, weekly.accepted], [2, 2, 1]);
  console.log("PASS input indexing and per-generation acceptance");

  now = followingStart + 1_000;
  const before = await first.packages.followup(following, now);
  const summary = async () => (await first.packages.report()).outcomes.find(item => item.packageId === cohort.id && item.week === following);
  const effective = await summary();
  assert.deepEqual([effective?.state, effective?.opportunities, effective?.accepted, effective?.corrections], ["effective", 2, 1, 0]);
  const correction = { taskId: "report-task", conversationId: "trace", input: 11, actor: "main" as const, entry: 30, trigger: 25, at: now };
  await other.packages.correction(correction);
  await first.packages.acknowledgeWeek(following, before);
  assert.deepEqual(await first.packages.dirtyWeeks(following), [following], "A new correction must survive acknowledging an older report");
  const after = await first.packages.followup(following, now);
  const ineffective = await summary();
  assert.deepEqual([ineffective?.state, ineffective?.opportunities, ineffective?.accepted, ineffective?.corrections], ["ineffective", 2, 0, 1]);
  await first.packages.acknowledgeWeek(following, after);
  await other.packages.correction(correction);
  assert.deepEqual(await first.packages.dirtyWeeks(following), []);

  for (const id of ["report-task", "unbound"]) {
    const saved = await first.reader.upsertTaskRecord({ id, title: id, at: started, preserveTitle: false, preserveWorkspace: false });
    assert.equal(saved?.status, "saved");
  }
  const initialBinding = { taskId: "report-task", directory: join(root, "pi-store"), cwd: root };
  const bound = await first.reader.writeDurableTaskProjection({ kind: "bindBot", ...initialBinding });
  assert.equal(bound?.status, "applied");
  assert.deepEqual(await other.review.bindings(), [{ ...initialBinding, projectId: null, spaceId: null }]);
  assert.equal(await first.review.binding("unbound"), undefined);
  const changed = await other.reader.writeDurableTaskProjection({ kind: "bindBot", ...initialBinding,
    cwd: join(root, "new-workspace"), updateCwdIfExists: true });
  assert.equal(changed?.status, "applied");
  assert.deepEqual(await first.review.binding("report-task"), { ...initialBinding, cwd: join(root, "new-workspace"), projectId: null, spaceId: null });

  const owners = ["interactive", "scheduled"];
  const began = await Promise.all([first, other].map(({ review }, index) =>
    review.command<boolean>({ kind: "begin", owner: owners[index], week, at: started, scheduled: index === 1 })));
  assert.equal(began.filter(Boolean).length, 1, "Only one Core client owns the review");
  const owner = owners[began.indexOf(true)];
  const rival = owners[began.indexOf(false)];
  await assert.rejects(other.review.write(rival, { kind: "finishScan", week, at: started, duration: 10_000, issues: "[]" }), /所有权/);

  const source = JSON.stringify({ taskId: "report-task", conversationId: "trace", entry: 30, input: 11, at: started });
  const currentCursor = JSON.stringify({ analysisVersion: 3, last: 42 });
  const scan = {
    kind: "saveScan" as const, week, task: "report-task", conversation: "trace", state: currentCursor, scanned: 4,
    observations: [{ key: "contract-gap", kind: "deliveryContract" as const, scope: '{"kind":"task","id":"report-task"}',
      entry: 30, source, replay: "{}" }],
  };
  await Promise.all([first.review.write(owner, scan), other.review.write(owner, scan)]);
  await other.review.write(owner, { ...scan, state: JSON.stringify({ analysisVersion: 2, last: 99 }) });
  assert.equal(await first.review.read({ kind: "checkpoint", task: "report-task", conversation: "trace" }), currentCursor);
  assert.deepEqual(await other.review.read({ kind: "source", key: "contract-gap", task: "report-task", conversation: "trace", entry: 30 }), source);
  const assessment = { key: "contract-gap", week, source };
  assert.deepEqual(await first.review.read({ kind: "assessmentCandidates", week }), [{ key: assessment.key, source }]);
  assert.equal(await other.review.write(owner, { kind: "reserveAssessment", ...assessment }), true);
  await first.review.write(owner, { kind: "assessmentStarted", week });
  await other.review.write(owner, { kind: "assessmentResult", ...assessment, assessment: '{"text":"The original request lacked the required attachment."}' });
  assert.deepEqual(await first.review.read({ kind: "assessmentCandidates", week }), []);
  const slots = await Promise.all(Array.from({ length: 6 }, (_, key) => [first, other][key % 2].review.write<string | null>(owner,
    { kind: "reserveSlot", key: String(key), week })));
  assert.equal(slots.filter(slot => slot === week).length, 5);
  assert.equal(await first.review.write(owner, { kind: "reserveSlot", key: String(slots.indexOf(week)), week: following }), week);
  await first.review.write(owner, { kind: "saveChild", task: "report-task", directory: root, conversation: 13,
    childId: "audit", immutable: true, summary: JSON.stringify({ startedAt: started }) });
  await first.review.write(owner, { kind: "pruneChildren", task: "report-task", seen: [13] });
  await other.review.write(owner, { kind: "finishScan", week, at: started, duration: 25, issues: "[]" });
  await first.review.write(owner, { kind: "markExported", week, finished: true });
  await other.review.write(owner, { kind: "sealReview", week });
  await first.review.command({ kind: "release", owner });
  assert.equal(await other.review.command<boolean>({ kind: "begin", owner: rival, week, at: started, scheduled: true }), false);
  const afterGap = "2026-12-07";
  assert.equal(await other.review.command<boolean>({ kind: "begin", owner: rival, week: afterGap, at: now, scheduled: false }), true);
  await assert.rejects(first.review.write(owner, { kind: "pruneChildren", task: "report-task", seen: [] }), /所有权/);
  await first.review.command({ kind: "release", owner });
  assert.equal(await other.review.command<boolean>({ kind: "renew", owner: rival }), true);
  await other.review.write(rival, { kind: "finishScan", week: afterGap, at: now, duration: 5, issues: "[]" });
  assert.deepEqual(await first.review.read({ kind: "unfinished", through: afterGap }), [{ week: following }, { week: afterGap }]);
  await other.review.command({ kind: "release", owner: rival });
  console.log("PASS review ownership, checkpoint replay, weekly quotas, assessment and missed-week recovery");

  await first.reader.close();
  await other.reader.close();
  await shutdownCoreWorker(root, database);
  reopened = connect();
  const persisted = await reopened.packages.report();
  assert.deepEqual(persisted.versions.filter(v => v.packageId === "versioned").map(v => [v.revision, v.retired, v.active]),
    [[3, false, true], [2, true, false], [1, false, false]]);
  assert.deepEqual(persisted.outcomes.find(item => item.packageId === cohort.id && item.week === following), ineffective);
  const review = await reopened.review.read<ReviewSnapshot>({ kind: "report" });
  const finished = review.runs.find(run => run.week === week);
  assert.deepEqual([finished?.scanned, finished?.added, finished?.issues], [4, 1, "[]"]);
  assert.equal(review.items[0]?.assessment?.source, source);
  assert.equal(review.children[0]?.task, "report-task");
  assert.deepEqual(await reopened.review.read({ kind: "weeklyStats", week, start: started - 1, end: started + 1 }),
    { durationMs: 25, modelRequests: 1, corrections: 1 });
  console.log("PASS DuckDB improvement packages: concurrent publication, stale replay fence, idempotent rollback, cohort totals, late evidence and restart");
} finally {
  await reopened?.reader.close();
  await first.reader.close();
  await other.reader.close();
  await shutdownCoreWorker(root, database);
  rmSync(root, { recursive: true, force: true });
}
