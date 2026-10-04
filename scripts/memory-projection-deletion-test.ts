import assert from "node:assert/strict";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";

async function main(): Promise<void> {
  const db = new AppDatabase(":memory:");
  try {
    const memory = new MemoryService(db, { semantic: false });
    const projections = memory.cognition.projections;
    const globalScope = { scopeType: "global" as const };
    db.createSpace({ id: "other", name: "其他空间" });
    const otherScope = { scopeType: "workspace" as const, scopeId: "other" };
    const a = memory.create({ kind: "fact", title: "基础事实 A", content: "已确认的长期事实 A", scopeType: "global", sourceType: "manual" });
    const b = memory.create({ kind: "fact", title: "基础事实 B", content: "已确认的长期事实 B", scopeType: "global", sourceType: "manual" });
    const c = memory.create({ kind: "fact", title: "其他空间事实", content: "未选中的空间事实", ...otherScope, sourceType: "manual" });
    db.upsertTask({ id: "source", title: "保留对话", updatedAt: Date.now(), status: "completed" });
    const pipeline = new MemoryPipelineManager(db);
    const source = pipeline.capture({ taskId: "source", userText: "保留来源原文", assistantText: "收到" }).turn;
    const draft = (title: string) => ({ title, summary: `${title}的已确认摘要`, sourceMemoryIds: [a.id, b.id] });
    const first = projections.replaceScenarios(globalScope, [draft("场景 A"), draft("历史场景"), draft("已屏蔽场景")]);
    const live = first.find((item) => item.title === "场景 A")!;
    const historical = first.find((item) => item.title === "历史场景")!;
    const dismissed = first.find((item) => item.title === "已屏蔽场景")!;
    memory.dismissProjection(dismissed.id, "scenario");
    projections.replaceScenarios(globalScope, [draft("场景 A")]);
    const other = projections.replaceScenarios(otherScope, [{ title: "其他空间场景", summary: "保持有效", sourceMemoryIds: [c.id] }])[0];
    const profile = projections.replaceCoreProfile(globalScope, { title: "关联画像", content: "基于 A 的画像", sourceScenarioIds: [live.id] })!;
    const otherProfile = projections.replaceCoreProfile(otherScope, { title: "其他画像", content: "保持有效", sourceScenarioIds: [other.id] })!;
    projections.proposeScenarios(globalScope, [{ ...draft("场景 A"), summary: "场景 A 的待批准修改" }, draft("待批准场景"), draft("已拒绝场景")]);
    const rejected = memory.listProjectionProposals().find((item) => item.title === "已拒绝场景")!;
    memory.rejectProjectionProposal(rejected.id);
    projections.proposeProfile(globalScope, { title: "关联画像修改", content: "旧场景的待批准画像", sourceScenarioIds: [live.id] });
    const l1Before = memory.stats().total;
    const proposalsBefore = memory.listProjectionProposals();
    const versionBefore = memory.cognition.generationVersion("scenario");
    db.connection.exec(`CREATE TRIGGER fail_scene_delete BEFORE DELETE ON memory_scenarios
      WHEN OLD.title='场景 A' BEGIN SELECT RAISE(ABORT, 'test scene deletion failure'); END`);
    assert.throws(() => memory.deleteProjectionRecords({ kind: "scenario", targetIds: [live.id] }), /test scene deletion failure/);
    assert.equal(memory.listScenarios().find((item) => item.id === live.id)?.status, "active");
    assert.equal(memory.listCoreProfiles().find((item) => item.id === profile.id)?.status, "active", "failure rolls back dependent invalidation");
    assert.deepEqual(memory.listProjectionProposals(), proposalsBefore, "failure rolls back dependent proposal deletion");
    assert.equal(memory.cognition.generationVersion("scenario"), versionBefore, "failed deletion does not cancel a valid generation");
    db.connection.exec("DROP TRIGGER fail_scene_delete");
    const deleted = memory.deleteProjectionRecords({ kind: "scenario", targetIds: [live.id, live.id] });
    assert.deepEqual(deleted, { projections: 1, dismissals: 0, proposals: 1, invalidatedProfiles: 1, dependentProposals: 1 });
    assert.equal(memory.listScenarios().some((item) => item.id === live.id), false);
    assert.equal(memory.listDismissedProjections().some((item) => item.id === live.id), false, "hard delete leaves no dismissal copy");
    assert.equal(memory.listCoreProfiles().find((item) => item.id === profile.id)?.status, "stale");
    assert.equal(projections.isRevoked(profile.id, "profile"), true, "frozen L3 cannot continue using a deleted L2 source");
    assert.equal(projections.isRevoked(otherProfile.id, "profile"), false);
    assert.equal(memory.listScenarios().find((item) => item.id === other.id)?.status, "active");
    assert.equal(memory.stats().total, l1Before);
    assert.ok(pipeline.turns.get(source.id));
    assert.equal(memory.deleteProjectionRecords({ kind: "scenario", targetIds: [historical.id] }).projections, 1);
    assert.equal(memory.deleteProjectionRecords({ kind: "scenario", targetIds: [dismissed.id] }).dismissals, 1);
    assert.equal(memory.restoreProjection(dismissed.id), false);
    assert.equal(memory.deleteProjectionRecords({ kind: "scenario", proposalIds: [rejected.id] }).proposals, 1);
    assert.equal(memory.restoreProjectionProposal(rejected.id), false);
    assert.equal(memory.approveProjectionProposal(rejected.id), false);
    assert.throws(() => memory.deleteProjectionRecords({ kind: "bogus" } as never), /有效的场景或画像/);
    assert.throws(() => memory.deleteProjectionRecords({ kind: "scenario", all: true, targetIds: [live.id] }), /有效的场景或画像/);
    assert.equal(memory.deleteProjectionRecords({ kind: "profile", targetIds: [other.id] }).projections, 0, "kind mismatch must not remove a scene");

    const batchScenes = projections.replaceScenarios(globalScope, [draft("多选场景 A"), draft("多选场景 B"), draft("保留场景")]);
    projections.proposeScenarios(globalScope, [draft("多选提案"), draft("保留提案")]);
    const batchProposal = memory.listProjectionProposals().find((item) => item.title === "多选提案")!;
    const batchTargets = batchScenes.filter((item) => item.title.startsWith("多选")).map((item) => item.id);
    const mixedDeleted = memory.deleteProjectionRecords({ kind: "scenario", targetIds: batchTargets, proposalIds: [batchProposal.id] });
    assert.deepEqual(mixedDeleted, { projections: 2, dismissals: 0, proposals: 1, invalidatedProfiles: 0, dependentProposals: 0 });
    assert.equal(memory.listScenarios().some((item) => batchTargets.includes(item.id)), false);
    assert.equal(memory.listProjectionProposals().some((item) => item.id === batchProposal.id), false);
    assert.ok(memory.listScenarios().some((item) => item.title === "保留场景"), "batch deletion preserves unselected scenes");
    assert.ok(memory.listProjectionProposals().some((item) => item.title === "保留提案"), "batch deletion preserves unselected proposals");
    assert.equal(memory.stats().total, l1Before);
    assert.ok(pipeline.turns.get(source.id));

    // A full deletion is database-wide, including rows outside the renderer's display caps.
    projections.replaceScenarios(globalScope, Array.from({ length: 305 }, (_, i) => draft(`全量场景 ${i}`)));
    projections.proposeScenarios(globalScope, Array.from({ length: 305 }, (_, i) => draft(`全量提案 ${i}`)));
    assert.equal(memory.listScenarios().length, 300);
    assert.equal(memory.listProjectionProposals().length, 300);
    const result = memory.deleteProjectionRecords({ kind: "scenario", all: true });
    assert.ok(result.projections > 300 && result.proposals > 300);
    for (const table of ["memory_scenarios", "memory_projection_dismissals", "memory_projection_proposals"]) {
      const where = table === "memory_scenarios" ? "" : " WHERE kind='scenario'";
      assert.equal((db.connection.prepare(`SELECT COUNT(*) n FROM ${table}${where}`).get() as { n: number }).n, 0);
    }
    assert.equal(memory.stats().scenarios, 0);
    assert.equal(memory.stats().coreProfiles, 0);
    assert.equal(memory.deleteProjectionRecords({ kind: "profile", all: true }).projections, 2, "profile history is also deletable");
    assert.equal(memory.listCoreProfiles().length, 0);
    assert.equal(memory.stats().total, l1Before);
    assert.ok(pipeline.turns.get(source.id));
    assert.equal(memory.deleteProjectionRecords({ kind: "scenario", all: true }).projections, 0);

    // Manual generation can be requested again, but an in-flight pre-delete result cannot return.
    const model = {} as never;
    const reply = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }], stopReason: "stop" });
    const runtime = { completeSimple: async () => {
      memory.deleteProjectionRecords({ kind: "scenario", all: true });
      return reply({ scenarios: [{ scopeKey: "global:", ...draft("迟到场景") }] });
    } };
    const lateL2 = await memory.cognition.generateL2({ includeAllScopes: true, modelRuntime: runtime as never, model, isEnabled: () => true });
    assert.equal(lateL2.completed, false);
    assert.equal(memory.listProjectionProposals().length, 0);
    const freshRuntime = { completeSimple: async () => reply({ scenarios: [{ scopeKey: "global:", ...draft("场景 A") }] }) };
    const fresh = await memory.cognition.generateL2({ includeAllScopes: true, modelRuntime: freshRuntime as never, model, isEnabled: () => true });
    assert.equal(fresh.outputs, 1);
    assert.equal(memory.listScenarios().length, 0, "regeneration still requires approval");
    memory.approveProjectionProposal(memory.listProjectionProposals()[0].id);
    const recreated = memory.listScenarios()[0];
    const profileRuntime = { completeSimple: async () => {
      memory.deleteProjectionRecords({ kind: "profile", all: true });
      return reply({ profiles: [{ scopeKey: "global:", title: "迟到画像", content: "旧请求", sourceScenarioIds: [recreated.id] }] });
    } };
    const lateL3 = await memory.cognition.generateL3({ includeAllScopes: true, modelRuntime: profileRuntime as never, model, isEnabled: () => true });
    assert.equal(lateL3.completed, false);
    assert.equal(memory.listProjectionProposals().length, 0);
    projections.proposeProfile(globalScope, { title: "已拒绝画像", content: "画像提案", sourceScenarioIds: [recreated.id] });
    const profileProposal = memory.listProjectionProposals()[0];
    memory.rejectProjectionProposal(profileProposal.id);
    const publishedProfile = projections.replaceCoreProfile(globalScope, { title: "已屏蔽画像", content: "历史画像", sourceScenarioIds: [recreated.id] })!;
    memory.dismissProjection(publishedProfile.id, "profile");
    const clearedProfiles = memory.deleteProjectionRecords({ kind: "profile", all: true });
    assert.equal(clearedProfiles.dismissals, 1);
    assert.equal(clearedProfiles.proposals, 1);
    assert.equal(memory.listScenarios().length, 1, "profile cleanup preserves its scene sources");
    console.log("memory-projection-deletion-test: PASS (active/history/dismissal/proposal deletion, full-store coverage, rollback, dependent revocation, and generation races)");
  } finally {
    db.close();
  }
}
void main().catch((error) => { console.error(error); process.exit(1); });
