import assert from "node:assert/strict";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";

function fakeResponse(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], stopReason: "stop" };
}

async function main(): Promise<void> {
  const db = new AppDatabase(":memory:");
  try {
    const ws = db.createSpace({ id: "ws-cognition", name: "Cognition" });
    db.connection.prepare(
      `INSERT INTO projects (id,name,description,instructions,created_at,updated_at,archived,resource_budget_chars)
       VALUES ('proj-cognition','Cognition Project',NULL,NULL,?,?,0,128000)`,
    ).run(Date.now(), Date.now());
    db.upsertTask({
      id: "task-cognition",
      title: "Cognition Task",
      spaceId: ws.id,
      projectId: "proj-cognition",
      status: "in_progress",
      updatedAt: Date.now(),
    });

    const memory = new MemoryService(db, { semantic: false });
    const globalPreference = memory.create({
      kind: "preference", title: "工程偏好", content: "质量和稳定优先，验证保持短而聚焦。",
      scopeType: "global", sourceType: "user", explicit: true, importance: 2, confidence: 1,
    });
    const globalProcedure = memory.create({
      kind: "procedure", title: "Review 方式", content: "实现后做独立 review，再做相关 focused tests。",
      scopeType: "global", sourceType: "user", explicit: true, importance: 1, confidence: 1,
    });
    const projectDecision = memory.create({
      kind: "decision", title: "Pt100 激励方案", content: "采用 ±100 µA 正反向激励。",
      scopeType: "project", scopeId: "proj-cognition", sourceType: "user", explicit: true, importance: 3, confidence: 1,
    });
    const projectConstraint = memory.create({
      kind: "constraint", title: "Pt100 校准约束", content: "使用 21 点校准并保留四线制。",
      scopeType: "project", scopeId: "proj-cognition", sourceType: "user", explicit: true, importance: 2, confidence: 1,
    });
    const projectRisk = memory.create({
      kind: "risk", title: "模拟温漂风险", content: "模拟前端温漂仍需持续关注，不能假设已经消失。",
      scopeType: "project", scopeId: "proj-cognition", sourceType: "agent", importance: 1, confidence: 0.85,
    });
    const l1Total = memory.stats().total;

    let l2Version = 1;
    let modelCalls = 0;
    const runtime = {
      completeSimple: async (_model: unknown, request: { systemPrompt?: string }) => {
        modelCalls += 1;
        if (request.systemPrompt?.includes("L3 Core Profile")) {
          const scenarios = memory.listScenarios().filter((item) => item.status === "active");
          const globalIds = scenarios.filter((item) => item.scopeType === "global").map((item) => item.id);
          const projectIds = scenarios.filter((item) => item.scopeType === "project" && item.scopeId === "proj-cognition").map((item) => item.id);
          return fakeResponse({
            profiles: [
              {
                scopeKey: "global:",
                title: "工程工作画像",
                content: "以质量和稳定为优先原则，偏好短而聚焦的验证，并在实现后进行独立 review。",
                sourceScenarioIds: globalIds,
              },
              {
                scopeKey: "project:proj-cognition",
                title: "Pt100 项目核心认知",
                content: "项目长期技术方向是四线精密 Pt100 测量，以正反向小电流激励和多点校准为基础，同时持续关注模拟温漂风险。",
                sourceScenarioIds: projectIds,
              },
            ],
          });
        }
        if (request.systemPrompt?.includes("L2 Scenario")) {
          if (l2Version === 1) {
            return fakeResponse({
              scenarios: [
                {
                  scopeKey: "global:",
                  title: "工程协作方式",
                  summary: "长期强调质量与稳定，并在实现后采用独立 review 和 focused tests。",
                  sourceMemoryIds: [globalPreference.id, globalProcedure.id],
                },
                {
                  scopeKey: "project:proj-cognition",
                  title: "Pt100 高精度测量方案",
                  summary: "当前采用 ±100 µA 正反向激励、四线制与 21 点校准；模拟温漂仍是持续风险，不能视为已解决。",
                  sourceMemoryIds: [projectDecision.id, projectConstraint.id, projectRisk.id],
                },
                {
                  scopeKey: "project:proj-cognition",
                  title: "恶意越界 provenance",
                  summary: "这条必须被拒绝。",
                  sourceMemoryIds: [projectDecision.id, "mem_hallucinated"],
                },
              ],
            });
          }
          return fakeResponse({
            scenarios: [
              {
                scopeKey: "global:",
                title: "工程协作方式",
                summary: "长期强调质量与稳定，并在实现后采用独立 review 和 focused tests。",
                sourceMemoryIds: [globalPreference.id, globalProcedure.id],
              },
              {
                scopeKey: "project:proj-cognition",
                title: "Pt100 精密前端当前架构",
                summary: "精密前端以 ±100 µA 正反向激励、四线制和 21 点校准为稳定约束；模拟温漂风险继续保留。",
                sourceMemoryIds: [projectDecision.id, projectConstraint.id, projectRisk.id],
              },
            ],
          });
        }
        throw new Error("unexpected cognition prompt");
      },
    };
    const model = {} as never;
    const approvePending = (): void => {
      for (const proposal of memory.listProjectionProposals("pending")) {
        assert.equal(memory.approveProjectionProposal(proposal.id), true, "valid proposal can be explicitly approved");
      }
    };

    const l2 = await memory.cognition.generateL2({
      taskId: "task-cognition",
      modelRuntime: runtime as never,
      model,
      isEnabled: () => true,
    });
    assert.equal(l2.completed, true);
    assert.equal(l2.outputs, 2, "only validated scenarios should become proposals");
    assert.equal(memory.stats().total, l1Total, "L2 must never create L1 MemoryRecord");
    assert.equal(memory.listScenarios().length, 0, "generated scenarios stay out of context before approval");
    assert.equal(memory.listProjectionProposals("pending").length, 2);
    approvePending();
    const scenariosV1 = memory.listScenarios();
    const activeV1 = scenariosV1.filter((item) => item.status === "active");
    assert.equal(activeV1.length, 2);
    assert.equal(activeV1.some((item) => item.title === "恶意越界 provenance"), false, "hallucinated source id must reject the whole scenario");
    const l1Ids = new Set(memory.list().map((item) => item.id));
    assert.ok(activeV1.every((item) => item.sourceMemoryIds.every((id) => l1Ids.has(id))), "every L2 provenance id must point to L1 truth");

    const l3 = await memory.cognition.generateL3({
      taskId: "task-cognition",
      modelRuntime: runtime as never,
      model,
      isEnabled: () => true,
    });
    assert.equal(l3.completed, true);
    assert.equal(l3.outputs, 2);
    assert.equal(memory.stats().total, l1Total, "L3 must never create L1 MemoryRecord");
    assert.equal(memory.listCoreProfiles().length, 0, "generated profiles require explicit approval");
    approvePending();
    const profiles = memory.listCoreProfiles().filter((item) => item.status === "active");
    assert.equal(profiles.length, 2);
    const scenarioIds = new Set(activeV1.map((item) => item.id));
    assert.ok(profiles.every((profile) => profile.sourceScenarioIds.every((id) => scenarioIds.has(id))), "L3 must only cite same-pipeline L2 scenarios");

    // L1 commit and projection invalidation share a transaction.
    const totalBeforeProjectionFailure = memory.stats().total;
    db.connection.exec(
      `CREATE TRIGGER fail_test_projection_invalidation BEFORE UPDATE ON memory_scenarios
       WHEN OLD.scope_type='project' AND OLD.scope_id='proj-cognition'
       BEGIN SELECT RAISE(ABORT, 'test projection invalidation failure'); END`,
    );
    assert.throws(() => memory.create({
      kind: "fact", title: "Must roll back", content: "L1 cannot commit while its old projection remains active.",
      scopeType: "project", scopeId: "proj-cognition", sourceType: "manual",
    }), /test projection invalidation failure/);
    db.connection.exec("DROP TRIGGER fail_test_projection_invalidation");
    assert.equal(memory.stats().total, totalBeforeProjectionFailure, "projection invalidation failure rolls back L1 create");

    // L2 replacement and L3 invalidation are also one transaction.
    const globalBeforeFailedReplace = memory.listScenarios().filter((item) => item.scopeType === "global" && item.status === "active");
    db.connection.exec(
      `CREATE TRIGGER fail_test_profile_invalidation BEFORE UPDATE ON memory_core_profiles
       WHEN OLD.scope_type='global' BEGIN SELECT RAISE(ABORT, 'test profile invalidation failure'); END`,
    );
    assert.throws(() => memory.cognition.projections.replaceScenarios({ scopeType: "global" }, [
      ...globalBeforeFailedReplace.map((item) => ({ title: item.title, summary: item.summary, sourceMemoryIds: item.sourceMemoryIds })),
      { title: "Must not commit", summary: "L2 must roll back if L3 cannot be marked stale.", sourceMemoryIds: [globalPreference.id] },
    ]), /test profile invalidation failure/);
    db.connection.exec("DROP TRIGGER fail_test_profile_invalidation");
    assert.equal(memory.listScenarios().some((item) => item.title === "Must not commit"), false, "failed L3 invalidation rolls back L2 replacement");

    const context = memory.resolveContext({
      taskId: "task-cognition",
      query: "Pt100 方案和校准",
      budgetChars: 5000,
      limit: 20,
    });
    assert.equal(context.profileIds?.length, 2, "approved grounded profiles enter context");
    for (const profile of profiles) assert.ok(context.text.includes(`[L3 derived:${profile.id}]`));
    for (const atom of [globalPreference, globalProcedure, projectDecision, projectConstraint, projectRisk]) {
      assert.ok(context.text.includes(`${atom.id}@1`), "derived context preserves exact L1 provenance");
    }
    assert.equal(context.scenarioIds?.length, 0, "L2 already covered by L3 is not repeated");
    assert.equal(context.items.length, 0, "L1 already covered by grounded profiles is not repeated");
    assert.ok(context.includedChars <= context.budgetChars);

    // Generation proposes changes without silently replacing approved scenarios.
    l2Version = 2;
    await memory.cognition.generateL2({ taskId: "task-cognition", modelRuntime: runtime as never, model, isEnabled: () => true });
    approvePending();
    const scenariosV2 = memory.listScenarios();
    assert.ok(scenariosV2.some((item) => item.title === "Pt100 高精度测量方案" && item.status === "active"), "separate approved scenarios remain until explicitly removed or their sources change");
    assert.ok(scenariosV2.some((item) => item.title === "Pt100 精密前端当前架构" && item.status === "active"));
    assert.equal(memory.stats().total, l1Total);
    assert.ok(memory.listCoreProfiles().some((item) => item.scopeType === "project" && item.scopeId === "proj-cognition" && item.status === "stale"), "changed L2 must invalidate dependent L3");
    assert.ok(memory.listCoreProfiles().some((item) => item.scopeType === "global" && item.status === "active"), "unchanged global L2 must not invalidate unrelated L3");

    // Adding a brand-new L2 scenario changes the complete scope input even though the old L3
    // could not have referenced its id yet.
    const globalScenario = memory.listScenarios().find((item) => item.scopeType === "global" && item.status === "active")!;
    memory.cognition.projections.replaceScenarios({ scopeType: "global" }, [
      { title: globalScenario.title, summary: globalScenario.summary, sourceMemoryIds: globalScenario.sourceMemoryIds },
      { title: "新增协作边界", summary: "新增场景必须使基于旧完整 L2 集合的画像失效。", sourceMemoryIds: [globalPreference.id] },
    ]);
    assert.ok(memory.listCoreProfiles().some((item) => item.scopeType === "global" && item.status === "stale"), "new L2 id must invalidate the exact-scope L3 profile");

    // Rebuild L3, then mutate an L1 atom: dependent L2 + L3 must immediately become stale.
    await memory.cognition.generateL3({ taskId: "task-cognition", modelRuntime: runtime as never, model, isEnabled: () => true });
    approvePending();
    assert.ok(memory.listCoreProfiles().some((item) => item.scopeType === "project" && item.status === "active"));
    memory.create({
      kind: "fact", title: "新增 L1 输入", content: "新增记录不在旧 projection provenance 中，也必须按 scope 使投影失效。",
      scopeType: "project", scopeId: "proj-cognition", sourceType: "manual",
    });
    assert.equal(memory.listScenarios().filter((item) => item.scopeType === "project" && item.status === "active").length, 0, "new L1 must invalidate exact-scope L2 even without an old source id");
    assert.ok(memory.listCoreProfiles().some((item) => item.scopeType === "project" && item.status === "stale"), "new L1 must invalidate exact-scope L3");
    await memory.cognition.generateL2({ taskId: "task-cognition", modelRuntime: runtime as never, model, isEnabled: () => true });
    approvePending();
    await memory.cognition.generateL3({ taskId: "task-cognition", modelRuntime: runtime as never, model, isEnabled: () => true });
    approvePending();
    memory.update({
      id: projectConstraint.id,
      content: "使用 21 点校准、四线制，并保留校准点可追溯记录。",
      changedBy: "user",
      changeReason: "constraint refined",
    });
    assert.equal(memory.listScenarios().filter((item) => item.scopeType === "project" && item.status === "active").length, 0, "L1 update must invalidate dependent L2");
    assert.ok(memory.listCoreProfiles().some((item) => item.scopeType === "project" && item.status === "stale"), "L1 update must invalidate dependent L3");

    // Rebuild once more, then hard-forget a source L1. Forget must not be bypassed by stale derived text.
    await memory.cognition.generateL2({ taskId: "task-cognition", modelRuntime: runtime as never, model, isEnabled: () => true });
    approvePending();
    await memory.cognition.generateL3({ taskId: "task-cognition", modelRuntime: runtime as never, model, isEnabled: () => true });
    approvePending();
    memory.forget(projectRisk.id);
    assert.equal(memory.get(projectRisk.id), undefined);
    assert.equal(memory.listScenarios().filter((item) => item.scopeType === "project" && item.status === "active").length, 0, "forgotten L1 must invalidate dependent Scenario");
    assert.ok(memory.listCoreProfiles().some((item) => item.scopeType === "project" && item.status === "stale"), "forgotten L1 must invalidate dependent Profile");
    const afterForgetContext = memory.resolveContext({ taskId: "task-cognition", query: "Pt100 温漂风险", budgetChars: 5000, limit: 20 });
    assert.equal(afterForgetContext.text.includes("Pt100 项目核心认知"), false, "forgotten L1 must not re-enter prompt through L3");
    assert.equal(afterForgetContext.text.includes("Pt100 精密前端当前架构"), false, "forgotten L1 must not re-enter prompt through L2");

    // Disabled cognition must not call the model or mutate projections.
    const callsBeforeDisabled = modelCalls;
    const activeBeforeDisabled = memory.listScenarios().filter((item) => item.status === "active").map((item) => item.contentHash).sort();
    const disabled = await memory.cognition.generateL2({ taskId: "task-cognition", modelRuntime: runtime as never, model, isEnabled: () => false });
    assert.equal(disabled.completed, false);
    assert.equal(modelCalls, callsBeforeDisabled);
    assert.deepEqual(memory.listScenarios().filter((item) => item.status === "active").map((item) => item.contentHash).sort(), activeBeforeDisabled);

    // Automatic L1 completion does not generate higher-layer proposals or publish them.
    const pipeline = new MemoryPipelineManager(db);
    const proposalsBefore = memory.listProjectionProposals("pending");
    const callsBeforeL1 = modelCalls;
    for (let i = 0; i < 12; i += 1) pipeline.completeL1("task-cognition", []);
    assert.deepEqual(memory.listProjectionProposals("pending"), proposalsBefore);
    assert.equal(modelCalls, callsBeforeL1);

    // Malformed/empty model output must preserve an existing healthy projection rather than erase it.
    const globalBeforeMalformed = memory.listScenarios().find((item) => item.scopeType === "global" && item.status === "active");
    assert.ok(globalBeforeMalformed);
    const emptyRuntime = { completeSimple: async () => fakeResponse({ scenarios: [] }) };
    await memory.cognition.generateL2({ taskId: "task-cognition", modelRuntime: emptyRuntime as never, model, isEnabled: () => true });
    const globalAfterMalformed = memory.listScenarios().find((item) => item.scopeType === "global" && item.status === "active");
    assert.equal(globalAfterMalformed?.id, globalBeforeMalformed?.id);
    assert.equal(globalAfterMalformed?.contentHash, globalBeforeMalformed?.contentHash);

    // Optimistic snapshot guard: if L1 changes while L2 is in flight, the stale response must not reactivate old cognition.
    db.connection.prepare(
      `INSERT INTO projects (id,name,description,instructions,created_at,updated_at,archived,resource_budget_chars)
       VALUES ('proj-race','Race Project',NULL,NULL,?,?,0,128000)`,
    ).run(Date.now(), Date.now());
    db.upsertTask({ id: "task-race", title: "Race", spaceId: ws.id, projectId: "proj-race", status: "in_progress", updatedAt: Date.now() });
    const raceA = memory.create({ kind: "decision", title: "Race A", content: "old A", scopeType: "project", scopeId: "proj-race", sourceType: "user", explicit: true });
    const raceB = memory.create({ kind: "constraint", title: "Race B", content: "stable B", scopeType: "project", scopeId: "proj-race", sourceType: "user", explicit: true });
    let mutatedDuringL2 = false;
    const raceRuntime = {
      completeSimple: async (_model: unknown, request: { systemPrompt?: string }) => {
        if (!request.systemPrompt?.includes("L2 Scenario")) throw new Error("unexpected race prompt");
        if (!mutatedDuringL2) {
          mutatedDuringL2 = true;
          memory.update({ id: raceA.id, content: "new A", changedBy: "user", changeReason: "mid-flight update" });
        }
        return fakeResponse({
          scenarios: [{
            scopeKey: "project:proj-race",
            title: "Stale Race Scenario",
            summary: "This response was generated from old A and must be discarded.",
            sourceMemoryIds: [raceA.id, raceB.id],
          }],
        });
      },
    };
    const raceResult = await memory.cognition.generateL2({ taskId: "task-race", modelRuntime: raceRuntime as never, model, isEnabled: () => true });
    assert.equal(mutatedDuringL2, true);
    assert.equal(raceResult.outputs, 0);
    assert.equal(memory.listScenarios().some((item) => item.scopeType === "project" && item.scopeId === "proj-race" && item.status === "active"), false, "stale in-flight L2 response must be discarded");

    console.log("memory-cognition-test: PASS");
  } finally {
    db.close();
  }
}

void main().catch((error) => {
  console.error("memory-cognition-test: FAILED", error);
  process.exit(1);
});
